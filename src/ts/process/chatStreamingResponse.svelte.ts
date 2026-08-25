import type {
  character,
  groupChat,
  Chat,
  MessageGenerationInfo,
  MessagePresetInfo,
  StreamingDisplayOptimizationMode,
} from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { processScriptFull } from "./scripts";
import { addRerolls } from "./prereroll";
import { runInlayScreen } from "./inlayScreen";
import { sayTTS } from "./tts";
import { trimUntilPunctuation } from "../util";
import {
  applyOutputTrigger,
  findMessageIndexByChatId,
  runChatOutputListeners,
} from "./chatResponseShared.svelte";

type StreamingRequest = Extract<
  Awaited<ReturnType<typeof import("./request/request").requestChatData>>,
  { type: "streaming" }
>;

interface StreamingOptions {
  req: StreamingRequest;
  abortSignal: AbortSignal;
  selectedChar: number;
  selectedChat: number;
  currentChar: character;
  nowChatroom: character | groupChat;
  currentChat: Chat;
  continueGeneration?: boolean;
  generationInfo: MessageGenerationInfo;
  promptInfo: MessagePresetInfo;
  generationId: string;
  reformatContent: (data: string) => string;
}

interface StreamDisplayOptions {
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

async function consumeStreamingDisplay(options: StreamDisplayOptions) {
  let result = "";
  let emoChanged = false;
  let lastResponseChunk: { [key: string]: string } = {};
  let streamAborted = options.abortSignal.aborted;
  let receivedStreamingResult = false;
  const deferPostProcessing = options.performanceMode === "strong";
  const coalesceDisplay =
    options.performanceMode === "balanced" ||
    options.performanceMode === "strong";
  let pendingResult: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushFrame: number | null = null;
  let flushPromise: Promise<void> | null = null;
  let flushQueued = false;
  let flushError: unknown = null;

  const clearSchedule = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushFrame !== null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
    }
  };

  const flush = async () => {
    clearSchedule();
    if (flushPromise) {
      flushQueued = true;
      return flushPromise;
    }
    flushPromise = (async () => {
      do {
        flushQueued = false;
        const nextResult = pendingResult;
        pendingResult = null;
        if (nextResult === null) continue;
        if (deferPostProcessing) {
          characterStore.characters[options.selectedChar].chats[
            options.selectedChat
          ].message[options.msgIndex].data = options.reformatContent(
            options.prefix + nextResult,
          );
        } else {
          const processed = await processScriptFull(
            options.nowChatroom,
            options.reformatContent(options.prefix + nextResult),
            "editoutput",
            options.msgIndex,
          );
          characterStore.characters[options.selectedChar].chats[
            options.selectedChat
          ].message[options.msgIndex].data = processed.data;
          emoChanged = processed.emoChanged;
        }
        characterStore.characters[options.selectedChar].reloadKeys += 1;
      } while (flushQueued || pendingResult !== null);
    })().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  };

  const scheduleFlush = () => {
    if (flushTimer !== null || flushFrame !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = null;
        void flush().catch((error) => {
          flushError ??= error;
          void options.reader.cancel().catch(() => {});
        });
      });
    }, 125);
  };

  const abortReader = () => {
    streamAborted = true;
    void options.reader.cancel().catch(() => {});
  };
  options.abortSignal.addEventListener("abort", abortReader, { once: true });

  try {
    while (!streamAborted) {
      let read: ReadableStreamReadResult<{ [key: string]: string }>;
      try {
        read = await options.reader.read();
      } catch (error) {
        if (options.abortSignal.aborted || streamAborted) {
          streamAborted = true;
          break;
        }
        throw error;
      }

      if (read.value) {
        receivedStreamingResult = true;
        lastResponseChunk = read.value;
        result = lastResponseChunk[Object.keys(lastResponseChunk)[0]] || "";
        if (settingsStore.state.removeIncompleteResponse) {
          result = trimUntilPunctuation(result);
        }
        if (coalesceDisplay) {
          pendingResult = result;
          scheduleFlush();
        } else {
          const processed = await processScriptFull(
            options.nowChatroom,
            options.reformatContent(options.prefix + result),
            "editoutput",
            options.msgIndex,
          );
          characterStore.characters[options.selectedChar].chats[
            options.selectedChat
          ].message[options.msgIndex].data = processed.data;
          emoChanged = processed.emoChanged;
          characterStore.characters[options.selectedChar].reloadKeys += 1;
        }
      }
      if (read.done) break;
    }
  } finally {
    options.abortSignal.removeEventListener("abort", abortReader);
    try {
      if (coalesceDisplay) {
        try {
          await flush();
        } catch (error) {
          flushError ??= error;
        }
      }
      if (flushError !== null) throw flushError;
      if (deferPostProcessing && receivedStreamingResult) {
        const processed = await processScriptFull(
          options.nowChatroom,
          options.reformatContent(options.prefix + result),
          "editoutput",
          options.msgIndex,
        );
        characterStore.characters[options.selectedChar].chats[
          options.selectedChat
        ].message[options.msgIndex].data = processed.data;
        emoChanged = processed.emoChanged;
      }
    } finally {
      const chat =
        characterStore.characters[options.selectedChar].chats[
          options.selectedChat
        ];
      chat.isStreaming = false;
      chat.activeStreamingDisplayOptimizationMode = undefined;
      characterStore.characters[options.selectedChar].reloadKeys += 1;
      void options.reader.cancel().catch(() => {});
    }
  }

  return {
    result,
    emoChanged,
    lastResponseChunk,
    aborted: streamAborted || options.abortSignal.aborted,
  };
}

async function applyStreamingInlay(
  currentChar: character,
  currentChat: Chat,
  selectedChar: number,
  selectedChat: number,
  outputMessageId?: string,
) {
  const messageIndex = findMessageIndexByChatId(currentChat, outputMessageId);
  const outputMessage = currentChat.message[messageIndex];
  if (!outputMessage) return currentChat;

  const inlay = runInlayScreen(currentChar, outputMessage.data);
  outputMessage.data = inlay.text;
  characterStore.characters[selectedChar].chats[selectedChat] = currentChat;
  if (!inlay.promise) return currentChat;

  const resolved = await inlay.promise;
  currentChat = characterStore.characters[selectedChar].chats[selectedChat];
  const asyncIndex = findMessageIndexByChatId(currentChat, outputMessageId);
  if (asyncIndex !== -1) {
    currentChat.message[asyncIndex].data = resolved;
    characterStore.characters[selectedChar].chats[selectedChat] = currentChat;
  }
  return currentChat;
}

export async function processStreamingResponse(options: StreamingOptions) {
  const reader = options.req.result.getReader();
  const messages =
    characterStore.characters[options.selectedChar].chats[options.selectedChat]
      .message;
  let msgIndex = messages.length;
  let prefix = "";
  if (options.continueGeneration) {
    msgIndex -= 1;
    prefix = messages[msgIndex].data;
  } else {
    messages.push({
      role: "char",
      data: "",
      saying: options.currentChar.chaId,
      time: Date.now(),
      generationInfo: options.generationInfo,
      promptInfo: options.promptInfo,
      chatId: options.generationId,
    });
  }

  const outputMessageId = messages[msgIndex]?.chatId;
  const performanceMode: StreamingDisplayOptimizationMode =
    settingsStore.state.streamingDisplayOptimizationMode ?? "off";
  const chat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  chat.isStreaming = true;
  chat.activeStreamingDisplayOptimizationMode = performanceMode;
  characterStore.characters[options.selectedChar].reloadKeys += 1;

  const streamed = await consumeStreamingDisplay({
    reader,
    abortSignal: options.abortSignal,
    selectedChar: options.selectedChar,
    selectedChat: options.selectedChat,
    nowChatroom: options.nowChatroom,
    msgIndex,
    prefix,
    reformatContent: options.reformatContent,
    performanceMode,
  });
  if (streamed.aborted) {
    return {
      ok: false as const,
      result: streamed.result,
      emoChanged: streamed.emoChanged,
      resendChat: false,
      currentChat: options.currentChat,
    };
  }

  addRerolls(options.generationId, Object.values(streamed.lastResponseChunk));
  const triggered = await applyOutputTrigger(
    options.currentChar,
    options.selectedChar,
    options.selectedChat,
  );
  let currentChat = await applyStreamingInlay(
    options.currentChar,
    triggered.currentChat,
    options.selectedChar,
    options.selectedChat,
    outputMessageId,
  );
  currentChat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  await runChatOutputListeners(
    options.currentChar,
    currentChat,
    options.selectedChar,
    options.selectedChat,
    findMessageIndexByChatId(currentChat, outputMessageId),
  );
  if (settingsStore.state.ttsAutoSpeech) {
    await sayTTS(options.currentChar, streamed.result);
  }

  return {
    ok: true as const,
    result: streamed.result,
    emoChanged: streamed.emoChanged,
    resendChat: triggered.resendChat,
    currentChat,
  };
}
