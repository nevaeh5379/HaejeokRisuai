import { getNodeServerProxyAuth } from "../storage/nodeStorage";

export interface DurableGenerationContext {
  realChatId: string;
  generationId: string;
  model?: string;
  speakerId?: string;
}

const contexts = new Map<string, DurableGenerationContext>();
const ownedJobIds = new Set<string>();

export function isDurableModelJobOwned(jobId: string): boolean {
  return ownedJobIds.has(jobId);
}

export function registerDurableGenerationContext(
  context: DurableGenerationContext,
): void {
  if (!context.generationId || !context.realChatId) return;
  contexts.set(context.generationId, context);
}

export function unregisterDurableGenerationContext(generationId: string): void {
  contexts.delete(generationId);
}

export function getDurableGenerationContext(
  generationId?: string,
): DurableGenerationContext | null {
  if (!generationId) return null;
  return contexts.get(generationId) ?? null;
}

export class DurableModelJobBusyError extends Error {
  constructor() {
    super("A server-side generation is already running for this chat.");
    this.name = "DurableModelJobBusyError";
  }
}

export class DurableModelJobUnavailableError extends Error {
  constructor(message = "Server-side model jobs are unavailable.") {
    super(message);
    this.name = "DurableModelJobUnavailableError";
  }
}

function inferProtocol(interceptor?: string): string {
  const value = interceptor?.toLowerCase() ?? "";
  if (value.includes("anthropic")) return "anthropic";
  if (value.includes("gemini") || value.includes("google")) return "gemini";
  if (value.includes("response_api") || value.includes("responses")) {
    return "openai-responses";
  }
  return "openai";
}

function isStreamingRequest(interceptor: string | undefined, body: string): boolean {
  if (interceptor?.toLowerCase().includes("stream")) return true;
  try {
    return JSON.parse(body)?.stream === true;
  } catch {
    return false;
  }
}

function isRecoverableRequest(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return !(Array.isArray(parsed?.tools) && parsed.tools.length > 0);
  } catch {
    return true;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  return { "risu-auth": await getNodeServerProxyAuth() };
}

const MAX_REATTACH_ATTEMPTS = 5;
const MAX_NO_PROGRESS_REATTACHES = 3;

export interface DurableModelJobFetchArgs {
  body: string;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  generationId: string;
  interceptor?: string;
}

export async function fetchViaDurableModelJob(
  url: string,
  arg: DurableModelJobFetchArgs,
): Promise<Response> {
  const context = getDurableGenerationContext(arg.generationId);
  if (!context) {
    throw new DurableModelJobUnavailableError("No durable generation context is registered.");
  }

  let created: Response;
  try {
    created = await fetch("/api/model-jobs", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        targetUrl: url,
        method: arg.method ?? "POST",
        headers: arg.headers ?? {},
        body: arg.body,
        chatId: context.realChatId,
        generationId: context.generationId,
        protocol: inferProtocol(arg.interceptor),
        model: context.model,
        speakerId: context.speakerId,
        streaming: isStreamingRequest(arg.interceptor, arg.body),
        recoverable: isRecoverableRequest(arg.body),
        timeoutMs: arg.requestTimeoutMs,
      }),
      signal: arg.signal,
    });
  } catch (error) {
    if (arg.signal?.aborted) throw error;
    // The POST may already have reached the server. Falling back to a direct
    // provider request here could double-generate, so ambiguous network errors
    // are terminal rather than "server job unsupported".
    throw new Error(`Model job creation connection failed: ${String(error)}`);
  }

  if (created.status === 409) throw new DurableModelJobBusyError();
  if (created.status === 404 || created.status === 405) {
    throw new DurableModelJobUnavailableError(
      `Model job API is unavailable (HTTP ${created.status})`,
    );
  }
  if (!created.ok) {
    throw new Error(`Model job creation failed with HTTP ${created.status}`);
  }
  const { jobId } = (await created.json()) as { jobId?: string };
  if (!jobId) {
    throw new Error("Model job creation returned no job id.");
  }
  ownedJobIds.add(jobId);

  const releaseOwnership = () => ownedJobIds.delete(jobId);
  const abortWithAuth = () => {
    void (async () => {
      await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
    })().catch(() => {});
  };
  arg.signal?.addEventListener("abort", abortWithAuth, { once: true });
  const detachAbort = () =>
    arg.signal?.removeEventListener("abort", abortWithAuth);

  let streamResponse: Response;
  try {
    streamResponse = await fetch(
      `/api/model-jobs/${encodeURIComponent(jobId)}/stream`,
      { headers: await authHeaders(), signal: arg.signal },
    );
  } catch (error) {
    detachAbort();
    releaseOwnership();
    if (arg.signal?.aborted) throw error;
    throw new Error("The model job is still running, but its result stream disconnected.");
  }

  const upstreamStatus = Number(
    streamResponse.headers.get("x-model-job-upstream-status"),
  );
  if (!streamResponse.ok || !streamResponse.body || !Number.isFinite(upstreamStatus)) {
    detachAbort();
    releaseOwnership();
    throw new TypeError("Model job upstream connection failed.");
  }

  let reader = streamResponse.body.getReader();
  let deliveredBytes = 0;
  let skipBytes = 0;
  let progressedSinceAttach = true;
  let noProgressReattaches = 0;

  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  const sleepAbortable = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        arg.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      if (arg.signal?.aborted) return onAbort();
      arg.signal?.addEventListener("abort", onAbort, { once: true });
    });

  const reattach = async (): Promise<boolean> => {
    if (progressedSinceAttach) {
      noProgressReattaches = 0;
    } else if (++noProgressReattaches >= MAX_NO_PROGRESS_REATTACHES) {
      return false;
    }
    for (let attempt = 0; attempt < MAX_REATTACH_ATTEMPTS; attempt++) {
      try {
        await sleepAbortable(500 * 2 ** attempt);
        const response = await fetch(
          `/api/model-jobs/${encodeURIComponent(jobId)}/stream`,
          { headers: await authHeaders(), signal: arg.signal },
        );
        if (response.status === 404) return false;
        if (!response.ok || !response.body) continue;
        reader = response.body.getReader();
        skipBytes = deliveredBytes;
        progressedSinceAttach = false;
        return true;
      } catch {
        if (arg.signal?.aborted) return false;
      }
    }
    return false;
  };

  const getJob = async (): Promise<{ status?: string; error?: string } | null> => {
    try {
      const response = await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}`, {
        headers: await authHeaders(),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const claimJob = () => {
    void (async () => {
      await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}/claim`, {
        method: "POST",
        headers: await authHeaders(),
      });
    })().catch(() => {});
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          if (arg.signal?.aborted) {
            detachAbort();
            releaseOwnership();
            throw error;
          }
          if (await reattach()) continue;
          detachAbort();
          releaseOwnership();
          throw new Error("The server is still generating, but the result stream could not be reattached.");
        }

        if (!read.done) {
          let chunk = read.value;
          if (skipBytes > 0) {
            if (chunk.length <= skipBytes) {
              skipBytes -= chunk.length;
              continue;
            }
            chunk = chunk.subarray(skipBytes);
            skipBytes = 0;
          }
          deliveredBytes += chunk.length;
          progressedSinceAttach = true;
          controller.enqueue(chunk);
          return;
        }

        if (arg.signal?.aborted) {
          detachAbort();
          releaseOwnership();
          throw abortError();
        }
        const job = await getJob();
        if (job?.status === "done") {
          detachAbort();
          releaseOwnership();
          controller.close();
          claimJob();
          return;
        }
        if (job?.status === "failed" || job?.status === "aborted") {
          detachAbort();
          releaseOwnership();
          if (job.status === "failed") claimJob();
          controller.error(new Error(job.error ?? `Model job ${job.status}.`));
          return;
        }
        if (await reattach()) continue;
        detachAbort();
        releaseOwnership();
        if (arg.signal?.aborted) throw abortError();
        controller.error(
          new Error("The server is still generating, but the result stream could not be reattached."),
        );
        return;
      }
    },
    cancel(reason) {
      detachAbort();
      releaseOwnership();
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: upstreamStatus,
    headers: {
      "content-type":
        streamResponse.headers.get("content-type") ?? "application/octet-stream",
      "x-model-job-id": jobId,
    },
  });
}
