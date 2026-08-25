import { writable } from "svelte/store";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import type { MessageGenerationInfo } from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { language } from "../../lang";
import { requestChatData } from "./request/request";
import {
  registerDurableGenerationContext,
  unregisterDurableGenerationContext,
} from "../network/durableModelJobs";
import { v4 } from "uuid";
import { getGenerationModelString } from "./models/modelString";
import { processChatResponse } from "./chatResponse.svelte";
import {
  finalizeChatGeneration,
  type ChatStageTimings,
} from "./chatGenerationFinalizer.svelte";
import {
  createChatErrorHandler,
  type ChatErrorContext,
} from "./chatError.svelte";
import { prepareChatSession } from "./chatSession.svelte";
import { buildGenerationPrompt } from "./chatPromptPipeline";

export interface OpenAIChat {
  role: "system" | "user" | "assistant" | "function";
  content: string;
  memo?: string;
  name?: string;
  removable?: boolean;
  attr?: string[];
  multimodals?: MultiModal[];
  thoughts?: string[];
  cachePoint?: boolean;
}

export interface MultiModal {
  type: "image" | "video" | "audio" | "signature";
  base64: string;
  height?: number;
  width?: number;
}

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
  let formated = prompt.formated;
  const biases = prompt.biases;

  // Token rechecking. Compute every per-message count in one batch so Node
  // deployments avoid a request/tokenizer pass for each removable prompt.
  const formatedTokenCounts = await tokenizer.tokenizeChatsDetailed(formated);
  let inputTokens = formatedTokenCounts.reduce((total, count) => total + count, 0);

  if (inputTokens > maxContextTokens) {
    let pointer = 0;
    while (inputTokens > maxContextTokens) {
      if (pointer >= formated.length) {
        throwError(
          language.errors.toomuchtoken +
            "\n\nAt token rechecking. Required Tokens: " +
            inputTokens,
        );
        return false;
      }
      if (formated[pointer].removable) {
        inputTokens -= formatedTokenCounts[pointer];
        formated[pointer].content = "";
      }
      pointer++;
    }
    formated = formated.filter((v) => {
      return v.content !== "" || (v.multimodals && v.multimodals.length > 0);
    });
  }

  //estimate tokens
  let outputTokens = settingsStore.state.maxResponse;
  if (inputTokens + outputTokens > maxContextTokens) {
    outputTokens = maxContextTokens - inputTokens;
  }
  const generationId = v4();
  const generationModel = getGenerationModelString();

  generationInfo = {
    model: generationModel,
    generationId: generationId,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
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
    previewFormated = formated;
    return true;
  }

  let req: Awaited<ReturnType<typeof requestChatData>>;
  const durableChatId = currentChat.id;
  if (durableChatId) {
    registerDurableGenerationContext({
      realChatId: durableChatId,
      generationId,
      model: generationModel,
      speakerId: currentChar.chaId,
    });
  }
  try {
    req = await requestChatData(
      {
        formated: formated,
        biasString: biases,
        currentChar: currentChar,
        useStreaming: true,
        isGroupChat: nowChatroom.type === "group",
        bias: {},
        continue: arg.continue,
        chatId: generationId,
        imageResponse: settingsStore.state.outputImageModal,
        previewBody: arg.previewPrompt,
        escape: nowChatroom.type === "character" && nowChatroom.escapeOutput,
        rememberToolUsage: settingsStore.state.rememberToolUsage,
      },
      "model",
      abortSignal,
    );
  } finally {
    unregisterDurableGenerationContext(generationId);
  }

  console.log(req);
  if (req.model) {
    generationInfo.model = getGenerationModelString(req.model);
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
