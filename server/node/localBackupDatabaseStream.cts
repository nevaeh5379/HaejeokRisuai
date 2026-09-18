"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  decodeStorageSyncValue,
  encodeStorageSyncValue,
} = require("../../packages/protocol/storageSyncValueCodec.cjs");
const {
  StorageSyncSqlRecordError,
  readStorageSyncSqlRecords,
  validateStorageSyncSqlRecord,
} = require("./storageSyncSqlRecords.cjs");

const LOCAL_BACKUP_DATABASE_STREAM_VERSION = 1;
const LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS = 256;
const LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS = 64;
const LOCAL_BACKUP_DATABASE_STREAM_TTL_MS = 60 * 60 * 1000;
const ALLOWED_RECORD_TYPES = new Set([
  "meta",
  "setting",
  "plugin-storage",
  "module",
  "preset",
  "character",
  "chat",
  "branch",
  "active-branch",
  "message",
]);

class LocalBackupDatabaseStreamError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code = "local_backup_database_stream_error",
  ) {
    super(message);
    this.name = "LocalBackupDatabaseStreamError";
    this.code = code;
  }
}

function cloneCounts(counts) {
  return Object.assign(Object.create(null), counts);
}

function serializeSession(session) {
  return {
    id: session.id,
    nextFragmentIndex: session.nextFragmentIndex,
    recordCount: session.recordCount,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}
function validateManifest(manifest, session) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.format !== "risu-portable-database-stream" ||
    manifest.version !== LOCAL_BACKUP_DATABASE_STREAM_VERSION ||
    manifest.complete !== true ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Number.isSafeInteger(manifest.totalFragments) ||
    manifest.totalFragments <= 0 ||
    !Number.isSafeInteger(manifest.totalRecords) ||
    manifest.totalRecords <= 0 ||
    !manifest.counts ||
    typeof manifest.counts !== "object"
  ) {
    throw new LocalBackupDatabaseStreamError(
      "Portable database stream manifest is invalid",
      "invalid_manifest",
    );
  }
  if (session.currentFragmentRecords !== 0) {
    throw new LocalBackupDatabaseStreamError(
      "Portable database stream ended with an incomplete fragment",
      "incomplete_fragment",
    );
  }
  const completedFragments = session.nextFragmentIndex - 1;
  if (
    manifest.totalFragments !== completedFragments ||
    manifest.totalRecords !== session.recordCount
  ) {
    throw new LocalBackupDatabaseStreamError(
      `Portable database stream is incomplete (${completedFragments}/${manifest.totalFragments} fragments, ${session.recordCount}/${manifest.totalRecords} records)`,
      "incomplete_stream",
    );
  }
  if (manifest.revision !== session.validationState.sourceRevision) {
    throw new LocalBackupDatabaseStreamError(
      "Portable database stream revision does not match",
      "revision_mismatch",
    );
  }
  for (const type of ALLOWED_RECORD_TYPES) {
    if ((manifest.counts[type] ?? 0) !== (session.counts[type] ?? 0)) {
      throw new LocalBackupDatabaseStreamError(
        `Portable database stream ${type} count does not match`,
        "record_count_mismatch",
      );
    }
  }
  for (const [type, count] of Object.entries(manifest.counts)) {
    if (!ALLOWED_RECORD_TYPES.has(type) && Number(count) !== 0) {
      throw new LocalBackupDatabaseStreamError(
        `Portable database stream contains unsupported record type '${type}'`,
        "unsupported_record_type",
      );
    }
  }
}
class LocalBackupDatabaseStreamStore {
  private readonly rootPath: string;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, any>();

  constructor(
    rootPath: string,
    options: { ttlMs?: number } = {},
  ) {
    this.rootPath = path.resolve(rootPath);
    this.ttlMs =
      Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
        ? options.ttlMs
        : LOCAL_BACKUP_DATABASE_STREAM_TTL_MS;
  }

  sessionDirectory(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new LocalBackupDatabaseStreamError(
        "Invalid local backup database stream session id",
        "invalid_session",
      );
    }
    return path.join(this.rootPath, id);
  }

  filePath(id) {
    return path.join(this.sessionDirectory(id), "database.ndjson.part");
  }

  async create() {
    await this.cleanupExpired();
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const session = {
      id,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      nextFragmentIndex: 1,
      currentFragmentRecords: 0,
      recordCount: 0,
      counts: Object.create(null),
      validationState: { sourceRevision: null, entityPhase: false },
      writeInProgress: false,
    };
    await fs.promises.mkdir(this.sessionDirectory(id), { recursive: true });
    await fs.promises.writeFile(this.filePath(id), Buffer.alloc(0));
    this.sessions.set(id, session);
    return serializeSession(session);
  }

  require(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new LocalBackupDatabaseStreamError(
        "Local backup database stream session was not found or expired",
        "session_not_found",
      );
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      void fs.promises.rm(this.sessionDirectory(id), {
        recursive: true,
        force: true,
      });
      throw new LocalBackupDatabaseStreamError(
        "Local backup database stream session expired",
        "session_expired",
      );
    }
    return session;
  }
  async appendRecords(id, input) {
    const session = this.require(id);
    if (session.finalizedResult) {
      throw new LocalBackupDatabaseStreamError(
        "Local backup database stream session is already finalized",
        "session_finalized",
      );
    }
    if (session.writeInProgress) {
      throw new LocalBackupDatabaseStreamError(
        "A database stream write is already in progress",
        "write_in_progress",
      );
    }
    const fragmentIndex = Number(input?.fragmentIndex);
    const fragmentComplete = input?.fragmentComplete === true;
    const encodedRecords = input?.records;
    if (
      !Number.isSafeInteger(fragmentIndex) ||
      fragmentIndex !== session.nextFragmentIndex
    ) {
      throw new LocalBackupDatabaseStreamError(
        `Expected database fragment ${session.nextFragmentIndex}`,
        "fragment_order_mismatch",
      );
    }
    if (
      !Array.isArray(encodedRecords) ||
      encodedRecords.length === 0 ||
      encodedRecords.length > LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS
    ) {
      throw new LocalBackupDatabaseStreamError(
        `Each database stream request must contain 1-${LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS} records`,
        "invalid_record_batch",
      );
    }
    if (
      session.currentFragmentRecords + encodedRecords.length >
      LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS
    ) {
      throw new LocalBackupDatabaseStreamError(
        "Portable database fragment contains too many records",
        "fragment_too_large",
      );
    }

    const candidateState = { ...session.validationState };
    const candidateCounts = cloneCounts(session.counts);
    const records = [];
    const lines = [];
    let recordIndex = session.recordCount;
    try {
      for (const encoded of encodedRecords) {
        const record = decodeStorageSyncValue(encoded);
        if (!ALLOWED_RECORD_TYPES.has(record?.type)) {
          throw new LocalBackupDatabaseStreamError(
            `Unsupported portable database record type '${String(record?.type)}'`,
            "unsupported_record_type",
          );
        }
        validateStorageSyncSqlRecord(record, recordIndex, candidateState);
        candidateCounts[record.type] = (candidateCounts[record.type] || 0) + 1;
        records.push(record);
        lines.push(
          Buffer.from(
            `${JSON.stringify(encodeStorageSyncValue(record))}\n`,
            "utf8",
          ),
        );
        recordIndex++;
      }
    } catch (error) {
      if (error instanceof LocalBackupDatabaseStreamError) throw error;
      if (error instanceof StorageSyncSqlRecordError) {
        throw new LocalBackupDatabaseStreamError(error.message, error.code);
      }
      throw new LocalBackupDatabaseStreamError(
        error?.message || String(error),
        "invalid_record",
      );
    }

    session.writeInProgress = true;
    try {
      await fs.promises.appendFile(this.filePath(id), Buffer.concat(lines));
      session.validationState = candidateState;
      session.counts = candidateCounts;
      session.recordCount += records.length;
      session.currentFragmentRecords += records.length;
      if (fragmentComplete) {
        session.nextFragmentIndex++;
        session.currentFragmentRecords = 0;
      }
      session.expiresAt = Date.now() + this.ttlMs;
      return serializeSession(session);
    } finally {
      session.writeInProgress = false;
    }
  }
  getFinalizedResult(id: string): unknown | null {
    return this.require(id).finalizedResult ?? null;
  }

  async markFinalized(id: string, result: unknown): Promise<void> {
    const session = this.require(id);
    session.finalizedResult = result;
    session.expiresAt = Date.now() + this.ttlMs;
    await fs.promises.rm(this.sessionDirectory(id), {
      recursive: true,
      force: true,
    });
  }

  prepareFinalize(id, manifest) {
    const session = this.require(id);
    if (session.finalizedResult) {
      throw new LocalBackupDatabaseStreamError(
        "Local backup database stream session is already finalized",
        "session_finalized",
      );
    }
    if (session.writeInProgress) {
      throw new LocalBackupDatabaseStreamError(
        "Database stream write is still in progress",
        "write_in_progress",
      );
    }
    validateManifest(manifest, session);
    return {
      session,
      sourceRevision: manifest.revision,
      recordCount: manifest.totalRecords,
      counts: { ...session.counts },
      sqlStaging: {
        validate: async (
          _syncSession: unknown,
          options: { onRecord?: (record: unknown, index: number) => Promise<void> } = {},
        ) =>
          await readStorageSyncSqlRecords(this.filePath(id), {
            expectedRecordCount: manifest.totalRecords,
            expectedSourceRevision: manifest.revision,
            onRecord: options.onRecord,
          }),
      },
    };
  }

  async cleanup(id) {
    this.sessions.delete(id);
    await fs.promises.rm(this.sessionDirectory(id), {
      recursive: true,
      force: true,
    });
  }

  async cleanupExpired() {
    const now = Date.now();
    const expired = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) expired.push(id);
    }
    await Promise.all(expired.map((id) => this.cleanup(id)));
  }
}

module.exports = {
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS,
  LocalBackupDatabaseStreamError,
  LocalBackupDatabaseStreamStore,
};
