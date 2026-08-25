import { describe, expect, it } from "vitest";
import {
  decodeMistralResponse,
  formatMistralMessages,
} from "@risuai/chat-core/mistralProvider.cjs";

describe("Mistral provider core", () => {
  it("merges adjacent roles and folds later system messages", () => {
    expect(formatMistralMessages([
      { role: "assistant", content: "prefill" },
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
      { role: "user", content: "again" },
      { role: "function", content: "tool result" },
    ])).toEqual([
      { role: "system", content: "assistant:prefill\nrules" },
      { role: "user", content: "hello\nagain" },
      { role: "user", content: "tool result" },
    ]);
  });

  it("decodes successful chat completion payloads", () => {
    expect(decodeMistralResponse(true, {
      choices: [{ message: { content: "done" } }],
    }, "HTTP: ")).toEqual({ type: "success", result: "done" });
  });
  it("uses provider error messages when available", () => {
    expect(decodeMistralResponse(false, {
      error: { message: "bad request" },
    }, "HTTP: ")).toEqual({ type: "fail", result: "HTTP: bad request" });
  });

  it("falls back to serialized payloads for malformed responses", () => {
    expect(decodeMistralResponse(true, { unexpected: true }, "HTTP: ")).toEqual({
      type: "fail",
      result: 'HTTP: {"unexpected":true}',
    });
  });
});
