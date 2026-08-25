import { describe, expect, it } from "vitest";
import {
  applyOpenAIPostParameterBodyPolicies,
  applyOpenAIPreParameterBodyPolicies,
  appendOpenAIStreamingFragment,
  buildOpenAIRequestHeaders,
  collectOpenAIToolCalls,
  formatOpenAIReasoningText,
  mergeOpenAIStreamingToolCallDeltas,
  normalizeOpenAIProviderMessages,
  resolveOpenAIRequestEndpoint,
  resolveOpenAIRequestModel,
  shouldUseOpenAIFlexProcessing,
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

  it("normalizes transient OpenAI message fields and DeepSeek metadata", () => {
    const messages = [
      {
        role: "assistant",
        content: "answer",
        name: "temporary",
        memo: "memo",
        removable: true,
        attr: ["x"],
        multimodals: [{ type: "image", base64: "data" }],
        thoughts: ["reasoning", "detail"],
        cachePoint: true,
      },
    ];
    expect(normalizeOpenAIProviderMessages(messages, {
      deepSeekPrefix: true,
      deepSeekThinkingInput: true,
    })).toEqual([{
      role: "assistant",
      content: "answer",
      name: undefined,
      prefix: true,
      reasoning_content: "reasoning\ndetail",
    }]);
  });

  it("merges reverse-proxy system prompts and applies developer roles", () => {
    const messages = [
      { role: "system", content: "one" },
      { role: "user", content: "hello" },
      { role: "system", content: "two" },
    ];
    expect(normalizeOpenAIProviderMessages(messages, {
      reverseProxyOobaMode: true,
      developerRole: true,
      newOAIHandle: true,
    })).toEqual([
      { role: "user", content: "hello", name: undefined },
      { role: "developer", content: "one\ntwo" },
    ]);
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

  it("enables flex processing only for official OpenAI traffic", () => {
    expect(shouldUseOpenAIFlexProcessing({
      aiModel: "gpt4o",
      url: "https://example.invalid/v1/chat/completions",
      isOpenAIProvider: true,
    })).toBe(true);
    expect(shouldUseOpenAIFlexProcessing({
      aiModel: "reverse_proxy",
      url: "https://api.openai.com/v1/chat/completions",
    })).toBe(true);
    expect(shouldUseOpenAIFlexProcessing({
      aiModel: "reverse_proxy",
      url: "https://proxy.example/v1/chat/completions",
    })).toBe(false);
    expect(shouldUseOpenAIFlexProcessing({
      aiModel: "openrouter",
      url: "https://api.openai.com/v1/chat/completions",
    })).toBe(false);
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

  it("applies pre-parameter OpenAI body policies in one shared step", () => {
    const body = applyOpenAIPreParameterBodyPolicies({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 123,
      logit_bias: {},
    }, {
      useCompletionTokens: true,
      generationSeed: 42,
      responseJsonSchema: { name: "reply" },
      prediction: "expected",
      aiModel: "openrouter",
      openRouterFallback: true,
      openRouterMiddleOut: true,
      openRouterProvider: {
        order: ["a"],
        only: [],
        ignore: ["b"],
      },
      instructPrompt: "rendered prompt",
    });
    expect(body).toEqual({
      max_completion_tokens: 123,
      seed: 42,
      response_format: {
        type: "json_schema",
        json_schema: { name: "reply" },
      },
      prediction: { type: "content", content: "expected" },
      route: "fallback",
      transforms: ["middle-out"],
      provider: { order: ["a"], ignore: ["b"] },
      prompt: "rendered prompt",
    });
  });

  it("applies post-parameter thinking, tools, proxy args, inlay, and multigen policies", () => {
    const result = applyOpenAIPostParameterBodyPolicies({
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      logit_bias: { 1: 5 },
    }, {
      deepSeekThinkingToggle: true,
      deepSeekThinkingType: "enabled",
      deepSeekReasoningEffort: "medium",
      toolDefinitions: [{ type: "function", function: { name: "tool" } }],
      reverseProxyOobaMode: true,
      reverseProxyOobaArgs: { min_p: 0.05, ignored: null },
      removeLogitBiasForInlay: true,
      multiGen: true,
      hasTools: false,
      genTime: 3,
    });
    expect(result.error).toBeNull();
    expect(result.body).toEqual({
      thinking: { type: "enabled", reasoning_effort: "medium" },
      tools: [{ type: "function", function: { name: "tool" } }],
      min_p: 0.05,
      n: 3,
    });
  });

  it("rejects multi-generation with tools before additional request parameters", () => {
    const body = { model: "gpt-test" };
    const result = applyOpenAIPostParameterBodyPolicies(body, {
      multiGen: true,
      hasTools: true,
      genTime: 4,
    });
    expect(result.error).toBe(
      "MultiGen mode cannot be used with tool calls. Please disable one of them.",
    );
    expect(result.body).toEqual({ model: "gpt-test" });
  });
});
