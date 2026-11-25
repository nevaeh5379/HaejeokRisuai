import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  modelRequestNotices,
  notifyModelRequest,
  trackModelResponse,
} from "./modelRequestNotices";
import {
  calculateChatGenerationMetrics,
  chatGenerationStats,
  startChatGenerationStats,
} from "../chat/generationStats";

const latest = () => get(modelRequestNotices).at(-1)!;

describe("model request notices", () => {
  it("leaves main model requests to the generation stats float", () => {
    const before = get(modelRequestNotices).length;
    notifyModelRequest("main", "model");
    expect(get(modelRequestNotices)).toHaveLength(before);
  });

  it("records the duration and text of an auxiliary response", async () => {
    const finish = notifyModelRequest("model-a", "submodel");
    expect(latest().endedAt).toBeUndefined();
    await trackModelResponse(
      Promise.resolve({ type: "success", result: "ok" }),
      finish,
    );
    expect(latest().endedAt).toBeGreaterThanOrEqual(latest().startedAt);
    expect(latest().failed).toBe(false);
    expect(latest().outputText).toBe("ok");
  });

  it("marks failed responses", async () => {
    const finish = notifyModelRequest("model-b", "submodel");
    await trackModelResponse(
      Promise.resolve({ type: "fail", result: "no" }),
      finish,
    );
    expect(latest().failed).toBe(true);
  });

  it("ends a streaming request only after the stream closes", async () => {
    const finish = notifyModelRequest("model-c", "submodel");
    const res = await trackModelResponse(
      Promise.resolve({
        type: "streaming",
        result: new ReadableStream<Record<string, string>>({
          start(c) {
            c.enqueue({ "0": "a" });
            c.close();
          },
        }),
      }),
      finish,
    );
    expect(latest().endedAt).toBeUndefined();
    const reader = (
      res.result as ReadableStream<Record<string, string>>
    ).getReader();
    expect((await reader.read()).value).toEqual({ "0": "a" });
    expect((await reader.read()).done).toBe(true);
    expect(latest().endedAt).toBeDefined();
    expect(latest().outputText).toBe("a");
  });

  it("freezes the main model timer when an auxiliary request starts", () => {
    startChatGenerationStats({
      generationId: "gen-pause",
      selectedChar: 0,
      selectedChat: 0,
      model: "main",
      startedAt: Date.now() - 2000,
    });
    notifyModelRequest("aux", "submodel");
    const stats = get(chatGenerationStats).get("gen-pause")!;
    expect(stats.pausedAt).toBeDefined();
    const frozen = calculateChatGenerationMetrics(stats, null, Date.now());
    const later = calculateChatGenerationMetrics(
      stats,
      null,
      Date.now() + 60_000,
    );
    expect(later.totalSeconds).toBe(frozen.totalSeconds);
  });
});
