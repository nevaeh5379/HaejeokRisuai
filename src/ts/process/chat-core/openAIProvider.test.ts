import { describe, expect, it } from "vitest";
import {
  appendOpenAIStreamingFragment,
  buildOpenAIRequestHeaders,
  collectOpenAIToolCalls,
  formatOpenAIReasoningText,
  mergeOpenAIStreamingToolCallDeltas,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
} from "@risuai/chat-core/openAIProvider.cjs";

describe("OpenAI provider core", () => {
  it("collects tool calls from every response choice in order", () => {
    const first = { id: "one", function: { name: "a", arguments: "{}" } };
    const second = { id: "two", function: { name: "b", arguments: "{}" } };
    expect(collectOpenAIToolCalls({
      choices: [
        { message: { tool_calls: [first] } },
        { message: { tool_calls: [second] } },
      ],
    })).toEqual([first, second]);
  });

  it("wraps structured reasoning before assistant content", () => {
    expect(formatOpenAIReasoningText({
      choices: [{ message: { content: "answer", reasoning_content: "thought" } }],
    })).toBe("<Thoughts>\nthought\n</Thoughts>\nanswer");
  });

  it("extracts legacy DeepSeek think tags when the model flag requires it", () => {
    expect(formatOpenAIReasoningText({
      choices: [{ message: { content: "<think>hidden</think>visible" } }],
    }, { deepSeekThinkingOutput: true })).toBe(
      "<Thoughts>\nhidden\n</Thoughts>\nvisible",
    );
  });

  it("preserves existing Thoughts wrappers when structured reasoning is repeated", () => {
    expect(formatOpenAIReasoningText({
      choices: [{ message: {
        content: "<Thoughts>\nold\n</Thoughts>\nanswer",
        reasoning_content: "new",
      } }],
    })).toBe("<Thoughts>\nold\n</Thoughts>\nanswer");
  });

  it("prepends OpenRouter reasoning using the existing precedence", () => {
    expect(formatOpenAIReasoningText({
      choices: [{ message: {
        content: "answer",
        reasoning_content: "structured",
        reasoning: "openrouter",
      } }],
    })).toBe(
      "<Thoughts>\nopenrouter\n</Thoughts>\n<Thoughts>\nstructured\n</Thoughts>\nanswer",
    );
  });

  it("merges cumulative and incremental streaming fragments without duplication", () => {
    expect(appendOpenAIStreamingFragment("Hel", "Hello")).toBe("Hello");
    expect(appendOpenAIStreamingFragment("Hello", " world")).toBe("Hello world");
    expect(appendOpenAIStreamingFragment("Hello", "")).toBe("Hello");
  });

  it("merges fragmented streaming tool calls by index", () => {
    const merged = mergeOpenAIStreamingToolCallDeltas({}, [
      { index: 0, id: "call-1", function: { name: "weather", arguments: '{"city"' } },
    ]);
    expect(mergeOpenAIStreamingToolCallDeltas(merged, [
      { index: 0, function: { arguments: ':"Seoul"}' } },
    ])).toEqual({
      0: {
        id: "call-1",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Seoul"}' },
      },
    });
  });

  it("resolves legacy model aliases and provider-specific model overrides", () => {
    expect(resolveOpenAIRequestModel({ requestModel: "gpt4o1-mini" })).toBe("o1-mini");
    expect(resolveOpenAIRequestModel({
      aiModel: "openrouter",
      requestModel: "ignored",
      openRouterRequestModel: "anthropic/claude-test",
    })).toBe("anthropic/claude-test");
    expect(resolveOpenAIRequestModel({
      requestModel: "custom",
      internalID: "vendor/internal-model",
    })).toBe("vendor/internal-model");
  });

  it("normalizes provider endpoints without losing reverse-proxy markers", () => {
    expect(resolveOpenAIRequestEndpoint({ aiModel: "openrouter" })).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      risuIdentify: false,
    });
    expect(resolveOpenAIRequestEndpoint({
      aiModel: "reverse_proxy",
      customURL: "risu::https://proxy.example/v1/",
      autofillRequestUrl: true,
    })).toEqual({
      url: "https://proxy.example/v1/chat/completions",
      risuIdentify: true,
    });
  });

  it("builds provider headers with the existing API key precedence", () => {
    expect(buildOpenAIRequestHeaders({
      aiModel: "openrouter",
      key: "explicit",
      openRouterKey: "provider",
    })).toMatchObject({
      Authorization: "Bearer explicit",
      "Content-Type": "application/json",
      "X-Title": "RisuAI",
      "HTTP-Referer": "https://risuai.xyz",
    });
    expect(buildOpenAIRequestHeaders({
      aiModel: "nanogpt",
      key: "explicit",
      keyIdentifier: "saved",
      keyByIdentifier: { saved: "selected" },
      nanoGPTProvider: "provider-a",
      risuIdentify: true,
    })).toMatchObject({
      Authorization: "Bearer selected",
      "X-Provider": "provider-a",
      "X-Proxy-Risu": "RisuAI",
    });
  });
});
