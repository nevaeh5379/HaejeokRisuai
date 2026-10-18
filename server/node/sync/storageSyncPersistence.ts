"use strict";

import * as fs from "fs";
import * as path from "path";

const STORAGE_SYNC_SESSION_FILE_VERSION: any = 1;
const SESSION_ID_PATTERN: any = /^[A-Za-z0-9_-]{1,128}$/;

function isNonNegativeSafeInteger(value?: any): any {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeFinalizedResult(value?: any): any {
  if (!value || typeof value !== "object" || value.status !== "completed")
    return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isNonNegativeSafeInteger(value.sourceRevision)) return null;
  if (!isNonNegativeSafeInteger(value.recordCount)) return null;
  if (
    typeof value.recoveryId !== "string" ||
    !SESSION_ID_PATTERN.test(value.recoveryId)
  )
    return null;
  return value;
}

function normalizeStoredSession(raw?: any): any {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== STORAGE_SYNC_SESSION_FILE_VERSION) return null;
  if (typeof raw.id !== "string" || !SESSION_ID_PATTERN.test(raw.id))
    return null;
  if (!["local-to-remote", "remote-to-local"].includes(raw.direction))
    return null;
  const expectedRole: any =
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
  const finalizedResult: any = normalizeFinalizedResult(raw.finalizedResult);
  const finalized: any = raw.status === "finalized" && finalizedResult !== null;
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

function serializeSessionBase(session?: any): any {
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

function writeJsonAtomic(filePath?: any, value?: any): any {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath: any = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf8");
  fs.renameSync(tempPath, filePath);
}

class StorageSyncSessionPersistence {
  [key: string]: any;

  constructor(rootPath?: any, now: any = () => Date.now()) {
    this.rootPath = path.resolve(rootPath);
    this.now = now;
  }

  sessionDirectory(id?: any): any {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error("Invalid storage sync session id");
    }
    return path.join(this.rootPath, id);
  }

  metadataPath(id?: any): any {
    return path.join(this.sessionDirectory(id), "session.json");
  }

  saveBase(session?: any): any {
    writeJsonAtomic(
      this.metadataPath(session.id),
      serializeSessionBase(session),
    );
  }

  cleanup(id?: any): any {
    fs.rmSync(this.sessionDirectory(id), { recursive: true, force: true });
  }

  loadActiveSessions(): any {
    fs.mkdirSync(this.rootPath, { recursive: true });
    const sessions: any = [];
    for (const entry of fs.readdirSync(this.rootPath, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name))
        continue;
      const metadataPath: any = this.metadataPath(entry.name);
      let session: any = null;
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

export {
  STORAGE_SYNC_SESSION_FILE_VERSION,
  StorageSyncSessionPersistence,
  normalizeFinalizedResult,
  normalizeStoredSession,
  serializeSessionBase,
  writeJsonAtomic,
};
