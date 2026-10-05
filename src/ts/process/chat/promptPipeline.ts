import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import type {
  character,
  Chat,
  groupChat,
  MessagePresetInfo,
} from "../../storage/database/schema";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { resolveIllustrationSettings } from "@risuai/protocol/dist/illustration.mjs";
import { ChatTokenizer } from "../../tokenizer";
import { setChatProcessStage } from "./runtimeState";
import { risuChatParser } from "../scripts";
import { preparePromptSections } from "./promptSections";
import {
  estimatePromptTemplateTokens,
  formatPromptForRequest,
} from "./promptTemplate";
import { buildChatHistory } from "./historyBuilder";
import { applyChatMemory } from "./memory";
import type { ChatStageTimings, OpenAIChat } from "@risuai/chat-core/types.cjs";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import {
  generationOverride,
  type ChatGenerationOverrides,
} from "./generationContext";
import {
  applyMemoryPromptPolicy,
  applyTriggerPromptPolicy,
  buildPromptBiases,
  insertDepthPrompts,
} from "@risuai/chat-core/prompt.cjs";

type LorePrompt = Awaited<
  ReturnType<typeof import("../lorebook.svelte").loadLoreBookV3Prompt>
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

/**
 * Builds bounded dialogue history after reserving tokens for output, prompt sections and appended instructions.
 *
 * 한국어: 출력·프롬프트 구간·추가 지침의 토큰을 예약한 뒤 한도에 맞는 이전 대화를 구성하는 함수.
 *
 * @param options - Generation target, tokenizer and runtime options. / 생성 대상·토큰 계산기·실행 설정.
 * @param sections - Prepared prompt sections and active lore. / 준비된 프롬프트 구간·활성 로어.
 * @param appendedInstructions - Extra system instructions, including illustration marker usage. / 삽화 표식 사용을 포함한 추가 시스템 지침.
 */
async function buildHistoryStage(
  options: BuildGenerationPromptOptions,
  sections: PreparedPromptSections,
  appendedInstructions: OpenAIChat[] = [],
) {
  const chatTarget = {
    ...createExecutionTarget(options),
    authorNoteContent: sections.authorNoteContent,
  };
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
    currentTokens:
      presetStore.state.maxResponse +
      50 +
      estimate.tokens +
      (await options.tokenizer.tokenizeChats(appendedInstructions)),
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

/**
 * Assembles the main chat prompt and captures context actually used for automatic illustrations.
 *
 * 한국어: 메인 채팅 프롬프트를 구성하고 자동 삽화에 사용할 실제 생성 문맥을 캡처하는 함수.
 *
 * @param options - Character/chat snapshots and prompt-generation dependencies. / 캐릭터·채팅 사본과 프롬프트 생성 의존성.
 * @returns Prepared prompt data, or an unsuccessful result when history/memory preparation fails. / 준비된 프롬프트 정보 또는 이력·메모리 준비 실패 결과.
 * @remarks
 * Enabled one-to-one chats reserve and append marker instructions. The returned illustration context
 * reuses this request's descriptions, persona, active lore and included memory without rerunning them.
 * 한국어: 삽화를 켠 1:1 채팅은 표식 지침 토큰을 예약하고 지침을 추가.
 * 반환한 삽화 문맥은 해당 요청의 설명·페르소나·활성 로어·실제 포함 메모리를 재실행 없이 재사용.
 */
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
  const illustration = resolveIllustrationSettings(
    settingsStore.state.illustration,
    options.currentChar.illustration,
  );
  const markerInstructions: OpenAIChat[] =
    illustration.enabled &&
    options.nowChatroom.type !== "group" &&
    illustration.markerInstructions
      ? [
          {
            role: "system",
            content: risuChatParser(illustration.markerInstructions, {
              chara: options.currentChar,
              chatTarget: createExecutionTarget(options),
            }),
          },
        ]
      : [];
  const historyStage = await buildHistoryStage(
    options,
    sections,
    markerInstructions,
  );
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
  formated.push(...markerInstructions);
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
    illustrationContext:
      illustration.enabled && options.nowChatroom.type !== "group"
        ? {
            description: sections.illustrationDescription,
            persona: sections.unformated.personaPrompt
              .map((m) => m.content)
              .join("\n\n"),
            lorebook: illustration.includeLorebook
              ? sections.lorepmt.actives
                  .map((lore) =>
                    risuChatParser(sections.resolvePosition(lore.prompt), {
                      chara: options.currentChar,
                      chatTarget: createExecutionTarget(options),
                    }),
                  )
                  .join("\n\n")
              : undefined,
            memory: illustration.includeMemory
              ? formated
                  .filter(
                    (m) => m.memo === "supaMemory" || m.memo === "hypaMemory",
                  )
                  .map((m) => m.content)
                  .join("\n\n")
              : undefined,
          }
        : undefined,
  };
}
