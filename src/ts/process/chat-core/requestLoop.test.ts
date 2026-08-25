import { describe, expect, it, vi } from "vitest";
import { executeChatRequestFallbacks } from "@risuai/chat-core/requestLoop.cjs";

describe("executeChatRequestFallbacks", () => {
  it("bounds banned-character retries and advances to the next fallback", async () => {
    const calls: string[] = [];
    const response = await executeChatRequestFallbacks({
      fallbackModels: ["fallback-a", "fallback-b", ""],
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackWhenBlankResponse: false,
      bannedCharacterSets: ["Hangul"],
    }, {
      executeAttempt: async ({ fallbackModel }) => {
        calls.push(fallbackModel);
        return fallbackModel === "fallback-a"
          ? { type: "success", result: "금지" }
          : { type: "success", result: "accepted" };
      },
    });

    expect(calls).toEqual(["fallback-a", "fallback-a", "fallback-a", "fallback-b"]);
    expect(response).toEqual({ type: "success", result: "accepted", model: "fallback-b" });
  });

  it("returns a terminal failure instead of retrying banned output forever", async () => {
    const executeAttempt = vi.fn(async () => ({ type: "success" as const, result: "금지" }));
    const response = await executeChatRequestFallbacks({
      fallbackModels: [""],
      requestRetries: 1,
      antiServerOverloads: false,
      fallbackWhenBlankResponse: false,
      bannedCharacterSets: ["Hangul"],
    }, { executeAttempt });

    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({ type: "fail", noRetry: true });
  });

  it("moves to the next fallback immediately for blank successful responses", async () => {
    const calls: string[] = [];
    const response = await executeChatRequestFallbacks({
      fallbackModels: ["fallback-a", "fallback-b", ""],
      requestRetries: 3,
      antiServerOverloads: false,
      fallbackWhenBlankResponse: true,
    }, {
      executeAttempt: async ({ fallbackModel }) => {
        calls.push(fallbackModel);
        return { type: "success", result: fallbackModel === "fallback-a" ? "   " : "ok" };
      },
    });

    expect(calls).toEqual(["fallback-a", "fallback-b"]);
    expect(response).toEqual({ type: "success", result: "ok", model: "fallback-b" });
  });

  it("preserves overload half-retry accounting and delay", async () => {
    const sleep = vi.fn(async () => {});
    const executeAttempt = vi.fn(async () => ({
      type: "fail" as const,
      result: "busy",
      failByServerError: true,
    }));
    await executeChatRequestFallbacks({
      fallbackModels: [""],
      requestRetries: 2,
      antiServerOverloads: true,
      fallbackWhenBlankResponse: false,
    }, { executeAttempt, sleep });

    expect(executeAttempt).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("resets fallback state once while preserving retry-local mutations", async () => {
    const events: string[] = [];
    let attempts = 0;
    const response = await executeChatRequestFallbacks({
      fallbackModels: ["fallback-a", "fallback-b", ""],
      requestRetries: 1,
      antiServerOverloads: false,
      fallbackWhenBlankResponse: false,
    }, {
      beginFallback: ({ fallbackModel }) => { events.push(`begin:${fallbackModel}`); },
      executeAttempt: async ({ fallbackModel }) => {
        events.push(`attempt:${fallbackModel}`);
        attempts++;
        if (attempts < 2) return { type: "fail", result: "retry" };
        return { type: "success", result: "ok" };
      },
    });

    expect(events).toEqual(["begin:fallback-a", "attempt:fallback-a", "attempt:fallback-a"]);
    expect(response).toEqual({ type: "success", result: "ok", model: "fallback-a" });
  });

  it("returns an aborted response before executing another attempt", async () => {
    const executeAttempt = vi.fn();
    const response = await executeChatRequestFallbacks({
      fallbackModels: [""],
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackWhenBlankResponse: false,
    }, {
      isAborted: () => true,
      executeAttempt,
    });

    expect(executeAttempt).not.toHaveBeenCalled();
    expect(response).toEqual({ type: "fail", result: "Aborted" });
  });
});
