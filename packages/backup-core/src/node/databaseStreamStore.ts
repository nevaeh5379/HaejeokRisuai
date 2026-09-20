import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { LocalBackupDatabaseStreamSession } from "../api";
import {
  parsePortableDatabaseStreamManifest,
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
} from "../streamFormat";

export const LOCAL_BACKUP_DATABASE_STREAM_VERSION = 1;
/**
 * Compatibility alias of the canonical streamed-fragment record bound in
 * streamFormat.ts, so Node export/import/session validation always consume
 * the same value as the frontend and the aggregate collector.
 */
export const LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS =
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS;
export const LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS = 64;
export const LOCAL_BACKUP_DATABASE_STREAM_TTL_MS = 60 * 60 * 1000;

export const LOCAL_BACKUP_DATABASE_RECORD_TYPES = [
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
] as const;

export type LocalBackupDatabaseRecordType =
  (typeof LOCAL_BACKUP_DATABASE_RECORD_TYPES)[number];

export interface LocalBackupDatabaseStreamManifest {
  format: "risu-portable-database-stream";
  version: 1;
  revision: number;
  complete: true;
  totalFragments: number;
  totalRecords: number;
  counts: Record<string, number | undefined>;
}

export interface LocalBackupDatabaseStreamRecord {
  type: string;
}

export interface LocalBackupDatabaseStreamRecordAdapter<
  TRecord extends LocalBackupDatabaseStreamRecord,
  TState,
> {
  createValidationState(): TState;
  cloneValidationState(state: TState): TState;
  decodeRecord(value: unknown): TRecord;
  encodeRecord(record: TRecord): unknown;
  validateRecord(record: TRecord, index: number, state: TState): void;
  getSourceRevision(state: TState): number | null;
}

export interface LocalBackupDatabaseStreamPrepared {
  id: string;
  filePath: string;
  sourceRevision: number;
  recordCount: number;
  counts: Record<string, number>;
}

interface InternalSession<TState> {
  id: string;
  createdAt: number;
  expiresAt: number;
  nextFragmentIndex: number;
  currentFragmentRecords: number;
  recordCount: number;
  counts: Record<string, number>;
  validationState: TState;
  writeInProgress: boolean;
  finalizedResult?: unknown;
}

export class LocalBackupDatabaseStreamError extends Error {
  constructor(
    message: string,
    readonly code = "local_backup_database_stream_error",
  ) {
    super(message);
    this.name = "LocalBackupDatabaseStreamError";
  }
}

function cloneCounts(counts: Record<string, number>): Record<string, number> {
  return { ...counts };
}

function serializeSession<TState>(
  session: InternalSession<TState>,
): LocalBackupDatabaseStreamSession {
  return {
    id: session.id,
    nextFragmentIndex: session.nextFragmentIndex,
    recordCount: session.recordCount,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function isAllowedRecordType(type: string): type is LocalBackupDatabaseRecordType {
  return (LOCAL_BACKUP_DATABASE_RECORD_TYPES as readonly string[]).includes(
    type,
  );
}

export class LocalBackupDatabaseStreamStore<
  TRecord extends LocalBackupDatabaseStreamRecord,
  TState,
> {
  private readonly rootPath: string;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, InternalSession<TState>>();

  constructor(
    rootPath: string,
    private readonly adapter: LocalBackupDatabaseStreamRecordAdapter<
      TRecord,
      TState
    >,
    options: { ttlMs?: number } = {},
  ) {
    this.rootPath = resolve(rootPath);
    this.ttlMs =
      Number.isSafeInteger(options.ttlMs) && Number(options.ttlMs) > 0
        ? Number(options.ttlMs)
        : LOCAL_BACKUP_DATABASE_STREAM_TTL_MS;
  }

  private sessionDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new LocalBackupDatabaseStreamError(
        "Invalid local backup database stream session id",
        "invalid_session",
      );
    }
    return join(this.rootPath, id);
  }

  private filePath(id: string): string {
    return join(this.sessionDirectory(id), "database.ndjson.part");
  }

  async create(): Promise<LocalBackupDatabaseStreamSession> {
    await this.cleanupExpired();
    const id = randomUUID();
    const createdAt = Date.now();
    const session: InternalSession<TState> = {
      id,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      nextFragmentIndex: 1,
      currentFragmentRecords: 0,
      recordCount: 0,
      counts: {},
      validationState: this.adapter.createValidationState(),
      writeInProgress: false,
    };
    await fs.mkdir(this.sessionDirectory(id), { recursive: true });
    await fs.writeFile(this.filePath(id), new Uint8Array());
    this.sessions.set(id, session);
    return serializeSession(session);
  }

  private require(id: string): InternalSession<TState> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new LocalBackupDatabaseStreamError(
        "Local backup database stream session was not found or expired",
        "session_not_found",
      );
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      void fs.rm(this.sessionDirectory(id), {
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

  async appendRecords(
    id: string,
    input: {
      fragmentIndex?: unknown;
      records?: unknown;
      fragmentComplete?: unknown;
    },
  ): Promise<LocalBackupDatabaseStreamSession> {
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

    const candidateState = this.adapter.cloneValidationState(
      session.validationState,
    );
    const candidateCounts = cloneCounts(session.counts);
    const lines: string[] = [];
    let recordIndex = session.recordCount;

    try {
      for (const encoded of encodedRecords) {
        const record = this.adapter.decodeRecord(encoded);
        if (!isAllowedRecordType(record?.type)) {
          throw new LocalBackupDatabaseStreamError(
            `Unsupported portable database record type '${String(record?.type)}'`,
            "unsupported_record_type",
          );
        }
        this.adapter.validateRecord(record, recordIndex, candidateState);
        candidateCounts[record.type] =
          (candidateCounts[record.type] ?? 0) + 1;
        lines.push(
          `${JSON.stringify(this.adapter.encodeRecord(record))}\n`,
        );
        recordIndex++;
      }
    } catch (error) {
      if (error instanceof LocalBackupDatabaseStreamError) throw error;
      throw new LocalBackupDatabaseStreamError(
        error instanceof Error ? error.message : String(error),
        (error as { code?: string } | null)?.code ?? "invalid_record",
      );
    }

    session.writeInProgress = true;
    try {
      await fs.appendFile(this.filePath(id), lines.join(""), "utf8");
      session.validationState = candidateState;
      session.counts = candidateCounts;
      session.recordCount += encodedRecords.length;
      session.currentFragmentRecords += encodedRecords.length;
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
    await fs.rm(this.sessionDirectory(id), {
      recursive: true,
      force: true,
    });
  }

  prepareFinalize(
    id: string,
    manifest: unknown,
  ): LocalBackupDatabaseStreamPrepared {
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

    this.validateManifest(manifest, session);
    const typedManifest = manifest as LocalBackupDatabaseStreamManifest;
    return {
      id,
      filePath: this.filePath(id),
      sourceRevision: typedManifest.revision,
      recordCount: typedManifest.totalRecords,
      counts: cloneCounts(session.counts),
    };
  }

  private validateManifest(
    manifest: unknown,
    session: InternalSession<TState>,
  ): asserts manifest is LocalBackupDatabaseStreamManifest {
    const value = manifest as Partial<LocalBackupDatabaseStreamManifest> | null;
    const parsed = parsePortableDatabaseStreamManifest(value);
    if (!parsed) {
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
      parsed.totalFragments !== completedFragments ||
      parsed.totalRecords !== session.recordCount
    ) {
      throw new LocalBackupDatabaseStreamError(
        `Portable database stream is incomplete (${completedFragments}/${parsed.totalFragments} fragments, ${session.recordCount}/${parsed.totalRecords} records)`,
        "incomplete_stream",
      );
    }
    if (
      parsed.revision !==
      this.adapter.getSourceRevision(session.validationState)
    ) {
      throw new LocalBackupDatabaseStreamError(
        "Portable database stream revision does not match",
        "revision_mismatch",
      );
    }
    for (const type of LOCAL_BACKUP_DATABASE_RECORD_TYPES) {
      if ((parsed.counts[type] ?? 0) !== (session.counts[type] ?? 0)) {
        throw new LocalBackupDatabaseStreamError(
          `Portable database stream ${type} count does not match`,
          "record_count_mismatch",
        );
      }
    }
    for (const [type, count] of Object.entries(parsed.counts)) {
      if (!isAllowedRecordType(type) && Number(count) !== 0) {
        throw new LocalBackupDatabaseStreamError(
          `Portable database stream contains unsupported record type '${type}'`,
          "unsupported_record_type",
        );
      }
    }
  }

  async cleanup(id: string): Promise<void> {
    this.sessions.delete(id);
    await fs.rm(this.sessionDirectory(id), {
      recursive: true,
      force: true,
    });
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) expired.push(id);
    }
    await Promise.all(expired.map((id) => this.cleanup(id)));
  }
}
