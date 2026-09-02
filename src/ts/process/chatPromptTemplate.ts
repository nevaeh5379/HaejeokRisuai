import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import type { character, MessagePresetInfo } from "../storage/database/schema";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../polyfill";
import { prebuiltAssetCommand } from "../util";
import { parseChatML } from "../parser/chatML";
import { ChatTokenizer } from "../tokenizer";
import type {
  PromptItem,
  PromptItemAuthorNote,
  PromptItemChat,
  PromptItemTyped,
  PromptRole,
} from "./prompt";
import { risuChatParser } from "./scripts";
import { runLuaEditTrigger } from "./scriptings";
import { generationOverride, type ChatGenerationOverrides } from "./chatGenerationContext";
import {
  applyPromptBlockRole,
  PROMPT_ROLE_TO_OPENAI,
  type PromptSections,
} from "./chatPromptSections";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

interface RenderContext {
  currentChar: character;
  unformated: PromptSections;
  usingPromptTemplate: boolean;
  positionParser: (text: string, location: string) => string;
  getDescriptionPrompts: (role?: PromptRole) => OpenAIChat[];
  chatTarget: ChatExecutionTarget;
  generation?: ChatGenerationOverrides;
}

interface RenderedCard {
  prompts: OpenAIChat[];
  promptInfo: OpenAIChat[];
}

function isCardEnabled(card: PromptItem, context: RenderContext) {
  if (
    card.type === "jailbreak" &&
    !generationOverride(
      context.generation,
      "jailbreakToggle",
      settingsStore.state.jailbreakToggle,
    )
  ) return false;
  if (card.type === "cot" && !settingsStore.state.chainOfThought) return false;
  return true;
}

function appendPromptInfo(
  promptInfo: OpenAIChat[],
  role: OpenAIChat["role"],
  content: string,
  context: RenderContext,
) {
  if (!content.trim()) return;
  promptInfo.push({
    role,
    content: risuChatParser(content, {
      chara: context.currentChar,
      chatTarget: context.chatTarget,
    }),
  });
}

function formatTypedPrompts(
  prompts: OpenAIChat[],
  role: PromptRole | undefined,
  innerFormat: string | undefined,
  location: string,
  context: RenderContext,
  capturePromptInfo: boolean,
  defaultText = "",
  usePositionParser = true,
) {
  applyPromptBlockRole(prompts, role);
  const promptInfo: OpenAIChat[] = [];
  if (!innerFormat || prompts.length === 0) return { prompts, promptInfo };

  for (const prompt of prompts) {
    const format = usePositionParser
      ? context.positionParser(innerFormat, location)
      : innerFormat;
    prompt.content = risuChatParser(format, {
      chara: context.currentChar,
      chatTarget: context.chatTarget,
    }).replace("{{slot}}", prompt.content || defaultText);
    if (capturePromptInfo) {
      appendPromptInfo(promptInfo, prompt.role, innerFormat, context);
    }
  }
  return { prompts, promptInfo };
}

function renderPlainCard(
  card: Extract<PromptItem, { type: "plain" | "jailbreak" | "cot" }>,
  context: RenderContext,
  capturePromptInfo: boolean,
): RenderedCard {
  const positionType = card.type === "plain" ? card.type2 : card.type;
  let content = context.positionParser(card.text, positionType);
  if (card.type2 === "globalNote") {
    if (context.currentChar.replaceGlobalNote) {
      content = context
        .positionParser(context.currentChar.replaceGlobalNote, positionType)
        .replaceAll("{{original}}", content);
    }
    if (
      context.currentChar.prebuiltAssetCommand &&
      !card.text.includes("{{//@customimageinstruction}}")
    ) {
      content += prebuiltAssetCommand;
    }
  }
  content = risuChatParser(content, {
    chara: context.currentChar,
    role: card.role,
    chatTarget: context.chatTarget,
  });

  const prompt: OpenAIChat = {
    role: PROMPT_ROLE_TO_OPENAI[card.role],
    content,
  };
  const promptInfo: OpenAIChat[] = [];
  if (capturePromptInfo && card.type2 !== "globalNote") {
    appendPromptInfo(promptInfo, prompt.role, prompt.content, context);
  }
  return { prompts: [prompt], promptInfo };
}

function normalizeChatRange(card: PromptItemChat, length: number) {
  let start = card.rangeStart;
  let end = card.rangeEnd === "end" ? length : card.rangeEnd;
  if (start === -1000) return { start: 0, end: length };
  if (start < 0) start = Math.max(0, length + start);
  if (end < 0) end = Math.max(0, length + end);
  return { start, end };
}

function systemizeChat(chats: OpenAIChat[]) {
  for (const chat of chats) {
    if (chat.role !== "user" && chat.role !== "assistant") continue;
    const attr = chat.attr ?? [];
    if (chat.name?.startsWith("example_")) {
      chat.content = `${chat.name}: ${chat.content}`;
    } else if (!attr.includes("nameAdded")) {
      chat.content = `${chat.role}: ${chat.content}`;
    }
    chat.role = "system";
    delete chat.memo;
    delete chat.name;
  }
  return chats;
}

function renderChatCard(card: PromptItemChat, context: RenderContext): RenderedCard {
  const { start, end } = normalizeChatRange(card, context.unformated.chats.length);
  if (start >= end) return { prompts: [], promptInfo: [] };
  let prompts = context.unformated.chats.slice(start, end);
  if (
    context.usingPromptTemplate &&
    generationOverride(
      context.generation,
      "promptSettings",
      presetStore.state.promptSettings,
    ).sendChatAsSystem &&
    !card.chatAsOriginalOnSystem
  ) {
    prompts = systemizeChat(prompts);
  }
  return { prompts, promptInfo: [] };
}

function renderPersonaCard(
  card: PromptItemTyped,
  context: RenderContext,
  capturePromptInfo: boolean,
) {
  return formatTypedPrompts(
    safeStructuredClone(context.unformated.personaPrompt),
    card.role2,
    card.innerFormat,
    card.type,
    context,
    capturePromptInfo,
  );
}

function renderDescriptionCard(
  card: PromptItemTyped,
  context: RenderContext,
  capturePromptInfo: boolean,
) {
  return formatTypedPrompts(
    context.getDescriptionPrompts(card.role2),
    undefined,
    card.innerFormat,
    card.type,
    context,
    capturePromptInfo,
  );
}

function renderAuthorNoteCard(
  card: PromptItemAuthorNote,
  context: RenderContext,
  capturePromptInfo: boolean,
) {
  return formatTypedPrompts(
    safeStructuredClone(context.unformated.authorNote),
    card.role2,
    card.innerFormat,
    card.type,
    context,
    capturePromptInfo,
    card.defaultText || "",
  );
}

function renderMemoryCard(
  card: PromptItemTyped,
  context: RenderContext,
  memories: OpenAIChat[],
  capturePromptInfo: boolean,
) {
  return formatTypedPrompts(
    safeStructuredClone(memories),
    card.role2,
    card.innerFormat,
    card.type,
    context,
    capturePromptInfo,
    "",
    false,
  );
}

function renderTypedCard(
  card: PromptItemTyped | PromptItemAuthorNote,
  context: RenderContext,
  memories: OpenAIChat[],
  capturePromptInfo: boolean,
): RenderedCard {
  if (card.type === "persona") {
    return renderPersonaCard(card, context, capturePromptInfo);
  }
  if (card.type === "description") {
    return renderDescriptionCard(card, context, capturePromptInfo);
  }
  if (card.type === "authornote") {
    return renderAuthorNoteCard(card, context, capturePromptInfo);
  }
  return renderMemoryCard(card, context, memories, capturePromptInfo);
}

function renderPostEverythingCard(context: RenderContext): RenderedCard {
  const prompts = [...context.unformated.postEverything];
  const promptSettings = generationOverride(
    context.generation,
    "promptSettings",
    presetStore.state.promptSettings,
  );
  if (context.usingPromptTemplate && promptSettings.postEndInnerFormat) {
    prompts.push({
      role: "system",
      content: promptSettings.postEndInnerFormat,
    });
  }
  return { prompts, promptInfo: [] };
}

function renderCard(
  card: PromptItem,
  context: RenderContext,
  memories: OpenAIChat[] = [],
  capturePromptInfo = false,
): RenderedCard {
  if (!isCardEnabled(card, context)) return { prompts: [], promptInfo: [] };
  if (
    card.type === "persona" ||
    card.type === "description" ||
    card.type === "authornote" ||
    card.type === "memory"
  ) {
    return renderTypedCard(card, context, memories, capturePromptInfo);
  }
  if (card.type === "plain" || card.type === "jailbreak" || card.type === "cot") {
    return renderPlainCard(card, context, capturePromptInfo);
  }
  if (card.type === "lorebook") {
    return { prompts: context.unformated.lorebook, promptInfo: [] };
  }
  if (card.type === "postEverything") return renderPostEverythingCard(context);
  if (card.type === "chatML") {
    return { prompts: (parseChatML(card.text) ?? []) as OpenAIChat[], promptInfo: [] };
  }
  if (card.type === "chat") return renderChatCard(card, context);
  return { prompts: [], promptInfo: [] };
}

export async function estimatePromptTemplateTokens(options: {
  promptTemplate: PromptItem[] | null | undefined;
  context: RenderContext;
  tokenizer: ChatTokenizer;
}) {
  let tokens = 0;
  let supaMemoryCardUsed = false;
  let hasCachePoint = false;

  if (!options.promptTemplate) {
    for (const prompts of Object.values(options.context.unformated)) {
      tokens += await options.tokenizer.tokenizeChats(prompts);
    }
    return { tokens, supaMemoryCardUsed, hasCachePoint };
  }

  for (const card of options.promptTemplate) {
    if (card.type === "memory") {
      supaMemoryCardUsed = true;
      continue;
    }
    if (card.type === "cache") {
      hasCachePoint = true;
      continue;
    }
    const rendered = renderCard(card, options.context);
    tokens += await options.tokenizer.tokenizeChats(rendered.prompts);
  }
  return { tokens, supaMemoryCardUsed, hasCachePoint };
}

function mergePrompts(target: OpenAIChat[], prompts: OpenAIChat[]) {
  const mergeSystem =
    presetStore.state.aiModel.startsWith("gpt") ||
    presetStore.state.aiModel.startsWith("claude") ||
    presetStore.state.aiModel === "openrouter" ||
    presetStore.state.aiModel === "reverse_proxy";

  for (const chat of prompts) {
    if (!chat.content.trim() && !chat.multimodals?.length) continue;
    if (!mergeSystem || chat.role !== "system") {
      target.push(chat);
      continue;
    }

    const previous = target.at(-1);
    if (
      previous?.role === "system" &&
      previous.memo === chat.memo &&
      previous.name === chat.name
    ) {
      previous.content += `\n\n${chat.content}`;
    } else {
      target.push(chat);
    }
  }
}

function applyCachePoint(
  formated: OpenAIChat[],
  depth: number,
  role: "user" | "assistant" | "system" | "all",
) {
  let pointer = formated.length - 1;
  let remaining = depth;
  while (pointer >= 0 && remaining > 0) {
    if (role === "all" || formated[pointer].role === role) {
      formated[pointer].cachePoint = true;
      remaining--;
    }
    pointer--;
  }
}

function shouldAppendContinuePrompt(continued?: boolean) {
  if (!continued) return false;
  const model = presetStore.state.aiModel;
  return (
    model.startsWith("claude") ||
    model.startsWith("gpt") ||
    model.startsWith("openrouter") ||
    model.startsWith("reverse_proxy")
  );
}

interface FormatPromptOptions {
  promptTemplate: PromptItem[] | null | undefined;
  context: RenderContext;
  memories: OpenAIChat[];
  hasCachePoint: boolean;
  continued?: boolean;
  promptInfo: MessagePresetInfo;
}

function appendContinuePrompt(options: FormatPromptOptions) {
  if (!shouldAppendContinuePrompt(options.continued)) return;
  options.context.unformated.postEverything.push({
    role: "system",
    content: "[Continue the last response]",
  });
}

function renderTemplateCards(
  options: FormatPromptOptions,
  formated: OpenAIChat[],
  promptInfoBody: OpenAIChat[],
  capturePromptInfo: boolean,
) {
  for (const card of options.promptTemplate ?? []) {
    if (card.type === "cache") {
      applyCachePoint(formated, card.depth, card.role);
      continue;
    }

    const rendered = renderCard(
      card,
      options.context,
      options.memories,
      capturePromptInfo,
    );
    mergePrompts(formated, rendered.prompts);
    if (capturePromptInfo) promptInfoBody.push(...rendered.promptInfo);
    if (
      card.type === "chat" &&
      settingsStore.state.automaticCachePoint &&
      !options.hasCachePoint
    ) {
      applyCachePoint(formated, 3, "user");
    }
  }
}

function renderLegacyPromptOrder(options: FormatPromptOptions, formated: OpenAIChat[]) {
  const formatOrder = safeStructuredClone(
    generationOverride(
      options.context.generation,
      "formatingOrder",
      presetStore.state.formatingOrder,
    ),
  ) ?? [];
  formatOrder.push("postEverything");
  for (const key of formatOrder) {
    mergePrompts(formated, options.context.unformated[key]);
  }
}

function trimPromptContents(prompts: OpenAIChat[]) {
  for (const prompt of prompts) prompt.content = prompt.content.trim();
}

function insertCharacterDepthPrompt(options: FormatPromptOptions, formated: OpenAIChat[]) {
  const depthPrompt = options.context.currentChar.depth_prompt;
  if (!depthPrompt?.prompt) return;
  formated.splice(formated.length - depthPrompt.depth, 0, {
    role: "system",
    content: risuChatParser(depthPrompt.prompt, {
      chara: options.context.currentChar,
      chatTarget: options.context.chatTarget,
    }),
  });
}

async function runPromptEditTriggers(
  options: FormatPromptOptions,
  formated: OpenAIChat[],
  promptInfoBody: OpenAIChat[],
  capturePromptInfo: boolean,
) {
  if (options.context.generation?.suppressTriggers) return formated;
  const edited = await runLuaEditTrigger(
    options.context.currentChar,
    "editRequest",
    formated,
    undefined,
    options.context.chatTarget,
  );
  if (capturePromptInfo) {
    options.promptInfo.promptText = await runLuaEditTrigger(
      options.context.currentChar,
      "editRequest",
      promptInfoBody,
      undefined,
      options.context.chatTarget,
    );
  }
  return edited;
}

export async function formatPromptForRequest(options: FormatPromptOptions) {
  appendContinuePrompt(options);
  const formated: OpenAIChat[] = [];
  const promptInfoBody: OpenAIChat[] = [];
  const capturePromptInfo =
    settingsStore.state.promptInfoInsideChat &&
    settingsStore.state.promptTextInfoInsideChat;

  if (options.promptTemplate) {
    renderTemplateCards(options, formated, promptInfoBody, capturePromptInfo);
  } else {
    renderLegacyPromptOrder(options, formated);
  }

  trimPromptContents(formated);
  if (capturePromptInfo) trimPromptContents(promptInfoBody);
  insertCharacterDepthPrompt(options, formated);
  return runPromptEditTriggers(
    options,
    formated,
    promptInfoBody,
    capturePromptInfo,
  );
}
