import type {
  character,
  Chat,
  groupChat,
  MessagePresetInfo,
} from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { ChatTokenizer } from "../tokenizer";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
import { risuChatParser } from "./scripts";
import { preparePromptSections } from "./chatPromptSections";
import {
  estimatePromptTemplateTokens,
  formatPromptForRequest,
} from "./chatPromptTemplate";
import { buildChatHistory } from "./chatHistoryBuilder";
import { applyChatMemory } from "./chatMemory";
import type { ChatStageTimings } from "./chatGenerationFinalizer.svelte";
import type { OpenAIChat } from "./index.svelte";

type LorePrompt = Awaited<
  ReturnType<typeof import("./lorebook.svelte").loadLoreBookV3Prompt>
>;

function buildBiases(currentChar: character): [string, number][] {
  return settingsStore.state.bias.concat(currentChar.bias).map((bias) => [
    risuChatParser(
      bias[0]
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\\\", "\\"),
      { chara: currentChar },
    ),
    bias[1],
  ]);
}

function applyMemoryPrompts(
  chats: OpenAIChat[],
  unformated: Awaited<ReturnType<typeof preparePromptSections>>["unformated"],
  promptTemplate: Awaited<ReturnType<typeof preparePromptSections>>["promptTemplate"],
  supaMemoryCardUsed: boolean,
) {
  const memories: OpenAIChat[] = [];
  if (!promptTemplate) {
    unformated.lastChat.push(chats[chats.length - 1]);
    chats.splice(chats.length - 1, 1);
  }

  unformated.chats = chats
    .map((chat) => {
      if (chat.memo !== "supaMemory" && chat.memo !== "hypaMemory") {
        chat.removable = true;
      } else if (supaMemoryCardUsed) {
        memories.push(chat);
        return { role: "system", content: "" } as OpenAIChat;
      } else {
        chat.content = `<Previous Conversation>${chat.content}</Previous Conversation>`;
      }
      return chat;
    })
    .filter((chat) => chat.content.trim() !== "" || !!chat.multimodals?.length);
  return memories;
}

function applyDepthPrompts(
  unformated: Awaited<ReturnType<typeof preparePromptSections>>["unformated"],
  depthPrompts: LorePrompt["actives"],
  resolvePosition: (text: string, maxDepth?: number) => string,
  currentChar: character,
) {
  for (const depthPrompt of depthPrompts) {
    const chat: OpenAIChat = {
      role: depthPrompt.role,
      content: risuChatParser(resolvePosition(depthPrompt.prompt), {
        chara: currentChar,
      }),
    };
    const depth =
      depthPrompt.pos === "depth"
        ? depthPrompt.depth
        : unformated.chats.length - depthPrompt.depth;
    unformated.chats.splice(depth, 0, chat);
  }
}

function applyTriggerPrompts(
  unformated: Awaited<ReturnType<typeof preparePromptSections>>["unformated"],
  triggerResult: Exclude<
    Awaited<ReturnType<typeof buildChatHistory>>,
    { stopSending: true }
  >["triggerResult"],
) {
  if (!triggerResult) return;
  if (triggerResult.additonalSysPrompt.promptend) {
    unformated.postEverything.push({
      role: "system",
      content: triggerResult.additonalSysPrompt.promptend,
    });
  }
  if (triggerResult.additonalSysPrompt.historyend) {
    unformated.lastChat.push({
      role: "system",
      content: triggerResult.additonalSysPrompt.historyend,
    });
  }
  if (triggerResult.additonalSysPrompt.start) {
    unformated.lastChat.unshift({
      role: "system",
      content: triggerResult.additonalSysPrompt.start,
    });
  }
}

type PreparedPromptSections = Awaited<ReturnType<typeof preparePromptSections>>;
type ReadyChatHistory = Extract<
  Awaited<ReturnType<typeof buildChatHistory>>,
  { stopSending: false }
>;

function createRenderContext(
  currentChar: character,
  sections: PreparedPromptSections,
) {
  return {
    currentChar,
    unformated: sections.unformated,
    usingPromptTemplate: sections.usingPromptTemplate,
    positionParser: sections.positionParser,
    getDescriptionPrompts: sections.getDescriptionPrompts,
  };
}

async function buildHistoryStage(
  options: BuildGenerationPromptOptions,
  sections: PreparedPromptSections,
) {
  const renderContext = createRenderContext(options.currentChar, sections);
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
    currentTokens: settingsStore.state.maxResponse + 50 + estimate.tokens,
    lorePrompt: sections.lorepmt,
    resolvePosition: sections.resolvePosition,
    findCharacter: options.findCharacter,
  });
  if (history.stopSending) {
    doingChat.set(false);
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
  });
  if (!memory.ok) return memory;
  options.stageTimings.stage1Duration = memory.stage1Duration;
  options.stageTimings.stage2Duration = memory.stage2Duration;
  return memory;
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
}

export async function buildGenerationPrompt(
  options: BuildGenerationPromptOptions,
) {
  chatProcessStage.set(1);
  options.stageTimings.stage1Start = Date.now();
  const sections = await preparePromptSections(
    options.currentChar,
    options.currentChat,
    options.nowChatroom,
  );
  const historyStage = await buildHistoryStage(options, sections);
  if (!historyStage.ok) return { ok: false as const };

  const memory = await applyMemoryStage(options, historyStage.history);
  if (!memory.ok) return { ok: false as const };
  const memories = applyMemoryPrompts(
    memory.chats,
    sections.unformated,
    sections.promptTemplate,
    historyStage.estimate.supaMemoryCardUsed,
  );
  applyDepthPrompts(
    sections.unformated,
    historyStage.history.depthPrompts,
    sections.resolvePosition,
    options.currentChar,
  );
  applyTriggerPrompts(
    sections.unformated,
    historyStage.history.triggerResult,
  );

  const formated = await formatPromptForRequest({
    promptTemplate: sections.promptTemplate,
    context: historyStage.renderContext,
    memories,
    hasCachePoint: historyStage.estimate.hasCachePoint,
    continued: options.continued,
    promptInfo: options.promptInfo,
  });
  return {
    ok: true as const,
    formated,
    biases: buildBiases(options.currentChar),
    currentChat: memory.currentChat,
  };
}
