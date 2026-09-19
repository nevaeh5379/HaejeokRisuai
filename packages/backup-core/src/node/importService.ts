import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  LocalBackupImportJobCompletion,
  LocalBackupImportJobProgress,
  LocalBackupImportProgress,
  LocalBackupImportUploadState,
} from "../api";
import { isColdStorageBackupData } from "../coldStorage";
import {
  getColdStorageBackupKey,
  normalizeBackupAssetPath,
} from "../entryPolicy";
import { decodeInlayAssetBackup } from "../inlayCodec";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import {
  prepareLocalBackupDatabaseImport,
  type PreparedLocalBackupDatabase,
} from "./importDatabase";
import { buildBackupImportPlan } from "./importPlan";
import {
  LocalBackupImportJobError,
  LocalBackupImportJobStore,
} from "./importJobStore";
import {
  BackupImportStagingStore,
  type StagedBackupEntry,
} from "./importStagingStore";
import { BackupImportUploadStore } from "./importUploadStore";

export interface LocalBackupImportRestoreResult {
  revision?: number;
  recordCount?: number;
}

export interface LocalBackupImportAdapter {
  writeColdStorage(key: string, value: unknown): Promise<void>;
  writeAsset(key: string, filePath: string, size: number): Promise<void>;
  encodeDatabaseRecord(record: LegacyBackupSqlRecord): unknown;
  applyPreparedDatabase(
    prepared: PreparedLocalBackupDatabase,
    sourceClientId: unknown,
  ): Promise<LocalBackupImportRestoreResult>;
}

export interface LocalBackupImportRequestOptions {
  totalBytes?: number;
  sourceClientId?: unknown;
}

export class LocalBackupImportService {
  constructor(
    readonly jobs: LocalBackupImportJobStore,
    readonly staging: BackupImportStagingStore,
    private readonly adapter: LocalBackupImportAdapter,
    readonly uploads?: BackupImportUploadStore,
  ) {}

  createJob(): { id: string } {
    return this.jobs.create();
  }

  progress(id: string): LocalBackupImportJobProgress {
    return this.jobs.progress(id);
  }

  async wait(id: string): Promise<LocalBackupImportJobCompletion> {
    return await this.jobs.wait(id);
  }

  remove(id: string): void {
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

  private async restoreColdStorage(
    id: string,
    entries: readonly StagedBackupEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    this.update(id, "coldStorage", 0, entries.length);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const key = getColdStorageBackupKey(entry.name);
      if (!key)
        throw new Error(`Invalid cold storage backup entry '${entry.name}'`);
      const value = JSON.parse(await fs.readFile(entry.filePath, "utf8"));
      if (!isColdStorageBackupData(value)) {
        throw new Error(`Invalid cold storage backup payload: ${entry.name}`);
      }
      await this.adapter.writeColdStorage(key, value);
      this.update(id, "coldStorage", index + 1, entries.length, entry.name);
    }
  }

  private async restoreAssets(
    id: string,
    entries: readonly StagedBackupEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    this.update(id, "assets", 0, entries.length);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const key = normalizeBackupAssetPath(entry.name);
      await this.adapter.writeAsset(key, entry.filePath, entry.size);
      this.update(id, "assets", index + 1, entries.length, entry.name);
    }
  }

  private async restoreInlays(
    id: string,
    entries: readonly StagedBackupEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    this.update(id, "inlays", 0, entries.length);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      decodeInlayAssetBackup(new Uint8Array(await fs.readFile(entry.filePath)));
      await this.adapter.writeAsset(entry.name, entry.filePath, entry.size);
      this.update(id, "inlays", index + 1, entries.length, entry.name);
    }
  }

  private async restoreStream(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    options: LocalBackupImportRequestOptions,
    sourceKind: "direct" | "sealed-upload",
  ): Promise<LocalBackupImportJobCompletion> {
    const totalBytes = Math.max(0, options.totalBytes ?? 0);
    try {
      if (sourceKind === "direct") {
        this.jobs.beginUpload(id, totalBytes);
      } else {
        if (this.jobs.progress(id).status !== "uploading") {
          throw new LocalBackupImportJobError(
            "Local backup import is not ready to finalize",
          );
        }
        this.jobs.markRestoring(id);
      }

      const staged = await this.staging.stage(id, chunks, {
        totalBytes,
        onProgress: (progress) => {
          this.update(
            id,
            sourceKind === "direct" ? "uploading" : "reading",
            progress.bytesRead,
            progress.totalBytes,
            progress.entryName,
          );
        },
      });

      if (sourceKind === "direct") {
        this.jobs.markRestoring(id);
      }
      const plan = buildBackupImportPlan(staged);

      await this.restoreColdStorage(id, plan.coldStorage);
      await this.restoreAssets(id, plan.assets);
      await this.restoreInlays(id, plan.inlays);
      const prepared = await prepareLocalBackupDatabaseImport(plan, {
        encodeRecord: (record) => this.adapter.encodeDatabaseRecord(record),
        idFactory: randomUUID,
        onProgress: (progress) =>
          this.update(
            id,
            "database",
            progress.current,
            progress.total,
            progress.detail,
          ),
      });
      this.update(
        id,
        "database",
        prepared.recordCount,
        prepared.recordCount,
        "Applying database",
      );
      const result = await this.adapter.applyPreparedDatabase(
        prepared,
        options.sourceClientId,
      );

      this.jobs.settle(id, "complete", result);
      return await this.jobs.wait(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.jobs.settle(id, "error", { error: message });
      } catch {}
      throw error;
    } finally {
      await this.staging.cleanup(id).catch(() => {});
    }
  }

  async importStream(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    options: LocalBackupImportRequestOptions = {},
  ): Promise<LocalBackupImportJobCompletion> {
    return await this.restoreStream(id, chunks, options, "direct");
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

    const state = await this.uploads.append(id, offset, chunks, totalBytes);
    const currentStatus = this.jobs.progress(id).status;
    if (currentStatus === "pending") {
      this.jobs.beginUpload(id, totalBytes);
    } else if (currentStatus !== "uploading") {
      throw new LocalBackupImportJobError(
        "Local backup import stopped accepting upload chunks",
      );
    }
    this.update(id, "uploading", state.receivedBytes, state.totalBytes);
    return state;
  }

  async finalizeUpload(
    id: string,
    options: Pick<LocalBackupImportRequestOptions, "sourceClientId"> = {},
  ): Promise<LocalBackupImportJobCompletion> {
    if (!this.uploads) {
      throw new Error("Chunked local backup uploads are not configured");
    }
    const source = await this.uploads.finalize(id);
    try {
      return await this.restoreStream(
        id,
        source.stream,
        {
          totalBytes: source.totalBytes,
          sourceClientId: options.sourceClientId,
        },
        "sealed-upload",
      );
    } finally {
      await this.uploads.cleanup(id).catch(() => {});
    }
  }

  async cancel(id: string): Promise<void> {
    await this.uploads?.cleanup(id).catch(() => {});
    await this.staging.cleanup(id).catch(() => {});
    this.jobs.remove(id);
  }
}
