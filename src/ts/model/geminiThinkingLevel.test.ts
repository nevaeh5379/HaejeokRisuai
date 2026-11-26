import { describe, expect, it } from "vitest";
import {
  applyGeminiThinkingLevel,
  LLMFlags,
  LLMFormat,
  LLMProvider,
  LLMTokenizer,
  type LLMModel,
} from "./types";

const gemini = (
  flags: LLMModel["flags"],
  format: LLMFormat = LLMFormat.GoogleCloud,
): LLMModel => ({
  id: "xcustom:::gemini",
  name: "Gemini",
  provider: LLMProvider.AsIs,
  format,
  flags,
  parameters: ["temperature", "thinking_tokens"],
  tokenizer: LLMTokenizer.GoogleCloud,
});

describe("applyGeminiThinkingLevel", () => {
  it("keeps the thinking token budget without the flag", () => {
    const model = gemini([LLMFlags.geminiThinking]);
    expect(applyGeminiThinkingLevel(model).parameters).toEqual([
      "temperature",
      "thinking_tokens",
    ]);
  });

  it("replaces the token budget with a thinking level up to xhigh", () => {
    for (const format of [LLMFormat.GoogleCloud, LLMFormat.VertexAIGemini]) {
      const model = gemini([LLMFlags.geminiThinkingLevel], format);
      expect(applyGeminiThinkingLevel(model).parameters).toEqual([
        "temperature",
        "reasoning_effort",
        "reasoning_effort_xhigh",
      ]);
      expect(model.parameters).toContain("thinking_tokens");
    }
  });

  it("ignores the flag outside Gemini formats", () => {
    const model = gemini(
      [LLMFlags.geminiThinkingLevel],
      LLMFormat.OpenAICompatible,
    );
    expect(applyGeminiThinkingLevel(model)).toBe(model);
  });
});
