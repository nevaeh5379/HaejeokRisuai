"use strict";

const DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE = 256;

class StorageSyncPostgresApplyError extends Error {
  constructor(message, code = "storage_sync_apply_error") {
    super(message);
    this.name = "StorageSyncPostgresApplyError";
    this.code = code;
  }
}

function externalTransaction(client, context) {
  return {
    client,
    currentRevision: context.currentRevision,
    nextRevision: context.nextRevision,
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
      throw new StorageSyncPostgresApplyError(
        `Unsupported batched SQL record type '${type}'`,
        "unsupported_sql_record",
      );
  }
}

async function applyBatch(sqlStorage, client, context, type, records) {
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
    await sqlStorage.applyStorageSyncMessageLinks(client, records);
    return;
  }
  if (type === "cold-storage") {
    for (const record of records) {
      await sqlStorage.applyStorageSyncColdStorageRecord(
        client,
        record.key,
        record.value,
      );
    }
    return;
  }
  if (type === "branch") {
    await sqlStorage.applyStorageSyncBranchRecords(client, records, []);
    return;
  }
  if (type === "active-branch") {
    await sqlStorage.applyStorageSyncBranchRecords(client, [], records);
    return;
  }
  throw new StorageSyncPostgresApplyError(
    `Unsupported storage sync SQL record type '${type}'`,
    "unsupported_sql_record",
  );
}
async function applyStorageSyncPostgresRecords(options) {
  const {
    session,
    sqlStaging,
    sqlStorage,
    client,
    transactionContext,
    batchSize = DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE,
    onProgress,
  } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new StorageSyncPostgresApplyError("Invalid storage sync apply batch size");
  }
  if (transactionContext.currentRevision !== session.serverRevision) {
    throw new StorageSyncPostgresApplyError(
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
  await sqlStorage.clearStorageSyncColdStorage(client);
  let pendingType = null;
  let pending = [];
  let applied = 0;
  const flush = async () => {
    if (!pendingType || pending.length === 0) return;
    const batch = pending;
    const type = pendingType;
    pending = [];
    pendingType = null;
    await applyBatch(sqlStorage, client, transactionContext, type, batch);
    applied += batch.length;
    onProgress?.({ applied, type });
  };

  const validation = await sqlStaging.validate(session, {
    onRecord: async (record) => {
      if (record.type === "meta") return;
      if (pendingType !== record.type || pending.length >= batchSize) {
        await flush();
      }
      pendingType = record.type;
      pending.push(record);
    },
  });
  await flush();
  return {
    applied,
    recordCount: validation.recordCount,
    sourceRevision: validation.sourceRevision,
    counts: validation.counts,
  };
}

module.exports = {
  DEFAULT_STORAGE_SYNC_APPLY_BATCH_SIZE,
  StorageSyncPostgresApplyError,
  applyStorageSyncPostgresRecords,
  recordPayload,
};
