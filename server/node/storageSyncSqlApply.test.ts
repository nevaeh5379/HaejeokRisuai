import { describe, expect, it, vi } from "vitest";

const {
  StorageSyncSqlApplyError,
  applyStorageSyncSqlRecords,
} = require("./storageSyncSqlApply.cts") as {
  StorageSyncSqlApplyError: new (...args: any[]) => Error;
  applyStorageSyncSqlRecords: (options: Record<string, any>) => Promise<any>;
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

describe("applyStorageSyncSqlRecords", () => {
  it("applies large validated streams in bounded batches", async () => {
    const records = makeRecords();
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);
    const client = { query: vi.fn() };

    const result = await applyStorageSyncSqlRecords({
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
  it("can preserve cold storage while applying a local backup database stream", async () => {
    const records = makeRecords().filter(
      (record) => record.type !== "cold-storage",
    );
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);

    await applyStorageSyncSqlRecords({
      session: session(),
      sqlStaging: staging(records),
      sqlStorage,
      client: { query: vi.fn() },
      transactionContext: transactionContext(),
      replaceColdStorage: false,
    });

    expect(sqlStorage.clearStorageSyncColdStorage).not.toHaveBeenCalled();
    expect(log).not.toContain("clear-cold");
  });

  it("flushes batches by byte size even when the record-count limit is not reached", async () => {
    const records: any[] = [
      { type: "meta", formatVersion: 1, revision: 4 },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: "setting",
        key: `large-setting-${index}`,
        value: "x".repeat(400),
      })),
    ];
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);

    await applyStorageSyncSqlRecords({
      session: session(),
      sqlStaging: staging(records),
      sqlStorage,
      client: { query: vi.fn() },
      transactionContext: transactionContext(),
      batchSize: 128,
      batchBytes: 1024,
      replaceColdStorage: false,
    });

    const settingSizes = sqlStorage.sync.mock.calls
      .slice(1)
      .map(([payload]: [any]) =>
        payload.root ? payload.root.upserts.length : null,
      )
      .filter((value: number | null) => value !== null);
    expect(settingSizes).toEqual([2, 2, 2, 2]);
  });

  it("rejects a stale transaction before destructive writes", async () => {
    const log: string[] = [];
    const sqlStorage = fakeStorage(log);
    const client = { query: vi.fn() };
    const stale = { ...transactionContext(), currentRevision: 8, nextRevision: 9 };

    await expect(
      applyStorageSyncSqlRecords({
        session: session(),
        sqlStaging: staging(makeRecords()),
        sqlStorage,
        client,
        transactionContext: stale,
      }),
    ).rejects.toBeInstanceOf(StorageSyncSqlApplyError);

    expect(sqlStorage.sync).not.toHaveBeenCalled();
    expect(sqlStorage.clearStorageSyncColdStorage).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});

describe("applyStorageSyncSqlRecords vendor adapters", () => {
  it("applies Oracle branch, message-link, and cold-storage records inside the caller transaction", async () => {
    const records = makeRecords();
    const sync = vi.fn(async () => ({ revision: 8 }));
    const bulkTables: string[] = [];
    const storage = {
      sync,
      _bulkInsertRows: vi.fn(
        async (_client: unknown, table: string, _columns: string[], rows: any[]) => {
          bulkTables.push(`${table}:${rows.length}`);
        },
      ),
      upsertColdStorageWithClient: vi.fn(async () => {}),
    };
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
    };

    const result = await applyStorageSyncSqlRecords({
      vendor: "oracle",
      session: session(),
      sqlStaging: staging(records),
      sqlStorage: storage,
      client,
      transactionContext: transactionContext(),
      batchSize: 128,
    });

    expect(result.applied).toBe(records.length - 1);
    expect(client.execute).toHaveBeenCalledWith("DELETE FROM cold_archives");
    expect(storage.upsertColdStorageWithClient).toHaveBeenCalledOnce();
    expect(bulkTables).toContain("chat_branches:1");
    expect(bulkTables).toContain("chat_active_branches:1");
    expect(bulkTables).toContain("chat_message_branch_links:128");
    expect(bulkTables).toContain("chat_message_branch_links:44");
    expect(
      sync.mock.calls.every(([, options]) =>
        Boolean(options?.externalTransaction?.storageSyncImport),
      ),
    ).toBe(true);
  });

  it("stages Azure branch references until messages exist and finalizes them in the same transaction", async () => {
    const records = makeRecords().filter(
      (record) => record.type !== "cold-storage",
    );
    const sync = vi.fn(async () => ({ revision: 8 }));
    const queries: string[] = [];
    const request = () => {
      const req = {
        input: vi.fn(() => req),
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          return { recordset: [] };
        }),
      };
      return req;
    };
    const client = { request };
    const storage = { sync };

    const result = await applyStorageSyncSqlRecords({
      vendor: "azure",
      session: session(),
      sqlStaging: staging(records),
      sqlStorage: storage,
      client,
      transactionContext: transactionContext(),
      batchSize: 128,
      replaceColdStorage: false,
    });

    expect(result.applied).toBe(records.length - 1);
    expect(
      queries.some((sql) =>
        sql.includes("#risu_storage_sync_branch_refs"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (sql) =>
          sql.includes("MERGE INTO [chat].[branches]") ||
          sql.includes("MERGE INTO [chat].[message_branch_links]"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (sql) =>
          sql.includes("UPDATE branch") &&
          sql.includes("parent_branch_id = refs.parent_branch_id"),
      ),
    ).toBe(true);
    expect(
      sync.mock.calls.every(([, options]) =>
        Boolean(options?.externalTransaction?.storageSyncImport),
      ),
    ).toBe(true);
  });
});
