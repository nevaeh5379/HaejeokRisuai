import type {
  character,
  MessageGenerationInfo,
} from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { tokenize } from "../tokenizer";
import { parseChatML } from "../parser/chatML";
import { requestChatData } from "./request/request";
import type { ChatModelResponse, ChatStageTimings } from "@risuai/chat-core/types.cjs";
import {
  decideAutoContinuation,
  endsWithCompletionPunctuation,
} from "@risuai/chat-core/finalization.cjs";
import { risuChatParser } from "./scripts";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
import { peerSync } from "../sync/multiuser";
import { processPostGenerationEffects } from "./chatPostGeneration.svelte";
import { tryCreateNodeAutoContinuationDecision } from "./chatNodePlanner";


function updateGenerationStageTimings(
  generationInfo: MessageGenerationInfo,
  timings: ChatStageTimings,
) {
  if (!generationInfo.stageTiming) return;
  generationInfo.stageTiming.stage1 = timings.stage1Duration;
  generationInfo.stageTiming.stage2 = timings.stage2Duration;
  generationInfo.stageTiming.stage3 = timings.stage3Duration;
  generationInfo.stageTiming.stage4 = timings.stage4Duration;
}

async function shouldAutoContinue(
  result: string,
  usedContinueTokens: number,
) {
  const minimumTokens = settingsStore.state.autoContinueMinTokens;
  const continueIncomplete = settingsStore.state.autoContinueChat;
  const remote = await tryCreateNodeAutoContinuationDecision(
    result,
    usedContinueTokens,
    minimumTokens,
    continueIncomplete,
  );
  if (remote) return remote;

  const resultTokens = (await tokenize(result)) + usedContinueTokens;
  return decideAutoContinuation({
    resultTokens,
    minimumTokens,
    continueIncomplete,
    endsWithPunctuation: endsWithCompletionPunctuation(result),
  });
}

async function appendIgpResult(
  selectedChar: number,
  selectedChat: number,
  abortSignal: AbortSignal,
) {
  const igp = risuChatParser(settingsStore.state.igpPrompt ?? "");
  if (!igp) return;

  const response = await requestChatData(
    {
      formated: parseChatML(igp),
      bias: {},
    },
    "emotion",
    abortSignal,
  );
  const messages =
    characterStore.characters[selectedChar].chats[selectedChat].message;
  messages[messages.length - 1].data += response;
}

async function showGenerationNotification(result: string) {
  if (!settingsStore.state.notification) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const notification = new Notification("Risuai", { body: result });
    notification.onclick = () => window.focus();
  } catch (_error) {}
}

function attachGenerationInfoToLastMessage(
  selectedChar: number,
  selectedChat: number,
  generationInfo: MessageGenerationInfo,
) {
  const messages =
    characterStore.characters[selectedChar].chats[selectedChat].message;
  const lastMessage = messages.at(-1);
  if (lastMessage?.generationInfo) {
    lastMessage.generationInfo = generationInfo;
  }
}

function commitRecentMessages(selectedChar: number, selectedChat: number) {
  const chat = characterStore.characters[selectedChar]?.chats?.[selectedChat];
  if (!chat?.id) return;

  const messages = (chat.message ?? []).slice(-2);
  if (messages.length === 0) return;
  void messageStore.commitMessages(chat.id, messages).catch((error) => {
    console.error("[requestProcess] Failed to commit chat messages:", error);
  });
}

export interface FinalizeChatGenerationOptions {
  req: ChatModelResponse;
  result: string;
  emoChanged: boolean;
  resendChat: boolean;
  selectedChar: number;
  selectedChat: number;
  chatProcessIndex: number;
  currentChar: character;
  generationInfo: MessageGenerationInfo;
  stageTimings: ChatStageTimings;
  abortSignal: AbortSignal;
  usedContinueTokens?: number;
  chatAdditonalTokens?: number;
  throwError: (error: string) => void;
  continueGeneration: (resultTokens: number) => Promise<boolean>;
  resendGeneration: () => Promise<boolean>;
}

function startPostGenerationStage(options: FinalizeChatGenerationOptions) {
  options.stageTimings.stage3Duration =
    Date.now() - options.stageTimings.stage3Start;
  if (options.generationInfo.stageTiming) {
    options.generationInfo.stageTiming.stage3 =
      options.stageTimings.stage3Duration;
  }
  chatProcessStage.set(4);
  options.stageTimings.stage4Start = Date.now();
}

async function handleResend(options: FinalizeChatGenerationOptions) {
  if (!options.resendChat) return null;
  options.stageTimings.stage4Duration =
    Date.now() - options.stageTimings.stage4Start;
  updateGenerationStageTimings(options.generationInfo, options.stageTimings);
  attachGenerationInfoToLastMessage(
    options.selectedChar,
    options.selectedChat,
    options.generationInfo,
  );
  doingChat.set(false);
  return options.resendGeneration();
}

async function runFinalEffects(options: FinalizeChatGenerationOptions) {
  await showGenerationNotification(options.result);
  void peerSync();
  return processPostGenerationEffects({
    req: options.req,
    currentChar: options.currentChar,
    selectedChar: options.selectedChar,
    selectedChat: options.selectedChat,
    chatProcessIndex: options.chatProcessIndex,
    result: options.result,
    emoChanged: options.emoChanged,
    abortSignal: options.abortSignal,
    throwError: options.throwError,
  });
}

function completeGeneration(options: FinalizeChatGenerationOptions) {
  options.stageTimings.stage4Duration =
    Date.now() - options.stageTimings.stage4Start;
  updateGenerationStageTimings(options.generationInfo, options.stageTimings);
  commitRecentMessages(options.selectedChar, options.selectedChat);
}

export async function finalizeChatGeneration(
  options: FinalizeChatGenerationOptions,
): Promise<boolean> {
  const continuation = await shouldAutoContinue(
    options.result,
    options.usedContinueTokens ?? 0,
  );
  if (continuation.shouldContinue) {
    doingChat.set(false);
    return options.continueGeneration(continuation.resultTokens);
  }

  await appendIgpResult(
    options.selectedChar,
    options.selectedChat,
    options.abortSignal,
  );
  startPostGenerationStage(options);
  const resendResult = await handleResend(options);
  if (resendResult !== null) return resendResult;

  const effects = await runFinalEffects(options);
  if (effects.returnEarly) return true;
  completeGeneration(options);
  return true;
}
