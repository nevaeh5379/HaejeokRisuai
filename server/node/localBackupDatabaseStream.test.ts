import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LocalBackupDatabaseStreamError,
  LocalBackupDatabaseStreamStore,
} from "@risuai/backup-core/node/databaseStreamStore";

const {
  decodeStorageSyncValue,
  encodeStorageSyncValue,
} = require("../../packages/protocol/storageSyncValueCodec.cjs") as {
  decodeStorageSyncValue: (value: unknown) => any;
  encodeStorageSyncValue: (value: unknown) => unknown;
};
const {
  readStorageSyncSqlRecords,
  validateStorageSyncSqlRecord,
} = require("./storageSyncSqlRecords.cjs") as {
  readStorageSyncSqlRecords: (
    filePath: string,
    options?: Record<string, any>,
  ) => Promise<any>;
  validateStorageSyncSqlRecord: (
    record: any,
    index: number,
    state: any,
  ) => void;
};

const roots: string[] = [];

async function makeStore() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "risu-local-backup-db-stream-"),
  );
  roots.push(root);
  return new LocalBackupDatabaseStreamStore(
    root,
    {
      createValidationState: () => ({
        sourceRevision: null as number | null,
        entityPhase: false,
      }),
      cloneValidationState: (state) => ({ ...state }),
      decodeRecord: decodeStorageSyncValue,
      encodeRecord: encodeStorageSyncValue,
      validateRecord: validateStorageSyncSqlRecord,
      getSourceRevision: (state) => state.sourceRevision,
    },
    { ttlMs: 60_000 },
  );
}

function records() {
  return [
    { type: "meta", formatVersion: 1, revision: 11 },
    { type: "setting", key: "language", value: "ko" },
    {
      type: "character",
      position: 0,
      id: "char-1",
      data: { name: "Alpha", type: "character" },
    },
    {
      type: "chat",
      characterId: "char-1",
      position: 0,
      id: "chat-1",
      data: { name: "Main" },
    },
    {
      type: "branch",
      chatId: "chat-1",
      data: {
        id: "root",
        reason: "root",
        createdAt: 0,
        headMessageId: "m1",
      },
    },
    { type: "active-branch", chatId: "chat-1", branchId: "root" },
    {
      type: "message",
      chatId: "chat-1",
      id: "m1",
      position: 0,
      originBranchId: "root",
      data: { role: "user", data: "hello" },
    },
  ];
}

function manifest(input: any[]) {
  const counts = input.reduce(
    (result, record) => {
      result[record.type] = (result[record.type] ?? 0) + 1;
      return result;
    },
    {} as Record<string, number>,
  );
  return {
    format: "risu-portable-database-stream",
    version: 1,
    revision: 11,
    complete: true,
    totalFragments: 1,
    totalRecords: input.length,
    counts,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.promises.rm(root, { recursive: true, force: true }),
    ),
  );
});
describe("LocalBackupDatabaseStreamStore", () => {
  it("stages split request batches and validates the final manifest", async () => {
    const store = await makeStore();
    const session = await store.create();
    const input = records();
    const encoded = input.map(encodeStorageSyncValue);

    const first = await store.appendRecords(session.id, {
      fragmentIndex: 1,
      records: encoded.slice(0, 3),
      fragmentComplete: false,
    });
    expect(first).toMatchObject({
      nextFragmentIndex: 1,
      recordCount: 3,
    });

    const second = await store.appendRecords(session.id, {
      fragmentIndex: 1,
      records: encoded.slice(3),
      fragmentComplete: true,
    });
    expect(second).toMatchObject({
      nextFragmentIndex: 2,
      recordCount: input.length,
    });

    const prepared = store.prepareFinalize(session.id, manifest(input));
    const replayed: any[] = [];
    const validation = await readStorageSyncSqlRecords(prepared.filePath, {
      expectedRecordCount: prepared.recordCount,
      expectedSourceRevision: prepared.sourceRevision,
      onRecord: async (record: any) => {
        replayed.push(record);
      },
    });

    expect(validation).toMatchObject({
      recordCount: input.length,
      sourceRevision: 11,
    });
    expect(replayed).toEqual(input);

    const finalized = {
      status: "completed",
      revision: 12,
      revisionId: 99,
      sourceRevision: 11,
      recordCount: input.length,
    };
    await store.markFinalized(session.id, finalized);
    expect(store.getFinalizedResult(session.id)).toEqual(finalized);
    await expect(
      store.appendRecords(session.id, {
        fragmentIndex: 2,
        records: [encodeStorageSyncValue(input[1])],
        fragmentComplete: true,
      }),
    ).rejects.toMatchObject({ code: "session_finalized" });

    await store.cleanup(session.id);
    expect(() => store.getFinalizedResult(session.id)).toThrow(
      LocalBackupDatabaseStreamError,
    );
  });

  it("rejects fragment reordering before writing the stream", async () => {
    const store = await makeStore();
    const session = await store.create();

    await expect(
      store.appendRecords(session.id, {
        fragmentIndex: 2,
        records: [encodeStorageSyncValue(records()[0])],
        fragmentComplete: true,
      }),
    ).rejects.toMatchObject({ code: "fragment_order_mismatch" });
  });

  it("rejects a manifest whose record totals do not match staged data", async () => {
    const store = await makeStore();
    const session = await store.create();
    const input = records();
    await store.appendRecords(session.id, {
      fragmentIndex: 1,
      records: input.map(encodeStorageSyncValue),
      fragmentComplete: true,
    });

    expect(() =>
      store.prepareFinalize(session.id, {
        ...manifest(input),
        totalRecords: input.length + 1,
      }),
    ).toThrow(/incomplete/i);
  });

  it("rejects cold-storage records from the portable database stream", async () => {
    const store = await makeStore();
    const session = await store.create();

    await expect(
      store.appendRecords(session.id, {
        fragmentIndex: 1,
        records: [
          encodeStorageSyncValue({
            type: "meta",
            formatVersion: 1,
            revision: 11,
          }),
          encodeStorageSyncValue({
            type: "cold-storage",
            key: "12345678-1234-1234-1234-123456789abc",
            value: {},
          }),
        ],
        fragmentComplete: true,
      }),
    ).rejects.toMatchObject({ code: "unsupported_record_type" });
  });
});
