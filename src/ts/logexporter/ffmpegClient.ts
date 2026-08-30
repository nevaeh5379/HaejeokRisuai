/**
 * Self-managed ffmpeg.wasm client.
 *
 * @ffmpeg/ffmpeg 0.12 spawns its worker from a bundle-transpiled module, and
 * with Vite's `worker.format: 'es'` that worker is a MODULE worker. A module
 * worker cannot run the classic UMD core (`importScripts` is undefined there)
 * and the fallback `import()` blob chain fails: on the UMD core it yields no
 * default export (ERROR_IMPORT_FAILURE → "failed to import ffmpeg-core.js"),
 * and the ESM core currently rejects mid-execution (ErrnoError: FS error).
 * Both were confirmed in headless Chromium runs.
 *
 * This client instead owns a tiny CLASSIC blob worker and loads the UMD core
 * via importScripts, which every browser supporting Workers handles. Only the
 * narrow API slice the Log Exporter needs is exposed, and worker replies
 * carry a log tail so load/exec failures are diagnosable.
 */

import { toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.10";
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

/** How long to wait (ms) for ffmpeg.wasm to be ready before giving up. */
export const FFMPEG_LOAD_TIMEOUT_MS = 60000;

export interface FFmpegClient {
  writeFile(name: string, data: Uint8Array): Promise<void>;
  exec(args: string[]): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  deleteFile(name: string): Promise<void>;
}

const WORKER_SOURCE = `
let core = null;
const logs = [];
const post = (m) => self.postMessage(m);
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    switch (type) {
      case "LOAD": {
        importScripts(payload.coreURL);
        core = await self.createFFmpegCore({
          mainScriptUrlOrBlob:
            payload.coreURL + "#" + btoa(JSON.stringify({ wasmURL: payload.wasmURL })),
        });
        core.setLogger((l) => {
          logs.push(String((l && l.message) || l));
          if (logs.length > 200) logs.shift();
        });
        post({ id, type, ok: true });
        return;
      }
      case "WRITE": {
        core.FS.writeFile(payload.name, new Uint8Array(payload.data));
        post({ id, type, ok: true });
        return;
      }
      case "EXEC": {
        core.setTimeout(-1);
        core.exec(...payload.args);
        const ret = core.ret;
        core.reset();
        post({ id, type, ok: true, ret, logs: logs.slice(-40).join(String.fromCharCode(10)) });
        return;
      }
      case "READ": {
        const data = core.FS.readFile(payload.name);
        post({ id, type, ok: true, data: data.buffer }, [data.buffer]);
        return;
      }
      case "DEL": {
        try { core.FS.unlink(payload.name); } catch (_) {}
        post({ id, type, ok: true });
        return;
      }
    }
  } catch (err) {
    const tail = logs.slice(-12).join(String.fromCharCode(10));
    post({ id, type, ok: false, error: String((err && err.message) || err) + (tail ? " || ffmpeg logs: " + tail : "") });
  }
};
`;

interface PendingCall {
  res: (value: any) => void;
  rej: (error: Error) => void;
}

interface WorkerHandle {
  client: FFmpegClient;
  load(config: { coreURL: string; wasmURL: string }): Promise<void>;
}

function spawnClassicWorker(): WorkerHandle {
  const worker = new Worker(
    URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })),
  );
  let seq = 1;
  const pending = new Map<number, PendingCall>();
  worker.onmessage = (event: MessageEvent) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return; // e.g. late log frames
    pending.delete(message.id);
    if (message.ok) entry.res(message);
    else entry.rej(new Error(message.error || "ffmpeg worker error"));
  };
  worker.onerror = (event) => {
    const error = new Error(
      `ffmpeg worker error: ${event.message || "unknown"}`,
    );
    for (const entry of pending.values()) entry.rej(error);
    pending.clear();
  };
  const call = async (
    type: string,
    payload?: unknown,
    transfer?: Transferable[],
  ): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { res: resolve, rej: reject });
      worker.postMessage({ id, type, payload }, transfer ?? []);
    });
  return {
    client: {
      writeFile: (name, data) =>
        call("WRITE", { name, data: new Uint8Array(data).buffer }),
      exec: async (args) => {
        const reply = await call("EXEC", { args });
        if (reply.ret !== 0) {
          const tail = String(reply.logs || "")
            .split("\n")
            .filter(Boolean)
            .slice(-12)
            .join(" | ");
          throw new Error(
            `ffmpeg exited with code ${reply.ret}${tail ? ": " + tail : "(no logs captured)"}`,
          );
        }
      },
      readFile: async (name) =>
        new Uint8Array((await call("READ", { name })).data),
      deleteFile: (name) => call("DEL", { name }),
    },
    load: (config) => call("LOAD", config),
  };
}

let clientPromise: Promise<FFmpegClient> | null = null;

/** Invalidates the cached client so the next call retries with a fresh worker. */
export function resetFFmpegClient(): void {
  clientPromise = null;
}

/**
 * Returns a cached (or freshly spawning) ffmpeg client. A failed load
 * invalidates the singleton so a later call can retry.
 */
export async function getFFmpeg(): Promise<FFmpegClient> {
  if (!clientPromise) {
    clientPromise = spawnAndLoad().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timed = Promise.race([
    clientPromise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `ffmpeg.wasm 로드 시간 초과 (${FFMPEG_LOAD_TIMEOUT_MS / 1000}초). 네트워크 상태를 확인해주세요.`,
            ),
          ),
        FFMPEG_LOAD_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  return timed;
}

async function spawnAndLoad(): Promise<FFmpegClient> {
  // CDN fetches can be flaky; retry a couple of times before giving up.
  const fetchAsset = async (file: string, mime: string): Promise<string> => {
    const url = `${CORE_BASE_URL}/${file}`;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      try {
        return await toBlobURL(url, mime);
      } catch (e) {
        lastError = e;
        console.warn(
          `[logexporter] ffmpeg asset fetch failed (attempt ${attempt + 1}/3):`,
          e,
        );
      }
    }
    throw new Error(
      `Failed to fetch ffmpeg asset ${url}: ${String(lastError)}`,
    );
  };
  const [coreUrl, wasmUrl] = await Promise.all([
    fetchAsset("ffmpeg-core.js", "text/javascript"),
    fetchAsset("ffmpeg-core.wasm", "application/wasm"),
  ]);
  const handle = spawnClassicWorker();
  await handle.load({ coreURL: coreUrl, wasmURL: wasmUrl });
  return handle.client;
}
