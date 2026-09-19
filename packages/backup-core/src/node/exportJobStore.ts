import { randomBytes } from "node:crypto";
import type {
  LocalBackupExportJobCompletion,
  LocalBackupExportJobProgress,
  LocalBackupExportJobStatus,
  LocalBackupMode,
  LocalBackupProgress,
} from "../api";

export interface LocalBackupExportStreamOptions {
  pageSize: number;
  fragmentRecords: number;
}

export interface LocalBackupExportJob {
  id: string;
  mode: LocalBackupMode;
  streamOptions: LocalBackupExportStreamOptions;
  status: LocalBackupExportJobStatus;
  error: string | null;
  progress: LocalBackupProgress;
  expiresAt: number;
}

interface InternalLocalBackupExportJob extends LocalBackupExportJob {
  completion: Promise<void>;
  resolveCompletion: (() => void) | null;
}

export class LocalBackupExportJobError extends Error {
  constructor(
    message: string,
    readonly code:
      | "job_not_found"
      | "job_already_started"
      | "invalid_job_state" = "invalid_job_state",
  ) {
    super(message);
    this.name = "LocalBackupExportJobError";
  }
}

function publicJob(job: InternalLocalBackupExportJob): LocalBackupExportJob {
  const {
    completion: _completion,
    resolveCompletion: _resolveCompletion,
    ...result
  } = job;
  return result;
}

export class LocalBackupExportJobStore {
  private readonly jobs = new Map<string, InternalLocalBackupExportJob>();

  constructor(
    private readonly ttlMs = 60 * 1000,
    private readonly idFactory = () => randomBytes(24).toString("base64url"),
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Local backup export job TTL must be positive");
    }
  }

  prune(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) this.jobs.delete(id);
    }
  }

  create(input: {
    mode: LocalBackupMode;
    streamOptions: LocalBackupExportStreamOptions;
    progress?: LocalBackupProgress;
  }): LocalBackupExportJob {
    this.prune();
    const id = this.idFactory();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const job: InternalLocalBackupExportJob = {
      id,
      mode: input.mode,
      streamOptions: input.streamOptions,
      status: "pending",
      error: null,
      completion,
      resolveCompletion,
      progress: input.progress ?? {
        stage: "preparing",
        current: 0,
        total: 0,
      },
      expiresAt: Date.now() + this.ttlMs,
    };
    this.jobs.set(id, job);
    return publicJob(job);
  }

  private require(id: string): InternalLocalBackupExportJob {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) {
      throw new LocalBackupExportJobError(
        "Local backup job not found or expired",
        "job_not_found",
      );
    }
    return job;
  }

  get(id: string): LocalBackupExportJob | null {
    this.prune();
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  beginStreaming(id: string): LocalBackupExportJob {
    const job = this.require(id);
    if (job.status !== "pending") {
      throw new LocalBackupExportJobError(
        "Local backup download was already started",
        "job_already_started",
      );
    }
    job.status = "streaming";
    job.expiresAt = Number.POSITIVE_INFINITY;
    return publicJob(job);
  }

  updateProgress(id: string, progress: LocalBackupProgress): void {
    const job = this.require(id);
    job.progress = progress;
  }

  settle(
    id: string,
    status: Extract<LocalBackupExportJobStatus, "complete" | "error">,
    error: string | null = null,
  ): LocalBackupExportJob {
    const job = this.require(id);
    job.status = status;
    job.error = error;
    job.expiresAt = Date.now() + this.ttlMs;
    job.resolveCompletion?.();
    job.resolveCompletion = null;
    return publicJob(job);
  }

  progress(id: string): LocalBackupExportJobProgress {
    const job = this.require(id);
    return {
      status: job.status,
      progress: job.progress,
    };
  }

  async wait(id: string): Promise<LocalBackupExportJobCompletion> {
    const job = this.require(id);
    if (job.status === "pending" || job.status === "streaming") {
      await job.completion;
    }
    return {
      status: job.status,
      error: job.error,
    };
  }

  remove(id: string): void {
    this.jobs.delete(id);
  }
}
