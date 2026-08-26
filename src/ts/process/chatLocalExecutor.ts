import type { MessageGenerationInfo } from "../storage/database.svelte";
import { language } from "../../lang";
import { chatProcessStage } from "./chatRuntimeState";
import {
  createChatGenerationPlan,
  executeChatModelRequest,
} from "@risuai/chat-core/generation.cjs";
import type { ChatExecutor, ChatSendOptions } from "@risuai/chat-core/executor.cjs";
import type {
  ChatModelResponse,
  ChatStageTimings,
  OpenAIChat,
} from "@risuai/chat-core/types.cjs";
import { createLocalChatGenerationRuntime } from "./chatLocalRuntime";
import { tryCreateNodeChatGenerationPlan } from "./chatNodePlanner";
import { processChatResponse } from "./chatResponse.svelte";
import { finalizeChatGeneration } from "./chatGenerationFinalizer.svelte";
import {
  createChatErrorHandler,
  type ChatErrorContext,
} from "./chatError.svelte";
import { prepareChatSession } from "./chatSession.svelte";
import { buildGenerationPrompt } from "./chatPromptPipeline";
import {
  cancelChatGenerationStats,
  completeChatGenerationStats,
  recordChatGenerationText,
  startChatGenerationStats,
  updateChatGenerationModel,
} from "./chatGenerationStats";

export interface LocalChatExecutorSink {
  setPreviewFormated(chats: OpenAIChat[]): void;
  setPreviewBody(body: string): void;
}

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

export class LocalChatExecutor implements ChatExecutor {
  constructor(private readonly sink: LocalChatExecutorSink) {}

  async execute(
    chatProcessIndex = -1,
    arg: ChatSendOptions = {},
  ): Promise<boolean> {
    const abortSignal = arg.signal ?? new AbortController().signal;
    const errorContext: ChatErrorContext = {
      selectedChar: -1,
      selectedChat: -1,
    };
    const throwError = createChatErrorHandler(errorContext);
    const stageTimings = createStageTimings();
    const generationStartedAt = Date.now();

    const session = await prepareChatSession({
      chatProcessIndex,
      chatAdditonalTokens: arg.chatAdditonalTokens,
      abortSignal,
      errorContext,
      throwError,
      sendGroupMember: ({ chatProcessIndex, chatAdditonalTokens, signal }) =>
        this.execute(chatProcessIndex, {
          chatAdditonalTokens,
          signal,
          targetCharacterId: arg.targetCharacterId,
          targetChatId: arg.targetChatId,
        }),
      targetCharacterId: arg.targetCharacterId,
      targetChatId: arg.targetChatId,
    });
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

    chatProcessStage.set(3);
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
      const firstResponse = req.type === "success" ? req.result : req.result[0]?.[1] ?? "";
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
      continueGeneration: (resultTokens) =>
        this.execute(chatProcessIndex, {
          chatAdditonalTokens: arg.chatAdditonalTokens,
          continue: true,
          signal: abortSignal,
          usedContinueTokens: resultTokens,
          targetCharacterId: arg.targetCharacterId,
          targetChatId: arg.targetChatId,
        }),
      resendGeneration: () =>
        this.execute(chatProcessIndex, {
          signal: abortSignal,
          targetCharacterId: arg.targetCharacterId,
          targetChatId: arg.targetChatId,
        }),
    });
  }
}

export function createLocalChatExecutor(sink: LocalChatExecutorSink): ChatExecutor {
  return new LocalChatExecutor(sink);
}
