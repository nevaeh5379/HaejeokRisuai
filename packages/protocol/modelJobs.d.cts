export const MODEL_JOB_STATUSES: readonly [
  "running",
  "done",
  "failed",
  "aborted",
];
export type ModelJobStatus = (typeof MODEL_JOB_STATUSES)[number];

export const MODEL_JOB_TERMINAL_STATUSES: readonly [
  "done",
  "failed",
  "aborted",
];
export type TerminalModelJobStatus =
  (typeof MODEL_JOB_TERMINAL_STATUSES)[number];

export const MODEL_JOB_FILTERS: readonly ["active", "unclaimed"];
export type ModelJobFilter = (typeof MODEL_JOB_FILTERS)[number];

export const DEFAULT_MODEL_JOB_MAX_BODY_BYTES: number;

export interface CreateModelJobRequest {
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body: string;
  chatId: string;
  generationId?: string;
  protocol?: string;
  model?: string;
  speakerId?: string;
  streaming?: boolean;
  recoverable?: boolean;
  timeoutMs?: number;
}

export interface NormalizedCreateModelJobRequest {
  targetUrl: string;
  targetOrigin: string;
  method: "POST";
  headers?: Record<string, string>;
  body: string;
  chatId: string;
  generationId: string | null;
  protocol: string;
  model: string | null;
  speakerId: string | null;
  streaming: boolean;
  recoverable: boolean;
  timeoutMs?: number;
}

export interface DurableModelJobRecord {
  id: string;
  chatId: string;
  generationId: string | null;
  protocol: string;
  model: string | null;
  speakerId: string | null;
  targetOrigin?: string;
  streaming: boolean;
  recoverable: boolean;
  status: ModelJobStatus;
  upstreamStatus: number | null;
  contentType?: string | null;
  error: string | null;
  createdAt: number;
  endedAt?: number | null;
  bytes?: number;
  claimed?: boolean;
  sourceClientId?: string | null;
}

export interface CreateModelJobResponse {
  jobId: string;
}

export interface ListModelJobsResponse {
  jobs: DurableModelJobRecord[];
}

export type NormalizeModelJobCreateResult =
  | {
      value: NormalizedCreateModelJobRequest;
      error?: never;
      httpStatus?: never;
    }
  | { value?: never; error: string; httpStatus: number };

export function normalizeModelJobCreateRequest(
  arg: unknown,
  options?: { maxBodyBytes?: number },
): NormalizeModelJobCreateResult;
