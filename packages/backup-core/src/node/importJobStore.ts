import { randomBytes } from "node:crypto";
import type {
  LocalBackupImportJobCompletion,
  LocalBackupImportJobProgress,
  LocalBackupImportJobStatus,
  LocalBackupImportProgress,
} from "../api";

interface InternalImportJob {
  id: string;
  status: LocalBackupImportJobStatus;
  progress: LocalBackupImportProgress;
  error: string | null;
  revision?: number;
  recordCount?: number;
  expiresAt: number;
  completion: Promise<void>;
  resolveCompletion: (() => void) | null;
}

export class LocalBackupImportJobError extends Error {
  constructor(
    message: string,
    readonly code:
      | "job_not_found"
      | "job_already_started"
      | "invalid_job_state" = "invalid_job_state",
  ) {
    super(message);
    this.name = "LocalBackupImportJobError";
  }
}

export class LocalBackupImportJobStore {
  private readonly jobs = new Map<string, InternalImportJob>();

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly idFactory = () => randomBytes(24).toString("base64url"),
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Local backup import job TTL must be positive");
    }
  }

  prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) this.jobs.delete(id);
    }
  }

  create(): { id: string } {
    this.prune();
    const id = this.idFactory();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.jobs.set(id, {
      id,
      status: "pending",
      progress: { stage: "uploading", current: 0, total: 0 },
      error: null,
      expiresAt: Date.now() + this.ttlMs,
      completion,
      resolveCompletion,
    });
    return { id };
  }

  private require(id: string): InternalImportJob {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) {
      throw new LocalBackupImportJobError(
        "Local backup import job not found or expired",
        "job_not_found",
      );
    }
    return job;
  }

  beginUpload(id: string, totalBytes = 0): void {
    const job = this.require(id);
    if (job.status !== "pending") {
      throw new LocalBackupImportJobError(
        "Local backup import upload was already started",
        "job_already_started",
      );
    }
    job.status = "uploading";
    job.progress = {
      stage: "uploading",
      current: 0,
      total: Math.max(0, totalBytes),
    };
    job.expiresAt = Number.POSITIVE_INFINITY;
  }

  markRestoring(id: string): void {
    const job = this.require(id);
    if (job.status !== "uploading") {
      throw new LocalBackupImportJobError(
        "Local backup import is not ready to restore",
      );
    }
    job.status = "restoring";
    job.progress = { stage: "reading", current: 0, total: 0 };
  }

  updateProgress(id: string, progress: LocalBackupImportProgress): void {
    const job = this.require(id);
    if (job.status === "complete" || job.status === "error") return;
    job.progress = progress;
  }

  progress(id: string): LocalBackupImportJobProgress {
    const job = this.require(id);
    return {
      status: job.status,
      progress: job.progress,
    };
  }

  settle(
    id: string,
    status: Extract<LocalBackupImportJobStatus, "complete" | "error">,
    result: {
      error?: string | null;
      revision?: number;
      recordCount?: number;
    } = {},
  ): void {
    const job = this.require(id);
    job.status = status;
    job.error = result.error ?? null;
    job.revision = result.revision;
    job.recordCount = result.recordCount;
    job.progress = {
      stage: "finalizing",
      current: status === "complete" ? 1 : 0,
      total: 1,
    };
    job.expiresAt = Date.now() + this.ttlMs;
    job.resolveCompletion?.();
    job.resolveCompletion = null;
  }

  async wait(id: string): Promise<LocalBackupImportJobCompletion> {
    const job = this.require(id);
    if (
      job.status === "pending" ||
      job.status === "uploading" ||
      job.status === "restoring"
    ) {
      await job.completion;
    }
    return {
      status: job.status,
      error: job.error,
      revision: job.revision,
      recordCount: job.recordCount,
    };
  }

  remove(id: string): void {
    const job = this.jobs.get(id);
    if (job?.resolveCompletion) {
      job.status = "error";
      job.error = job.error ?? "Local backup import was cancelled";
      job.resolveCompletion();
      job.resolveCompletion = null;
    }
    this.jobs.delete(id);
  }
}
