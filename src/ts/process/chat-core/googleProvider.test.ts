import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_GENERATION_PARAMETER_RENAMES,
  buildGoogleSafetySettings,
  collectGoogleFunctionCalls,
  finalizeGoogleGenerationConfig,
  formatGoogleTextResponse,
  mergeGoogleConsecutiveChats,
  prepareGoogleConversation,
  selectGoogleGenerationParameters,
  selectGoogleVertexRegion,
} from "@risuai/chat-core/googleProvider.cjs";

describe("Google provider core", () => {
  it("extracts one leading system prompt and maps normal chat roles", () => {
    expect(
      prepareGoogleConversation([
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toEqual({
      systemPrompt: "rules",
      consumedLeadingSystem: true,
      chats: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
      ],
    });
  });

  it("folds later system messages into a preceding user message", () => {
    expect(
      prepareGoogleConversation([
        { role: "user", content: "hello" },
        { role: "system", content: "late rule" },
        { role: "system", content: "another rule" },
      ]),
    ).toEqual({
      systemPrompt: "",
      consumedLeadingSystem: false,
      chats: [
        {
          role: "user",
          parts: [{ text: "hello\nsystem:late rule\nsystem:another rule" }],
        },
      ],
    });
  });

  it("converts supported multimodal data URLs and ignores unsupported media", () => {
    expect(
      prepareGoogleConversation(
        [
          {
            role: "user",
            content: "look",
            multimodals: [
              { type: "image", base64: "data:image/png;base64,AAA" },
              { type: "audio", base64: "data:audio/wav;base64,BBB" },
              { type: "video", base64: "data:video/mp4;base64,CCC" },
            ],
          },
        ],
        { hasImageInput: true, hasAudioInput: false, hasVideoInput: true },
      ).chats,
    ).toEqual([
      {
        role: "user",
        parts: [
          { text: "look" },
          { inlineData: { mimeType: "image/png", data: "AAA" } },
          { inlineData: { mimeType: "video/mp4", data: "CCC" } },
        ],
      },
    ]);
  });

  it("delegates signature restoration without coupling shared policy to storage", () => {
    const resolveSignature = vi.fn(() => ({
      thought: true,
      thoughtSignature: "sig",
    }));
    const result = prepareGoogleConversation(
      [
        {
          role: "assistant",
          content: "thought",
          multimodals: [{ type: "signature", base64: "opaque" }],
        },
      ],
      { resolveSignature },
    );

    expect(resolveSignature).toHaveBeenCalledOnce();
    expect(result.chats).toEqual([
      {
        role: "model",
        parts: [
          { text: "thought" },
          { thought: true, thoughtSignature: "sig" },
        ],
      },
    ]);
  });

  it("keeps function and other roles in the legacy user fallback", () => {
    expect(
      prepareGoogleConversation([{ role: "function", content: "tool output" }])
        .chats,
    ).toEqual([{ role: "user", parts: [{ text: "function:tool output" }] }]);
  });
  it("merges consecutive roles using Gemini part semantics", () => {
    const chats = [
      { role: "user" as const, parts: [{ text: "first" }] },
      {
        role: "user" as const,
        parts: [
          { text: "second" },
          { inlineData: { mimeType: "image/png", data: "A" } },
        ],
      },
      { role: "model" as const, parts: [{ text: "answer" }] },
      {
        role: "model" as const,
        parts: [{ functionCall: { name: "tool", args: {} } }],
      },
    ];

    expect(mergeGoogleConsecutiveChats(chats)).toEqual([
      {
        role: "user",
        parts: [
          { text: "first\n\nsecond" },
          { inlineData: { mimeType: "image/png", data: "A" } },
        ],
      },
      {
        role: "model",
        parts: [
          { text: "answer" },
          { functionCall: { name: "tool", args: {} } },
        ],
      },
    ]);
  });

  it("builds Gemini safety settings from runtime capabilities", () => {
    expect(buildGoogleSafetySettings()).toEqual([
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ]);

    expect(
      buildGoogleSafetySettings({
        includeCivicIntegrity: false,
        blockOff: true,
      }),
    ).toEqual([
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    ]);
  });

  it("selects supported Gemini generation parameters and provider field names", () => {
    expect(
      selectGoogleGenerationParameters(
        [
          "temperature",
          "top_p",
          "thinking_tokens",
          "reasoning_effort",
          "min_p",
        ],
        { thinking: true },
      ),
    ).toEqual(["temperature", "top_p", "thinking_tokens", "reasoning_effort"]);
    expect(
      selectGoogleGenerationParameters(
        ["temperature", "thinking_tokens", "reasoning_effort"],
        { thinking: false },
      ),
    ).toEqual(["temperature"]);
    expect(GOOGLE_GENERATION_PARAMETER_RENAMES).toEqual({
      top_p: "topP",
      top_k: "topK",
      presence_penalty: "presencePenalty",
      frequency_penalty: "frequencyPenalty",
      thinking_tokens: "thinkingBudget",
      reasoning_effort: "thinkingConfig.thinkingLevel",
    });
  });

  it("routes Vertex global-only Gemini models without coupling to auth", () => {
    expect(
      selectGoogleVertexRegion("gemini-3-pro-preview", "us-central1"),
    ).toBe("global");
    expect(
      selectGoogleVertexRegion("gemini-3.6-flash-preview", "us-west1"),
    ).toBe("global");
    expect(selectGoogleVertexRegion("gemini-2.5-pro", "us-central1")).toBe(
      "us-central1",
    );
    expect(selectGoogleVertexRegion("gemini-3.4-flash", "us-west1")).toBe(
      "us-west1",
    );
  });

  it("formats Gemini text and thoughts through an optional pure transform", () => {
    const transformText = vi.fn((text: string) => text.toUpperCase());
    expect(
      formatGoogleTextResponse(
        [
          { text: "reason one", thought: true },
          { text: "answer one" },
          { text: "reason two", thought: true },
          { text: "answer two", thought: false },
        ],
        { transformText },
      ),
    ).toBe(
      "<Thoughts>\n\nREASON ONE\n\nREASON TWO\n\n</Thoughts>\n\nANSWER ONE\n\nANSWER TWO",
    );
    expect(transformText).toHaveBeenCalledTimes(4);
    expect(formatGoogleTextResponse([{ text: "answer" }])).toBe("answer");
  });

  it("collects Gemini function calls in candidate part order", () => {
    const first = { name: "weather", args: { city: "Seoul" } };
    const second = { id: "call-2", name: "clock", args: {} };
    expect(
      collectGoogleFunctionCalls([
        { text: "before" },
        { functionCall: first },
        { thought: true, text: "reasoning" },
        { functionCall: second },
      ]),
    ).toEqual([first, second]);
  });

  it("normalizes Gemini thinking and output generation settings", () => {
    const flat = { thinkingBudget: 2048 };
    expect(
      finalizeGoogleGenerationConfig(flat, {
        thinking: true,
        useStreaming: true,
        hasAudioOutput: true,
        highMediaResolution: true,
      }),
    ).toEqual({
      generationConfig: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
        responseModalities: ["TEXT", "AUDIO"],
        mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
      },
      useStreaming: false,
    });

    const nested = { thinkingConfig: { thinkingLevel: "minimal" } };
    expect(
      finalizeGoogleGenerationConfig(nested, {
        thinking: true,
        thinkingNoMinimal: true,
        useStreaming: true,
        hasAudioOutput: true,
        hasImageOutput: true,
      }),
    ).toEqual({
      generationConfig: {
        thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
        responseModalities: ["TEXT", "IMAGE"],
      },
      useStreaming: false,
    });
  });

  it("leaves ordinary generation settings and streaming untouched", () => {
    const generationConfig = { maxOutputTokens: 512 };
    expect(
      finalizeGoogleGenerationConfig(generationConfig, { useStreaming: true }),
    ).toEqual({
      generationConfig: { maxOutputTokens: 512 },
      useStreaming: true,
    });
  });
});
