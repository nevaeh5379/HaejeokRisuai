import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  LocalBackupImportJobCreated,
  LocalBackupImportJobCompletion,
  LocalBackupImportJobProgress,
  LocalBackupImportProgress,
  LocalBackupImportUploadState,
} from "../api";
import {
  getColdStorageBackupKey,
  isColdStorageBackupData,
} from "../coldStorage";
import { normalizeBackupAssetPath } from "../entryPolicy";
import { decodeInlayAssetBackup } from "../inlayCodec";
import {
  iterateLegacyBackupSqlRecords,
  type LegacyBackupSqlRecord,
} from "../legacyRecords";
import {
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamFragmentName,
  parsePortableDatabaseStreamManifest,
  PORTABLE_DATABASE_STREAM_MANIFEST,
  type PortableDatabaseStreamManifest,
} from "../streamFormat";
import { decodeLegacyBackupDatabase } from "./legacyFormat";
import {
  LocalBackupImportJobError,
  LocalBackupImportJobStore,
} from "./importJobStore";
import {
  BACKUP_IMPORT_MAX_LEGACY_DATABASE_ENTRY_BYTES,
  BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES,
  BackupImportStagingStore,
  type BackupImportEntryWriter,
  type BackupImportStreamSession,
  type BufferedBackupEntry,
  type StreamedBackupEntry,
} from "./importStagingStore";
import {
  BackupImportUploadError,
  BackupImportUploadStore,
} from "./importUploadStore";

const DATABASE_STAGE_BATCH_RECORDS = 64;
const MAX_INLAY_METADATA_BYTES = 1024 * 1024;
const DEFAULT_IMPORT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_IMPORTS = 1;

export interface LocalBackupImportRestoreResult {
  revision?: number;
  recordCount?: number;
}

export interface LocalBackupImportPreparedState {
  sourceRevision: number;
  databaseRecordCount: number;
}

export interface LocalBackupImportFinalizeProgress {
  phase: "applying" | "committing";
  current: number;
  total: number;
  detail?: string;
}

export interface LocalBackupImportRestoreSession {
  stageDatabaseRecords(
    records: readonly LegacyBackupSqlRecord[],
  ): Promise<void>;
  stageColdStorage(key: string, value: unknown): Promise<void>;
  openAsset(key: string, size: number): Promise<BackupImportEntryWriter>;
  complete(
    prepared: LocalBackupImportPreparedState,
    sourceClientId: unknown,
    onProgress?: (progress: LocalBackupImportFinalizeProgress) => void,
  ): Promise<LocalBackupImportRestoreResult>;
  abort(): Promise<void>;
}

export interface LocalBackupImportAdapter {
  beginRestore(id: string): Promise<LocalBackupImportRestoreSession>;
}

export interface LocalBackupImportRequestOptions {
  totalBytes?: number;
  sourceClientId?: unknown;
}

interface DatabaseImportState {
  mode: "unknown" | "legacy" | "stream";
  expectedFragmentIndex: number;
  recordCount: number;
  counts: Record<string, number>;
  sourceRevision: number | null;
  manifest: PortableDatabaseStreamManifest | null;
}

interface ActiveImport {
  restore: LocalBackupImportRestoreSession;
  parser: BackupImportStreamSession;
  database: DatabaseImportState;
  sourceKind: "direct" | "chunked";
  finalizing: boolean;
}

function requireDatabaseObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function supportedDatabaseRecord(
  record: unknown,
): record is LegacyBackupSqlRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  return [
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
  ].includes(String((record as { type?: unknown }).type));
}

function validatingInlayWriter(
  destination: BackupImportEntryWriter,
  expectedSize: number,
): BackupImportEntryWriter {
  const prefixChunks: Uint8Array[] = [];
  let prefixBytes = 0;
  let requiredPrefixBytes: number | null = null;
  let validated = false;
  let failed = false;

  const inspect = (): void => {
    if (validated || prefixBytes < 4) return;
    const prefix = Buffer.concat(
      prefixChunks.map((chunk) => Buffer.from(chunk)),
      prefixBytes,
    );
    if (requiredPrefixBytes === null) {
      const metadataBytes = prefix.readUInt32LE(0);
      if (
        metadataBytes === 0 ||
        metadataBytes > MAX_INLAY_METADATA_BYTES ||
        4 + metadataBytes > expectedSize
      ) {
        throw new Error("Invalid inlay backup metadata length");
      }
      requiredPrefixBytes = 4 + metadataBytes;
    }
    if (prefixBytes >= requiredPrefixBytes) {
      decodeInlayAssetBackup(
        new Uint8Array(prefix.subarray(0, requiredPrefixBytes)),
      );
      validated = true;
      prefixChunks.length = 0;
    }
  };

  return {
    async write(chunk): Promise<void> {
      if (failed) throw new Error("Inlay restore writer has failed");
      try {
        if (!validated) {
          const captureLimit = requiredPrefixBytes ?? 4;
          const captureBytes = Math.min(
            chunk.byteLength,
            Math.max(0, captureLimit - prefixBytes),
          );
          if (captureBytes > 0) {
            prefixChunks.push(chunk.slice(0, captureBytes));
            prefixBytes += captureBytes;
          }
          inspect();
          if (!validated && requiredPrefixBytes !== null) {
            const remaining = requiredPrefixBytes - prefixBytes;
            const alreadyCaptured = captureBytes;
            const additional = Math.min(
              Math.max(0, chunk.byteLength - alreadyCaptured),
              remaining,
            );
            if (additional > 0) {
              prefixChunks.push(
                chunk.slice(alreadyCaptured, alreadyCaptured + additional),
              );
              prefixBytes += additional;
              inspect();
            }
          }
        }
        await destination.write(chunk);
      } catch (error) {
        failed = true;
        await destination.abort().catch(() => {});
        throw error;
      }
    },
    async close(): Promise<void> {
      try {
        inspect();
        if (!validated) throw new Error("Incomplete inlay backup metadata");
        await destination.close();
      } catch (error) {
        failed = true;
        await destination.abort().catch(() => {});
        throw error;
      }
    },
    async abort(): Promise<void> {
      failed = true;
      await destination.abort();
    },
  };
}

export class LocalBackupImportService {
  private readonly active = new Map<string, Promise<ActiveImport>>();
  private readonly finalizations = new Map<
    string,
    Promise<LocalBackupImportJobCompletion>
  >();
  private readonly idleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly idleTimeoutMs: number;
  private readonly maxActiveImports: number;

  constructor(
    readonly jobs: LocalBackupImportJobStore,
    readonly staging: BackupImportStagingStore,
    private readonly adapter: LocalBackupImportAdapter,
    readonly uploads?: BackupImportUploadStore,
    options: { idleTimeoutMs?: number; maxActiveImports?: number } = {},
  ) {
    this.idleTimeoutMs =
      options.idleTimeoutMs ?? DEFAULT_IMPORT_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) {
      throw new TypeError("Local backup import idle timeout must be positive");
    }
    this.maxActiveImports =
      options.maxActiveImports ?? DEFAULT_MAX_ACTIVE_IMPORTS;
    if (
      !Number.isSafeInteger(this.maxActiveImports) ||
      this.maxActiveImports <= 0
    ) {
      throw new TypeError("Local backup active import limit must be positive");
    }
  }

  createJob(): LocalBackupImportJobCreated {
    return this.jobs.create();
  }

  authorizeDirectUpload(id: string, uploadToken: string): boolean {
    return this.jobs.authorizeDirectUpload(id, uploadToken);
  }

  progress(id: string): LocalBackupImportJobProgress {
    return this.jobs.progress(id);
  }

  hasActiveImports(): boolean {
    return this.active.size > 0 || this.finalizations.size > 0;
  }

  async wait(id: string): Promise<LocalBackupImportJobCompletion> {
    return await this.jobs.wait(id);
  }

  remove(id: string): void {
    this.clearIdleTimer(id);
    this.jobs.remove(id);
  }

  private clearIdleTimer(id: string): void {
    const timer = this.idleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(id);
  }

  private armIdleTimer(id: string): void {
    this.clearIdleTimer(id);
    const timer = setTimeout(() => {
      void this.expireIdleImport(id);
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(id, timer);
  }

  private async expireIdleImport(id: string): Promise<void> {
    this.clearIdleTimer(id);
    await this.uploads?.cleanup(id).catch(() => {});
    await this.abortActive(id);
    await this.staging.cleanup(id).catch(() => {});
    this.jobs.remove(id);
  }

  private update(
    id: string,
    stage: LocalBackupImportProgress["stage"],
    current: number,
    total: number,
    detail?: string,
  ): void {
    this.jobs.updateProgress(id, {
      stage,
      current: Math.max(0, current),
      total: Math.max(0, total),
      ...(detail ? { detail } : {}),
    });
  }

  private async stageRecords(
    id: string,
    active: ActiveImport,
    records: readonly LegacyBackupSqlRecord[],
    detail: string,
  ): Promise<void> {
    const baseRecordCount = active.database.recordCount - records.length;
    for (
      let offset = 0;
      offset < records.length;
      offset += DATABASE_STAGE_BATCH_RECORDS
    ) {
      const batch = records.slice(
        offset,
        offset + DATABASE_STAGE_BATCH_RECORDS,
      );
      await active.restore.stageDatabaseRecords(batch);
      this.update(
        id,
        "database",
        baseRecordCount + Math.min(records.length, offset + batch.length),
        0,
        detail,
      );
    }
  }

  private acceptDatabaseRecords(
    state: DatabaseImportState,
    records: readonly LegacyBackupSqlRecord[],
  ): void {
    let recordCount = state.recordCount;
    let sourceRevision = state.sourceRevision;
    const counts = { ...state.counts };
    for (const record of records) {
      if (!supportedDatabaseRecord(record)) {
        throw new Error(
          "Portable database fragment contains an unsupported record",
        );
      }
      if (recordCount === 0) {
        if (
          record.type !== "meta" ||
          record.formatVersion !== 1 ||
          !Number.isSafeInteger(record.revision) ||
          record.revision < 0
        ) {
          throw new Error(
            "Portable database stream must begin with valid metadata",
          );
        }
        sourceRevision = record.revision;
      } else if (record.type === "meta") {
        throw new Error("Portable database stream contains duplicate metadata");
      }
      counts[record.type] = (counts[record.type] ?? 0) + 1;
      recordCount++;
    }
    state.recordCount = recordCount;
    state.sourceRevision = sourceRevision;
    state.counts = counts;
  }

  private async stageLegacyDatabase(
    id: string,
    active: ActiveImport,
    entry: BufferedBackupEntry,
  ): Promise<void> {
    if (active.database.mode !== "unknown") {
      throw new Error("Backup mixes or duplicates database formats");
    }
    active.database.mode = "legacy";
    const decoded = requireDatabaseObject(
      decodeLegacyBackupDatabase(
        new Uint8Array(await fs.readFile(entry.filePath)),
        {
          maxOutputBytes: BACKUP_IMPORT_MAX_LEGACY_DATABASE_ENTRY_BYTES * 2,
        },
      ),
      "Legacy backup database",
    );
    const batch: LegacyBackupSqlRecord[] = [];
    for (const record of iterateLegacyBackupSqlRecords(decoded, {
      sourceRevision: 0,
      idFactory: randomUUID,
    })) {
      batch.push(record);
      if (batch.length >= DATABASE_STAGE_BATCH_RECORDS) {
        this.acceptDatabaseRecords(active.database, batch);
        await active.restore.stageDatabaseRecords(batch);
        batch.length = 0;
        this.update(
          id,
          "database",
          active.database.recordCount,
          0,
          "Preparing legacy database",
        );
      }
    }
    if (batch.length > 0) {
      this.acceptDatabaseRecords(active.database, batch);
      await active.restore.stageDatabaseRecords(batch);
    }
  }

  private async stageDatabaseStreamEntry(
    id: string,
    active: ActiveImport,
    entry: BufferedBackupEntry,
  ): Promise<void> {
    if (active.database.mode === "legacy") {
      throw new Error("Backup mixes legacy and streaming database formats");
    }
    active.database.mode = "stream";
    const decoded = decodeLegacyBackupDatabase(
      new Uint8Array(await fs.readFile(entry.filePath)),
      { maxOutputBytes: BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES * 2 },
    );

    if (entry.name === PORTABLE_DATABASE_STREAM_MANIFEST) {
      if (active.database.manifest) {
        throw new Error("Backup contains more than one streaming manifest");
      }
      const manifest = parsePortableDatabaseStreamManifest(decoded);
      if (!manifest) {
        throw new Error("Portable database stream manifest is invalid");
      }
      active.database.manifest = manifest;
      return;
    }

    if (active.database.manifest) {
      throw new Error("Database stream fragment appears after the manifest");
    }
    const nameIndex = parsePortableDatabaseStreamFragmentName(entry.name);
    if (nameIndex !== active.database.expectedFragmentIndex) {
      throw new Error(
        `Streaming backup fragment order is incomplete; expected ${active.database.expectedFragmentIndex}, got ${String(nameIndex)}`,
      );
    }
    const fragment = parsePortableDatabaseStreamFragment(decoded, {
      expectedIndex: active.database.expectedFragmentIndex,
    });
    if (!fragment) {
      throw new Error(`Invalid portable database fragment: ${entry.name}`);
    }
    const records = fragment.records;
    const before = active.database.recordCount;
    this.acceptDatabaseRecords(active.database, records);
    try {
      await this.stageRecords(id, active, records, entry.name);
    } catch (error) {
      active.database.recordCount = before;
      throw error;
    }
    active.database.expectedFragmentIndex++;
  }

  private async handleBufferedEntry(
    id: string,
    active: ActiveImport,
    entry: BufferedBackupEntry,
  ): Promise<void> {
    switch (entry.kind) {
      case "database":
        await this.stageLegacyDatabase(id, active, entry);
        return;
      case "databaseStream":
        await this.stageDatabaseStreamEntry(id, active, entry);
        return;
      case "coldStorage": {
        const key = getColdStorageBackupKey(entry.name);
        if (!key)
          throw new Error(`Invalid cold storage backup entry '${entry.name}'`);
        const value: unknown = JSON.parse(
          await fs.readFile(entry.filePath, "utf8"),
        );
        if (!isColdStorageBackupData(value)) {
          throw new Error(`Invalid cold storage backup payload: ${entry.name}`);
        }
        await active.restore.stageColdStorage(key, value);
        this.update(id, "coldStorage", 1, 0, entry.name);
        return;
      }
      case "inlay":
        throw new Error("Inlay entries must use the streaming destination");
      case "asset":
        throw new Error("Asset entries must use the streaming destination");
    }
  }

  private validateDatabase(
    state: DatabaseImportState,
  ): LocalBackupImportPreparedState {
    if (state.mode === "unknown" || state.recordCount === 0) {
      throw new Error("Backup does not contain a database entry");
    }
    if (state.sourceRevision === null) {
      throw new Error("Backup database metadata is missing");
    }
    if (state.mode === "legacy") {
      return {
        sourceRevision: state.sourceRevision,
        databaseRecordCount: state.recordCount,
      };
    }

    const manifest = state.manifest;
    if (!manifest) throw new Error("Streaming backup manifest is missing");
    const fragments = state.expectedFragmentIndex - 1;
    if (
      manifest.totalFragments !== fragments ||
      manifest.totalRecords !== state.recordCount ||
      manifest.revision !== state.sourceRevision
    ) {
      throw new Error(
        "Portable database stream manifest does not match its fragments",
      );
    }
    for (const [type, count] of Object.entries(manifest.counts)) {
      if ((state.counts[type] ?? 0) !== Number(count ?? 0)) {
        throw new Error(
          `Portable database stream ${type} count does not match`,
        );
      }
    }
    for (const [type, count] of Object.entries(state.counts)) {
      if (
        (manifest.counts as Record<string, number | undefined>)[type] !== count
      ) {
        throw new Error(
          `Portable database stream ${type} count does not match`,
        );
      }
    }
    return {
      sourceRevision: state.sourceRevision,
      databaseRecordCount: state.recordCount,
    };
  }

  private async createActive(
    id: string,
    totalBytes: number,
    sourceKind: ActiveImport["sourceKind"],
  ): Promise<ActiveImport> {
    const restore = await this.adapter.beginRestore(id);
    const database: DatabaseImportState = {
      mode: "unknown",
      expectedFragmentIndex: 1,
      recordCount: 0,
      counts: {},
      sourceRevision: null,
      manifest: null,
    };
    const shell = { restore, database, sourceKind, finalizing: false } as Omit<
      ActiveImport,
      "parser"
    >;
    try {
      const parser = await this.staging.createSession(
        id,
        {
          onBufferedEntry: async (entry: BufferedBackupEntry): Promise<void> =>
            await this.handleBufferedEntry(id, shell as ActiveImport, entry),
          openAssetEntry: async (
            entry: StreamedBackupEntry,
          ): Promise<BackupImportEntryWriter> => {
            if (entry.kind === "inlay") {
              const destination = await restore.openAsset(
                entry.name,
                entry.size,
              );
              this.update(id, "inlays", entry.index, 0, entry.name);
              return validatingInlayWriter(destination, entry.size);
            }
            const key = normalizeBackupAssetPath(entry.name);
            const destination = await restore.openAsset(key, entry.size);
            this.update(id, "assets", entry.index, 0, entry.name);
            return destination;
          },
          onProgress: (progress): void => {
            const stage = sourceKind === "direct" ? "reading" : "uploading";
            this.update(
              id,
              stage,
              progress.bytesRead,
              progress.totalBytes,
              progress.entryName,
            );
          },
        },
        { totalBytes },
      );
      return { ...shell, parser };
    } catch (error) {
      await restore.abort().catch(() => {});
      throw error;
    }
  }

  private async activeImport(
    id: string,
    totalBytes: number,
    sourceKind: ActiveImport["sourceKind"],
  ): Promise<ActiveImport> {
    let active = this.active.get(id);
    if (!active) {
      if (this.active.size >= this.maxActiveImports) {
        throw new LocalBackupImportJobError(
          "Another local backup import is already active",
        );
      }
      active = this.createActive(id, totalBytes, sourceKind);
      this.active.set(id, active);
    }
    let resolved: ActiveImport;
    try {
      resolved = await active;
    } catch (error) {
      if (this.active.get(id) === active) this.active.delete(id);
      throw error;
    }
    if (resolved.sourceKind !== sourceKind) {
      throw new LocalBackupImportJobError(
        "Local backup import upload mode cannot change after it starts",
      );
    }
    return resolved;
  }

  private async abortActive(id: string): Promise<void> {
    this.clearIdleTimer(id);
    const activePromise = this.active.get(id);
    this.active.delete(id);
    if (!activePromise) return;
    const active = await activePromise.catch(() => null);
    if (!active) return;
    await active.parser.abort().catch(() => {});
    await active.restore.abort().catch(() => {});
  }

  private async completeActive(
    id: string,
    sourceClientId: unknown,
  ): Promise<LocalBackupImportJobCompletion> {
    const activePromise = this.active.get(id);
    if (!activePromise) {
      throw new LocalBackupImportJobError(
        "Local backup import has no active stream",
      );
    }
    const active = await activePromise;
    active.finalizing = true;
    try {
      await active.parser.finish();
      const prepared = this.validateDatabase(active.database);
      const applyTotal = Math.max(1, prepared.databaseRecordCount - 1);
      this.update(id, "database", 0, applyTotal, "Applying prepared database");
      const result = await active.restore.complete(
        prepared,
        sourceClientId,
        (progress): void => {
          this.update(
            id,
            progress.phase === "committing" ? "finalizing" : "database",
            progress.current,
            progress.total,
            progress.detail,
          );
        },
      );
      this.jobs.settle(id, "complete", result);
      return await this.jobs.wait(id);
    } catch (error) {
      await active.parser.abort().catch(() => {});
      await active.restore.abort().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.jobs.settle(id, "error", { error: message });
      } catch {}
      throw error;
    } finally {
      this.clearIdleTimer(id);
      this.active.delete(id);
      await this.staging.cleanup(id).catch(() => {});
    }
  }

  async importStream(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    options: LocalBackupImportRequestOptions = {},
  ): Promise<LocalBackupImportJobCompletion> {
    const totalBytes = Math.max(0, options.totalBytes ?? 0);
    this.jobs.beginUpload(id, totalBytes);
    try {
      const active = await this.activeImport(id, totalBytes, "direct");
      await active.parser.writeAll(chunks);
      this.jobs.markRestoring(id);
      return await this.completeActive(id, options.sourceClientId);
    } catch (error) {
      await this.abortActive(id);
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.jobs.settle(id, "error", { error: message });
      } catch {}
      throw error;
    }
  }

  async appendUploadChunk(
    id: string,
    offset: number,
    chunks: AsyncIterable<Uint8Array>,
    totalBytes: number,
  ): Promise<LocalBackupImportUploadState> {
    if (!this.uploads) {
      throw new Error("Chunked local backup uploads are not configured");
    }
    const status = this.jobs.progress(id).status;
    if (status !== "pending" && status !== "uploading") {
      throw new LocalBackupImportJobError(
        "Local backup import is not accepting upload chunks",
      );
    }
    if (status === "pending") this.jobs.beginUpload(id, totalBytes);
    this.clearIdleTimer(id);

    try {
      const active = await this.activeImport(id, totalBytes, "chunked");
      const state = await this.uploads.append(
        id,
        offset,
        chunks,
        totalBytes,
        async (acceptedChunks): Promise<void> =>
          await active.parser.writeAll(acceptedChunks),
      );
      this.update(id, "uploading", state.receivedBytes, state.totalBytes);
      this.armIdleTimer(id);
      return state;
    } catch (error) {
      if (
        error instanceof BackupImportUploadError ||
        error instanceof LocalBackupImportJobError
      ) {
        this.armIdleTimer(id);
        throw error;
      }
      await this.abortActive(id);
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.jobs.settle(id, "error", { error: message });
      } catch {}
      throw error;
    }
  }

  private async finalizeUploadOnce(
    id: string,
    options: Pick<LocalBackupImportRequestOptions, "sourceClientId"> = {},
  ): Promise<LocalBackupImportJobCompletion> {
    if (!this.uploads) {
      throw new Error("Chunked local backup uploads are not configured");
    }
    const initialStatus = this.jobs.progress(id).status;
    if (
      initialStatus === "restoring" ||
      initialStatus === "complete" ||
      initialStatus === "error"
    ) {
      return await this.jobs.wait(id);
    }
    try {
      await this.uploads.finalize(id);
    } catch (error) {
      if (
        error instanceof BackupImportUploadError &&
        error.code === "upload_finalized"
      ) {
        const status = this.jobs.progress(id).status;
        if (
          status === "restoring" ||
          status === "complete" ||
          status === "error"
        ) {
          return await this.jobs.wait(id);
        }
      }
      this.armIdleTimer(id);
      throw error;
    }
    this.jobs.markRestoring(id);
    try {
      return await this.completeActive(id, options.sourceClientId);
    } finally {
      await this.uploads.cleanup(id).catch(() => {});
    }
  }

  async finalizeUpload(
    id: string,
    options: Pick<LocalBackupImportRequestOptions, "sourceClientId"> = {},
  ): Promise<LocalBackupImportJobCompletion> {
    this.clearIdleTimer(id);
    const existing = this.finalizations.get(id);
    if (existing) return await existing;
    const operation = this.finalizeUploadOnce(id, options);
    this.finalizations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.finalizations.get(id) === operation) {
        this.finalizations.delete(id);
      }
    }
  }

  async cancel(id: string): Promise<void> {
    this.clearIdleTimer(id);
    await this.uploads?.cleanup(id).catch(() => {});
    const active = await this.active.get(id)?.catch(() => null);
    if (active?.finalizing) {
      await this.jobs.wait(id).catch(() => {});
      this.jobs.remove(id);
      return;
    }
    await this.abortActive(id);
    await this.staging.cleanup(id).catch(() => {});
    this.jobs.remove(id);
  }
}
