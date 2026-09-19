"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./storageSyncPersistence.cjs");
const { STORAGE_SYNC_CHUNK_SIZE_BYTES } = require("./storageSync.cjs");
const {
  StorageSyncSqlRecordError,
  readStorageSyncSqlRecords,
} = require("./storageSyncSqlRecords.cjs");

const STORAGE_SYNC_SQL_FORMAT_VERSION = 1;
const MAX_SYNC_SQL_STREAM_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_SYNC_SQL_RECORDS = 5_000_000;

class StorageSyncSqlError extends Error {
  constructor(message, code = "invalid_sql_stream") {
    super(message);
    this.name = "StorageSyncSqlError";
    this.code = code;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function normalizePlan(input) {
  const formatVersion = Number(input?.formatVersion);
  const size = Number(input?.size);
  const recordCount = Number(input?.recordCount);
  const sha256 = String(input?.sha256 || "").toLowerCase();
  if (
    formatVersion !== STORAGE_SYNC_SQL_FORMAT_VERSION ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_SYNC_SQL_STREAM_BYTES ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0 ||
    recordCount > MAX_SYNC_SQL_RECORDS ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new StorageSyncSqlError("Storage sync SQL stream plan is invalid");
  }
  if ((size === 0) !== (recordCount === 0)) {
    throw new StorageSyncSqlError(
      "Empty SQL streams must have zero records and non-empty streams must have records",
    );
  }
  return { formatVersion, size, recordCount, sha256 };
}

function serializePlan(session) {
  if (!session.sql) {
    throw new StorageSyncSqlError(
      "Storage sync SQL stream has not been planned",
    );
  }
  return { ...session.sql, status: session.status };
}

class StorageSyncSqlStagingStore {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
  }

  sessionDirectory(sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new StorageSyncSqlError("Invalid storage sync session id");
    }
    return path.join(this.rootPath, sessionId);
  }

  filePath(sessionId) {
    return path.join(this.sessionDirectory(sessionId), "sql.ndjson.part");
  }

  planPath(sessionId) {
    return path.join(this.sessionDirectory(sessionId), "sql-plan.json");
  }

  persistPlan(session) {
    const { formatVersion, size, recordCount, sha256 } = session.sql;
    writeJsonAtomic(this.planPath(session.id), {
      version: 1,
      formatVersion,
      size,
      recordCount,
      sha256,
    });
  }

  async plan(session, input) {
    if (session.role !== "target") {
      throw new StorageSyncSqlError(
        "Only target sync sessions accept SQL streams",
      );
    }
    if (session.sql) return serializePlan(session);
    if (session.assets && session.status !== "assets-ready") {
      throw new StorageSyncSqlError(
        "Storage sync assets must finish before SQL staging begins",
        "assets_not_ready",
      );
    }
    const plan = normalizePlan(input);
    const filePath = this.filePath(session.id);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    session.sql = {
      ...plan,
      offset: 0,
      state: plan.size === 0 ? "ready" : "pending",
    };
    session.sqlUploadInProgress = false;
    if (plan.size === 0) {
      const emptyHash = crypto.createHash("sha256").digest("hex");
      if (plan.sha256 !== emptyHash) {
        delete session.sql;
        throw new StorageSyncSqlError(
          "Empty SQL stream checksum mismatch",
          "sql_checksum_mismatch",
        );
      }
      await fs.promises.writeFile(filePath, Buffer.alloc(0));
      session.status = "sql-ready";
    } else {
      session.status = "receiving-sql";
    }
    try {
      this.persistPlan(session);
    } catch (error) {
      delete session.sql;
      session.status = session.assets ? "assets-ready" : "created";
      await this.cleanupSql(session.id);
      throw error;
    }
    return serializePlan(session);
  }

  getPlan(session) {
    return serializePlan(session);
  }

  async writeChunk(session, offset, data) {
    if (session.role !== "target" || !session.sql) {
      throw new StorageSyncSqlError("Storage sync SQL stream is not planned");
    }
    if (
      !(data instanceof Uint8Array) ||
      data.byteLength > STORAGE_SYNC_CHUNK_SIZE_BYTES
    ) {
      throw new StorageSyncSqlError(
        `Storage sync SQL chunks must not exceed ${STORAGE_SYNC_CHUNK_SIZE_BYTES} bytes`,
        "chunk_too_large",
      );
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset !== session.sql.offset
    ) {
      throw new StorageSyncSqlError(
        `Storage sync SQL offset mismatch; expected ${session.sql.offset}`,
        "offset_mismatch",
      );
    }
    if (offset + data.byteLength > session.sql.size) {
      throw new StorageSyncSqlError(
        "Storage sync SQL chunk exceeds declared size",
        "sql_size_mismatch",
      );
    }
    if (session.sql.state === "ready") return serializePlan(session);
    if (session.sqlUploadInProgress) {
      throw new StorageSyncSqlError(
        "Storage sync SQL upload is already in progress",
        "sql_upload_in_progress",
      );
    }

    session.sqlUploadInProgress = true;
    try {
      const filePath = this.filePath(session.id);
      const handle = await fs.promises.open(
        filePath,
        offset === 0 ? "w" : "r+",
      );
      try {
        const buffer = Buffer.from(data);
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(
            buffer,
            written,
            buffer.length - written,
            offset + written,
          );
          if (!result.bytesWritten) {
            throw new StorageSyncSqlError(
              "Storage sync SQL chunk write made no progress",
              "sql_write_failed",
            );
          }
          written += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      session.sql.offset += data.byteLength;
      session.sql.state = "receiving";
      if (session.sql.offset === session.sql.size) {
        const digest = await sha256File(filePath);
        if (digest !== session.sql.sha256) {
          await fs.promises.rm(filePath, { force: true });
          session.sql.offset = 0;
          session.sql.state = "pending";
          throw new StorageSyncSqlError(
            "Storage sync SQL stream checksum mismatch",
            "sql_checksum_mismatch",
          );
        }
        session.sql.state = "ready";
        session.status = "sql-ready";
      } else {
        session.status = "receiving-sql";
      }
      return serializePlan(session);
    } finally {
      session.sqlUploadInProgress = false;
    }
  }

  async validate(session, options = {}) {
    if (
      session.role !== "target" ||
      !session.sql ||
      session.sql.state !== "ready" ||
      session.sql.offset !== session.sql.size
    ) {
      throw new StorageSyncSqlError(
        "Storage sync SQL stream is not ready for validation",
        "sql_not_ready",
      );
    }
    try {
      return await readStorageSyncSqlRecords(this.filePath(session.id), {
        expectedRecordCount: session.sql.recordCount,
        expectedSourceRevision: session.peerRevision,
        onRecord: options.onRecord,
      });
    } catch (error) {
      if (!(error instanceof StorageSyncSqlRecordError)) throw error;
      const wrapped = new StorageSyncSqlError(error.message, error.code);
      wrapped.recordIndex = error.recordIndex;
      throw wrapped;
    }
  }

  async hydrateSession(session) {
    if (session.sql) return true;
    let raw;
    try {
      raw = JSON.parse(await fs.promises.readFile(this.planPath(session.id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      await this.cleanupSql(session.id);
      return false;
    }
    if (raw?.version !== 1) {
      await this.cleanupSql(session.id);
      return false;
    }
    let plan;
    try {
      plan = normalizePlan(raw);
    } catch {
      await this.cleanupSql(session.id);
      return false;
    }
    const filePath = this.filePath(session.id);
    let actualSize = 0;
    let exists = true;
    try {
      actualSize = (await fs.promises.stat(filePath)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      exists = false;
    }
    if (actualSize > plan.size) {
      await fs.promises.rm(filePath, { force: true });
      actualSize = 0;
      exists = false;
    }
    let state = actualSize > 0 ? "receiving" : "pending";
    if (plan.size === 0) {
      const emptyHash = crypto.createHash("sha256").digest("hex");
      if (plan.sha256 !== emptyHash) {
        await this.cleanupSql(session.id);
        return false;
      }
      if (!exists) {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, Buffer.alloc(0));
      }
      state = "ready";
    } else if (exists && actualSize === plan.size) {
      const digest = await sha256File(filePath);
      if (digest === plan.sha256) state = "ready";
      else {
        await fs.promises.rm(filePath, { force: true });
        actualSize = 0;
        state = "pending";
      }
    }
    session.sql = { ...plan, offset: actualSize, state };
    session.sqlUploadInProgress = false;
    session.status = state === "ready" ? "sql-ready" : "receiving-sql";
    return true;
  }

  async cleanupSql(sessionId) {
    await Promise.all([
      fs.promises.rm(this.filePath(sessionId), { force: true }),
      fs.promises.rm(this.planPath(sessionId), { force: true }),
    ]);
  }
}

module.exports = {
  STORAGE_SYNC_SQL_FORMAT_VERSION,
  MAX_SYNC_SQL_STREAM_BYTES,
  MAX_SYNC_SQL_RECORDS,
  StorageSyncSqlError,
  StorageSyncSqlStagingStore,
  normalizePlan,
  serializePlan,
};
