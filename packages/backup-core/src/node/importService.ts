import type {
  LocalBackupImportJobCompletion,
  LocalBackupImportJobProgress,
  LocalBackupImportProgress,
} from "../api";
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
  restoreColdStorage(
    entries: readonly StagedBackupEntry[],
    onProgress: (current: number, total: number, detail?: string) => void,
  ): Promise<void>;
  restoreAssets(
    entries: readonly StagedBackupEntry[],
    onProgress: (current: number, total: number, detail?: string) => void,
  ): Promise<void>;
  restoreInlays(
    entries: readonly StagedBackupEntry[],
    onProgress: (current: number, total: number, detail?: string) => void,
  ): Promise<void>;
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

      await this.adapter.restoreColdStorage(
        plan.coldStorage,
        (current, total, detail) =>
          this.update(id, "coldStorage", current, total, detail),
      );
      await this.adapter.restoreAssets(
        plan.assets,
        (current, total, detail) =>
          this.update(id, "assets", current, total, detail),
      );
      await this.adapter.restoreInlays(
        plan.inlays,
        (current, total, detail) =>
          this.update(id, "inlays", current, total, detail),
      );
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
