import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI_CHAT_COMPLETIONS_URL } from "@risuai/chat-core/openAIProvider.cjs";
import { resolveNanoGPTTransportUrl } from "@risuai/chat-core/nanoGPTProvider.cjs";
import { resolveOllamaCloudTransportUrl } from "@risuai/chat-core/ollamaProvider.cjs";
import { LLMFormat } from "src/ts/model/modellist";
import { shouldUseNodeOpenAINonStreamingTransport } from "./nonStreamingTransport";

describe("OpenAI non-streaming transport", () => {
  it("uses Node transport for the official OpenAI-compatible endpoint", () => {
    expect(shouldUseNodeOpenAINonStreamingTransport(
      DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
      LLMFormat.OpenAICompatible,
    )).toBe(true);
  });

  it("uses Node transport for both official NanoGPT chat endpoints", () => {
    for (const subscription of [false, true]) {
      expect(shouldUseNodeOpenAINonStreamingTransport(
        resolveNanoGPTTransportUrl("chat", subscription)!,
        LLMFormat.NanoGPT,
      )).toBe(true);
    }
  });

  it("uses Node transport for the official Ollama Cloud OpenAI endpoint", () => {
    expect(shouldUseNodeOpenAINonStreamingTransport(
      resolveOllamaCloudTransportUrl("openai-chat")!,
      LLMFormat.Ollama,
    )).toBe(true);
  });

  it("keeps custom URLs and other formats on their existing transport path", () => {
    expect(shouldUseNodeOpenAINonStreamingTransport(
      "https://proxy.example/v1/chat/completions",
      LLMFormat.OpenAICompatible,
    )).toBe(false);
    expect(shouldUseNodeOpenAINonStreamingTransport(
      DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
      LLMFormat.Mistral,
    )).toBe(false);
  });
});
