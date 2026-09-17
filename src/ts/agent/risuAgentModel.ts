import type { Chat } from "../storage/database/schema";
import {
  isHiddenFromCharacterLists,
  RISU_AGENT_CHARACTER_ID,
} from "../systemCharacters";

export { RISU_AGENT_CHARACTER_ID };

/** Small, stable per-session attachment persisted on the chat row. */
export interface RisuAgentChatContext {
  characterId: string;
  chatId?: string;
}

/** Normalize persisted/raw context down to stable ids, or null. */
export function normalizeRisuAgentChatContext(
  value: unknown,
): RisuAgentChatContext | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { characterId?: unknown; chatId?: unknown };
  const characterId =
    typeof raw.characterId === "string" ? raw.characterId.trim() : "";
  if (!characterId) return null;
  const chatId = typeof raw.chatId === "string" ? raw.chatId.trim() : "";
  return chatId ? { characterId, chatId } : { characterId };
}

/** Read a chat's persisted agent context, ignoring malformed summaries. */
export function resolveRisuAgentSessionContext(
  chat: { agentContext?: unknown } | null | undefined,
): RisuAgentChatContext | null {
  if (!chat) return null;
  return normalizeRisuAgentChatContext(chat.agentContext);
}

/**
 * Session/context changes are blocked while a generation is running so an
 * in-flight request always keeps the scope it started with.
 */
export function canMutateRisuAgentSession(busy: boolean): boolean {
  return !busy;
}

/**
 * True only when a character object carries fully loaded details. Lazy
 * summaries (`detailsLoaded === false`) and group chats are rejected so a
 * failed hydration is never mistaken for an empty, fully loaded character.
 */
export function isHydratedRisuAgentCharacter(
  char: { type?: string | null; detailsLoaded?: boolean | null } | null | undefined,
): boolean {
  if (!char) return false;
  if (char.type === "group") return false;
  return char.detailsLoaded !== false;
}

export const RISU_AGENT_DISPLAY_NAME = "Risu Agent";

/**
 * Agent-specific system instruction. Stored on the reserved character's
 * `desc`, which the utility-bot prompt template renders as the leading system
 * message. Risu tools are explicitly described as optional and read-only.
 */
export const RISU_AGENT_SYSTEM_INSTRUCTION = `You are Risu Agent, a helpful, general-purpose AI assistant running inside the Risuai application. You help with everyday tasks: answering questions, writing and editing text, summarizing, brainstorming, planning, analysis, and coding help. Be clear, accurate, and practical. Ask a clarifying question only when it is genuinely needed.

Risu context is optional. When a Risu character (and optionally one of its chats) is attached, you gain read-only tools to look up that character's creation metadata, lorebooks, chat list, and recent messages. Use them only when they are relevant to the user's request, never invent data you did not read, and remember that these tools are strictly read-only: you cannot modify, create, or delete anything.

When no Risu context is attached, behave as a normal general-purpose assistant. Never claim to have changed Risu data, and never request or reveal API keys, credentials, global settings, or files. Reply in the user's language unless asked otherwise.`;

export function isRisuAgentCharacterIdValue(
  chaId: string | null | undefined,
): boolean {
  return chaId === RISU_AGENT_CHARACTER_ID;
}

export function createRisuAgentChat(sequence: number): Chat {
  const safeSequence = Number.isFinite(sequence) ? Math.max(1, sequence) : 1;
  return {
    id: undefined,
    name: `Conversation ${safeSequence}`,
    note: "",
    localLore: [],
    message: [],
    lastDate: Date.now(),
  };
}

/**
 * Resolve the active chat for the agent surface by stable ID first, then the
 * persisted index, then the most recently used chat. Never returns an array
 * index to callers.
 */
export function resolveRisuAgentChatId(
  chats: readonly Chat[] | null | undefined,
  preferredChatId: string | null | undefined,
  preferredIndex: number | null | undefined,
): string | undefined {
  if (!chats || chats.length === 0) return undefined;
  if (preferredChatId) {
    const byId = chats.find((chat) => chat.id === preferredChatId);
    if (byId?.id) return byId.id;
  }
  if (
    typeof preferredIndex === "number" &&
    Number.isFinite(preferredIndex) &&
    preferredIndex >= 0 &&
    preferredIndex < chats.length
  ) {
    const byIndex = chats[Math.floor(preferredIndex)];
    if (byIndex?.id) return byIndex.id;
  }
  let newest: Chat | undefined;
  for (const chat of chats) {
    if (!chat?.id) continue;
    if (
      !newest ||
      (chat.lastDate ?? 0) > (newest.lastDate ?? 0)
    ) {
      newest = chat;
    }
  }
  return newest?.id;
}

export interface AttachableCharacterFields {
  chaId?: string | null;
  name?: string | null;
  type?: string | null;
  trashTime?: number | null;
}

/**
 * Characters the agent context picker may show: ordinary, non-group, not
 * trashed, and not reserved/system. Names come from lazy summaries, so this
 * never hydrates details.
 */
export function filterRisuAgentAttachableCharacters<
  T extends AttachableCharacterFields,
>(characters: readonly T[], query: string, limit = 200): T[] {
  const normalized = query.trim().toLowerCase();
  const result: T[] = [];
  for (const character of characters) {
    if (!character || character.type === "group") continue;
    if (isHiddenFromCharacterLists(character)) continue;
    if (
      normalized &&
      !(character.name ?? "").toLowerCase().includes(normalized)
    ) {
      continue;
    }
    result.push(character);
    if (result.length >= limit) break;
  }
  return result;
}
