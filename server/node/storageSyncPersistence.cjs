"use strict";

const fs = require("fs");
const path = require("path");

const STORAGE_SYNC_SESSION_FILE_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeFinalizedResult(value) {
  if (!value || typeof value !== "object" || value.status !== "completed") return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isNonNegativeSafeInteger(value.sourceRevision)) return null;
  if (!isNonNegativeSafeInteger(value.recordCount)) return null;
  if (typeof value.recoveryId !== "string" || !SESSION_ID_PATTERN.test(value.recoveryId)) return null;
  return value;
}

function normalizeStoredSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== STORAGE_SYNC_SESSION_FILE_VERSION) return null;
  if (typeof raw.id !== "string" || !SESSION_ID_PATTERN.test(raw.id))
    return null;
  if (!["local-to-remote", "remote-to-local"].includes(raw.direction))
    return null;
  const expectedRole =
    raw.direction === "local-to-remote" ? "target" : "source";
  if (raw.role !== expectedRole) return null;
  if (!isNonNegativeSafeInteger(raw.serverRevision)) return null;
  if (raw.peerRevision !== null && !isNonNegativeSafeInteger(raw.peerRevision))
    return null;
  if (
    !isNonNegativeSafeInteger(raw.createdAt) ||
    !isNonNegativeSafeInteger(raw.expiresAt)
  )
    return null;
  if (
    !isNonNegativeSafeInteger(raw.chunkSizeBytes) ||
    !isNonNegativeSafeInteger(raw.maxConcurrency)
  )
    return null;
  if (!raw.summary || Number(raw.summary.revision) !== raw.serverRevision)
    return null;
  const finalizedResult = normalizeFinalizedResult(raw.finalizedResult);
  const finalized = raw.status === "finalized" && finalizedResult !== null;
  return {
    id: raw.id,
    direction: raw.direction,
    role: raw.role,
    status: finalized ? "finalized" : "created",
    serverRevision: raw.serverRevision,
    peerRevision: raw.peerRevision,
    summary: raw.summary,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    chunkSizeBytes: raw.chunkSizeBytes,
    maxConcurrency: raw.maxConcurrency,
    ...(finalized ? { finalizedResult } : { needsHydration: true }),
  };
}

function serializeSessionBase(session) {
  return {
    version: STORAGE_SYNC_SESSION_FILE_VERSION,
    id: session.id,
    direction: session.direction,
    role: session.role,
    serverRevision: session.serverRevision,
    peerRevision: session.peerRevision ?? null,
    summary: session.summary,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    chunkSizeBytes: session.chunkSizeBytes,
    maxConcurrency: session.maxConcurrency,
    ...(session.status === "finalized" && session.finalizedResult
      ? { status: "finalized", finalizedResult: session.finalizedResult }
      : {}),
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf8");
  fs.renameSync(tempPath, filePath);
}

class StorageSyncSessionPersistence {
  constructor(rootPath, now = () => Date.now()) {
    this.rootPath = path.resolve(rootPath);
    this.now = now;
  }

  sessionDirectory(id) {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error("Invalid storage sync session id");
    }
    return path.join(this.rootPath, id);
  }

  metadataPath(id) {
    return path.join(this.sessionDirectory(id), "session.json");
  }

  saveBase(session) {
    writeJsonAtomic(
      this.metadataPath(session.id),
      serializeSessionBase(session),
    );
  }

  cleanup(id) {
    fs.rmSync(this.sessionDirectory(id), { recursive: true, force: true });
  }

  loadActiveSessions() {
    fs.mkdirSync(this.rootPath, { recursive: true });
    const sessions = [];
    for (const entry of fs.readdirSync(this.rootPath, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name))
        continue;
      const metadataPath = this.metadataPath(entry.name);
      let session = null;
      try {
        session = normalizeStoredSession(
          JSON.parse(fs.readFileSync(metadataPath, "utf8")),
        );
      } catch {}
      if (!session || session.expiresAt <= this.now()) {
        this.cleanup(entry.name);
        continue;
      }
      sessions.push(session);
    }
    return sessions;
  }
}

module.exports = {
  STORAGE_SYNC_SESSION_FILE_VERSION,
  StorageSyncSessionPersistence,
  normalizeFinalizedResult,
  normalizeStoredSession,
  serializeSessionBase,
  writeJsonAtomic,
};
