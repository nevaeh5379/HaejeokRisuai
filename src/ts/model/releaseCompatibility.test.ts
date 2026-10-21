import { describe, expect, it } from "vitest";
import { AnthropicModels } from "./providers/anthropic";
import { GoogleModels } from "./providers/google";
import { LLMFlags, resolveClaudeThinkingType } from "./types";

describe("v2026.10.210 models", () => {
  it("uses adaptive thinking for Opus 5 budget presets while preserving explicit off", () => {
    const opus = AnthropicModels.find((model) => model.id === "claude-opus-5")!;
    expect(opus.flags).toContain(LLMFlags.claudeThinkingOnByDefault);
    expect(resolveClaudeThinkingType(opus.flags, "budget")).toBe("adaptive");
    expect(resolveClaudeThinkingType(opus.flags, "off")).toBe("off");
    expect(
      resolveClaudeThinkingType(
        [LLMFlags.claudeThinking, LLMFlags.claudeAdaptiveThinking],
        "budget",
      ),
    ).toBe("budget");
  });
  it("registers each new Gemini model once", () => {
    const ids = GoogleModels.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ])
      expect(ids).toContain(id);
  });
});
