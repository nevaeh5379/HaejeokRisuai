import { writable } from "svelte/store";
import { pauseActiveChatGenerationStats } from "../chat/generationStats";
import type { ModelModeExtended } from "./shared";

export interface ModelRequestNotice {
  id: number;
  mode: ModelModeExtended;
  model: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  outputText?: string;
}

const visibleAfterEndMs = 8_000;
// Guards against a request whose stream is never consumed or closed.
const maxPendingMs = 10 * 60 * 1000;

let nextId = 0;
let notices: ModelRequestNotice[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
export const modelRequestNotices = writable<readonly ModelRequestNotice[]>([]);
/** Mounted generation stats floats that show these notices next to them. */
export const modelRequestNoticeHosts = writable(0);

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

type Finish = (failed?: boolean, outputText?: string) => void;
const noop: Finish = () => {};

/**
 * Shows a toast for an auxiliary model request and freezes the main model
 * timer. Main model requests are shown by the generation stats float.
 */
export function notifyModelRequest(
  model: string,
  mode: ModelModeExtended,
): Finish {
  if (mode === "model") return noop;
  const startedAt = Date.now();
  pauseActiveChatGenerationStats(startedAt);
  const id = ++nextId;
  notices = [...notices.slice(-3), { id, mode, model, startedAt }];
  publish();
  let done = false;
  return (failed = false, outputText) => {
    if (done) return;
    done = true;
    const endedAt = Date.now();
    notices = notices.map((n) =>
      n.id === id ? { ...n, endedAt, failed, outputText } : n,
    );
    publish();
  };
}

/** Ends the toast when the response, including any stream, has finished. */
export function trackModelResponse<T extends { type: string; result: unknown }>(
  response: Promise<T>,
  finish: Finish,
): Promise<T> {
  if (finish === noop) return response;
  return response.then(
    (res) => {
      if (res.type === "streaming" && res.result instanceof ReadableStream) {
        return { ...res, result: trackStream(res.result, finish) };
      }
      const text = typeof res.result === "string" ? res.result : undefined;
      finish(res.type === "fail", res.type === "fail" ? undefined : text);
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
  finish: Finish,
): ReadableStream<C> {
  const reader = source.getReader();
  let last: C | undefined;
  return new ReadableStream<C>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(false, streamText(last));
          controller.close();
        } else {
          last = value;
          controller.enqueue(value);
        }
      } catch (error) {
        finish(true);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish(false, streamText(last));
      return reader.cancel(reason);
    },
  });
}

// Stream chunks carry the accumulated text keyed by response slot.
function streamText(chunk: unknown) {
  if (!chunk || typeof chunk !== "object") return undefined;
  const values = Object.values(chunk as Record<string, unknown>);
  return typeof values[0] === "string" ? values[0] : undefined;
}
