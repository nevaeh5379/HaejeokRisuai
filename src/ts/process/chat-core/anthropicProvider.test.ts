import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_NO_INPUT_ERROR,
  prepareAnthropicConversation,
} from "@risuai/chat-core/anthropicProvider.cjs";

describe("Anthropic provider core", () => {
  it("separates leading system prompts and converts later system messages", () => {
    expect(
      prepareAnthropicConversation([
        { role: "system", content: "rule one" },
        { role: "system", content: "rule two" },
        { role: "user", content: "hello" },
        { role: "system", content: "late rule" },
      ]),
    ).toEqual({
      ok: true,
      systemPrompt: "\n\nrule one\n\nrule two",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello\n\nSystem: late rule" }],
        },
      ],
    });
  });

  it("merges adjacent roles, converts images, and preserves cache semantics", () => {
    const result = prepareAnthropicConversation(
      [
        {
          role: "user",
          content: "first",
          multimodals: [{ type: "image", base64: "data:image/png;base64,AAA" }],
        },
        {
          role: "user",
          content: "second",
          cachePoint: true,
          multimodals: [
            { type: "image", base64: "data:image/jpeg;base64,BBB" },
          ],
        },
      ],
      { oneHourCaching: true },
    );

    expect(result).toEqual({
      ok: true,
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "BBB" },
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAA" },
            },
            {
              type: "text",
              text: "first\n\nsecond",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
    });
  });

  it("inserts a synthetic user message for assistant-first conversations", () => {
    expect(
      prepareAnthropicConversation([{ role: "assistant", content: "prefill" }]),
    ).toEqual({
      ok: true,
      systemPrompt: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "Start" }] },
        { role: "assistant", content: [{ type: "text", text: "prefill" }] },
      ],
    });
  });

  it("converts system-only input into the legacy Start message", () => {
    expect(
      prepareAnthropicConversation([{ role: "system", content: "rules" }]),
    ).toEqual({
      ok: true,
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "Start" }] }],
    });
  });

  it("returns an explicit no-input failure", () => {
    expect(prepareAnthropicConversation([])).toEqual({
      ok: false,
      error: ANTHROPIC_NO_INPUT_ERROR,
    });
  });
});
