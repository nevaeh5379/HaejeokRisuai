import { describe, expect, it } from "vitest";
import { resolveOllamaCloudTransportUrl } from "@risuai/chat-core/ollamaProvider.cjs";
import { LLMFormat } from "../../model/modellist";
import {
  matchesNodeOllamaCloudEndpoint,
  shouldUseNodeOllamaCloudTransport,
} from "./ollamaTransport";

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

  it("matches only pinned Ollama Cloud compatibility endpoints", () => {
    for (const api of ["openai-chat", "responses", "anthropic"] as const) {
      expect(
        matchesNodeOllamaCloudEndpoint({
          requestURL: resolveOllamaCloudTransportUrl(api)!,
          format: LLMFormat.Ollama,
          api,
        }),
      ).toBe(true);
    }
    expect(
      matchesNodeOllamaCloudEndpoint({
        requestURL: "https://proxy.example/v1/messages",
        format: LLMFormat.Ollama,
        api: "anthropic",
      }),
    ).toBe(false);
    expect(
      matchesNodeOllamaCloudEndpoint({
        requestURL: resolveOllamaCloudTransportUrl("responses")!,
        format: LLMFormat.OpenAIResponseAPI,
        api: "responses",
      }),
    ).toBe(false);
  });
});
