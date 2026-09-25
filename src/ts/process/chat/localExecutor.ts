import type { MessageGenerationInfo } from "../../storage/database/schema";
import { language } from "../../../lang";
import { setChatProcessStage } from "./runtimeState";
import {
  createChatGenerationPlan,
  executeChatModelRequest,
} from "@risuai/chat-core/generation.cjs";
import type {
  ChatExecutor,
  ChatSendOptions,
} from "@risuai/chat-core/executor.cjs";
import type {
  ChatModelResponse,
  ChatStageTimings,
  OpenAIChat,
} from "@risuai/chat-core/types.cjs";
import { createLocalChatGenerationRuntime } from "./localRuntime";
import { requireChatTargetFromIndexes } from "../../chatTarget";
import { tryCreateNodeChatGenerationPlan } from "./nodePlanner";
import { processChatResponse } from "./response.svelte";
import { finalizeChatGeneration } from "./generationFinalizer.svelte";
import { createChatErrorHandler, type ChatErrorContext } from "./error.svelte";
import { prepareChatSession } from "./session.svelte";
import { LocalPrepareChatSessionOptions } from "./localSessionOptions";
import { buildGenerationPrompt } from "./promptPipeline";
import {
  cancelChatGenerationStats,
  completeChatGenerationStats,
  recordChatGenerationText,
  startChatGenerationStats,
  updateChatGenerationModel,
} from "./generationStats";

export interface LocalChatExecutorSink {
  /**
   * 미리보기용으로 구성된 채팅 메시지를 전달합니다.
   * Passes the prepared chat messages to the preview UI.
   *
   * @param chats - 미리볼 채팅 메시지 목록 / Chat messages to preview.
   */
  setPreviewFormated(chats: OpenAIChat[]): void;

  /**
   * 요청 본문 미리보기 결과를 전달합니다.
   * Passes the request body preview to the UI.
   *
   * @param body - 미리볼 요청 본문 / Request body to preview.
   */
  setPreviewBody(body: string): void;
}

/**
 * 채팅 생성의 네 단계 시작 시각과 소요 시간을 0으로 초기화합니다.
 * Initializes the start times and durations of the four generation stages to zero.
 *
 * @returns 초기화된 단계별 시간 기록 / Initialized stage timing record.
 */
function createStageTimings(): ChatStageTimings {
  return {
    stage1Start: 0,
    stage2Start: 0,
    stage3Start: 0,
    stage4Start: 0,
    stage1Duration: 0,
    stage2Duration: 0,
    stage3Duration: 0,
    stage4Duration: 0,
  };
}

/**
 * 로컬 런타임으로 채팅 생성을 준비하고 실행한 뒤 응답을 반영합니다.
 * Prepares and runs chat generation through the local runtime, then applies the response.
 */
export class LocalChatExecutor implements ChatExecutor {
  /**
   * 미리보기 결과를 전달할 대상을 보관합니다.
   * Stores the destination for preview results.
   *
   * @param sink - 미리보기 결과 수신자 / Receiver of preview results.
   */
  constructor(private readonly sink: LocalChatExecutorSink) {}

  /**
   * 세션과 프롬프트를 준비하고, 모델 요청 및 응답 처리와 생성을 마무리합니다.
   * Prepares the session and prompt, requests the model, processes its response, and finalizes generation.
   * 미리보기에서는 결과를 sink에 전달하고, 취소 또는 처리 실패 시 일찍 종료합니다.
   * In preview mode, sends the result to the sink; cancellation or failure ends the run early.
   *
   * @param chatProcessIndex - 그룹 채팅 생성 순서. -1은 일반 생성을 뜻합니다 / Group generation index; -1 means a regular generation.
   * @param arg - 이어쓰기, 미리보기, 취소 신호와 대상 채팅 등의 실행 옵션 / Options for continuation, preview, cancellation, and the target chat.
   * @returns 생성 또는 미리보기가 성공적으로 완료되었는지 여부 / Whether generation or preview completed successfully.
   */
  async execute(
    chatProcessIndex = -1,
    arg: ChatSendOptions = {},
  ): Promise<boolean> {
    const abortSignal = arg.signal ?? new AbortController().signal;
    const errorContext: ChatErrorContext = {
      selectedChar: -1,
      selectedChat: -1,
      targetChatId: arg.targetChatId,
    };
    const throwError = createChatErrorHandler(errorContext);
    const stageTimings = createStageTimings();
    const generationStartedAt = Date.now();

    const session = await prepareChatSession(
      new LocalPrepareChatSessionOptions({
        chatProcessIndex,
        arg,
        abortSignal,
        errorContext,
        throwError,
        execute: (index, options) => this.execute(index, options),
      }),
    );
    if (session.status === "done") return session.result;

    const {
      selectedChar,
      selectedChat,
      nowChatroom,
      currentChar,
      promptInfo,
      tokenizer,
      maxContextTokens,
      findCharacter,
    } = session;
    let currentChat = session.currentChat;
    let generationInfo: MessageGenerationInfo | undefined;

    const prompt = await buildGenerationPrompt({
      currentChar,
      currentChat,
      nowChatroom,
      tokenizer,
      maxContextTokens,
      selectedChar,
      selectedChat,
      stageTimings,
      promptInfo,
      continued: arg.continue,
      findCharacter,
      throwError,
    });
    if (!prompt.ok) return false;
    currentChat = prompt.currentChat;

    const runtime = createLocalChatGenerationRuntime(tokenizer);
    const plan =
      (await tryCreateNodeChatGenerationPlan({
        formated: prompt.formated,
        maxContextTokens,
        tokenizer,
        runtime,
      })) ??
      (await createChatGenerationPlan(runtime, {
        formated: prompt.formated,
        maxContextTokens,
      }));
    if (plan.ok === false) {
      throwError(
        language.errors.toomuchtoken +
          "\n\nAt token rechecking. Required Tokens: " +
          plan.requiredTokens,
      );
      return false;
    }
    if (abortSignal.aborted) return false;

    const { generationId, generationModel, inputTokens, outputTokens } = plan;
    generationInfo = {
      model: generationModel,
      generationId,
      inputTokens,
      outputTokens,
      maxContext: maxContextTokens,
      stageTiming: {
        stage1: stageTimings.stage1Duration,
        stage2: stageTimings.stage2Duration,
        stage3: 0,
        stage4: 0,
      },
    };
    errorContext.generationInfo = generationInfo;

    setChatProcessStage(currentChat.id, 3);
    stageTimings.stage3Start = Date.now();
    if (arg.preview) {
      this.sink.setPreviewFormated(plan.formated);
      return true;
    }

    const trackGeneration = !arg.previewPrompt;
    if (trackGeneration) {
      startChatGenerationStats({
        generationId,
        selectedChar,
        selectedChat,
        model: generationModel,
        startedAt: generationStartedAt,
      });
    }

    let req: ChatModelResponse;
    try {
      req = await executeChatModelRequest(
        runtime,
        {
          plan,
          biases: prompt.biases,
          triggerTarget: requireChatTargetFromIndexes(
            selectedChar,
            selectedChat,
          ),
          currentChar,
          isGroupChat: nowChatroom.type === "group",
          continueGeneration: arg.continue,
          previewBody: arg.previewPrompt,
          escape: nowChatroom.type === "character" && nowChatroom.escapeOutput,
          durableChatId: currentChat.id,
          speakerId: currentChar.chaId,
        },
        abortSignal,
      );
    } catch (error) {
      if (trackGeneration) cancelChatGenerationStats(generationId);
      throw error;
    }
    if (abortSignal.aborted) {
      if (trackGeneration) cancelChatGenerationStats(generationId);
      return false;
    }

    console.log(req);
    if (req.model) {
      generationInfo.model = runtime.getGenerationModel(req.model);
      if (trackGeneration) {
        updateChatGenerationModel(generationId, generationInfo.model);
      }
      console.log(generationInfo.model, req.model);
    }

    if (arg.previewPrompt && req.type === "success") {
      this.sink.setPreviewBody(req.result);
      return true;
    }

    if (trackGeneration && req.type !== "streaming" && req.type !== "fail") {
      const firstResponse =
        req.type === "success" ? req.result : (req.result[0]?.[1] ?? "");
      recordChatGenerationText(
        generationId,
        firstResponse,
        Date.now(),
        stageTimings.stage3Start,
      );
    }

    let response: Awaited<ReturnType<typeof processChatResponse>>;
    try {
      response = await processChatResponse({
        req,
        abortSignal,
        selectedChar,
        selectedChat,
        currentChar,
        nowChatroom,
        currentChat,
        continueGeneration: arg.continue,
        generationInfo,
        promptInfo,
        generationId,
        /**
         * 모델 응답 완료 시 3단계 시간을 기록하고 후처리 단계로 전환합니다.
         * Records stage three timing and switches to postprocessing when the model completes.
         */
        onModelComplete: () => {
          const completedAt = Date.now();
          stageTimings.stage3Duration = completedAt - stageTimings.stage3Start;
          if (generationInfo.stageTiming) {
            generationInfo.stageTiming.stage3 = stageTimings.stage3Duration;
          }
          stageTimings.stage4Start = completedAt;
          setChatProcessStage(currentChat.id, 4);
        },
        /**
         * 응답 내용의 앞뒤 공백을 제거합니다.
         * Trims leading and trailing whitespace from response content.
         *
         * @param data - 원본 응답 내용 / Original response content.
         * @returns 공백을 제거한 내용 / Trimmed content.
         */
        reformatContent: (data) => data.trim(),
        throwError,
      });
    } catch (error) {
      if (trackGeneration) cancelChatGenerationStats(generationId);
      throw error;
    }
    if (!response.ok) {
      if (trackGeneration) cancelChatGenerationStats(generationId);
      return false;
    }

    if (trackGeneration) {
      completeChatGenerationStats(generationId, response.result);
    }

    currentChat = response.currentChat;
    return finalizeChatGeneration({
      req,
      result: response.result,
      emoChanged: response.emoChanged,
      resendChat: response.resendChat,
      selectedChar,
      selectedChat,
      chatProcessIndex,
      currentChar,
      generationInfo,
      stageTimings,
      abortSignal,
      usedContinueTokens: arg.usedContinueTokens,
      chatAdditonalTokens: arg.chatAdditonalTokens,
      throwError,
      /**
       * 기존 취소 신호와 채팅 대상을 유지하며 이어쓰기를 실행합니다.
       * Continues generation with the same cancellation signal and chat target.
       *
       * @param resultTokens - 이어쓰기 판단에 사용할 누적 출력 토큰 수 / Accumulated output tokens used for continuation.
       * @returns 이어쓰기 실행 결과 / Continuation result.
       */
      continueGeneration: (resultTokens) =>
        this.execute(chatProcessIndex, {
          chatAdditonalTokens: arg.chatAdditonalTokens,
          continue: true,
          signal: abortSignal,
          usedContinueTokens: resultTokens,
          targetCharacterId: arg.targetCharacterId,
          targetChatId: arg.targetChatId,
        }),
      /**
       * 기존 취소 신호와 채팅 대상을 유지하며 생성을 다시 요청합니다.
       * Requests generation again with the same cancellation signal and chat target.
       *
       * @returns 재요청 실행 결과 / Retry result.
       */
      resendGeneration: () =>
        this.execute(chatProcessIndex, {
          signal: abortSignal,
          targetCharacterId: arg.targetCharacterId,
          targetChatId: arg.targetChatId,
        }),
    });
  }
}

/**
 * 지정한 미리보기 수신자에 연결된 로컬 채팅 실행기를 만듭니다.
 * Creates a local chat executor connected to the given preview sink.
 *
 * @param sink - 미리보기 결과 수신자 / Receiver of preview results.
 * @returns 채팅 실행기 인터페이스 / Chat executor interface.
 */
export function createLocalChatExecutor(
  sink: LocalChatExecutorSink,
): ChatExecutor {
  return new LocalChatExecutor(sink);
}
