import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  calculateChatGenerationMetrics,
  cancelChatGenerationStats,
  chatGenerationStats,
  completeChatGenerationStats,
  getChatGenerationStats,
  recordChatGenerationText,
  startChatGenerationStats,
  updateChatGenerationModel,
} from "./chatGenerationStats";

afterEach(() => {
  for (const generationId of get(chatGenerationStats).keys()) {
    cancelChatGenerationStats(generationId);
  }
  vi.useRealTimers();
});

describe("chat generation stats", () => {
  it("tracks model, first token, completion, and displayed throughput", () => {
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

    const stats = get(chatGenerationStats).get("generation-a")!;
    expect(stats.model).toBe("gemini-3.7-flash");
    expect(stats.phase).toBe("complete");
    expect(calculateChatGenerationMetrics(stats, 1_297)).toEqual({
      totalSeconds: 18.4,
      generationSeconds: 14.9,
      tokensPerSecond: 1_297 / 14.9,
    });
  });

  it("keeps concurrent generations isolated by generation id", () => {
    startChatGenerationStats({
      generationId: "generation-a",
      selectedChar: 0,
      selectedChat: 0,
      model: "model-a",
      startedAt: 0,
    });
    startChatGenerationStats({
      generationId: "generation-b",
      selectedChar: 1,
      selectedChat: 3,
      model: "model-b",
      startedAt: 10,
    });
    recordChatGenerationText("generation-a", "alpha", 20);
    completeChatGenerationStats("generation-a", "alpha", 30);
    updateChatGenerationModel("generation-b", "model-b-updated");

    const stats = get(chatGenerationStats);
    expect(stats.size).toBe(2);
    expect(stats.get("generation-a")?.phase).toBe("complete");
    expect(stats.get("generation-a")?.outputText).toBe("alpha");
    expect(stats.get("generation-b")?.phase).toBe("generating");
    expect(stats.get("generation-b")?.model).toBe("model-b-updated");
    expect(getChatGenerationStats(stats, 0, 0)?.generationId).toBe(
      "generation-a",
    );
    expect(getChatGenerationStats(stats, 1, 3)?.generationId).toBe(
      "generation-b",
    );
  });

  it("selects the newest generation for the same chat", () => {
    startChatGenerationStats({
      generationId: "older",
      selectedChar: 0,
      selectedChat: 0,
      model: "older",
      startedAt: 10,
    });
    startChatGenerationStats({
      generationId: "newer",
      selectedChar: 0,
      selectedChat: 0,
      model: "newer",
      startedAt: 20,
    });

    expect(
      getChatGenerationStats(get(chatGenerationStats), 0, 0)?.generationId,
    ).toBe("newer");
  });

  it("hides only the completed generation after the reading window", async () => {
    vi.useFakeTimers();
    startChatGenerationStats({
      generationId: "completed",
      selectedChar: 0,
      selectedChat: 0,
      model: "done-model",
      startedAt: 0,
    });
    startChatGenerationStats({
      generationId: "active",
      selectedChar: 1,
      selectedChat: 0,
      model: "active-model",
      startedAt: 10,
    });
    completeChatGenerationStats("completed", "done", 1_000);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(get(chatGenerationStats).has("completed")).toBe(true);
    expect(get(chatGenerationStats).has("active")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(get(chatGenerationStats).has("completed")).toBe(false);
    expect(get(chatGenerationStats).has("active")).toBe(true);
  });
});
