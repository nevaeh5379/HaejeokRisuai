import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import type {
  character,
  Chat,
  groupChat,
  MessagePresetInfo,
} from "../storage/database/schema";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { ChatTokenizer } from "../tokenizer";
import { setChatProcessStage } from "./chatRuntimeState";
import { risuChatParser } from "./scripts";
import { preparePromptSections } from "./chatPromptSections";
import {
  estimatePromptTemplateTokens,
  formatPromptForRequest,
} from "./chatPromptTemplate";
import { buildChatHistory } from "./chatHistoryBuilder";
import { applyChatMemory } from "./chatMemory";
import type { ChatStageTimings, OpenAIChat } from "@risuai/chat-core/types.cjs";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import {
  generationOverride,
  type ChatGenerationOverrides,
} from "./chatGenerationContext";
import {
  applyMemoryPromptPolicy,
  applyTriggerPromptPolicy,
  buildPromptBiases,
  insertDepthPrompts,
} from "@risuai/chat-core/prompt.cjs";

type LorePrompt = Awaited<
  ReturnType<typeof import("./lorebook.svelte").loadLoreBookV3Prompt>
>;

type PreparedPromptSections = Awaited<ReturnType<typeof preparePromptSections>>;
type ReadyChatHistory = Extract<
  Awaited<ReturnType<typeof buildChatHistory>>,
  { stopSending: false }
>;

function createExecutionTarget(
  options: Pick<
    BuildGenerationPromptOptions,
    "currentChar" | "currentChat" | "chatTarget" | "generation"
  >,
): ChatExecutionTarget {
  if (options.chatTarget) {
    return {
      ...options.chatTarget,
      globalVariables:
        options.generation?.chatVariables ?? options.chatTarget.globalVariables,
    };
  }
  if (!options.currentChar.chaId || !options.currentChat.id) {
    throw new Error("Generation target requires stable character and chat IDs");
  }
  return {
    characterId: options.currentChar.chaId,
    chatId: options.currentChat.id,
    globalVariables: options.generation?.chatVariables,
  };
}

function createRenderContext(
  currentChar: character,
  sections: PreparedPromptSections,
  chatTarget: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  return {
    currentChar,
    unformated: sections.unformated,
    usingPromptTemplate: sections.usingPromptTemplate,
    positionParser: sections.positionParser,
    getDescriptionPrompts: sections.getDescriptionPrompts,
    chatTarget,
    generation,
  };
}

async function buildHistoryStage(
  options: BuildGenerationPromptOptions,
  sections: PreparedPromptSections,
) {
  const chatTarget = createExecutionTarget(options);
  const renderContext = createRenderContext(
    options.currentChar,
    sections,
    chatTarget,
    options.generation,
  );
  const estimate = await estimatePromptTemplateTokens({
    promptTemplate: sections.promptTemplate,
    context: renderContext,
    tokenizer: options.tokenizer,
  });
  const history = await buildChatHistory({
    currentChar: options.currentChar,
    nowChatroom: options.nowChatroom,
    currentChat: options.currentChat,
    usingPromptTemplate: sections.usingPromptTemplate,
    tokenizer: options.tokenizer,
    currentTokens: presetStore.state.maxResponse + 50 + estimate.tokens,
    lorePrompt: sections.lorepmt,
    resolvePosition: sections.resolvePosition,
    findCharacter: options.findCharacter,
    chatTarget,
    generation: options.generation,
  });
  if (history.stopSending) {
    return { ok: false as const };
  }
  return {
    ok: true as const,
    renderContext,
    estimate,
    history: history as ReadyChatHistory,
  };
}

async function applyMemoryStage(
  options: BuildGenerationPromptOptions,
  history: ReadyChatHistory,
) {
  const memory = await applyChatMemory({
    chats: history.chats,
    currentTokens: history.currentTokens,
    maxContextTokens: options.maxContextTokens,
    currentChat: history.currentChat,
    nowChatroom: options.nowChatroom,
    currentChar: options.currentChar,
    tokenizer: options.tokenizer,
    selectedChar: options.selectedChar,
    selectedChat: options.selectedChat,
    stage1Start: options.stageTimings.stage1Start,
    throwError: options.throwError,
    skipMemory: options.generation?.skipMemory,
  });
  if (!memory.ok) return memory;
  options.stageTimings.stage1Duration = memory.stage1Duration;
  options.stageTimings.stage2Duration = memory.stage2Duration;
  return memory;
}

function applyHistoryPromptDecorations(
  options: BuildGenerationPromptOptions,
  sections: PreparedPromptSections,
  historyStage: Awaited<ReturnType<typeof buildHistoryStage>> & { ok: true },
  memory: Awaited<ReturnType<typeof applyChatMemory>> & { ok: true },
) {
  const memories = applyMemoryPromptPolicy(
    memory.chats,
    sections.unformated,
    Boolean(sections.promptTemplate),
    historyStage.estimate.supaMemoryCardUsed,
  );
  insertDepthPrompts(
    sections.unformated,
    historyStage.history.depthPrompts,
    (prompt) =>
      risuChatParser(sections.resolvePosition(prompt), {
        chara: options.currentChar,
        chatTarget: historyStage.renderContext.chatTarget,
      }),
  );
  applyTriggerPromptPolicy(
    sections.unformated,
    historyStage.history.triggerResult,
  );
  return memories;
}

async function renderGenerationPrompt(
  options: BuildGenerationPromptOptions,
  sections: PreparedPromptSections,
  historyStage: Awaited<ReturnType<typeof buildHistoryStage>> & { ok: true },
  memories: OpenAIChat[],
) {
  return formatPromptForRequest({
    promptTemplate: sections.promptTemplate,
    context: historyStage.renderContext,
    memories,
    hasCachePoint: historyStage.estimate.hasCachePoint,
    continued: options.continued,
    promptInfo: options.promptInfo,
  });
}

export interface BuildGenerationPromptOptions {
  currentChar: character;
  currentChat: Chat;
  nowChatroom: character | groupChat;
  tokenizer: ChatTokenizer;
  maxContextTokens: number;
  selectedChar: number;
  selectedChat: number;
  stageTimings: ChatStageTimings;
  promptInfo: MessagePresetInfo;
  continued?: boolean;
  findCharacter: (id: string) => character;
  throwError: (error: string) => void;
  /** Stable variable/script target when currentChat is an isolated snapshot. */
  chatTarget?: ChatExecutionTarget;
  generation?: ChatGenerationOverrides;
}

export async function buildGenerationPrompt(
  options: BuildGenerationPromptOptions,
) {
  setChatProcessStage(options.currentChat.id, 1);
  options.stageTimings.stage1Start = Date.now();
  const sections = await preparePromptSections(
    options.currentChar,
    options.currentChat,
    options.nowChatroom,
    createExecutionTarget(options),
    options.generation,
  );
  const historyStage = await buildHistoryStage(options, sections);
  if (!historyStage.ok) return { ok: false as const };
  const memory = await applyMemoryStage(options, historyStage.history);
  if (!memory.ok) return { ok: false as const };

  const memories = applyHistoryPromptDecorations(
    options,
    sections,
    historyStage,
    memory,
  );
  const formated = await renderGenerationPrompt(
    options,
    sections,
    historyStage,
    memories,
  );
  return {
    ok: true as const,
    formated,
    biases: buildPromptBiases(
      presetStore.state.bias.concat(options.currentChar.bias),
      (text) =>
        risuChatParser(text, {
          chara: options.currentChar,
          chatTarget: historyStage.renderContext.chatTarget,
        }),
    ),
    currentChat: memory.currentChat,
  };
}
