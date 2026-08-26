import { describe, expect, it, vi } from "vitest";
import { prepareGoogleConversation } from "@risuai/chat-core/googleProvider.cjs";

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
});
