import { promises as fs } from "node:fs";
import type {
  LocalBackupImportJobCompletion,
  LocalBackupImportJobProgress,
  LocalBackupImportProgress,
} from "../api";
import { isColdStorageBackupData } from "../coldStorage";
import {
  getColdStorageBackupKey,
  normalizeBackupAssetPath,
} from "../entryPolicy";
import { decodeInlayAssetBackup } from "../inlayCodec";
import {
  buildBackupImportPlan,
  type BackupImportPlan,
} from "./importPlan";
import {
  LocalBackupImportJobStore,
} from "./importJobStore";
import {
  BackupImportStagingStore,
  type StagedBackupEntry,
} from "./importStagingStore";

export interface LocalBackupImportRestoreResult {
  revision?: number;
  recordCount?: number;
}

export interface LocalBackupImportAdapter {
  writeColdStorage(key: string, value: unknown): Promise<void>;
  writeAsset(key: string, filePath: string, size: number): Promise<void>;
  restoreDatabase(
    plan: BackupImportPlan,
    sourceClientId: unknown,
    onProgress: (current: number, total: number, detail?: string) => void,
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
      if (!key) throw new Error(`Invalid cold storage backup entry '${entry.name}'`);
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

  async importStream(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    options: LocalBackupImportRequestOptions = {},
  ): Promise<LocalBackupImportJobCompletion> {
    const totalBytes = Math.max(0, options.totalBytes ?? 0);
    try {
      this.jobs.beginUpload(id, totalBytes);
      const staged = await this.staging.stage(id, chunks, {
        totalBytes,
        onProgress: (progress) => {
          this.update(
            id,
            "uploading",
            progress.bytesRead,
            progress.totalBytes,
            progress.entryName,
          );
        },
      });

      this.jobs.markRestoring(id);
      const plan = buildBackupImportPlan(staged);

      await this.restoreColdStorage(id, plan.coldStorage);
      await this.restoreAssets(id, plan.assets);
      await this.restoreInlays(id, plan.inlays);
      const result = await this.adapter.restoreDatabase(
        plan,
        options.sourceClientId,
        (current, total, detail) =>
          this.update(id, "database", current, total, detail),
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
}
