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

/** Remove the last assistant reply so the standard pipeline can regenerate. */
export async function removeLastRisuAgentReply(chat: Chat): Promise<boolean> {
  const messages = chat.message ?? [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "char") return false;
  chat.message = messages.slice(0, -1);
  if (chat.id && last.chatId) {
    await messageStore.deleteMessage(chat.id, last.chatId);
  }
  return true;
}
