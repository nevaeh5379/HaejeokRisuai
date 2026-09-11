import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  StorageSyncSqlRecordError,
  readStorageSyncSqlRecords,
} = require("./storageSyncSqlRecords.cjs");
const {
  encodeStorageSyncValue,
} = require("../../packages/protocol/storageSyncValueCodec.cjs");

const tempRoots: string[] = [];

async function tempFile(lines: unknown[], trailingNewline = true) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "risu-sync-records-"),
  );
  tempRoots.push(root);
  const file = path.join(root, "sql.ndjson.part");
  const body = lines
    .map((line) => JSON.stringify(encodeStorageSyncValue(line)))
    .join("\n");
  await fs.promises.writeFile(file, body + (trailingNewline ? "\n" : ""));
  return file;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});
describe("readStorageSyncSqlRecords", () => {
  it("streams and decodes valid records without building an aggregate payload", async () => {
    const file = await tempFile([
      { type: "meta", formatVersion: 1, revision: 7 },
      {
        type: "setting",
        key: "edge",
        value: { missing: undefined, nan: Number.NaN },
      },
      { type: "character", position: 0, id: "char-1", data: { name: "Alpha" } },
      {
        type: "chat",
        characterId: "char-1",
        position: 0,
        id: "chat-1",
        data: { name: "Chat" },
      },
    ]);
    const seen: any[] = [];

    const result = await readStorageSyncSqlRecords(file, {
      expectedRecordCount: 4,
      expectedSourceRevision: 7,
      onRecord: async (record: unknown) => seen.push(record),
    });

    expect(result).toMatchObject({ recordCount: 4, sourceRevision: 7 });
    expect(result.counts).toMatchObject({
      meta: 1,
      setting: 1,
      character: 1,
      chat: 1,
    });
    expect(seen[1].value.missing).toBeUndefined();
    expect(Number.isNaN(seen[1].value.nan)).toBe(true);
  });
  it("rejects root records that appear after entity records", async () => {
    const file = await tempFile([
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "character", position: 0, id: "char-1", data: {} },
      { type: "setting", key: "late", value: true },
    ]);

    await expect(readStorageSyncSqlRecords(file)).rejects.toMatchObject({
      name: "StorageSyncSqlRecordError",
      code: "invalid_sql_record_order",
      recordIndex: 2,
    });
  });

  it("rejects unterminated records and mismatched source revisions", async () => {
    const unterminated = await tempFile(
      [{ type: "meta", formatVersion: 1, revision: 7 }],
      false,
    );
    await expect(readStorageSyncSqlRecords(unterminated)).rejects.toMatchObject(
      {
        code: "unterminated_sql_record",
      },
    );

    const wrongRevision = await tempFile([
      { type: "meta", formatVersion: 1, revision: 8 },
    ]);
    await expect(
      readStorageSyncSqlRecords(wrongRevision, { expectedSourceRevision: 7 }),
    ).rejects.toMatchObject({ code: "sql_source_revision_mismatch" });
  });
});
