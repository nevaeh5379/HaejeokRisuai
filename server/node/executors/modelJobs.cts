/**
 * Typed model-job execution for the Node server.
 * Node 서버의 모델 잡 실행을 타이핑한 구현입니다.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { once } from "node:events";
import type { Readable } from "node:stream";
import {
  MODEL_JOB_TERMINAL_STATUSES,
  normalizeModelJobCreateRequest,
  type DurableModelJobRecord,
  type NormalizedCreateModelJobRequest,
} from "../../../packages/protocol/modelJobs.cjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const TAIL_WAIT_MS = 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RETAIN_TERMINAL = 50;
const RETAIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set<string>(MODEL_JOB_TERMINAL_STATUSES);

/**
 * Minimal logger contract expected from the host server.
 * 호스트 서버가 제공해야 하는 최소 로거 계약입니다.
 */
interface JobLogger {
  error: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

/**
 * Lifecycle phase emitted for the durable model-job realtime event.
 * 내구성 모델 잡 실시간 이벤트로 전파되는 생명주기 단계입니다.
 */
type ModelJobEventPhase = "created" | "terminal";

/** In-flight state tracked per running job. / 진행 중 잡마다 추적하는 상태입니다. */
interface ActiveModelJob {
  id: string;
  controller: AbortController;
  waiters: Array<() => void>;
  bytesWritten: number;
  sourceClientId: string | null;
}

/** Upstream request description consumed by requestUpstream. / 상단 요청 정보입니다. */
interface UpstreamRequestArg {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  bodyBuffer?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Resolved upstream response handle. / 상단 응답 핸들입니다. */
interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** Result shape for createJob. / 잡 생성 결과 형태입니다. */
type CreateJobResult =
  | { jobId: string; runPromise: Promise<void> }
  | { error: string; httpStatus: number; jobId?: string };

/** Result shape for claim/delete. / 잡 요청·삭제 결과 형태입니다. */
type MutationJobResult =
  | { success: true; aborted?: boolean; deleted?: boolean }
  | { error: string; httpStatus: number };

/**
 * Minimal express app contract needed to register model-job routes.
 * 모델 잡 라우트 등록에 필요한 최소 express 앱 계약입니다.
 */
interface RouteRegistrationApp {
  post(
    path: string,
    ...handlers: RouteHandlerStack
  ): unknown;
  get(
    path: string,
    ...handlers: RouteHandlerStack
  ): unknown;
  delete(
    path: string,
    ...handlers: RouteHandlerStack
  ): unknown;
}

/** Middleware chain where every handler may call the next guard. / 각 핸들러가 다음 가드를 호출할 수 있는 미들웨어 체인입니다. */
type RouteHandlerStack = Array<
  (req: RouteRequest, res: RouteResponse, next: () => void) => unknown
>;

/**
 * Minimal request contract for the model-job HTTP routes.
 * 모델 잡 HTTP 라우트에 필요한 최소 요청 계약입니다.
 */
interface RouteRequest {
  body?: unknown;
  query: Record<string, unknown>;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal response contract for the model-job HTTP routes.
 * 모델 잡 HTTP 라우트에 필요한 최소 응답 계약입니다.
 */
interface RouteResponse {
  status(statusCode: number): RouteResponse;
  send(body?: unknown): unknown;
  on(event: "close", listener: () => void): unknown;
  once(event: "drain" | "close", listener: () => void): unknown;
  off?(event: "drain" | "close", listener: () => void): unknown;
  set(field: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: Buffer): boolean;
  end(chunk?: unknown): unknown;
}

/** Route registration options. / 라우트 등록 옵션입니다. */
interface RouteOptions {
  auth?: (req: RouteRequest, res: RouteResponse) => Promise<boolean>;
  limiter?: (req: RouteRequest, res: RouteResponse, next: () => void) => void;
}

/** Options accepted by createModelJobManager. / 관리자 생성 옵션입니다. */
export interface ModelJobManagerOptions {
  saveDir?: string;
  logger?: JobLogger;
  onEvent?: ((
    phase: ModelJobEventPhase,
    job: DurableModelJobRecord,
    context: { sourceClientId?: string | null },
  ) => void) | null;
}

/** Public manager surface. / 관리자의 공개 인터페이스입니다. */
export interface ModelJobManager {
  registerRoutes(app: RouteRegistrationApp, options?: RouteOptions): void;
  createJob(
    arg: unknown,
    eventContext?: { sourceClientId?: unknown },
  ): CreateJobResult;
  getJob(jobId: string): DurableModelJobRecord | null;
  listJobs(
    filter: "active" | "unclaimed" | "running",
  ): DurableModelJobRecord[] | null;
  claimJob(jobId: string): Promise<MutationJobResult>;
  deleteJob(jobId: string): Promise<MutationJobResult>;
  streamJob(jobId: string, res: RouteResponse): Promise<void>;
  cleanup(): void;
  journalPath(jobId: string): string;
  close(): Promise<void>;
}

function normalizeTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
}

/**
 * Copies caller headers, dropping hop-by-hop and proxy-auth headers.
 * The journal must never persist secrets from the request.
 * 호출자 헤더에서 홉별·프록시 인증 헤더를 제거해 복사합니다.
 * 저널에는 요청의 비밀이 절대 남지 않아야 합니다.
 */
export function normalizeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "proxy-authorization",
    "proxy-authenticate",
    "risu-auth",
    "risu-timeout-ms",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [rawKey, rawValue] of Object.entries(
    input as Record<string, unknown>,
  )) {
    if (typeof rawKey !== "string" || typeof rawValue !== "string") continue;
    const key = rawKey.toLowerCase();
    if (!blocked.has(key)) out[key] = rawValue;
  }
  out["accept-encoding"] = "identity";
  return out;
}

function requestUpstream(
  arg: UpstreamRequestArg,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(arg.targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const headers: Record<string, string | number> = {
      ...arg.headers,
      host: parsed.host,
    };
    if (arg.bodyBuffer)
      headers["content-length"] = String(arg.bodyBuffer.length);
    let settled = false;
    let upstreamResponse: Readable | null = null;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = client.request(
      parsed,
      { method: arg.method, headers },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        upstreamResponse = res;
        resolve({
          status: res.statusCode || 502,
          headers: res.headers,
          body: res,
        });
      },
    );
    req.on("error", fail);
    req.setTimeout(arg.timeoutMs, () => {
      req.destroy(
        new Error(`Upstream request timed out after ${arg.timeoutMs}ms`),
      );
    });
    if (arg.signal) {
      const abort = () => {
        const error = new Error("Model job aborted");
        error.name = "AbortError";
        upstreamResponse?.destroy(error);
        req.destroy(error);
      };
      if (arg.signal.aborted) {
        abort();
        return;
      }
      arg.signal.addEventListener("abort", abort, { once: true });
    }
    if (arg.bodyBuffer && arg.method !== "GET" && arg.method !== "HEAD") {
      req.write(arg.bodyBuffer);
    }
    req.end();
  });
}

/**
 * Checks whether a running record still has a live, non-aborted request.
 * A record whose in-flight request was already aborted must not block a new
 * generation for the chat.
 * 실행 중 레코드가 중단되지 않은 활성 요청을 아직 가지고 있는지 확인합니다.
 * 진행 중 요청이 이미 중단된 레코드는 채팅의 새 생성을 막아서는 안 됩니다.
 */
function isRunningModelJobActive(
  record: DurableModelJobRecord,
  lookup: (jobId: string) => ActiveModelJob | undefined,
): boolean {
  if (record.status !== "running") return false;
  if (record.recoverable === false) return true;
  const job = lookup(record.id);
  if (!job) return true;
  return !job.controller.signal.aborted;
}

export function createModelJobManager({
  saveDir,
  logger = console,
  onEvent = null,
}: ModelJobManagerOptions = {}): ModelJobManager {
  const root = path.join(
    saveDir || path.join(process.cwd(), "save"),
    "model-jobs",
  );
  const metadataPath = path.join(root, "index.json");
  fs.mkdirSync(root, { recursive: true });

  let records: DurableModelJobRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (Array.isArray(parsed)) records = parsed as DurableModelJobRecord[];
  } catch {
    /* first run or damaged sidecar */
  }

  const activeJobs = new Map<string, ActiveModelJob>();
  let writeChain = Promise.resolve();

  function journalPath(jobId: string): string {
    return path.join(root, `${jobId}.journal`);
  }

  function persist(): Promise<void> {
    const snapshot = JSON.stringify(records, null, 2);
    writeChain = writeChain
      .then(async () => {
        const tmp = `${metadataPath}.tmp`;
        await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
        await fsp.rename(tmp, metadataPath);
      })
      .catch((error: unknown) =>
        logger.error("[model-jobs] metadata write failed", error),
      );
    return writeChain;
  }

  function findRecord(jobId: string): DurableModelJobRecord | null {
    return records.find((record) => record.id === jobId) || null;
  }

  function publicRecord(record: DurableModelJobRecord | null) {
    if (!record) return null;
    const active = activeJobs.get(record.id);
    const merged: DurableModelJobRecord = {
      ...record,
      bytes: active?.bytesWritten ?? record.bytes ?? 0,
    };
    if (active?.sourceClientId) merged.sourceClientId = active.sourceClientId;
    return merged;
  }

  function emitEvent(
    type: ModelJobEventPhase,
    record: DurableModelJobRecord,
    context: { sourceClientId?: string | null } = {},
  ): void {
    if (typeof onEvent !== "function" || !record) return;
    try {
      const publicJob = publicRecord(record);
      if (publicJob) onEvent(type, publicJob, context);
    } catch (error) {
      logger.warn?.("[model-jobs] event listener failed", error);
    }
  }

  function notify(job: ActiveModelJob): void {
    const waiters = job.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  function waitForEvent(jobId: string): Promise<void> {
    const job = activeJobs.get(jobId);
    if (!job) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = job.waiters.indexOf(wake);
        if (index >= 0) job.waiters.splice(index, 1);
        resolve();
      }, TAIL_WAIT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      job.waiters.push(wake);
      if (!activeJobs.has(jobId)) notify(job);
    });
  }

  function cleanup(): void {
    const now = Date.now();
    const terminal = records.filter((record) => TERMINAL.has(record.status));
    const removable = terminal
      .filter((record) => record.claimed || record.recoverable === false)
      .filter(
        (record) => (record.endedAt || record.createdAt) < now - RETAIN_AGE_MS,
      );
    const protectedIds = new Set(
      records
        .filter((record) => !record.claimed && record.recoverable !== false)
        .map((record) => record.id),
    );
    const overflow = terminal
      .slice()
      .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt))
      .slice(RETAIN_TERMINAL);
    const deleteIds = new Set(removable.map((record) => record.id));
    for (const record of overflow) {
      if (!protectedIds.has(record.id)) deleteIds.add(record.id);
    }
    if (deleteIds.size === 0) return;
    records = records.filter((record) => !deleteIds.has(record.id));
    for (const id of deleteIds) {
      try {
        fs.unlinkSync(journalPath(id));
      } catch {
        /* already gone */
      }
    }
    void persist();
  }

  async function runJob(job: ActiveModelJob, arg: UpstreamRequestArg) {
    const stream = fs.createWriteStream(journalPath(job.id), { flags: "a" });
    let writeError: Error | null = null;
    stream.on("error", (error: Error) => {
      writeError ||= error;
    });
    let failure: Error | null = null;
    try {
      const upstream = await requestUpstream(arg);
      const record = findRecord(job.id);
      if (record) {
        record.upstreamStatus = upstream.status;
        const contentType = upstream.headers["content-type"];
        record.contentType =
          typeof contentType === "string" ? contentType : null;
        await persist();
      }
      for await (const chunk of upstream.body) {
        if (job.controller.signal.aborted) break;
        if (!chunk || chunk.length === 0) continue;
        if (writeError) throw writeError;
        const ok = stream.write(chunk);
        job.bytesWritten += chunk.length;
        notify(job);
        if (!ok) await once(stream, "drain");
      }
      if (writeError) throw writeError;
      if (job.controller.signal.aborted) {
        const error = new Error("Model job aborted");
        error.name = "AbortError";
        throw error;
      }
    } catch (error) {
      failure = error as Error;
    } finally {
      await new Promise((resolve) => stream.end(resolve));
      if (!failure && writeError) failure = writeError;
      const record = findRecord(job.id);
      if (record) {
        record.status = !failure
          ? "done"
          : failure.name === "AbortError" || job.controller.signal.aborted
            ? "aborted"
            : "failed";
        record.error =
          record.status === "failed"
            ? String(failure?.message || failure)
            : null;
        record.endedAt = Date.now();
        record.bytes = job.bytesWritten;
        await persist();
        emitEvent("terminal", record, { sourceClientId: job.sourceClientId });
      }
      activeJobs.delete(job.id);
      notify(job);
    }
  }

  function createJob(
    arg: unknown,
    eventContext: { sourceClientId?: unknown } = {},
  ): CreateJobResult {
    const normalized = normalizeModelJobCreateRequest(arg);
    if (normalized.error) {
      return { error: normalized.error, httpStatus: normalized.httpStatus };
    }
    const request = normalized.value as NormalizedCreateModelJobRequest;
    const { chatId, recoverable } = request;
    if (recoverable) {
      const running = records.find(
        (record) =>
          record.chatId === chatId &&
          isRunningModelJobActive(record, (id) => activeJobs.get(id)),
      );
      if (running) {
        return {
          error: "A generation is already running for this chat",
          httpStatus: 409,
          jobId: running.id,
        };
      }
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const record: DurableModelJobRecord = {
      id,
      chatId,
      generationId: request.generationId,
      protocol: request.protocol,
      model: request.model,
      speakerId: request.speakerId,
      targetOrigin: request.targetOrigin,
      streaming: request.streaming,
      recoverable,
      status: "running",
      upstreamStatus: null,
      contentType: null,
      error: null,
      createdAt,
      endedAt: null,
      bytes: 0,
      claimed: false,
    };
    records.push(record);
    fs.closeSync(fs.openSync(journalPath(id), "w"));
    const sourceClientId =
      typeof eventContext.sourceClientId === "string"
        ? eventContext.sourceClientId
        : null;
    const job: ActiveModelJob = {
      id,
      controller: new AbortController(),
      waiters: [],
      bytesWritten: 0,
      sourceClientId,
    };
    activeJobs.set(id, job);
    emitEvent("created", record, { sourceClientId: job.sourceClientId });
    void persist();
    const runPromise = runJob(job, {
      targetUrl: request.targetUrl,
      method: request.method,
      headers: normalizeHeaders(request.headers),
      bodyBuffer: request.body ? Buffer.from(request.body, "utf8") : undefined,
      timeoutMs: normalizeTimeout(request.timeoutMs),
    }).catch((error: unknown) =>
      logger.error("[model-jobs] run failed", error),
    );
    return { jobId: id, runPromise };
  }

  function getJob(jobId: string): DurableModelJobRecord | null {
    return publicRecord(findRecord(jobId));
  }

  function listJobs(
    filter: "active" | "unclaimed" | "running",
  ): DurableModelJobRecord[] | null {
    if (filter === "running") {
      return records
        .filter((record) => record.status === "running")
        .map((record) => publicRecord(record))
        .filter((record): record is DurableModelJobRecord => record !== null);
    }
    if (filter === "active") {
      return records
        .filter(
          (record) =>
            record.status === "running" && record.recoverable !== false,
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => publicRecord(record))
        .filter((record): record is DurableModelJobRecord => record !== null);
    }
    if (filter === "unclaimed") {
      return records
        .filter(
          (record) =>
            TERMINAL.has(record.status) && record.status !== "aborted",
        )
        .filter((record) => record.recoverable !== false && !record.claimed)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((record) => publicRecord(record))
        .filter((record): record is DurableModelJobRecord => record !== null);
    }
    return null;
  }

  async function claimJob(jobId: string): Promise<MutationJobResult> {
    const record = findRecord(jobId);
    if (!record) return { error: "Job not found", httpStatus: 404 };
    if (!TERMINAL.has(record.status)) {
      return { error: "Job is still running", httpStatus: 409 };
    }
    record.claimed = true;
    await persist();
    return { success: true };
  }

  async function deleteJob(jobId: string): Promise<MutationJobResult> {
    const record = findRecord(jobId);
    if (!record) return { error: "Job not found", httpStatus: 404 };
    const active = activeJobs.get(jobId);
    if (active) {
      active.controller.abort();
      return { success: true, aborted: true };
    }
    records = records.filter((item) => item.id !== jobId);
    try {
      await fsp.unlink(journalPath(jobId));
    } catch {
      /* already gone */
    }
    await persist();
    return { success: true, deleted: true };
  }

  async function streamJob(jobId: string, res: RouteResponse): Promise<void> {
    let record = findRecord(jobId);
    if (!record) {
      res.status(404).send({ error: "Job not found" });
      return;
    }
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    while (
      !clientGone &&
      record.status === "running" &&
      record.upstreamStatus == null &&
      activeJobs.has(jobId)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = findRecord(jobId);
      if (!record) return;
    }
    if (clientGone) return;
    res.status(200);
    res.set("content-type", record.contentType || "application/octet-stream");
    res.set("cache-control", "no-cache, no-transform");
    res.set("x-accel-buffering", "no");
    res.set("x-model-job-id", record.id);
    res.set("x-model-job-status", record.status);
    if (record.upstreamStatus != null) {
      res.set("x-model-job-upstream-status", String(record.upstreamStatus));
    }
    res.flushHeaders();

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(journalPath(jobId), "r");
    } catch {
      res.end();
      return;
    }
    try {
      let offset = 0;
      let sawTerminal = false;
      while (!clientGone) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (bytesRead > 0) {
          offset += bytesRead;
          const ok = res.write(buffer.subarray(0, bytesRead));
          if (!ok && !clientGone) {
            await new Promise<void>((resolve) => {
              const settle = () => {
                res.off?.("drain", settle);
                res.off?.("close", settle);
                resolve();
              };
              res.once("drain", settle);
              res.once("close", settle);
            });
          }
          continue;
        }
        if (sawTerminal) break;
        if (!activeJobs.has(jobId)) {
          sawTerminal = true;
          continue;
        }
        await waitForEvent(jobId);
      }
    } finally {
      await handle.close();
    }
    if (!clientGone) res.end();
  }

  function registerRoutes(app: RouteRegistrationApp, { auth, limiter }: RouteOptions = {}) {
    const guards = limiter ? [limiter] : [];
    const ensureAuth = async (req: RouteRequest, res: RouteResponse) =>
      !auth || (await auth(req, res));

    app.post("/api/model-jobs", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      const result = createJob(req.body, {
        sourceClientId: req.headers["x-risu-client-id"],
      });
      if ("error" in result && result.error) {
        res
          .status(result.httpStatus || 400)
          .send({ error: result.error, jobId: result.jobId });
        return;
      }
      res.send({ jobId: result.jobId });
    });

    app.get("/api/model-jobs", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      const filter = req.query.active
        ? "active"
        : req.query.unclaimed
          ? "unclaimed"
          : null;
      const jobs = filter ? listJobs(filter) : null;
      if (!jobs)
        return res
          .status(400)
          .send({ error: "active=1 or unclaimed=1 is required" });
      res.send({ jobs });
    });

    app.get("/api/model-jobs/:id/stream", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      await streamJob(req.params.id, res);
    });

    app.get("/api/model-jobs/:id", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      const job = getJob(req.params.id);
      if (!job) return res.status(404).send({ error: "Job not found" });
      res.send(job);
    });

    app.post("/api/model-jobs/:id/claim", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      const result = await claimJob(req.params.id);
      if ("error" in result)
        return res
          .status(result.httpStatus || 400)
          .send({ error: result.error });
      res.send(result);
    });

    app.delete("/api/model-jobs/:id", ...guards, async (req, res) => {
      if (!(await ensureAuth(req, res))) return;
      const result = await deleteJob(req.params.id);
      if ("error" in result)
        return res
          .status(result.httpStatus || 400)
          .send({ error: result.error });
      res.send(result);
    });
  }

  const restartTime = Date.now();
  let recoveredRestartRows = false;
  for (const record of records) {
    if (record.status !== "running") continue;
    record.status = "failed";
    record.error = "server restart interrupted the upstream request";
    record.endedAt = restartTime;
    recoveredRestartRows = true;
  }
  if (recoveredRestartRows) void persist();

  cleanup();
  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  return {
    registerRoutes,
    createJob,
    getJob,
    listJobs,
    claimJob,
    deleteJob,
    streamJob,
    cleanup,
    journalPath,
    async close() {
      clearInterval(cleanupTimer);
      for (const job of activeJobs.values()) job.controller.abort();
      await Promise.allSettled(
        [...activeJobs.keys()].map(async (id) => {
          while (activeJobs.has(id)) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }),
      );
      await writeChain;
    },
  };
}