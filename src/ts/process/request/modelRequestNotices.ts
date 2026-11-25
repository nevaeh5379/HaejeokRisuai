import { writable } from "svelte/store";
import type { ModelModeExtended } from "./shared";

export interface ModelRequestNotice {
  id: number;
  mode: ModelModeExtended;
  model: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
}

const visibleAfterEndMs = 3500;
// Guards against a request whose stream is never consumed or closed.
const maxPendingMs = 10 * 60 * 1000;

let nextId = 0;
let notices: ModelRequestNotice[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
export const modelRequestNotices = writable<readonly ModelRequestNotice[]>([]);

function expiresAt(notice: ModelRequestNotice) {
  return notice.endedAt !== undefined
    ? notice.endedAt + visibleAfterEndMs
    : notice.startedAt + maxPendingMs;
}

function publish() {
  clearTimeout(timer);
  const now = Date.now();
  notices = notices.filter((n) => expiresAt(n) > now);
  modelRequestNotices.set(notices);
  if (notices.length) {
    const next = Math.min(...notices.map(expiresAt));
    timer = setTimeout(publish, next - now);
  }
}

/** Shows a toast for a model request; call the returned function when it ends. */
export function notifyModelRequest(model: string, mode: ModelModeExtended) {
  const notice: ModelRequestNotice = {
    id: ++nextId,
    mode,
    model,
    startedAt: Date.now(),
  };
  notices = [...notices.slice(-3), notice];
  publish();
  let done = false;
  return (failed = false) => {
    if (done) return;
    done = true;
    const endedAt = Date.now();
    notices = notices.map((n) =>
      n.id === notice.id ? { ...n, endedAt, failed } : n,
    );
    publish();
  };
}

/** Ends the toast when the response, including any stream, has finished. */
export function trackModelResponse<T extends { type: string; result: unknown }>(
  response: Promise<T>,
  finish: (failed?: boolean) => void,
): Promise<T> {
  return response.then(
    (res) => {
      if (res.type === "streaming" && res.result instanceof ReadableStream) {
        return { ...res, result: trackStream(res.result, finish) };
      }
      finish(res.type === "fail");
      return res;
    },
    (error) => {
      finish(true);
      throw error;
    },
  );
}

function trackStream<C>(
  source: ReadableStream<C>,
  finish: (failed?: boolean) => void,
): ReadableStream<C> {
  const reader = source.getReader();
  return new ReadableStream<C>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish(true);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}
