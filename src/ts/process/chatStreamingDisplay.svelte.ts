import type {
  groupChat,
  character,
  StreamingDisplayOptimizationMode,
} from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { trimUntilPunctuation } from "../util";
import { processScriptFull } from "./scripts";

export interface StreamDisplayOptions {
  reader: ReadableStreamDefaultReader<{ [key: string]: string }>;
  abortSignal: AbortSignal;
  selectedChar: number;
  selectedChat: number;
  nowChatroom: character | groupChat;
  msgIndex: number;
  prefix: string;
  reformatContent: (data: string) => string;
  performanceMode: StreamingDisplayOptimizationMode;
}

interface StreamDisplayState {
  result: string;
  emoChanged: boolean;
  lastResponseChunk: Record<string, string>;
  streamAborted: boolean;
  receivedResult: boolean;
  pendingResult: string | null;
  flushError: unknown;
}

function targetMessage(options: StreamDisplayOptions) {
  return characterStore.characters[options.selectedChar].chats[
    options.selectedChat
  ].message[options.msgIndex];
}

async function writeDisplayResult(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  result: string,
  deferPostProcessing: boolean,
) {
  if (deferPostProcessing) {
    targetMessage(options).data = options.reformatContent(options.prefix + result);
  } else {
    const processed = await processScriptFull(
      options.nowChatroom,
      options.reformatContent(options.prefix + result),
      "editoutput",
      options.msgIndex,
    );
    targetMessage(options).data = processed.data;
    state.emoChanged = processed.emoChanged;
  }
  characterStore.characters[options.selectedChar].reloadKeys += 1;
}

function createFlushController(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  deferPostProcessing: boolean,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let promise: Promise<void> | null = null;
  let queued = false;

  const clearSchedule = () => {
    if (timer !== null) clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    timer = null;
    frame = null;
  };

  const flush = async () => {
    clearSchedule();
    if (promise) {
      queued = true;
      return promise;
    }
    promise = (async () => {
      do {
        queued = false;
        const next = state.pendingResult;
        state.pendingResult = null;
        if (next !== null) {
          await writeDisplayResult(options, state, next, deferPostProcessing);
        }
      } while (queued || state.pendingResult !== null);
    })().finally(() => {
      promise = null;
    });
    return promise;
  };

  const schedule = () => {
    if (timer !== null || frame !== null) return;
    timer = setTimeout(() => {
      timer = null;
      frame = requestAnimationFrame(() => {
        frame = null;
        void flush().catch((error) => {
          state.flushError ??= error;
          void options.reader.cancel().catch(() => {});
        });
      });
    }, 125);
  };

  return { flush, schedule };
}

function normalizeChunk(value: Record<string, string>) {
  let result = value[Object.keys(value)[0]] || "";
  if (settingsStore.state.removeIncompleteResponse) {
    result = trimUntilPunctuation(result);
  }
  return result;
}

async function readStreamingChunks(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  coalesceDisplay: boolean,
  deferPostProcessing: boolean,
  scheduleFlush: () => void,
) {
  while (!state.streamAborted) {
    let read: ReadableStreamReadResult<Record<string, string>>;
    try {
      read = await options.reader.read();
    } catch (error) {
      if (options.abortSignal.aborted || state.streamAborted) {
        state.streamAborted = true;
        break;
      }
      throw error;
    }

    if (read.value) {
      state.receivedResult = true;
      state.lastResponseChunk = read.value;
      state.result = normalizeChunk(read.value);
      if (coalesceDisplay) {
        state.pendingResult = state.result;
        scheduleFlush();
      } else {
        await writeDisplayResult(
          options,
          state,
          state.result,
          deferPostProcessing,
        );
      }
    }
    if (read.done) break;
  }
}

async function applyFinalPostProcessing(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
) {
  const processed = await processScriptFull(
    options.nowChatroom,
    options.reformatContent(options.prefix + state.result),
    "editoutput",
    options.msgIndex,
  );
  targetMessage(options).data = processed.data;
  state.emoChanged = processed.emoChanged;
}

async function finishStreamingDisplay(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  coalesceDisplay: boolean,
  deferPostProcessing: boolean,
  flush: () => Promise<void>,
) {
  if (coalesceDisplay) {
    try {
      await flush();
    } catch (error) {
      state.flushError ??= error;
    }
  }
  if (state.flushError !== null) throw state.flushError;
  if (deferPostProcessing && state.receivedResult) {
    await applyFinalPostProcessing(options, state);
  }
}

function resetStreamingState(options: StreamDisplayOptions) {
  const chat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  chat.isStreaming = false;
  chat.activeStreamingDisplayOptimizationMode = undefined;
  characterStore.characters[options.selectedChar].reloadKeys += 1;
  void options.reader.cancel().catch(() => {});
}

export async function consumeStreamingDisplay(options: StreamDisplayOptions) {
  const state: StreamDisplayState = {
    result: "",
    emoChanged: false,
    lastResponseChunk: {},
    streamAborted: options.abortSignal.aborted,
    receivedResult: false,
    pendingResult: null,
    flushError: null,
  };
  const deferPostProcessing = options.performanceMode === "strong";
  const coalesceDisplay = options.performanceMode !== "off";
  const controller = createFlushController(
    options,
    state,
    deferPostProcessing,
  );
  const abortReader = () => {
    state.streamAborted = true;
    void options.reader.cancel().catch(() => {});
  };

  options.abortSignal.addEventListener("abort", abortReader, { once: true });
  try {
    await readStreamingChunks(
      options,
      state,
      coalesceDisplay,
      deferPostProcessing,
      controller.schedule,
    );
  } finally {
    options.abortSignal.removeEventListener("abort", abortReader);
    try {
      await finishStreamingDisplay(
        options,
        state,
        coalesceDisplay,
        deferPostProcessing,
        controller.flush,
      );
    } finally {
      resetStreamingState(options);
    }
  }

  return {
    result: state.result,
    emoChanged: state.emoChanged,
    lastResponseChunk: state.lastResponseChunk,
    aborted: state.streamAborted || options.abortSignal.aborted,
  };
}
