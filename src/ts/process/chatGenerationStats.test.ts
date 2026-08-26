import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  calculateChatGenerationMetrics,
  cancelChatGenerationStats,
  chatGenerationStats,
  completeChatGenerationStats,
  recordChatGenerationText,
  startChatGenerationStats,
  updateChatGenerationModel,
} from "./chatGenerationStats";

afterEach(() => {
  const current = get(chatGenerationStats);
  if (current) cancelChatGenerationStats(current.generationId);
  vi.useRealTimers();
});

describe("chat generation stats", () => {
  it("tracks model, first token, completion, and the displayed throughput", () => {
    startChatGenerationStats({
      generationId: "generation-a",
      selectedChar: 1,
      selectedChat: 2,
      model: "initial-model",
      startedAt: 1_000,
    });
    updateChatGenerationModel("generation-a", "gemini-3.7-flash");
    recordChatGenerationText("generation-a", "hello", 4_500);
    recordChatGenerationText("generation-a", "hello world", 19_400);
    completeChatGenerationStats("generation-a", "hello world", 19_400);

    const stats = get(chatGenerationStats)!;
    expect(stats.model).toBe("gemini-3.7-flash");
    expect(stats.phase).toBe("complete");
    expect(calculateChatGenerationMetrics(stats, 1_297)).toEqual({
      totalSeconds: 18.4,
      generationSeconds: 14.9,
      tokensPerSecond: 1_297 / 14.9,
    });
  });

  it("ignores late updates from an older generation", () => {
    startChatGenerationStats({
      generationId: "old",
      selectedChar: 0,
      selectedChat: 0,
      model: "old-model",
      startedAt: 0,
    });
    startChatGenerationStats({
      generationId: "current",
      selectedChar: 0,
      selectedChat: 0,
      model: "current-model",
      startedAt: 10,
    });

    recordChatGenerationText("old", "stale", 20);
    completeChatGenerationStats("old", "stale", 30);

    expect(get(chatGenerationStats)?.generationId).toBe("current");
    expect(get(chatGenerationStats)?.outputText).toBe("");
  });

  it("hides completed stats after a short reading window", async () => {
    vi.useFakeTimers();
    startChatGenerationStats({
      generationId: "generation-a",
      selectedChar: 0,
      selectedChat: 0,
      model: "model",
      startedAt: 0,
    });
    completeChatGenerationStats("generation-a", "done", 1_000);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(get(chatGenerationStats)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(get(chatGenerationStats)).toBeNull();
  });
});
