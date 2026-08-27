import type { character, groupChat, Chat, MessageGenerationInfo, MessagePresetInfo, StreamingDisplayOptimizationMode } from "../storage/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import type { ChatModelResponse } from "@risuai/chat-core/types.cjs";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { addRerolls } from "./prereroll";
import { runInlayScreen } from "./inlayScreen";
import { sayTTS } from "./tts";
import {
  applyOutputTrigger,
  findMessageIndexByChatId,
  runChatOutputListeners,
} from "./chatResponseShared.svelte";
import { consumeStreamingDisplay } from "./chatStreamingDisplay.svelte";

type StreamingRequest = Extract<ChatModelResponse, { type: "streaming" }>;

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

function getMessages(options: StreamingOptions) {
  return characterStore.characters[options.selectedChar].chats[
    options.selectedChat
  ].message;
}

function prepareStreamingTarget(options: StreamingOptions) {
  const messages = getMessages(options);
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
  return { msgIndex, prefix, outputMessageId: messages[msgIndex]?.chatId };
}

function markStreamingActive(
  options: StreamingOptions,
  performanceMode: StreamingDisplayOptimizationMode,
) {
  const chat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  chat.isStreaming = true;
  chat.activeStreamingDisplayOptimizationMode = performanceMode;
  characterStore.characters[options.selectedChar].reloadKeys += 1;
}

async function applyStreamingInlay(
  options: StreamingOptions,
  currentChat: Chat,
  outputMessageId?: string,
) {
  const messageIndex = findMessageIndexByChatId(currentChat, outputMessageId);
  const outputMessage = currentChat.message[messageIndex];
  if (!outputMessage) return currentChat;

  const inlay = runInlayScreen(options.currentChar, outputMessage.data);
  outputMessage.data = inlay.text;
  characterStore.characters[options.selectedChar].chats[options.selectedChat] =
    currentChat;
  if (!inlay.promise) return currentChat;

  const resolved = await inlay.promise;
  currentChat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  const asyncIndex = findMessageIndexByChatId(currentChat, outputMessageId);
  if (asyncIndex !== -1) {
    currentChat.message[asyncIndex].data = resolved;
    characterStore.characters[options.selectedChar].chats[options.selectedChat] =
      currentChat;
  }
  return currentChat;
}

async function finalizeStreamingOutput(
  options: StreamingOptions,
  result: string,
  outputMessageId?: string,
) {
  const triggered = await applyOutputTrigger(
    options.currentChar,
    options.selectedChar,
    options.selectedChat,
  );
  await applyStreamingInlay(options, triggered.currentChat, outputMessageId);
  const currentChat =
    characterStore.characters[options.selectedChar].chats[options.selectedChat];
  await runChatOutputListeners(
    options.currentChar,
    currentChat,
    options.selectedChar,
    options.selectedChat,
    findMessageIndexByChatId(currentChat, outputMessageId),
  );
  if (settingsStore.state.ttsAutoSpeech) {
    await sayTTS(options.currentChar, result);
  }
  return { currentChat, resendChat: triggered.resendChat };
}

async function streamResponseBody(options: StreamingOptions) {
  const target = prepareStreamingTarget(options);
  const performanceMode: StreamingDisplayOptimizationMode =
    settingsStore.state.streamingDisplayOptimizationMode ?? "off";
  markStreamingActive(options, performanceMode);
  const streamed = await consumeStreamingDisplay({
    reader: options.req.result.getReader(),
    abortSignal: options.abortSignal,
    selectedChar: options.selectedChar,
    selectedChat: options.selectedChat,
    nowChatroom: options.nowChatroom,
    msgIndex: target.msgIndex,
    prefix: target.prefix,
    reformatContent: options.reformatContent,
    performanceMode,
    generationId: options.generationId,
  });
  return { target, streamed };
}

export async function processStreamingResponse(options: StreamingOptions) {
  const { target, streamed } = await streamResponseBody(options);
  if (streamed.aborted) {
    return {
      ok: false as const,
      result: streamed.result,
      emoChanged: streamed.emoChanged,
      resendChat: false,
      currentChat: options.currentChat,
    };
  }

  addRerolls(options.generationId, streamed.rerolls);
  const finalized = await finalizeStreamingOutput(
    options,
    streamed.result,
    target.outputMessageId,
  );
  return {
    ok: true as const,
    result: streamed.result,
    emoChanged: streamed.emoChanged,
    resendChat: finalized.resendChat,
    currentChat: finalized.currentChat,
  };
}
