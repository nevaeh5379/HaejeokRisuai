import { writable } from "svelte/store";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import type { MessageGenerationInfo } from "../storage/database.svelte";
import { language } from "../../lang";
import {
  createChatGenerationPlan,
  executeChatModelRequest,
} from "./chat-core/generation";
import { createLocalChatGenerationRuntime } from "./chatLocalRuntime";
import { processChatResponse } from "./chatResponse.svelte";
import { finalizeChatGeneration } from "./chatGenerationFinalizer.svelte";
import type { ChatStageTimings } from "./chat-core/types";
import {
  createChatErrorHandler,
  type ChatErrorContext,
} from "./chatError.svelte";
import { prepareChatSession } from "./chatSession.svelte";
import { buildGenerationPrompt } from "./chatPromptPipeline";

export type { MultiModal, OpenAIChat } from "./chat-core/types";
import type { OpenAIChat } from "./chat-core/types";

export interface requestTokenPart {
  name: string;
  tokens: number;
}

export const abortChat = writable(false);
export let requestTokenParts: { [key: string]: requestTokenPart[] } = {};
export let previewFormated: OpenAIChat[] = [];
export let previewBody: string = "";

export async function sendChat(
  chatProcessIndex = -1,
  arg: {
    chatAdditonalTokens?: number;
    signal?: AbortSignal;
    continue?: boolean;
    usedContinueTokens?: number;
    preview?: boolean;
    previewPrompt?: boolean;
  } = {},
): Promise<boolean> {
  const abortSignal = arg.signal ?? new AbortController().signal;
  const errorContext: ChatErrorContext = {
    selectedChar: -1,
    selectedChat: -1,
  };
  const throwError = createChatErrorHandler(errorContext);
  const stageTimings: ChatStageTimings = {
    stage1Start: 0,
    stage2Start: 0,
    stage3Start: 0,
    stage4Start: 0,
    stage1Duration: 0,
    stage2Duration: 0,
    stage3Duration: 0,
    stage4Duration: 0,
  };

  const session = await prepareChatSession({
    chatProcessIndex,
    chatAdditonalTokens: arg.chatAdditonalTokens,
    abortSignal,
    errorContext,
    throwError,
    sendGroupMember: ({ chatProcessIndex, chatAdditonalTokens, signal }) =>
      sendChat(chatProcessIndex, { chatAdditonalTokens, signal }),
  });
  if (session.status === "done") {
    return session.result;
  }

  const {
    selectedChar,
    selectedChat,
    nowChatroom,
    currentChar,
    promptInfo,
    tokenizer,
    maxContextTokens,
    findCharacter: findCharacterbyIdwithCache,
  } = session;
  let currentChat = session.currentChat;
  let generationInfo: MessageGenerationInfo | undefined;

  const reformatContent = (data: string) => data.trim();
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
    findCharacter: findCharacterbyIdwithCache,
    throwError,
  });
  if (!prompt.ok) {
    return false;
  }
  currentChat = prompt.currentChat;
  const biases = prompt.biases;
  const runtime = createLocalChatGenerationRuntime(tokenizer);
  const plan = await createChatGenerationPlan(runtime, {
    formated: prompt.formated,
    maxContextTokens,
  });
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
    previewFormated = plan.formated;
    return true;
  }

  const req = await executeChatModelRequest(
    runtime,
    {
      plan,
      biases,
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

  console.log(req);
  if (req.model) {
    generationInfo.model = runtime.getGenerationModel(req.model);
    console.log(generationInfo.model, req.model);
  }

  if (arg.previewPrompt && req.type === "success") {
    previewBody = req.result;
    return true;
  }

  const response = await processChatResponse({
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
    reformatContent,
    throwError,
  });
  if (!response.ok) {
    return false;
  }

  let { result, emoChanged, resendChat } = response;
  currentChat = response.currentChat;

  return finalizeChatGeneration({
    req,
    result,
    emoChanged,
    resendChat,
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
      sendChat(chatProcessIndex, {
        chatAdditonalTokens: arg.chatAdditonalTokens,
        continue: true,
        signal: abortSignal,
        usedContinueTokens: resultTokens,
      }),
    resendGeneration: () =>
      sendChat(chatProcessIndex, {
        signal: abortSignal,
      }),
  });
}
