import type {
  LocalBackupExportJobCompletion,
  LocalBackupExportJobProgress,
  LocalBackupMode,
  LocalBackupProgress,
} from "../api";
import {
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
} from "./databaseStreamStore";
import {
  LocalBackupExportJobStore,
  type LocalBackupExportJob,
} from "./exportJobStore";

export const LOCAL_BACKUP_EXPORT_DEFAULT_PAGE_SIZE = 128;
export const LOCAL_BACKUP_EXPORT_DEFAULT_FRAGMENT_RECORDS = 128;
export const LOCAL_BACKUP_EXPORT_MAX_PAGE_SIZE = 500;

export interface LocalBackupExportServiceCreateInput {
  mode?: unknown;
  pageSize?: unknown;
  fragmentRecords?: unknown;
}

export interface LocalBackupExportAdapter<TContext = unknown> {
  stream(
    job: LocalBackupExportJob,
    context: TContext,
    onProgress: (progress: LocalBackupProgress) => void,
  ): Promise<void>;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizeMode(value: unknown): LocalBackupMode {
  return value === "compatible" || value === "partial" ? value : "native";
}

export class LocalBackupExportService<TContext = unknown> {
  constructor(
    readonly jobs: LocalBackupExportJobStore,
    private readonly adapter: LocalBackupExportAdapter<TContext>,
  ) {}

  createJob(input: LocalBackupExportServiceCreateInput = {}): { id: string } {
    const job = this.jobs.create({
      mode: normalizeMode(input.mode),
      streamOptions: {
        pageSize: normalizeInteger(
          input.pageSize,
          LOCAL_BACKUP_EXPORT_DEFAULT_PAGE_SIZE,
          1,
          LOCAL_BACKUP_EXPORT_MAX_PAGE_SIZE,
        ),
        fragmentRecords: normalizeInteger(
          input.fragmentRecords,
          LOCAL_BACKUP_EXPORT_DEFAULT_FRAGMENT_RECORDS,
          1,
          LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
        ),
      },
    });
    return { id: job.id };
  }

  progress(id: string): LocalBackupExportJobProgress {
    return this.jobs.progress(id);
  }

  async wait(id: string): Promise<LocalBackupExportJobCompletion> {
    return await this.jobs.wait(id);
  }

  async waitAndRemove(id: string): Promise<LocalBackupExportJobCompletion> {
    const result = await this.jobs.wait(id);
    this.jobs.remove(id);
    return result;
  }

  async stream(id: string, context: TContext): Promise<void> {
    const job = this.jobs.beginStreaming(id);
    try {
      await this.adapter.stream(job, context, (progress) => {
        this.jobs.updateProgress(id, progress);
      });
      this.jobs.updateProgress(id, {
        stage: "finalizing",
        current: 1,
        total: 1,
      });
      this.jobs.settle(id, "complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.jobs.settle(id, "error", message);
      } catch {}
      throw error;
    }
  }
}
