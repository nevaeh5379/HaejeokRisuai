import { describe, expect, it } from "vitest";
import { resolveProviderRoute } from "@risuai/chat-core/providerRouting.cjs";
import { LLM_FORMATS } from "../../../../packages/protocol/modelFormat.cjs";

describe("provider routing", () => {
  it("groups compatible formats behind stable runtime-neutral routes", () => {
    expect(resolveProviderRoute(LLM_FORMATS.OpenAICompatible)).toBe("openai");
    expect(resolveProviderRoute(LLM_FORMATS.Mistral)).toBe("openai");
    expect(resolveProviderRoute(LLM_FORMATS.NanoGPT)).toBe("openai");
    expect(resolveProviderRoute(LLM_FORMATS.Anthropic)).toBe("anthropic");
    expect(resolveProviderRoute(LLM_FORMATS.AWSBedrockClaude)).toBe(
      "anthropic",
    );
    expect(resolveProviderRoute(LLM_FORMATS.VertexAIGemini)).toBe("google");
  });

  it("covers every known format", () => {
    for (const format of Object.values(LLM_FORMATS)) {
      expect(resolveProviderRoute(format)).not.toBeNull();
    }
  });

  it("returns null for unknown formats", () => {
    expect(resolveProviderRoute(999)).toBeNull();
  });
});
