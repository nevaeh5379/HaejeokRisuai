import { describe, expect, it, vi } from "vitest";
import {
  buildGoogleSafetySettings,
  finalizeGoogleGenerationConfig,
  mergeGoogleConsecutiveChats,
  prepareGoogleConversation,
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
    ).toEqual([
      { role: "user", parts: [{ text: "function:tool output" }] },
    ]);
  });
  it("merges consecutive roles using Gemini part semantics", () => {
    const chats = [
      { role: "user" as const, parts: [{ text: "first" }] },
      {
        role: "user" as const,
        parts: [{ text: "second" }, { inlineData: { mimeType: "image/png", data: "A" } }],
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
    ).toEqual({ generationConfig: { maxOutputTokens: 512 }, useStreaming: true });
  });

});
