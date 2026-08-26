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

const COMPLETED_VISIBLE_MS = 8_000;

export const chatGenerationStats = writable<ChatGenerationStats | null>(null);

let currentStats: ChatGenerationStats | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function publish(stats: ChatGenerationStats | null) {
  currentStats = stats;
  chatGenerationStats.set(stats);
}

function clearHideTimer() {
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  hideTimer = undefined;
}

export function startChatGenerationStats(options: {
  generationId: string;
  selectedChar: number;
  selectedChat: number;
  model: string;
  startedAt?: number;
}) {
  clearHideTimer();
  publish({
    ...options,
    phase: "generating",
    startedAt: options.startedAt ?? Date.now(),
    outputText: "",
  });
}

export function updateChatGenerationModel(
  generationId: string,
  model: string,
) {
  if (!currentStats || currentStats.generationId !== generationId) return;
  publish({ ...currentStats, model });
}

export function recordChatGenerationText(
  generationId: string,
  outputText: string,
  observedAt = Date.now(),
  firstTokenAt?: number,
) {
  if (!currentStats || currentStats.generationId !== generationId) return;
  const hasOutput = outputText.length > 0;
  publish({
    ...currentStats,
    outputText,
    firstTokenAt:
      currentStats.firstTokenAt ??
      (hasOutput ? (firstTokenAt ?? observedAt) : undefined),
    lastTokenAt: hasOutput ? observedAt : currentStats.lastTokenAt,
  });
}

export function completeChatGenerationStats(
  generationId: string,
  outputText: string,
  completedAt = Date.now(),
) {
  if (!currentStats || currentStats.generationId !== generationId) return;
  clearHideTimer();
  const hasOutput = outputText.length > 0;
  const completed: ChatGenerationStats = {
    ...currentStats,
    phase: "complete",
    outputText,
    firstTokenAt:
      currentStats.firstTokenAt ?? (hasOutput ? currentStats.startedAt : undefined),
    lastTokenAt: currentStats.lastTokenAt ?? (hasOutput ? completedAt : undefined),
    completedAt,
  };
  publish(completed);
  hideTimer = setTimeout(() => {
    if (currentStats?.generationId === generationId) publish(null);
    hideTimer = undefined;
  }, COMPLETED_VISIBLE_MS);
}

export function cancelChatGenerationStats(generationId: string) {
  if (!currentStats || currentStats.generationId !== generationId) return;
  clearHideTimer();
  publish(null);
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
