import { writable } from "svelte/store";

export interface ChatGenerationStats {
  generationId: string;
  selectedChar: number;
  selectedChat: number;
  model: string;
  phase: "generating" | "complete";
  startedAt: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  completedAt?: number;
  outputText: string;
}

export interface ChatGenerationMetrics {
  totalSeconds: number;
  generationSeconds: number;
  tokensPerSecond: number | null;
}

export type ChatGenerationStatsMap = ReadonlyMap<string, ChatGenerationStats>;

const COMPLETED_VISIBLE_MS = 8_000;
const statsByGeneration = new Map<string, ChatGenerationStats>();
const hideTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const chatGenerationStats = writable<ChatGenerationStatsMap>(new Map());
function publish() {
  chatGenerationStats.set(new Map(statsByGeneration));
}

function clearHideTimer(generationId: string) {
  const timer = hideTimers.get(generationId);
  if (timer !== undefined) clearTimeout(timer);
  hideTimers.delete(generationId);
}

function replaceStats(
  generationId: string,
  update: (stats: ChatGenerationStats) => ChatGenerationStats,
) {
  const current = statsByGeneration.get(generationId);
  if (!current) return;
  statsByGeneration.set(generationId, update(current));
  publish();
}

export function startChatGenerationStats(options: {
  generationId: string;
  selectedChar: number;
  selectedChat: number;
  model: string;
  startedAt?: number;
}) {
  clearHideTimer(options.generationId);
  statsByGeneration.set(options.generationId, {
    ...options,
    phase: "generating",
    startedAt: options.startedAt ?? Date.now(),
    outputText: "",
  });
  publish();
}

export function updateChatGenerationModel(generationId: string, model: string) {
  replaceStats(generationId, (stats) => ({ ...stats, model }));
}

export function recordChatGenerationText(
  generationId: string,
  outputText: string,
  observedAt = Date.now(),
  firstTokenAt?: number,
) {
  replaceStats(generationId, (stats) => {
    const hasOutput = outputText.length > 0;
    return {
      ...stats,
      outputText,
      firstTokenAt:
        stats.firstTokenAt ??
        (hasOutput ? (firstTokenAt ?? observedAt) : undefined),
      lastTokenAt: hasOutput ? observedAt : stats.lastTokenAt,
    };
  });
}
export function completeChatGenerationStats(
  generationId: string,
  outputText: string,
  completedAt = Date.now(),
) {
  clearHideTimer(generationId);
  const current = statsByGeneration.get(generationId);
  if (!current) return;
  const hasOutput = outputText.length > 0;
  statsByGeneration.set(generationId, {
    ...current,
    phase: "complete",
    outputText,
    firstTokenAt:
      current.firstTokenAt ?? (hasOutput ? current.startedAt : undefined),
    lastTokenAt: current.lastTokenAt ?? (hasOutput ? completedAt : undefined),
    completedAt,
  });
  publish();
  hideTimers.set(
    generationId,
    setTimeout(() => {
      statsByGeneration.delete(generationId);
      hideTimers.delete(generationId);
      publish();
    }, COMPLETED_VISIBLE_MS),
  );
}
export function cancelChatGenerationStats(generationId: string) {
  clearHideTimer(generationId);
  if (!statsByGeneration.delete(generationId)) return;
  publish();
}

export function getChatGenerationStats(
  stats: ChatGenerationStatsMap,
  selectedChar: number,
  selectedChat: number,
) {
  let match: ChatGenerationStats | null = null;
  for (const current of stats.values()) {
    if (
      current.selectedChar !== selectedChar ||
      current.selectedChat !== selectedChat
    ) {
      continue;
    }
    if (!match || current.startedAt > match.startedAt) match = current;
  }
  return match;
}

export function calculateChatGenerationMetrics(
  stats: ChatGenerationStats,
  outputTokens: number | null,
  now = Date.now(),
): ChatGenerationMetrics {
  const totalEnd = stats.completedAt ?? now;
  const generationStart = stats.firstTokenAt;
  const generationEnd = stats.lastTokenAt ?? totalEnd;
  const totalSeconds = Math.max(0, totalEnd - stats.startedAt) / 1000;
  const generationSeconds = generationStart
    ? Math.max(0, generationEnd - generationStart) / 1000
    : 0;
  return {
    totalSeconds,
    generationSeconds,
    tokensPerSecond:
      outputTokens !== null && generationSeconds > 0
        ? outputTokens / generationSeconds
        : null,
  };
}
