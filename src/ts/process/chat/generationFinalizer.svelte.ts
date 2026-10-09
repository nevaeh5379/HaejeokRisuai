import type {
  character,
  MessageGenerationInfo,
} from "../../storage/database/schema";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { messageStore } from "../../stores/domain/messageStore.svelte";
import { tokenize } from "../../tokenizer";
import { parseChatML } from "../../parser/chatML";
import { requestChatData } from "../request/chatRequestOrchestrator";
import type {
  ChatModelResponse,
  ChatStageTimings,
} from "@risuai/chat-core/types.ts";
import {
  decideAutoContinuation,
  endsWithCompletionPunctuation,
} from "@risuai/chat-core/finalization.ts";
import { risuChatParser } from "../scripts";
import { peerSync } from "../../sync/multiuser";
import { processPostGenerationEffects } from "./postGeneration.svelte";
import { tryCreateNodeAutoContinuationDecision } from "./nodePlanner";
import { notifyChatResponse } from "../../chatNotifications";
import { requireChatTargetFromIndexes } from "../../chatTarget";
import type {
  IllustrationContext,
  IllustrationTarget,
} from "@risuai/protocol/dist/illustration.mjs";

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

async function shouldAutoContinue(result: string, usedContinueTokens: number) {
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
  currentChar: character,
  abortSignal: AbortSignal,
) {
  const chatTarget = requireChatTargetFromIndexes(selectedChar, selectedChat);
  const igp = risuChatParser(settingsStore.state.igpPrompt ?? "", {
    chara: currentChar,
    chatTarget,
  });
  if (!igp) return;

  const response = await requestChatData(
    {
      formated: parseChatML(igp),
      bias: {},
      currentChar,
      triggerTarget: chatTarget,
    },
    "emotion",
    abortSignal,
  );
  const messages =
    characterStore.characters[selectedChar].chats[selectedChat].message;
  messages[messages.length - 1].data += response;
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
  /**
   * Carries the completed request's scene strings without retaining its full session.
   *
   * 한국어: 전체 세션을 보관하지 않고 완료 요청의 장면 문자열만 전달하는 문맥.
   */
  illustrationContext?: IllustrationContext;
  /**
   * Identifies the final answer independently of later selection changes.
   *
   * 한국어: 이후 선택 변경과 무관하게 최종 답변을 지정하는 안정적인 대상 ID.
   */
  illustrationTarget?: Omit<IllustrationTarget, "illustrationId">;
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
  return options.resendGeneration();
}

async function runFinalEffects(options: FinalizeChatGenerationOptions) {
  const notificationChat = options.currentChar.chats?.[options.selectedChat];
  await notifyChatResponse({
    chatId: notificationChat?.id,
    characterId: options.currentChar.chaId,
    characterName: options.currentChar.name,
    chatName: notificationChat?.name,
    result: options.result,
    dedupeKey: options.generationInfo.generationId
      ? `local:${options.generationInfo.generationId}`
      : undefined,
    completeNativeLifecycle: true,
  });
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

/**
 * Handles continuation/resend decisions, completes chat effects and schedules eligible illustrations.
 *
 * 한국어: 이어쓰기·재전송 판단과 채팅 후처리를 끝내고 삽화 작업을 예약하는 함수.
 *
 * @param options - Response, lifecycle hooks and captured final-answer target/context. / 응답·생성 수명 주기 함수·캡처한 최종 답변 대상 및 문맥.
 * @returns The lifecycle result, including any delegated continuation/resend result. / 이어쓰기·재전송 처리 결과를 포함한 생성 수명 주기 결과.
 * @remarks
 * Illustration scheduling occurs only after all continuations and final effects, and is not awaited.
 * It therefore does not hold the main chat busy while images are generated.
 * 한국어: 모든 이어쓰기·최종 후처리가 끝난 뒤 삽화를 예약하며 이미지 완료는 기다리지 않는 방식.
 * 그림 생성이 메인 채팅의 처리 중 상태를 계속 유지하지 않도록 분리.
 */
export async function finalizeChatGeneration(
  options: FinalizeChatGenerationOptions,
): Promise<boolean> {
  const continuation = await shouldAutoContinue(
    options.result,
    options.usedContinueTokens ?? 0,
  );
  if (continuation.shouldContinue) {
    return options.continueGeneration(continuation.resultTokens);
  }

  await appendIgpResult(
    options.selectedChar,
    options.selectedChat,
    options.currentChar,
    options.abortSignal,
  );
  const resendResult = await handleResend(options);
  if (resendResult !== null) return resendResult;

  const effects = await runFinalEffects(options);
  if (effects.returnEarly) return true;
  completeGeneration(options);
  if (
    options.illustrationContext &&
    options.illustrationTarget &&
    !options.abortSignal.aborted
  ) {
    const target = options.illustrationTarget;
    // Capture strings from this request only; queueing must not retain the session/database.
    const context = options.illustrationContext;
    void import("../illustration/illustrationApp")
      .then(({ enqueueAnswerIllustrations }) =>
        enqueueAnswerIllustrations(target, context),
      )
      .catch((error) => console.error("Illustration scheduling failed", error));
  }
  return true;
}
