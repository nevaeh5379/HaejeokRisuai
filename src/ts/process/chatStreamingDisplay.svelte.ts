import type {
  groupChat,
  character,
  StreamingDisplayOptimizationMode,
} from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { trimUntilPunctuation } from "../util";
import { processScriptFull } from "./scripts";
import { recordChatGenerationText } from "./chatGenerationStats";
import { requireChatTargetFromIndexes } from "../chatTarget";

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
  generationId: string;
  onModelComplete?: () => void;
}

export async function processStreamingRerollValues(
  options: StreamDisplayOptions,
  values: string[],
  currentProcessedValue: string,
) {
  const processedValues = [currentProcessedValue];
  for (const value of values.slice(1)) {
    let result = value;
    if (settingsStore.state.removeIncompleteResponse) {
      result = trimUntilPunctuation(result);
    }
    const processed = await processScriptFull(
      options.nowChatroom,
      options.reformatContent(options.prefix + result),
      "editoutput",
      options.msgIndex,
      {},
      requireChatTargetFromIndexes(options.selectedChar, options.selectedChat),
    );
    processedValues.push(processed.data);
  }
  return processedValues;
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
    targetMessage(options).data = options.reformatContent(
      options.prefix + result,
    );
  } else {
    const processed = await processScriptFull(
      options.nowChatroom,
      options.reformatContent(options.prefix + result),
      "editoutput",
      options.msgIndex,
      {},
      requireChatTargetFromIndexes(options.selectedChar, options.selectedChat),
    );
    targetMessage(options).data = processed.data;
    state.emoChanged = processed.emoChanged;
  }
  characterStore.characters[options.selectedChar].reloadKeys += 1;
}

interface FlushRuntime {
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  promise: Promise<void> | null;
  queued: boolean;
}

function clearFlushSchedule(runtime: FlushRuntime) {
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  if (runtime.frame !== null) cancelAnimationFrame(runtime.frame);
  runtime.timer = null;
  runtime.frame = null;
}

function flushPendingResults(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  runtime: FlushRuntime,
  deferPostProcessing: boolean,
) {
  clearFlushSchedule(runtime);
  if (runtime.promise) {
    runtime.queued = true;
    return runtime.promise;
  }

  runtime.promise = (async () => {
    do {
      runtime.queued = false;
      const next = state.pendingResult;
      state.pendingResult = null;
      if (next !== null) {
        await writeDisplayResult(options, state, next, deferPostProcessing);
      }
    } while (runtime.queued || state.pendingResult !== null);
  })().finally(() => {
    runtime.promise = null;
  });
  return runtime.promise;
}

function scheduleDisplayFlush(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  runtime: FlushRuntime,
  flush: () => Promise<void>,
) {
  if (runtime.timer !== null || runtime.frame !== null) return;
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    runtime.frame = requestAnimationFrame(() => {
      runtime.frame = null;
      void flush().catch((error) => {
        state.flushError ??= error;
        void options.reader.cancel().catch(() => {});
      });
    });
  }, 125);
}

function createFlushController(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  deferPostProcessing: boolean,
) {
  const runtime: FlushRuntime = {
    timer: null,
    frame: null,
    promise: null,
    queued: false,
  };
  const flush = () =>
    flushPendingResults(options, state, runtime, deferPostProcessing);
  const schedule = () => scheduleDisplayFlush(options, state, runtime, flush);
  return { flush, schedule };
}

function normalizeChunk(value: Record<string, string>) {
  let result = value[Object.keys(value)[0]] || "";
  if (settingsStore.state.removeIncompleteResponse) {
    result = trimUntilPunctuation(result);
  }
  return result;
}

async function readNextStreamingChunk(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
) {
  try {
    return await options.reader.read();
  } catch (error) {
    if (options.abortSignal.aborted || state.streamAborted) {
      state.streamAborted = true;
      return null;
    }
    throw error;
  }
}

async function applyStreamingChunk(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  value: Record<string, string>,
  coalesceDisplay: boolean,
  deferPostProcessing: boolean,
  scheduleFlush: () => void,
) {
  state.receivedResult = true;
  state.lastResponseChunk = value;
  state.result = normalizeChunk(value);
  recordChatGenerationText(options.generationId, state.result);
  if (coalesceDisplay) {
    state.pendingResult = state.result;
    scheduleFlush();
    return;
  }
  await writeDisplayResult(options, state, state.result, deferPostProcessing);
}

async function readStreamingChunks(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
  coalesceDisplay: boolean,
  deferPostProcessing: boolean,
  scheduleFlush: () => void,
) {
  while (!state.streamAborted) {
    const read = await readNextStreamingChunk(options, state);
    if (!read) break;
    if (read.value) {
      await applyStreamingChunk(
        options,
        state,
        read.value,
        coalesceDisplay,
        deferPostProcessing,
        scheduleFlush,
      );
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
    {},
    requireChatTargetFromIndexes(options.selectedChar, options.selectedChat),
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

function createStreamDisplayState(
  options: StreamDisplayOptions,
): StreamDisplayState {
  return {
    result: "",
    emoChanged: false,
    lastResponseChunk: {},
    streamAborted: options.abortSignal.aborted,
    receivedResult: false,
    pendingResult: null,
    flushError: null,
  };
}

function createAbortReader(
  options: StreamDisplayOptions,
  state: StreamDisplayState,
) {
  return () => {
    state.streamAborted = true;
    void options.reader.cancel().catch(() => {});
  };
}

export async function consumeStreamingDisplay(options: StreamDisplayOptions) {
  const state = createStreamDisplayState(options);
  const deferPostProcessing = options.performanceMode === "strong";
  const coalesceDisplay = options.performanceMode !== "off";
  const controller = createFlushController(options, state, deferPostProcessing);
  const abortReader = createAbortReader(options, state);

  options.abortSignal.addEventListener("abort", abortReader, { once: true });
  try {
    await readStreamingChunks(
      options,
      state,
      coalesceDisplay,
      deferPostProcessing,
      controller.schedule,
    );
    if (!state.streamAborted && !options.abortSignal.aborted) {
      // Final display scripts and output triggers may call auxiliary models.
      // They belong to post-processing, after the main response has ended.
      options.onModelComplete?.();
    }
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

  const aborted = state.streamAborted || options.abortSignal.aborted;
  const rerolls = aborted
    ? []
    : await processStreamingRerollValues(
        options,
        Object.values(state.lastResponseChunk),
        targetMessage(options)?.data ?? "",
      );

  return {
    result: state.result,
    emoChanged: state.emoChanged,
    lastResponseChunk: state.lastResponseChunk,
    rerolls,
    aborted,
  };
}
