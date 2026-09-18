"use strict";

type SqlVendor = "postgres" | "oracle" | "azure";

type StorageSyncBranchRecord = {
  chatId: string;
  data: {
    id: string;
    parentBranchId?: string;
    forkMessageId?: string;
    headMessageId?: string;
    reason: "root" | "manual" | "reroll";
    createdAt?: number;
  };
};

type StorageSyncActiveBranchRecord = {
  chatId: string;
  branchId: string;
};

type StorageSyncMessageRecord = {
  chatId: string;
  id: string;
  parentMessageId?: string;
  originBranchId: string;
};

class VendorApplyPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorApplyPayloadError";
  }
}

const { createSqlStorageHelpers } = require("./sqlStorageCommon.cjs") as {
  createSqlStorageHelpers: (options: Record<string, unknown>) => {
    normalizeColdStorageKey: (key: string) => string;
    splitColdStorageValue: (value: unknown) => unknown;
  };
};

const compatibleColdHelpers = createSqlStorageHelpers({
  PayloadError: VendorApplyPayloadError,
  allowShortColdStorageKeys: true,
});

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4000) {
    throw new VendorApplyPayloadError(`${label} must be a non-empty string`);
  }
}

function branchRows(records: StorageSyncBranchRecord[]) {
  return records.map((record) => {
    assertId(record.chatId, "branch.chatId");
    assertId(record.data?.id, "branch.id");
    const reason = record.data?.reason;
    if (!["root", "manual", "reroll"].includes(reason)) {
      throw new VendorApplyPayloadError("Invalid chat branch reason");
    }
    return {
      chat_id: record.chatId,
      id: record.data.id,
      parent_branch_id: record.data.parentBranchId ?? null,
      fork_message_id: record.data.forkMessageId ?? null,
      head_message_id: record.data.headMessageId ?? null,
      reason,
      created_at: Number(record.data.createdAt) || 0,
    };
  });
}
function activeBranchRows(records: StorageSyncActiveBranchRecord[]) {
  return records.map((record) => {
    assertId(record.chatId, "active-branch.chatId");
    assertId(record.branchId, "active-branch.branchId");
    return { chat_id: record.chatId, branch_id: record.branchId };
  });
}

function messageLinkRows(records: StorageSyncMessageRecord[]) {
  return records.map((record) => {
    assertId(record.chatId, "message.chatId");
    assertId(record.id, "message.id");
    assertId(record.originBranchId, "message.originBranchId");
    if (record.parentMessageId !== undefined) {
      assertId(record.parentMessageId, "message.parentMessageId");
    }
    return {
      chat_id: record.chatId,
      message_id: record.id,
      parent_message_id: record.parentMessageId ?? null,
      origin_branch_id: record.originBranchId,
    };
  });
}

async function clearVendorColdStorage(
  vendor: SqlVendor,
  storage: any,
  client: any,
): Promise<void> {
  if (vendor === "postgres") {
    await storage.clearStorageSyncColdStorage(client);
    return;
  }
  if (vendor === "azure") {
    await client.request().query("DELETE FROM [cold].[archives]");
    return;
  }
  await client.execute("DELETE FROM cold_archives");
}

async function applyVendorColdStorageRecord(
  vendor: SqlVendor,
  storage: any,
  client: any,
  record: { key: string; value: unknown },
): Promise<void> {
  if (vendor === "postgres") {
    await storage.applyStorageSyncColdStorageRecord(
      client,
      record.key,
      record.value,
    );
    return;
  }
  const key = compatibleColdHelpers.normalizeColdStorageKey(record.key);
  const split = compatibleColdHelpers.splitColdStorageValue(record.value);
  await storage.upsertColdStorageWithClient(client, key, split);
}

async function applyVendorBranchRecords(
  vendor: SqlVendor,
  storage: any,
  client: any,
  branches: StorageSyncBranchRecord[],
  activeBranches: StorageSyncActiveBranchRecord[],
): Promise<void> {
  if (vendor === "postgres") {
    await storage.applyStorageSyncBranchRecords(
      client,
      branches,
      activeBranches,
    );
    return;
  }

  const rows = branchRows(branches);
  const activeRows = activeBranchRows(activeBranches);

  if (vendor === "oracle") {
    await storage._bulkInsertRows(
      client,
      "chat_branches",
      [
        "chat_id",
        "id",
        "parent_branch_id",
        "fork_message_id",
        "head_message_id",
        "reason",
        "created_at",
      ],
      rows,
    );
    await storage._bulkInsertRows(
      client,
      "chat_active_branches",
      ["chat_id", "branch_id"],
      activeRows,
    );
    return;
  }
  const { bulkInsert } = require("./azureStorage.cjs") as {
    bulkInsert: (
      target: any,
      table: string,
      columns: string[],
      columnTypes: string[],
      rows: Record<string, unknown>[],
      mergeKeys?: string[],
    ) => Promise<void>;
  };

  if (rows.length > 0) {
    const request = client.request();
    const mssql = require("mssql") as any;
    request.input(
      "storageSyncBranchRefs",
      mssql.NVarChar(mssql.MAX),
      JSON.stringify(rows),
    );
    await request.query(`
      IF OBJECT_ID('tempdb..#risu_storage_sync_branch_refs') IS NULL
      BEGIN
        CREATE TABLE #risu_storage_sync_branch_refs (
          chat_id NVARCHAR(450) NOT NULL,
          id NVARCHAR(450) NOT NULL,
          parent_branch_id NVARCHAR(450) NULL,
          fork_message_id NVARCHAR(450) NULL,
          head_message_id NVARCHAR(450) NULL,
          PRIMARY KEY (chat_id, id)
        );
      END;

      MERGE #risu_storage_sync_branch_refs AS target
      USING (
        SELECT chat_id, id, parent_branch_id, fork_message_id, head_message_id
        FROM OPENJSON(@storageSyncBranchRefs)
        WITH (
          chat_id NVARCHAR(450) '$.chat_id',
          id NVARCHAR(450) '$.id',
          parent_branch_id NVARCHAR(450) '$.parent_branch_id',
          fork_message_id NVARCHAR(450) '$.fork_message_id',
          head_message_id NVARCHAR(450) '$.head_message_id'
        )
      ) AS source
      ON target.chat_id = source.chat_id AND target.id = source.id
      WHEN MATCHED THEN UPDATE SET
        parent_branch_id = source.parent_branch_id,
        fork_message_id = source.fork_message_id,
        head_message_id = source.head_message_id
      WHEN NOT MATCHED THEN
        INSERT (chat_id,id,parent_branch_id,fork_message_id,head_message_id)
        VALUES (
          source.chat_id, source.id, source.parent_branch_id,
          source.fork_message_id, source.head_message_id
        );
    `);

    const baseRows = rows.map((row) => ({
      ...row,
      parent_branch_id: null,
      fork_message_id: null,
      head_message_id: null,
    }));
    await bulkInsert(
      client,
      "chat.branches",
      [
        "chat_id",
        "id",
        "parent_branch_id",
        "fork_message_id",
        "head_message_id",
        "reason",
        "created_at",
      ],
      [
        "nvarchar(450)",
        "nvarchar(450)",
        "nvarchar(450)",
        "nvarchar(450)",
        "nvarchar(450)",
        "nvarchar(32)",
        "bigint",
      ],
      baseRows,
      ["chat_id", "id"],
    );
  }

  await bulkInsert(
    client,
    "chat.active_branches",
    ["chat_id", "branch_id"],
    ["nvarchar(450)", "nvarchar(450)"],
    activeRows,
    ["chat_id"],
  );
}
async function applyVendorMessageLinks(
  vendor: SqlVendor,
  storage: any,
  client: any,
  records: StorageSyncMessageRecord[],
): Promise<void> {
  if (records.length === 0) return;
  if (vendor === "postgres") {
    await storage.applyStorageSyncMessageLinks(client, records);
    return;
  }

  const rows = messageLinkRows(records);
  if (vendor === "oracle") {
    await storage._bulkInsertRows(
      client,
      "chat_message_branch_links",
      ["chat_id", "message_id", "parent_message_id", "origin_branch_id"],
      rows,
    );
    return;
  }

  const { bulkInsert } = require("./azureStorage.cjs") as {
    bulkInsert: (
      target: any,
      table: string,
      columns: string[],
      columnTypes: string[],
      rows: Record<string, unknown>[],
      mergeKeys?: string[],
    ) => Promise<void>;
  };
  await bulkInsert(
    client,
    "chat.message_branch_links",
    ["chat_id", "message_id", "parent_message_id", "origin_branch_id"],
    ["nvarchar(450)", "nvarchar(450)", "nvarchar(450)", "nvarchar(450)"],
    rows,
    ["chat_id", "message_id"],
  );
}

async function finalizeVendorStorageSyncImport(
  vendor: SqlVendor,
  _storage: any,
  client: any,
): Promise<void> {
  if (vendor !== "azure") return;
  await client.request().query(`
    IF OBJECT_ID('tempdb..#risu_storage_sync_branch_refs') IS NOT NULL
    BEGIN
      UPDATE branch
         SET parent_branch_id = refs.parent_branch_id,
             fork_message_id = refs.fork_message_id,
             head_message_id = refs.head_message_id
        FROM [chat].[branches] branch
        JOIN #risu_storage_sync_branch_refs refs
          ON refs.chat_id = branch.chat_id
         AND refs.id = branch.id;

      DROP TABLE #risu_storage_sync_branch_refs;
    END
  `);
}




const DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE = 256;
const DEFAULT_STORAGE_SYNC_APPLY_BATCH_BYTES = 16 * 1024 * 1024;

class StorageSyncSqlApplyError extends Error {
  readonly code: string;

  constructor(message: string, code = "storage_sync_apply_error") {
    super(message);
    this.name = "StorageSyncSqlApplyError";
    this.code = code;
  }
}

function externalTransaction(client, context) {
  return {
    client,
    currentRevision: context.currentRevision,
    nextRevision: context.nextRevision,
    revisionId: context.revisionId,
    storageSyncImport: true,
  };
}

function basePayload(context) {
  return { baseRevision: context.currentRevision };
}
function recordPayload(type, records, context) {
  const base = basePayload(context);
  switch (type) {
    case "setting":
      return {
        ...base,
        root: {
          upserts: records.map((record) => ({ key: record.key, value: record.value })),
          deletes: [],
        },
      };
    case "plugin-storage":
      return {
        ...base,
        pluginStorage: {
          upserts: records.map((record) => ({ key: record.key, value: record.value })),
          deletes: [],
          clear: false,
        },
      };
    case "module":
      return {
        ...base,
        modules: {
          upserts: records.map((record) => ({
            id: record.id,
            position: record.position,
            data: record.data,
          })),
          deletes: [],
        },
      };
    case "preset":
      return {
        ...base,
        presets: {
          upserts: records.map((record) => ({
            id: record.id,
            position: record.position,
            data: record.data,
          })),
          deletes: [],
        },
      };
    case "character":
      return {
        ...base,
        characters: records.map((record) => ({
          id: record.id,
          position: record.position,
          data: record.data,
        })),
      };
    case "chat":
      return {
        ...base,
        chats: records.map((record) => ({
          id: record.id,
          characterId: record.characterId,
          position: record.position,
          data: record.data,
        })),
      };
    case "message":
      return {
        ...base,
        messages: records.map((record) => ({
          id: record.id,
          chatId: record.chatId,
          position: record.position,
          data: record.data,
        })),
      };
    default:
      throw new StorageSyncSqlApplyError(
        `Unsupported batched SQL record type '${type}'`,
        "unsupported_sql_record",
      );
  }
}

async function applyBatch(
  vendor: "postgres" | "oracle" | "azure",
  sqlStorage: any,
  client: any,
  context: any,
  type: string,
  records: any[],
) {
  if (records.length === 0) return;
  const external = externalTransaction(client, context);
  if (["setting", "plugin-storage", "module", "preset", "character", "chat"].includes(type)) {
    await sqlStorage.sync(recordPayload(type, records, context), {
      externalTransaction: external,
    });
    return;
  }
  if (type === "message") {
    await sqlStorage.sync(recordPayload(type, records, context), {
      externalTransaction: external,
    });
    await applyVendorMessageLinks(vendor, sqlStorage, client, records);
    return;
  }
  if (type === "cold-storage") {
    for (const record of records) {
      await applyVendorColdStorageRecord(
        vendor,
        sqlStorage,
        client,
        record,
      );
    }
    return;
  }
  if (type === "branch") {
    await applyVendorBranchRecords(
      vendor,
      sqlStorage,
      client,
      records,
      [],
    );
    return;
  }
  if (type === "active-branch") {
    await applyVendorBranchRecords(
      vendor,
      sqlStorage,
      client,
      [],
      records,
    );
    return;
  }
  throw new StorageSyncSqlApplyError(
    `Unsupported storage sync SQL record type '${type}'`,
    "unsupported_sql_record",
  );
}
async function applyStorageSyncSqlRecords(options) {
  const {
    session,
    sqlStaging,
    sqlStorage,
    client,
    transactionContext,
    batchSize = DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE,
    batchBytes = DEFAULT_STORAGE_SYNC_APPLY_BATCH_BYTES,
    onProgress,
    replaceColdStorage = true,
    vendor = "postgres",
  } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new StorageSyncSqlApplyError("Invalid storage sync apply batch size");
  }
  if (
    !Number.isSafeInteger(batchBytes) ||
    batchBytes < 1024 ||
    batchBytes > 64 * 1024 * 1024
  ) {
    throw new StorageSyncSqlApplyError("Invalid storage sync apply byte limit");
  }
  if (transactionContext.currentRevision !== session.serverRevision) {
    throw new StorageSyncSqlApplyError(
      "Finalize transaction revision does not match the staged session",
      "target_changed",
    );
  }
  const external = externalTransaction(client, transactionContext);
  await sqlStorage.sync(
    {
      ...basePayload(transactionContext),
      replaceAll: true,
      action: "storage-sync:replace",
    },
    { externalTransaction: external },
  );
  if (replaceColdStorage) {
    await clearVendorColdStorage(vendor, sqlStorage, client);
  }
  let pendingType = null;
  let pending = [];
  let pendingBytes = 0;
  let applied = 0;
  const flush = async () => {
    if (!pendingType || pending.length === 0) return;
    const batch = pending;
    const type = pendingType;
    pending = [];
    pendingType = null;
    pendingBytes = 0;
    await applyBatch(
      vendor,
      sqlStorage,
      client,
      transactionContext,
      type,
      batch,
    );
    applied += batch.length;
    onProgress?.({ applied, type });
  };

  const validation = await sqlStaging.validate(session, {
    onRecord: async (record) => {
      if (record.type === "meta") return;
      const recordBytes = Buffer.byteLength(
        JSON.stringify(record),
        "utf8",
      );
      if (
        pendingType !== record.type ||
        pending.length >= batchSize ||
        (pending.length > 0 && pendingBytes + recordBytes > batchBytes)
      ) {
        await flush();
      }
      pendingType = record.type;
      pending.push(record);
      pendingBytes += recordBytes;
    },
  });
  await flush();
  await finalizeVendorStorageSyncImport(vendor, sqlStorage, client);
  return {
    applied,
    recordCount: validation.recordCount,
    sourceRevision: validation.sourceRevision,
    counts: validation.counts,
  };
}

module.exports = {
  DEFAULT_STORAGE_SYNC_APPLY_BATCH_BYTES,
  DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE,
  StorageSyncSqlApplyError,
  applyStorageSyncSqlRecords,
  recordPayload,
};
