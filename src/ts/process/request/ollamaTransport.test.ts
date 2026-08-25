import { describe, expect, it } from "vitest";
import { LLMFormat } from "../../model/modellist";
import { shouldUseNodeOllamaCloudTransport } from "./ollamaTransport";

describe("Ollama Cloud transport selection", () => {
  it("uses Node only for cloud native non-streaming requests", () => {
    expect(
      shouldUseNodeOllamaCloudTransport({
        isCloud: true,
        requestFormat: LLMFormat.Ollama,
        useStreaming: false,
      }),
    ).toBe(true);
  });

  it("keeps local, streaming, and compatibility formats on existing paths", () => {
    expect(
      shouldUseNodeOllamaCloudTransport({
        isCloud: false,
        requestFormat: LLMFormat.Ollama,
        useStreaming: false,
      }),
    ).toBe(false);
    expect(
      shouldUseNodeOllamaCloudTransport({
        isCloud: true,
        requestFormat: LLMFormat.Ollama,
        useStreaming: true,
      }),
    ).toBe(false);
    expect(
      shouldUseNodeOllamaCloudTransport({
        isCloud: true,
        requestFormat: LLMFormat.OpenAICompatible,
        useStreaming: false,
      }),
    ).toBe(false);
    expect(
      shouldUseNodeOllamaCloudTransport({
        isCloud: true,
        requestFormat: LLMFormat.Anthropic,
        useStreaming: false,
      }),
    ).toBe(false);
  });
});
