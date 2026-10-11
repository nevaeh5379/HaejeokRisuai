export type ModelJobStatus = (typeof MODEL_JOB_STATUSES)[number];

export type TerminalModelJobStatus =
  (typeof MODEL_JOB_TERMINAL_STATUSES)[number];

export type ModelJobFilter = (typeof MODEL_JOB_FILTERS)[number];

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
("use strict");

const MODEL_JOB_STATUSES: readonly ["running", "done", "failed", "aborted"] =
  Object.freeze(["running", "done", "failed", "aborted"]);
const MODEL_JOB_TERMINAL_STATUSES: readonly ["done", "failed", "aborted"] =
  Object.freeze(["done", "failed", "aborted"]);
const MODEL_JOB_FILTERS: readonly ["active", "unclaimed", "running"] =
  Object.freeze(["active", "unclaimed", "running"]);
const DEFAULT_MODEL_JOB_MAX_BODY_BYTES: number = 16 * 1024 * 1024;

function normalizeModelJobCreateRequest(
  arg: unknown,
  options?: { maxBodyBytes?: number },
): NormalizeModelJobCreateResult;
function normalizeModelJobCreateRequest(
  arg?: any,
  { maxBodyBytes = DEFAULT_MODEL_JOB_MAX_BODY_BYTES }: any = {},
): any {
  const chatId: any = typeof arg?.chatId === "string" ? arg.chatId : "";
  if (!chatId) return { error: "chatId is required", httpStatus: 400 };

  let parsedUrl: any;
  try {
    parsedUrl = new URL(String(arg?.targetUrl || ""));
  } catch {
    return { error: "Invalid target URL", httpStatus: 400 };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: "Invalid target URL", httpStatus: 400 };
  }

  const method: any =
    typeof arg?.method === "string" ? arg.method.toUpperCase() : "POST";
  if (method !== "POST") return { error: "Invalid method", httpStatus: 400 };

  const body: any = typeof arg?.body === "string" ? arg.body : "";
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    return { error: "Request body too large", httpStatus: 413 };
  }

  return {
    value: {
      targetUrl: parsedUrl.toString(),
      targetOrigin: `${parsedUrl.origin}${parsedUrl.pathname}`,
      method,
      headers: arg?.headers,
      body,
      chatId,
      generationId:
        typeof arg?.generationId === "string" ? arg.generationId : null,
      protocol: typeof arg?.protocol === "string" ? arg.protocol : "unknown",
      model: typeof arg?.model === "string" ? arg.model.slice(0, 160) : null,
      speakerId:
        typeof arg?.speakerId === "string" ? arg.speakerId.slice(0, 160) : null,
      streaming: arg?.streaming === true,
      recoverable: arg?.recoverable !== false,
      timeoutMs: arg?.timeoutMs,
    },
  };
}

export {
  MODEL_JOB_STATUSES,
  MODEL_JOB_TERMINAL_STATUSES,
  MODEL_JOB_FILTERS,
  DEFAULT_MODEL_JOB_MAX_BODY_BYTES,
  normalizeModelJobCreateRequest,
};
