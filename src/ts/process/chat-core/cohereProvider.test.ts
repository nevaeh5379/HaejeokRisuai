import { describe, expect, it } from "vitest";
import {
  COHERE_USER_MESSAGE_ERROR,
  decodeCohereResponse,
  prepareCohereConversation,
} from "@risuai/chat-core/cohereProvider.cjs";

describe("Cohere provider core", () => {
  it("builds Cohere chat history and extracts the final user message", () => {
    expect(
      prepareCohereConversation(
        [
          { role: "system", content: "rules" },
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "final" },
        ],
        "command-r",
      ),
    ).toEqual({
      ok: true,
      body: {
        message: "final",
        chat_history: [
          { role: "USER", message: "first" },
          { role: "CHATBOT", message: "answer" },
        ],
        safety_mode: "NONE",
        preamble: "rules",
      },
    });
  });

  it("folds trailing non-user messages into the final prompt", () => {
    const result = prepareCohereConversation(
      [
        { role: "user", content: "question" },
        { role: "assistant", content: "prefill" },
      ],
      "cohere-command-r-03-2024",
    );
    expect(result).toEqual({
      ok: true,
      body: {
        message: "\nquestionassistant: \nprefill",
        chat_history: [],
      },
    });
  });

  it("preserves the legacy system-only preamble fallback", () => {
    const result = prepareCohereConversation(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ],
      "command-r",
    );
    expect(result).toEqual({
      ok: true,
      body: {
        message: "system: rules",
        chat_history: [],
        safety_mode: "NONE",
      },
    });
  });

  it("returns an explicit failure when no user message exists", () => {
    expect(
      prepareCohereConversation(
        [{ role: "assistant", content: "prefill" }],
        "command-r",
      ),
    ).toEqual({ ok: false, error: COHERE_USER_MESSAGE_ERROR });
  });

  it("decodes Cohere success and failure payloads", () => {
    expect(decodeCohereResponse(true, { text: "done" })).toEqual({
      type: "success",
      result: "done",
    });
    expect(decodeCohereResponse(false, { message: "bad" })).toEqual({
      type: "fail",
      result: '{"message":"bad"}',
    });
    expect(decodeCohereResponse(true, { unexpected: true })).toEqual({
      type: "fail",
      result: '{"unexpected":true}',
    });
  });
});
