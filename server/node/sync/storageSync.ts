import { randomBytes } from "node:crypto";
("use strict");

const STORAGE_SYNC_PROTOCOL_VERSION: any = 1;

function normalizeNonNegativeInteger(value?: any): any {
  const numeric: any = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

async function createStorageSyncSummary(
  sqlStorage?: any,
  assetStorage?: any,
): Promise<any> {
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
  const records: any = database?.records || {};
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

const STORAGE_SYNC_CHUNK_SIZE_BYTES: any = 4 * 1024 * 1024;
const STORAGE_SYNC_MAX_CONCURRENCY: any = 2;
const STORAGE_SYNC_SESSION_TTL_MS: any = 6 * 60 * 60 * 1000;
const STORAGE_SYNC_DIRECTIONS: any = new Set([
  "local-to-remote",
  "remote-to-local",
]);

class StorageSyncValidationError extends Error {
  [key: string]: any;

  constructor(message?: any) {
    super(message);
    this.name = "StorageSyncValidationError";
  }
}

class StorageSyncRevisionConflictError extends Error {
  [key: string]: any;

  constructor(currentRevision?: any) {
    super(`Storage revision changed to ${currentRevision}`);
    this.name = "StorageSyncRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

class StorageSyncSessionManager {
  [key: string]: any;

  constructor(options: any = {}) {
    this.sessions = new Map();
    this.randomId =
      options.randomId || (() => randomBytes(24).toString("base64url"));
    this.now = options.now || (() => Date.now());
    this.onCreate = options.onCreate || (() => {});
    this.onExpire = options.onExpire || (() => {});
    for (const session of options.initialSessions || []) {
      if (session?.id && session.expiresAt > this.now()) {
        this.sessions.set(session.id, session);
      }
    }
  }

  prune(): any {
    const now: any = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        this.onExpire(id, session);
      }
    }
  }

  create({
    direction,
    expectedRevision,
    peerRevision = null,
    summary,
  }: any): any {
    this.prune();
    if (!STORAGE_SYNC_DIRECTIONS.has(direction)) {
      throw new StorageSyncValidationError("Invalid storage sync direction");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StorageSyncValidationError(
        "expectedRevision must be a non-negative integer",
      );
    }
    if (summary.revision !== expectedRevision) {
      throw new StorageSyncRevisionConflictError(summary.revision);
    }
    if (
      peerRevision !== null &&
      (!Number.isSafeInteger(peerRevision) || peerRevision < 0)
    ) {
      throw new StorageSyncValidationError(
        "peerRevision must be null or a non-negative integer",
      );
    }
    const id: any = this.randomId();
    const createdAt: any = this.now();
    const session: any = {
      id,
      direction,
      role: direction === "local-to-remote" ? "target" : "source",
      status: "created",
      serverRevision: summary.revision,
      peerRevision,
      summary,
      createdAt,
      expiresAt: createdAt + STORAGE_SYNC_SESSION_TTL_MS,
      chunkSizeBytes: STORAGE_SYNC_CHUNK_SIZE_BYTES,
      maxConcurrency: STORAGE_SYNC_MAX_CONCURRENCY,
    };
    this.sessions.set(id, session);
    try {
      this.onCreate(session);
    } catch (error: any) {
      this.sessions.delete(id);
      throw error;
    }
    return session;
  }

  get(id?: any): any {
    this.prune();
    return this.sessions.get(id) || null;
  }

  cancel(id?: any): any {
    const session: any = this.get(id);
    if (!session) return null;
    session.status = "cancelled";
    this.sessions.delete(id);
    return session;
  }
}

export {
  STORAGE_SYNC_PROTOCOL_VERSION,
  STORAGE_SYNC_CHUNK_SIZE_BYTES,
  STORAGE_SYNC_MAX_CONCURRENCY,
  STORAGE_SYNC_SESSION_TTL_MS,
  StorageSyncValidationError,
  StorageSyncRevisionConflictError,
  StorageSyncSessionManager,
  createStorageSyncSummary,
};
