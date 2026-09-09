"use strict";

const STORAGE_SYNC_PROTOCOL_VERSION = 1;

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

async function createStorageSyncSummary(sqlStorage, assetStorage) {
  if (typeof sqlStorage?.getStorageSyncSummary !== "function") {
    throw new Error("SQL storage does not support storage sync summaries");
  }
  if (typeof assetStorage?.getStats !== "function") {
    throw new Error("Asset storage does not support storage sync summaries");
  }

  const [database, assetStats] = await Promise.all([
    sqlStorage.getStorageSyncSummary(),
    assetStorage.getStats(),
  ]);
  const records = database?.records || {};
  return {
    protocolVersion: STORAGE_SYNC_PROTOCOL_VERSION,
    revision: normalizeNonNegativeInteger(database?.revision),
    initialized: Boolean(database?.initialized),
    records: {
      settings: normalizeNonNegativeInteger(records.settings),
      characters: normalizeNonNegativeInteger(records.characters),
      chats: normalizeNonNegativeInteger(records.chats),
      messages: normalizeNonNegativeInteger(records.messages),
      total: normalizeNonNegativeInteger(records.total),
    },
    assets: {
      count: normalizeNonNegativeInteger(assetStats?.totalObjects),
      sizeBytes: normalizeNonNegativeInteger(assetStats?.totalSizeBytes),
    },
  };
}

module.exports = {
  STORAGE_SYNC_PROTOCOL_VERSION,
  createStorageSyncSummary,
};
