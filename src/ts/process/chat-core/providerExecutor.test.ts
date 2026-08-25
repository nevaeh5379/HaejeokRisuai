import { describe, expect, it, vi } from "vitest";
import { executeProviderRoute } from "@risuai/chat-core/providerExecutor.cjs";
import { LLM_FORMATS } from "../../../../packages/protocol/modelFormat.cjs";

describe("provider executor", () => {
  it("dispatches a format through its runtime-neutral provider route", async () => {
    const openai = vi.fn(async () => ({ type: "success" as const, result: "ok" }));
    const result = await executeProviderRoute(
      LLM_FORMATS.Mistral,
      { prompt: "hello" },
      { openai },
    );
    expect(result).toEqual({ type: "success", result: "ok" });
    expect(openai).toHaveBeenCalledWith({ prompt: "hello" });
  });

  it("fails without retrying when the format is unknown", async () => {
    const result = await executeProviderRoute(999, {}, {}, {
      unknownModelMessage: "unknown",
    });
    expect(result).toEqual({ type: "fail", result: "unknown", noRetry: true });
  });

  it("reports a runtime that does not implement a known route", async () => {
    const result = await executeProviderRoute(LLM_FORMATS.Anthropic, {}, {});
    expect(result.type).toBe("fail");
    expect(result).toMatchObject({ noRetry: true });
  });
});
