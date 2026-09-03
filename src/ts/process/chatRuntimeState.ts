import { writable } from "svelte/store";

const localGenerationChats = new Set<string>();
const remoteGenerationSources = new Map<string, Set<string>>();
const processStages = new Map<string, number>();

export const doingChat = writable(false);
/** @deprecated Prefer chatProcessStages for chat-scoped generation UI. */
export const chatProcessStage = writable(0);
export const chatProcessStages = writable<ReadonlyMap<string, number>>(
  new Map(),
);
export const activeGenerationChatIds = writable<ReadonlySet<string>>(new Set());

function publishGenerationState() {
  const active = new Set([
    ...localGenerationChats,
    ...remoteGenerationSources.keys(),
  ]);
  activeGenerationChatIds.set(active);
  doingChat.set(active.size > 0);
}

function publishProcessStages() {
  chatProcessStages.set(new Map(processStages));
}

export function setChatProcessStage(
  chatId: string | undefined,
  stage: number,
): void {
  chatProcessStage.set(stage);
  if (!chatId) return;
  processStages.set(chatId, stage);
  publishProcessStages();
}

export function clearChatProcessStage(chatId: string | undefined): void {
  if (!chatId || !processStages.delete(chatId)) return;
  publishProcessStages();
  if (processStages.size === 0) chatProcessStage.set(0);
}

export function getChatProcessStage(
  stages: ReadonlyMap<string, number>,
  chatId: string | undefined,
): number {
  return chatId ? (stages.get(chatId) ?? 0) : 0;
}

export function isLocalChatGenerationActive(
  chatId: string | undefined,
): boolean {
  return Boolean(chatId && localGenerationChats.has(chatId));
}

export function isChatGenerationActive(chatId: string | undefined): boolean {
  return Boolean(
    chatId &&
    (localGenerationChats.has(chatId) || remoteGenerationSources.has(chatId)),
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
  clearChatProcessStage(chatId);
  publishGenerationState();
}

export function setRemoteChatGeneration(
  chatId: string,
  active: boolean,
  source = "legacy",
): void {
  if (!chatId || !source) return;
  if (active) {
    const sources = remoteGenerationSources.get(chatId) ?? new Set<string>();
    sources.add(source);
    remoteGenerationSources.set(chatId, sources);
  } else {
    const sources = remoteGenerationSources.get(chatId);
    if (!sources) return;
    sources.delete(source);
    if (sources.size === 0) remoteGenerationSources.delete(chatId);
  }
  publishGenerationState();
}
