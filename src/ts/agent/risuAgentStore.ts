import { v4 as uuidv4 } from "uuid";
import type { Chat, Message, character } from "../storage/database/schema";
import { createBlankChar } from "../characterDefaults";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { RISU_AGENT_CHARACTER_ID } from "../systemCharacters";
import {
  createRisuAgentChat,
  isHydratedRisuAgentCharacter,
  normalizeRisuAgentChatContext,
  resolveRisuAgentChatId,
  resolveRisuAgentSessionContext,
  RISU_AGENT_DISPLAY_NAME,
  RISU_AGENT_SYSTEM_INSTRUCTION,
  type RisuAgentChatContext,
} from "./risuAgentModel";
import {
  normalizeRisuAgentPromptConfig,
  type RisuAgentPromptConfig,
} from "./risuAgentPrompt";
import { safeStructuredClone } from "../polyfill";
import {
  clearRisuAgentContextScope,
  setRisuAgentContextScope,
} from "../process/mcp/risuagent/scope";

/** Locate Risu Agent's reserved character without hydrating any other data. */
export function findRisuAgentCharacterIndex(): number {
  return characterStore.characters.findIndex(
    (char) => char?.chaId === RISU_AGENT_CHARACTER_ID,
  );
}

export function getRisuAgentCharacter(): character | undefined {
  const index = findRisuAgentCharacterIndex();
  if (index < 0) return undefined;
  const char = characterStore.characters[index];
  if (!char || char.type === "group") return undefined;
  return char;
}

function buildRisuAgentCharacter(): character {
  const char = createBlankChar();
  char.chaId = RISU_AGENT_CHARACTER_ID;
  char.name = RISU_AGENT_DISPLAY_NAME;
  char.desc = RISU_AGENT_SYSTEM_INSTRUCTION;
  char.utilityBot = true;
  char.firstMessage = "";
  char.creatorNotes =
    "Reserved character owned by Risu Agent. Hidden from character lists.";
  const firstChat = createRisuAgentChat(1);
  firstChat.id = uuidv4();
  char.chats = [firstChat];
  char.chatPage = 0;
  return char;
}

/**
 * Ensure Risu Agent's reserved character exists and its details are hydrated.
 * Only this single character is loaded; ordinary characters stay lazy.
 */
export async function ensureRisuAgentCharacter(): Promise<{
  character: character;
  index: number;
}> {
  let index = findRisuAgentCharacterIndex();
  if (index < 0) {
    index = characterStore.add(buildRisuAgentCharacter());
    await characterStore.flush();
  }

  const summary = characterStore.characters[index];
  if (summary && summary.detailsLoaded === false) {
    // ensureCharacterDetails catches storage errors, so verify afterwards.
    await characterStore.ensureCharacterDetails(RISU_AGENT_CHARACTER_ID);
  }

  // Re-resolve after the await; selection/order may have changed.
  index = findRisuAgentCharacterIndex();
  const character = characterStore.characters[index];
  if (!character) {
    throw new Error("Risu Agent character is unavailable");
  }
  if (!isHydratedRisuAgentCharacter(character)) {
    throw new Error("Risu Agent character details could not be loaded");
  }
  return { character: character as character, index };
}

/** Resolve the session to show, preferring a stable chat id. */
export function resolveRisuAgentSession(
  character: character,
  preferredChatId?: string | null,
): Chat | undefined {
  const chats = character.chats ?? [];
  const chatId = resolveRisuAgentChatId(
    chats,
    preferredChatId,
    character.chatPage,
  );
  if (!chatId) return undefined;
  return chats.find((chat) => chat.id === chatId);
}

/**
 * Sync the runtime tool scope for exactly one session from its persisted
 * metadata. Never touches other sessions, so an in-flight generation keeps the
 * scope it started with.
 */
export function registerRisuAgentSessionScope(chat: Chat): void {
  if (!chat?.id) return;
  const context = resolveRisuAgentSessionContext(chat);
  if (context) {
    setRisuAgentContextScope(chat.id, {
      characterId: context.characterId,
      chatId: context.chatId,
    });
  } else {
    clearRisuAgentContextScope(chat.id);
  }
}

/**
 * Persist the attached context on the session itself (chat row metadata) and
 * mirror it into the runtime registry for that chat id only.
 */
export async function setRisuAgentSessionContext(
  character: character,
  chatId: string,
  scope: RisuAgentChatContext | null,
): Promise<void> {
  const chat = (character.chats ?? []).find((item) => item.id === chatId);
  if (!chat?.id) return;
  const normalized = normalizeRisuAgentChatContext(scope);
  if (normalized) {
    chat.agentContext = normalized;
  } else {
    delete chat.agentContext;
  }
  characterStore.markChatDirty(chat.id);
  await characterStore.flush();
  registerRisuAgentSessionScope(chat);
}

/**
 * Create a new Risu Agent session on the reserved character and persist its
 * manifest through the normal SQL-backed chat path.
 */
export async function createRisuAgentSession(
  character: character,
): Promise<Chat> {
  const chat = createRisuAgentChat((character.chats?.length ?? 0) + 1);
  chat.id = uuidv4();
  character.chats = [...(character.chats ?? []), chat];
  character.chatPage = character.chats.length - 1;
  characterStore.markChatDirty(chat.id);
  characterStore.markChatManifestDirty(character.chaId);
  // chatPage is a persisted character field; Risu Agent is never the active
  // selection, so it is not picked up by the active-character observer.
  characterStore.markCharacterDirty(character.chaId);
  await characterStore.flush();
  return chat;
}

/** Mark the persisted active session without touching message storage. */
export function selectRisuAgentSession(
  character: character,
  chatId: string,
): void {
  const chats = character.chats ?? [];
  const index = chats.findIndex((chat) => chat.id === chatId);
  if (index < 0) return;
  character.chatPage = index;
  characterStore.markCharacterDirty(character.chaId);
}

/**
 * Read Risu Agent's prompt configuration from the reserved character.
 * Returns null when nothing usable is persisted, which means the agent keeps
 * the default utility-bot prompt behavior.
 */
export function getRisuAgentPromptConfig(
  character: character | null | undefined,
): RisuAgentPromptConfig | null {
  return normalizeRisuAgentPromptConfig(character?.agentPrompt);
}

/**
 * Persist Risu Agent's prompt configuration globally on the reserved character.
 * Passing null removes the field entirely, restoring the default behavior
 * without destroying any conversation data.
 */
export async function setRisuAgentPromptConfig(
  character: character,
  config: RisuAgentPromptConfig | null,
): Promise<void> {
  const normalized = normalizeRisuAgentPromptConfig(config);
  if (normalized) {
    // Persistence boundary: store an owned deep clone so later editor mutations
    // cannot reach the saved character without an explicit save.
    character.agentPrompt = safeStructuredClone(normalized);
  } else {
    delete character.agentPrompt;
  }
  characterStore.markCharacterDirty(character.chaId);
  await characterStore.flush();
}

/**
 * Append a user message to the agent session and persist it before generation,
 * mirroring the normal chat send path.
 */
export async function appendRisuAgentUserMessage(
  chat: Chat,
  text: string,
): Promise<Message> {
  const message: Message = {
    role: "user",
    data: text,
    time: Date.now(),
    chatId: uuidv4(),
  };
  chat.message = [...(chat.message ?? []), message];
  if (chat.id) {
    chat.lastDate = message.time;
    await messageStore.appendMessage(chat.id, message);
  }
  return message;
}

/** A reply removed for regeneration, with enough data to restore it. */
export interface RemovedRisuAgentReply {
  message: Message;
  index: number;
}

/**
 * Remove the last assistant reply so the standard pipeline can regenerate.
 * Returns the removed message and its original position so callers can roll
 * back if the retry fails.
 *
 * Count bookkeeping: `messageTotal` is decremented exactly once. MessageStore
 * owns the decrement when both ids exist (it removes the message from the
 * in-memory window and updates the count together); otherwise we remove it
 * locally and decrement once ourselves. The in-memory array is never mutated
 * before calling MessageStore, otherwise it would see zero deletions and skip
 * the decrement, which restore would then overcount.
 */
export async function removeLastRisuAgentReply(
  chat: Chat,
): Promise<RemovedRisuAgentReply | null> {
  const messages = chat.message ?? [];
  const index = messages.length - 1;
  const last = messages[index];
  if (!last || last.role !== "char") return null;

  const persisted = Boolean(chat.id && last.chatId);
  if (persisted) {
    await messageStore.deleteMessage(chat.id!, last.chatId!);
  }

  // If MessageStore could not own the removal (missing ids, or the chat is not
  // resolvable from the store), remove it locally and keep the count in sync
  // exactly once.
  const current = chat.message ?? [];
  const stillPresent = current.some(
    (message) =>
      message === last || (persisted && message.chatId === last.chatId),
  );
  if (stillPresent) {
    chat.message = current.filter(
      (message) =>
        !(message === last || (persisted && message.chatId === last.chatId)),
    );
    decrementRisuAgentMessageTotal(chat);
  }

  return { message: last, index };
}

function decrementRisuAgentMessageTotal(chat: Chat): void {
  if (typeof chat.messageTotal === "number") {
    chat.messageTotal = Math.max(0, chat.messageTotal - 1);
  }
}

/**
 * Restore a reply removed by {@link removeLastRisuAgentReply} at its original
 * in-memory position and in SQL storage, returning `messageTotal` to its
 * original value exactly once. Used when regeneration fails, throws or is
 * aborted so a failed retry never destroys the prior answer.
 */
export async function restoreRisuAgentReply(
  chat: Chat,
  removed: RemovedRisuAgentReply,
): Promise<void> {
  const messages = chat.message ?? [];
  if (
    removed.message.chatId &&
    messages.some((message) => message.chatId === removed.message.chatId)
  ) {
    return;
  }
  const insertAt = Math.min(Math.max(removed.index, 0), messages.length);
  const next = messages.slice();
  next.splice(insertAt, 0, removed.message);
  chat.message = next;
  if (typeof chat.messageTotal === "number") chat.messageTotal += 1;
  if (chat.id) {
    await messageStore.appendMessage(chat.id, removed.message);
  }
}
