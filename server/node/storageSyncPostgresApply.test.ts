import { describe, expect, it, vi } from "vitest";

const {
  StorageSyncPostgresApplyError,
  applyStorageSyncPostgresRecords,
} = require("./storageSyncPostgresApply.cjs") as {
  StorageSyncPostgresApplyError: new (...args: any[]) => Error;
  applyStorageSyncPostgresRecords: (options: Record<string, any>) => Promise<any>;
};

function session() {
  return {
    id: "session-1",
    serverRevision: 7,
    peerRevision: 4,
  };
}

function transactionContext() {
  return {
    currentRevision: 7,
    nextRevision: 8,
    revisionId: 41,
    previousRevisionId: 40,
    databaseInitialized: true,
  };
}
function makeRecords() {
  const records: any[] = [{ type: "meta", formatVersion: 1, revision: 4 }];
  for (let index = 0; index < 300; index++) {
    records.push({ type: "setting", key: `setting-${index}`, value: index });
  }
  records.push({
    type: "cold-storage",
    key: "12345678-1234-1234-1234-123456789abc",
    value: { message: [] },
  });
  records.push({
    type: "branch",
    chatId: "chat-1",
    data: { id: "root", reason: "root", createdAt: 0, headMessageId: "m299" },
  });
  records.push({
    type: "active-branch",
    chatId: "chat-1",
    branchId: "root",
  });
  for (let index = 0; index < 300; index++) {
    records.push({
      type: "message",
      chatId: "chat-1",
      id: `m${index}`,
      position: index,
      parentMessageId: index === 0 ? undefined : `m${index - 1}`,
      originBranchId: "root",
      data: { role: "user", data: `message ${index}` },
    });
  }
  return records;
}

function staging(records: any[]) {
  return {
    validate: vi.fn(async (_session: unknown, options: any) => {
      for (let index = 0; index < records.length; index++) {
        await options.onRecord(records[index], index);
      }
      return {
        recordCount: records.length,
        sourceRevision: 4,
        counts: records.reduce((counts, record) => {
          counts[record.type] = (counts[record.type] || 0) + 1;
          return counts;
        }, {} as Record<string, number>),
      };
    }),
  };
}
function fakeStorage(log: string[]) {
  const sync = vi.fn(async (payload: any, options: any) => {
    expect(options.externalTransaction).toMatchObject({
      currentRevision: 7,
      nextRevision: 8,
      storageSyncImport: true,
    });
    if (payload.replaceAll) log.push("sync:clear");
    else if (payload.root) log.push(`sync:setting:${payload.root.upserts.length}`);
    else if (payload.messages) log.push(`sync:message:${payload.messages.length}`);
    else log.push("sync:other");
    return { revision: 8 };
  });
  return {
    sync,
    clearStorageSyncColdStorage: vi.fn(async () => {
      log.push("clear-cold");
    }),
    applyStorageSyncColdStorageRecord: vi.fn(async (_client, key: string) => {
      log.push(`cold:${key}`);
    }),
    applyStorageSyncBranchRecords: vi.fn(
      async (_client, branches: any[], activeBranches: any[]) => {
        if (branches.length) log.push(`branch:${branches.length}`);
        if (activeBranches.length) log.push(`active:${activeBranches.length}`);
      },
    ),
    applyStorageSyncMessageLinks: vi.fn(async (_client, records: any[]) => {
      log.push(`links:${records.length}`);
    }),
  };
}

function payloadBatchLength(payload: any): number | null {
  if (payload.root) return payload.root.upserts.length;
  if (payload.pluginStorage) return payload.pluginStorage.upserts.length;
  if (payload.modules) return payload.modules.upserts.length;
  if (payload.presets) return payload.presets.upserts.length;
  if (payload.characters) return payload.characters.length;
  if (payload.chats) return payload.chats.length;
  if (payload.messages) return payload.messages.length;
  return null;
}

describe("applyStorageSyncPostgresRecords", () => {
  it("applies large validated streams in bounded batches", async () => {
    const records = makeRecords();
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);
    const client = { query: vi.fn() };

    const result = await applyStorageSyncPostgresRecords({
      session: session(),
      sqlStaging: staging(records),
      sqlStorage,
      client,
      transactionContext: transactionContext(),
      batchSize: 128,
    });

    expect(result).toMatchObject({
      applied: records.length - 1,
      recordCount: records.length,
      sourceRevision: 4,
    });
    expect(sqlStorage.sync.mock.calls[0][0]).toMatchObject({
      replaceAll: true,
      action: "storage-sync:replace",
      baseRevision: 7,
    });
    const streamedCalls = sqlStorage.sync.mock.calls.slice(1);
    const settingSizes = streamedCalls
      .map(([payload]: [any]) => (payload.root ? payloadBatchLength(payload) : null))
      .filter((value: number | null) => value !== null);
    const messageSizes = streamedCalls
      .map(([payload]: [any]) => (payload.messages ? payloadBatchLength(payload) : null))
      .filter((value: number | null) => value !== null);

    expect(settingSizes).toEqual([128, 128, 44]);
    expect(messageSizes).toEqual([128, 128, 44]);
    expect(sqlStorage.clearStorageSyncColdStorage).toHaveBeenCalledOnce();
    expect(sqlStorage.applyStorageSyncColdStorageRecord).toHaveBeenCalledOnce();
    expect(sqlStorage.applyStorageSyncMessageLinks.mock.calls.map((call: any[]) => call[1].length)).toEqual([
      128,
      128,
      44,
    ]);
    expect(log.indexOf("sync:clear")).toBeLessThan(log.indexOf("clear-cold"));
  });
  it("rejects a stale transaction before destructive writes", async () => {
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);
    const client = { query: vi.fn() };
    const stale = { ...transactionContext(), currentRevision: 8, nextRevision: 9 };

    await expect(
      applyStorageSyncPostgresRecords({
        session: session(),
        sqlStaging: staging(makeRecords()),
        sqlStorage,
        client,
        transactionContext: stale,
      }),
    ).rejects.toBeInstanceOf(StorageSyncPostgresApplyError);

    expect(sqlStorage.sync).not.toHaveBeenCalled();
    expect(sqlStorage.clearStorageSyncColdStorage).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});
