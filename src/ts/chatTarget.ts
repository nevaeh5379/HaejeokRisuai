import { characterStore } from "./stores/domain/characterStore.svelte";
import type { Chat, character, groupChat } from "./storage/database/schema";

export interface ChatTarget {
  characterId: string;
  chatId: string;
}

export interface ChatExecutionTarget extends ChatTarget {
  /** Request-local variable overlay used by isolated generations such as /btw. */
  globalVariables?: Record<string, string>;
}

export interface ResolvedChatTarget {
  target: ChatTarget;
  character: character | groupChat;
  chat: Chat;
  characterIndex: number;
  chatIndex: number;
}

/** Resolve stable IDs at the moment an operation runs; never retain array indexes. */
export function resolveChatTarget(
  target: ChatTarget,
): ResolvedChatTarget | null {
  const characterIndex = characterStore.characters.findIndex(
    (candidate) => candidate.chaId === target.characterId,
  );
  if (characterIndex < 0) return null;
  const character = characterStore.characters[characterIndex];
  const chatIndex =
    character.chats?.findIndex((candidate) => candidate.id === target.chatId) ??
    -1;
  if (chatIndex < 0) return null;
  return {
    target,
    character,
    chat: character.chats[chatIndex],
    characterIndex,
    chatIndex,
  };
}

export function requireChatTarget(target: ChatTarget): ResolvedChatTarget {
  const resolved = resolveChatTarget(target);
  if (!resolved) {
    throw new Error(
      `Chat target not found: ${target.characterId}/${target.chatId}`,
    );
  }
  return resolved;
}

export function targetForChatId(chatId: string): ChatTarget | null {
  for (const character of characterStore.characters) {
    if (!character.chaId) continue;
    if (character.chats?.some((chat) => chat.id === chatId)) {
      return { characterId: character.chaId, chatId };
    }
  }
  return null;
}

/** Convert UI array coordinates once at the boundary; internal work keeps IDs. */
export function chatTargetFromIndexes(
  characterIndex: number,
  chatIndex: number,
): ChatTarget | null {
  const character = characterStore.characters[characterIndex];
  const chat = character?.chats?.[chatIndex];
  if (!character?.chaId || !chat?.id) return null;
  return { characterId: character.chaId, chatId: chat.id };
}

export function requireChatTargetFromIndexes(
  characterIndex: number,
  chatIndex: number,
): ChatTarget {
  const target = chatTargetFromIndexes(characterIndex, chatIndex);
  if (!target) {
    throw new Error(
      `Chat coordinates not found: ${characterIndex}/${chatIndex}`,
    );
  }
  return target;
}

/** Captures the currently selected UI chat as stable IDs. */
export function getSelectedChatTarget(): ChatTarget | null {
  const character = characterStore.characters[characterStore.selectedId];
  const chat = character?.chats?.[character.chatPage ?? 0];
  if (!character?.chaId || !chat?.id) return null;
  return { characterId: character.chaId, chatId: chat.id };
}

export function resolveSelectedChatTarget(): ResolvedChatTarget | null {
  const target = getSelectedChatTarget();
  return target ? resolveChatTarget(target) : null;
}

export function requireSelectedChatTarget(): ResolvedChatTarget {
  const resolved = resolveSelectedChatTarget();
  if (!resolved) throw new Error("No chat is selected");
  return resolved;
}

export function replaceTargetChat(target: ChatTarget, chat: Chat): boolean {
  const resolved = resolveChatTarget(target);
  if (!resolved) return false;
  resolved.character.chats[resolved.chatIndex] = chat;
  if (chat.id) characterStore.markChatDirty(chat.id);
  return true;
}
