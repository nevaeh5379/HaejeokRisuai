import type {
  character,
  groupChat,
  Chat,
  MessageGenerationInfo,
  MessagePresetInfo,
} from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import type { ChatModelResponse } from "@risuai/chat-core/types.cjs";
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
import { requireChatTargetFromIndexes } from "../chatTarget";

type NonStreamingRequest = Exclude<
  ChatModelResponse,
  { type: "streaming" } | { type: "fail" }
>;

type ResponseTuple = readonly [string, string];

interface NonStreamingOptions {
  req: NonStreamingRequest;
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

function getResponses(req: NonStreamingRequest): readonly ResponseTuple[] {
  if (req.type === "success") return [["char", req.result]];
  if (req.type === "multiline") return req.result;
  return [];
}

function getMessages(options: NonStreamingOptions) {
  return characterStore.characters[options.selectedChar].chats[
    options.selectedChat
  ].message;
}

async function processResponseContent(
  options: NonStreamingOptions,
  content: string,
  msgIndex: number,
  previousContent = "",
) {
  let processed = await processScriptFull(
    options.nowChatroom,
    options.reformatContent(previousContent + content),
    "editoutput",
    msgIndex,
    {},
    requireChatTargetFromIndexes(options.selectedChar, options.selectedChat),
  );
  if (settingsStore.state.removeIncompleteResponse) {
    processed.data = trimUntilPunctuation(processed.data);
  }
  const inlay = runInlayScreen(options.currentChar, processed.data);
  return {
    result: inlay.text,
    emoChanged: processed.emoChanged,
    inlayPromise: inlay.promise,
  };
}

function createGeneratedMessage(
  options: NonStreamingOptions,
  role: string,
  data: string,
) {
  return {
    role: role as "char",
    data,
    saying: options.currentChar.chaId,
    time: Date.now(),
    generationInfo: options.generationInfo,
    promptInfo: options.promptInfo,
    chatId: options.generationId,
  };
}

async function storeFirstResponse(
  options: NonStreamingOptions,
  response: ResponseTuple,
  result: string,
  inlayPromise?: Promise<string>,
) {
  const messages = getMessages(options);
  if (options.continueGeneration) {
    const index = messages.length - 1;
    messages[index] = createGeneratedMessage(options, "char", result);
    if (inlayPromise) messages[index].data = await inlayPromise;
    return messages[index]?.chatId;
  }

  messages.push(createGeneratedMessage(options, response[0], result));
  const index = messages.length - 1;
  if (inlayPromise) messages[index].data = await inlayPromise;
  return messages[index]?.chatId;
}

async function processSingleResponse(
  options: NonStreamingOptions,
  response: ResponseTuple,
  index: number,
) {
  const messages = getMessages(options);
  const isContinuation = index === 0 && !!options.continueGeneration;
  const msgIndex = isContinuation ? messages.length - 1 : messages.length;
  const previousContent = isContinuation ? messages[msgIndex].data : "";
  return processResponseContent(
    options,
    response[1],
    msgIndex,
    previousContent,
  );
}

async function notifyOutputListener(
  options: NonStreamingOptions,
  currentChat: Chat,
  outputMessageId?: string,
) {
  if (!outputMessageId) return;
  await runChatOutputListeners(
    options.currentChar,
    currentChat,
    options.selectedChar,
    options.selectedChat,
    findMessageIndexByChatId(currentChat, outputMessageId),
  );
}

async function consumeNonStreamingResponses(
  options: NonStreamingOptions,
  responses: readonly ResponseTuple[],
) {
  const rerolls: string[] = [];
  let result = "";
  let emoChanged = false;
  let outputMessageId: string | undefined;

  for (let index = 0; index < responses.length; index++) {
    const processed = await processSingleResponse(
      options,
      responses[index],
      index,
    );
    result = processed.result;
    emoChanged = processed.emoChanged;
    if (index === 0) {
      outputMessageId = await storeFirstResponse(
        options,
        responses[index],
        result,
        processed.inlayPromise,
      );
      if (!options.continueGeneration) rerolls.push(result);
    } else {
      rerolls.push(result);
    }
    characterStore.characters[options.selectedChar].reloadKeys += 1;
    if (settingsStore.state.ttsAutoSpeech) {
      await sayTTS(options.currentChar, result);
    }
  }
  return { rerolls, result, emoChanged, outputMessageId };
}

export async function processNonStreamingResponse(
  options: NonStreamingOptions,
) {
  const consumed = await consumeNonStreamingResponses(
    options,
    getResponses(options.req),
  );
  if (consumed.rerolls.length > 1) {
    addRerolls(options.generationId, consumed.rerolls);
  }
  const triggered = await applyOutputTrigger(
    options.currentChar,
    options.selectedChar,
    options.selectedChat,
  );
  await notifyOutputListener(
    options,
    triggered.currentChat,
    consumed.outputMessageId,
  );
  return {
    ok: true as const,
    result: consumed.result,
    emoChanged: consumed.emoChanged,
    resendChat: triggered.resendChat,
    currentChat: triggered.currentChat,
  };
}
