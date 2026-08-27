import { v4 } from "uuid";
import type { BtwSession, BtwSessionConfig, botPreset, character, Chat, groupChat, Message, MessagePresetInfo } from "../storage/schema";
import { safeStructuredClone } from "../polyfill";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { preLoadChat } from "./coldstorage.svelte";
import { getModules, getModuleToggles } from "./modules";
import { getGlobalChatVar } from "../parser/chatVar.svelte";
import { findCharacterbyId, parseToggleSyntax } from "../util";
import { ChatTokenizer } from "../tokenizer";
import { buildGenerationPrompt } from "./chatPromptPipeline";
import type { ChatGenerationOverrides } from "./chatGenerationContext";
import { requireChatTargetFromIndexes } from "../chatTarget";
import {
  createChatGenerationPlan,
  executeChatModelRequest,
} from "@risuai/chat-core/generation.cjs";
import type {
  ChatModelResponse,
  ChatStageTimings,
} from "@risuai/chat-core/types.cjs";
import { createLocalChatGenerationRuntime } from "./chatLocalRuntime";
import { tryCreateNodeChatGenerationPlan } from "./chatNodePlanner";
import { runChatOutputListeners } from "./chatResponseShared.svelte";

export type BtwToggleDefinition = ReturnType<typeof parseToggleSyntax>[number];

class BtwRuntimeStore {
  open = $state(false);
  characterIndex = $state(-1);
  chatIndex = $state(-1);
  generating = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string>>({});
}

export const btwRuntime = new BtwRuntimeStore();

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

function activeChat(characterIndex: number, chatIndex: number) {
  return characterStore.characters[characterIndex]?.chats?.[chatIndex] ?? null;
}

function markBtwDirty(chat: Chat, session?: BtwSession) {
  if (session) session.updatedAt = Date.now();
  if (chat.id) characterStore.markChatDirty(chat.id);
}

async function loadPromptPreset(id?: string): Promise<botPreset | undefined> {
  const targetId = id || presetStore.activeId;
  if (!targetId) return presetStore.activePreset;
  try {
    return await presetStore.load(targetId);
  } catch (error) {
    console.warn("[BTW] Failed to load prompt preset; using active prompt", error);
    return presetStore.activePreset;
  }
}

function promptOverridesFromPreset(
  preset: botPreset | undefined,
  config: BtwSessionConfig,
): ChatGenerationOverrides {
  return {
    ...(preset
      ? {
          promptTemplate: safeStructuredClone(preset.promptTemplate ?? null),
          promptSettings: safeStructuredClone(
            preset.promptSettings ?? settingsStore.state.promptSettings,
          ),
          mainPrompt: preset.mainPrompt ?? settingsStore.state.mainPrompt,
          jailbreak: preset.jailbreak ?? settingsStore.state.jailbreak,
          globalNote: preset.globalNote ?? settingsStore.state.globalNote,
          formatingOrder: safeStructuredClone(
            preset.formatingOrder ?? settingsStore.state.formatingOrder,
          ),
          promptPreprocess:
            preset.promptPreprocess ?? settingsStore.state.promptPreprocess,
        }
      : {}),
    jailbreakToggle: config.jailbreakToggle,
    moduleIds: [...config.moduleIds],
    chatVariables: { ...config.toggleValues },
    // Side sessions must not mutate the parent chat through Lua/start/output triggers.
    suppressTriggers: true,
    // BTW should see the frozen parent context, not mutate/refresh long-term memory.
    skipMemory: true,
    pluginsEnabled: config.pluginsEnabled,
  };
}

function findCharacter(id: string): character | undefined {
  const direct = findCharacterbyId(id);
  if (direct?.type === "character") return direct;
  return characterStore.characters.find(
    (entry): entry is character => entry?.type === "character" && entry.chaId === id,
  );
}

function resolveBtwSpeaker(
  room: character | groupChat,
  baseMessages: Message[],
): character {
  if (room.type === "character") return room;
  const lastSpeaker = [...baseMessages]
    .reverse()
    .find((message) => message.role === "char" && message.saying)?.saying;
  if (lastSpeaker) {
    const found = findCharacter(lastSpeaker);
    if (found) return found;
  }
  for (let index = 0; index < room.characters.length; index++) {
    if (room.characterActive?.[index] === false) continue;
    const found = findCharacter(room.characters[index]);
    if (found) return found;
  }
  throw new Error("BTW could not resolve a speaker for this group chat");
}

function createSyntheticChat(
  parent: Chat,
  session: BtwSession,
  pendingAssistantId: string,
) {
  const synthetic = safeStructuredClone(parent);
  synthetic.id = `${parent.id ?? "chat"}:btw:${session.id}`;
  synthetic.btwSessions = undefined;
  synthetic.activeBtwSessionId = undefined;
  const base = parent.message.slice(0, session.baseMessageCount);
  const sideMessages = session.messages.filter(
    (message) => message.chatId !== pendingAssistantId,
  );
  synthetic.message = safeStructuredClone([...base, ...sideMessages]);
  synthetic.messagesFullyLoaded = true;
  synthetic.messagesLoaded = true;
  synthetic.messageOffset = 0;
  synthetic.messageTotal = synthetic.message.length;
  synthetic.preventMessageCompaction = true;
  synthetic.useLocallySetGlobalVariables = true;
  synthetic.GLGlobalVariables = {
    ...(parent.GLGlobalVariables ?? {}),
    ...session.config.toggleValues,
  };
  return synthetic;
}

async function consumeBtwResponse(
  response: ChatModelResponse,
  signal: AbortSignal,
  onChunk: (text: string) => void,
) {
  if (response.type === "fail") throw new Error(response.result);
  if (response.type === "success") {
    onChunk(response.result);
    return response.result;
  }
  if (response.type === "multiline") {
    const result = response.result.map(([, text]) => text).join("\n");
    onChunk(result);
    return result;
  }

  const reader = response.result.getReader();
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  let result = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.value) {
        const firstKey = Object.keys(chunk.value)[0];
        const next = firstKey ? chunk.value[firstKey] ?? result : result;
        result = next;
        onChunk(result);
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
  if (signal.aborted) throw new DOMException("BTW generation aborted", "AbortError");
  return result;
}

function buildPromptInfo(
  preset: botPreset | undefined,
  session: BtwSession,
): MessagePresetInfo {
  return {
    promptName: preset?.name ?? "BTW",
    promptToggles: Object.entries(session.config.toggleValues)
      .filter(([key]) => key.startsWith("toggle_"))
      .map(([key, value]) => ({ key: key.slice(7), value })),
  };
}

export async function getBtwToggleDefinitions(
  characterIndex: number,
  session: BtwSession,
): Promise<BtwToggleDefinition[]> {
  const room = characterStore.characters[characterIndex];
  if (!room) return [];
  const preset = await loadPromptPreset(session.config.promptPresetId);
  return parseToggleSyntax(
    `${preset?.customPromptTemplateToggle ?? ""}\n${getModuleToggles(
      room,
      session.config.moduleIds,
    )}`,
  );
}

export async function syncBtwToggleValues(
  characterIndex: number,
  chat: Chat,
  session: BtwSession,
) {
  const definitions = await getBtwToggleDefinitions(characterIndex, session);
  const next = { ...session.config.toggleValues };
  let changed = false;
  for (const toggle of definitions) {
    if (!toggle.key || ["group", "groupEnd", "divider", "caption"].includes(toggle.type ?? "")) {
      continue;
    }
    const key = `toggle_${toggle.key}`;
    if (!(key in next)) {
      next[key] = "";
      changed = true;
    }
  }
  if (changed) updateBtwSessionConfig(chat, session, { toggleValues: next });
  return definitions;
}

async function createSession(
  characterIndex: number,
  chatIndex: number,
  name?: string,
): Promise<BtwSession> {
  await preLoadChat(characterIndex, chatIndex, { full: true });
  const room = characterStore.characters[characterIndex];
  const chat = room?.chats?.[chatIndex];
  if (!room || !chat) throw new Error("BTW target chat not found");
  const moduleIds = getModules(room).map((module) => module.id);
  const preset = await loadPromptPreset(presetStore.activeId);
  const toggleDefinitions = parseToggleSyntax(
    `${preset?.customPromptTemplateToggle ?? ""}\n${getModuleToggles(room, moduleIds)}`,
  );
  const toggleValues: Record<string, string> = {};
  for (const toggle of toggleDefinitions) {
    if (!toggle.key || ["group", "groupEnd", "divider", "caption"].includes(toggle.type ?? "")) {
      continue;
    }
    const key = `toggle_${toggle.key}`;
    const value = getGlobalChatVar(
      key,
      requireChatTargetFromIndexes(characterIndex, chatIndex),
    );
    toggleValues[key] = value === "null" ? "" : value;
  }
  const now = Date.now();
  const session: BtwSession = {
    id: v4(),
    name: name?.trim().slice(0, 48) || `BTW ${(chat.btwSessions?.length ?? 0) + 1}`,
    createdAt: now,
    updatedAt: now,
    baseMessageCount: chat.message.length,
    messages: [],
    config: {
      promptPresetId: presetStore.activeId || undefined,
      moduleIds,
      toggleValues,
      jailbreakToggle: settingsStore.state.jailbreakToggle,
      pluginsEnabled: true,
    },
  };
  chat.btwSessions ??= [];
  chat.btwSessions.push(session);
  chat.activeBtwSessionId = session.id;
  markBtwDirty(chat, session);
  return session;
}

export async function createBtwSession(
  characterIndex: number,
  chatIndex: number,
  name?: string,
) {
  return createSession(characterIndex, chatIndex, name);
}

export function selectBtwSession(chat: Chat, sessionId: string) {
  if (!chat.btwSessions?.some((session) => session.id === sessionId)) return;
  chat.activeBtwSessionId = sessionId;
  markBtwDirty(chat);
}

export function deleteBtwSession(chat: Chat, sessionId: string) {
  chat.btwSessions = (chat.btwSessions ?? []).filter(
    (session) => session.id !== sessionId,
  );
  if (chat.activeBtwSessionId === sessionId) {
    chat.activeBtwSessionId = chat.btwSessions.at(-1)?.id;
  }
  markBtwDirty(chat);
}

export function updateBtwSessionConfig(
  chat: Chat,
  session: BtwSession,
  patch: Partial<BtwSessionConfig>,
) {
  session.config = {
    ...session.config,
    ...patch,
    moduleIds: patch.moduleIds ? [...patch.moduleIds] : session.config.moduleIds,
    toggleValues: patch.toggleValues
      ? { ...patch.toggleValues }
      : session.config.toggleValues,
  };
  markBtwDirty(chat, session);
}

export function renameBtwSession(chat: Chat, session: BtwSession, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  session.name = trimmed.slice(0, 80);
  markBtwDirty(chat, session);
}

export function closeBtwPanel() {
  btwRuntime.open = false;
}

export function cancelBtwGeneration(sessionId: string) {
  const controller = controllers.get(sessionId);
  controller?.abort();
}

const controllers = new Map<string, AbortController>();

export async function sendBtwMessage(
  characterIndex: number,
  chatIndex: number,
  sessionId: string,
  text: string,
) {
  const trimmed = text.trim();
  if (!trimmed || btwRuntime.generating[sessionId]) return;
  await preLoadChat(characterIndex, chatIndex, { full: true });
  const room = characterStore.characters[characterIndex];
  const parent = room?.chats?.[chatIndex];
  const session = parent?.btwSessions?.find((item) => item.id === sessionId);
  if (!room || !parent || !session) throw new Error("BTW session not found");

  const userMessage: Message = {
    role: "user",
    data: trimmed,
    time: Date.now(),
    chatId: v4(),
  };
  const assistantMessage: Message = {
    role: "char",
    data: "",
    time: Date.now(),
    chatId: v4(),
  };
  if (session.messages.length === 0 && session.name.startsWith("BTW ")) {
    session.name = trimmed.replace(/\s+/g, " ").slice(0, 48);
  }
  session.messages.push(userMessage, assistantMessage);
  markBtwDirty(parent, session);

  const controller = new AbortController();
  controllers.set(sessionId, controller);
  btwRuntime.generating[sessionId] = true;
  delete btwRuntime.errors[sessionId];

  try {
    const baseMessages = parent.message.slice(0, session.baseMessageCount);
    const currentChar = resolveBtwSpeaker(room, baseMessages);
    const syntheticChat = createSyntheticChat(parent, session, assistantMessage.chatId!);
    await syncBtwToggleValues(characterIndex, parent, session);
    const preset = await loadPromptPreset(session.config.promptPresetId);
    const generation = promptOverridesFromPreset(preset, session.config);
    const tokenizer = new ChatTokenizer(
      settingsStore.state.aiModel.startsWith("gpt") ? 5 : 3,
      settingsStore.state.aiModel.startsWith("gpt") ? "noName" : "name",
    );
    const prompt = await buildGenerationPrompt({
      currentChar,
      currentChat: syntheticChat,
      nowChatroom: room,
      tokenizer,
      maxContextTokens: settingsStore.state.maxContext,
      selectedChar: characterIndex,
      selectedChat: chatIndex,
      stageTimings: createStageTimings(),
      promptInfo: buildPromptInfo(preset, session),
      findCharacter: (id) => findCharacter(id)!,
      throwError: (error) => {
        throw new Error(error);
      },
      generation,
    });
    if (!prompt.ok) throw new Error("BTW prompt generation stopped");

    const runtime = createLocalChatGenerationRuntime(tokenizer);
    const plan =
      (await tryCreateNodeChatGenerationPlan({
        formated: prompt.formated,
        maxContextTokens: settingsStore.state.maxContext,
        tokenizer,
        runtime,
      })) ??
      (await createChatGenerationPlan(runtime, {
        formated: prompt.formated,
        maxContextTokens: settingsStore.state.maxContext,
      }));
    if (!plan.ok) {
      throw new Error("BTW context is too large for the current model");
    }

    const response = await executeChatModelRequest(
      runtime,
      {
        plan,
        biases: prompt.biases,
        triggerTarget: requireChatTargetFromIndexes(characterIndex, chatIndex),
        currentChar,
        isGroupChat: room.type === "group",
        escape: room.type === "character" && room.escapeOutput,
        speakerId: currentChar.chaId,
      },
      controller.signal,
    );
    const result = await consumeBtwResponse(
      response,
      controller.signal,
      (chunk) => {
        assistantMessage.data = chunk;
        session.updatedAt = Date.now();
      },
    );
    assistantMessage.data = result.trim();
    assistantMessage.generationInfo = {
      model: response.model ?? plan.generationModel,
      generationId: plan.generationId,
      inputTokens: plan.inputTokens,
      outputTokens: plan.outputTokens,
      maxContext: settingsStore.state.maxContext,
    };
    if (session.config.pluginsEnabled) {
      await runChatOutputListeners(
        currentChar,
        { ...syntheticChat, message: session.messages },
        characterIndex,
        chatIndex,
        session.messages.length - 1,
      );
    }
    markBtwDirty(parent, session);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (!assistantMessage.data) assistantMessage.data = "[BTW generation cancelled]";
    } else {
      const message = error instanceof Error ? error.message : String(error);
      btwRuntime.errors[sessionId] = message;
      assistantMessage.data = assistantMessage.data || `[BTW error] ${message}`;
      console.error("[BTW] generation failed", error);
    }
    markBtwDirty(parent, session);
  } finally {
    controllers.delete(sessionId);
    btwRuntime.generating[sessionId] = false;
  }
}

export async function openBtwPanel(
  characterIndex: number,
  chatIndex: number,
  question = "",
) {
  await preLoadChat(characterIndex, chatIndex, { full: true });
  const chat = activeChat(characterIndex, chatIndex);
  if (!chat) throw new Error("BTW target chat not found");
  btwRuntime.characterIndex = characterIndex;
  btwRuntime.chatIndex = chatIndex;
  btwRuntime.open = true;

  let session: BtwSession | undefined;
  if (question.trim()) {
    session = await createSession(characterIndex, chatIndex, question);
  } else {
    session = chat.btwSessions?.find(
      (item) => item.id === chat.activeBtwSessionId,
    );
    session ??= chat.btwSessions?.at(-1);
    session ??= await createSession(characterIndex, chatIndex);
    chat.activeBtwSessionId = session.id;
  }
  if (question.trim()) {
    void sendBtwMessage(characterIndex, chatIndex, session.id, question);
  }
  return session;
}

export { moduleStore, presetStore };
