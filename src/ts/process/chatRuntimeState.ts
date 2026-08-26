import { writable } from "svelte/store";

const localGenerationChats = new Set<string>();
const remoteGenerationChats = new Set<string>();

export const doingChat = writable(false);
export const chatProcessStage = writable(0);
export const activeGenerationChatIds = writable<ReadonlySet<string>>(new Set());

function publishGenerationState() {
  const active = new Set([...localGenerationChats, ...remoteGenerationChats]);
  activeGenerationChatIds.set(active);
  doingChat.set(active.size > 0);
}

export function isLocalChatGenerationActive(
  chatId: string | undefined,
): boolean {
  return Boolean(chatId && localGenerationChats.has(chatId));
}

export function isChatGenerationActive(chatId: string | undefined): boolean {
  return Boolean(
    chatId &&
      (localGenerationChats.has(chatId) || remoteGenerationChats.has(chatId)),
  );
}

export function beginChatGeneration(chatId: string): boolean {
  if (!chatId || isChatGenerationActive(chatId)) return false;
  localGenerationChats.add(chatId);
  publishGenerationState();
  return true;
}

export function endChatGeneration(chatId: string): void {
  if (!chatId || !localGenerationChats.delete(chatId)) return;
  publishGenerationState();
}

export function setRemoteChatGeneration(chatId: string, active: boolean): void {
  if (!chatId) return;
  if (active) remoteGenerationChats.add(chatId);
  else remoteGenerationChats.delete(chatId);
  publishGenerationState();
}
