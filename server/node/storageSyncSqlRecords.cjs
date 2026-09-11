"use strict";

const fs = require("fs");
const {
  decodeStorageSyncValue,
} = require("../../packages/protocol/storageSyncValueCodec.cjs");

const STORAGE_SYNC_SQL_RECORD_MAX_BYTES = 16 * 1024 * 1024;
const STORAGE_SYNC_SQL_READ_CHUNK_BYTES = 256 * 1024;
const ROOT_RECORD_TYPES = new Set([
  "setting",
  "plugin-storage",
  "module",
  "preset",
  "cold-storage",
]);
const ENTITY_RECORD_TYPES = new Set([
  "character",
  "chat",
  "branch",
  "active-branch",
  "message",
]);

class StorageSyncSqlRecordError extends Error {
  constructor(message, code = "invalid_sql_record", recordIndex = null) {
    super(message);
    this.name = "StorageSyncSqlRecordError";
    this.code = code;
    this.recordIndex = recordIndex;
  }
}
function requireObject(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageSyncSqlRecordError(
      "Storage sync SQL record must be an object",
      "invalid_sql_record",
      index,
    );
  }
  return value;
}

function requireString(value, label, index, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new StorageSyncSqlRecordError(
      `${label} must be a ${allowEmpty ? "string" : "non-empty string"}`,
      "invalid_sql_record",
      index,
    );
  }
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new StorageSyncSqlRecordError(
      `${label} is too long`,
      "invalid_sql_record",
      index,
    );
  }
}

function requirePosition(value, label, index) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageSyncSqlRecordError(
      `${label} must be a non-negative safe integer`,
      "invalid_sql_record",
      index,
    );
  }
}
function validateRecord(record, index, state) {
  requireObject(record, index);
  requireString(record.type, "record.type", index);
  if (index === 0) {
    if (
      record.type !== "meta" ||
      record.formatVersion !== 1 ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0
    ) {
      throw new StorageSyncSqlRecordError(
        "Storage sync SQL stream must begin with a valid v1 meta record",
        "invalid_sql_meta",
        index,
      );
    }
    state.sourceRevision = record.revision;
    return;
  }
  if (record.type === "meta") {
    throw new StorageSyncSqlRecordError(
      "Storage sync SQL stream contains more than one meta record",
      "invalid_sql_meta",
      index,
    );
  }

  if (ROOT_RECORD_TYPES.has(record.type)) {
    if (state.entityPhase) {
      throw new StorageSyncSqlRecordError(
        "Root SQL records cannot appear after entity records",
        "invalid_sql_record_order",
        index,
      );
    }
  } else if (ENTITY_RECORD_TYPES.has(record.type)) {
    state.entityPhase = true;
  } else {
    throw new StorageSyncSqlRecordError(
      `Unsupported storage sync SQL record type '${record.type}'`,
      "unsupported_sql_record",
      index,
    );
  }
  switch (record.type) {
    case "setting":
    case "plugin-storage":
    case "cold-storage":
      requireString(record.key, `${record.type}.key`, index);
      break;
    case "module":
    case "preset":
    case "character":
      requirePosition(record.position, `${record.type}.position`, index);
      requireString(record.id, `${record.type}.id`, index);
      break;
    case "chat":
      requireString(record.characterId, "chat.characterId", index);
      requirePosition(record.position, "chat.position", index);
      requireString(record.id, "chat.id", index);
      break;
    case "branch":
      requireString(record.chatId, "branch.chatId", index);
      requireObject(record.data, index);
      requireString(record.data.id, "branch.data.id", index);
      break;
    case "active-branch":
      requireString(record.chatId, "active-branch.chatId", index);
      requireString(record.branchId, "active-branch.branchId", index);
      break;
    case "message":
      requireString(record.chatId, "message.chatId", index);
      requireString(record.id, "message.id", index);
      requirePosition(record.position, "message.position", index);
      requireString(record.originBranchId, "message.originBranchId", index);
      if (record.parentMessageId !== undefined) {
        requireString(record.parentMessageId, "message.parentMessageId", index);
      }
      break;
  }
}
async function readStorageSyncSqlRecords(filePath, options = {}) {
  const expectedRecordCount = options.expectedRecordCount;
  if (
    expectedRecordCount !== undefined &&
    (!Number.isSafeInteger(expectedRecordCount) || expectedRecordCount < 0)
  ) {
    throw new TypeError("expectedRecordCount must be a non-negative safe integer");
  }

  const state = { sourceRevision: null, entityPhase: false };
  const counts = Object.create(null);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineChunks = [];
  let lineBytes = 0;
  let recordCount = 0;

  const consumeLine = async () => {
    if (lineBytes === 0) {
      throw new StorageSyncSqlRecordError(
        "Storage sync SQL stream contains an empty record",
        "invalid_sql_record",
        recordCount,
      );
    }
    const line =
      lineChunks.length === 1
        ? lineChunks[0]
        : Buffer.concat(lineChunks, lineBytes);
    lineChunks = [];
    lineBytes = 0;

    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(line));
    } catch (error) {
      throw new StorageSyncSqlRecordError(
        `Storage sync SQL record ${recordCount} is not valid UTF-8 JSON: ${error.message}`,
        "invalid_sql_json",
        recordCount,
      );
    }
    const record = decodeStorageSyncValue(parsed);
    validateRecord(record, recordCount, state);
    counts[record.type] = (counts[record.type] || 0) + 1;
    await options.onRecord?.(record, recordCount);
    recordCount++;
  };
  const stream = fs.createReadStream(filePath, {
    highWaterMark: STORAGE_SYNC_SQL_READ_CHUNK_BYTES,
  });
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (end > start) {
        const slice = chunk.subarray(start, end);
        lineChunks.push(slice);
        lineBytes += slice.length;
        if (lineBytes > STORAGE_SYNC_SQL_RECORD_MAX_BYTES) {
          stream.destroy();
          throw new StorageSyncSqlRecordError(
            `Storage sync SQL record exceeds ${STORAGE_SYNC_SQL_RECORD_MAX_BYTES} bytes`,
            "sql_record_too_large",
            recordCount,
          );
        }
      }
      if (newline === -1) break;
      await consumeLine();
      start = newline + 1;
    }
  }

  if (lineBytes !== 0) {
    throw new StorageSyncSqlRecordError(
      "Storage sync SQL stream ends with an unterminated record",
      "unterminated_sql_record",
      recordCount,
    );
  }
  if (recordCount === 0) {
    throw new StorageSyncSqlRecordError(
      "Storage sync SQL stream is empty",
      "invalid_sql_meta",
      0,
    );
  }
  if (
    expectedRecordCount !== undefined &&
    recordCount !== expectedRecordCount
  ) {
    throw new StorageSyncSqlRecordError(
      `Storage sync SQL record count mismatch; expected ${expectedRecordCount}, got ${recordCount}`,
      "sql_record_count_mismatch",
      recordCount,
    );
  }
  if (
    options.expectedSourceRevision !== undefined &&
    state.sourceRevision !== options.expectedSourceRevision
  ) {
    throw new StorageSyncSqlRecordError(
      `Storage sync SQL source revision mismatch; expected ${options.expectedSourceRevision}, got ${state.sourceRevision}`,
      "sql_source_revision_mismatch",
      0,
    );
  }
  return {
    recordCount,
    sourceRevision: state.sourceRevision,
    counts,
  };
}

module.exports = {
  STORAGE_SYNC_SQL_READ_CHUNK_BYTES,
  STORAGE_SYNC_SQL_RECORD_MAX_BYTES,
  StorageSyncSqlRecordError,
  readStorageSyncSqlRecords,
  validateStorageSyncSqlRecord: validateRecord,
};
