import { describe, expect, it } from "vitest";
import { decodeDurableModelJob } from "./modelJobRecovery";

describe("decodeDurableModelJob", () => {
  it("reconstructs OpenAI chat-completions SSE including reasoning", () => {
    const raw = [
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
      "",
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(decodeDurableModelJob("openai", raw, true)).toBe(
      "<Thoughts>\nthink more\n</Thoughts>\n\nHello world",
    );
  });

  it("reconstructs Anthropic SSE", () => {
    const raw = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}',
      "",
    ].join("\n");
    expect(decodeDurableModelJob("anthropic", raw, true)).toBe(
      "<Thoughts>\nhmm\n</Thoughts>\n\nAnswer",
    );
  });

  it("reconstructs Gemini SSE thought and text parts", () => {
    const raw = [
      'data: {"candidates":[{"content":{"parts":[{"text":"reason","thought":true}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"reply"}]}}]}',
      "",
    ].join("\n");
    expect(decodeDurableModelJob("gemini", raw, true)).toBe(
      "<Thoughts>\nreason\n</Thoughts>\n\nreply",
    );
  });

  it("decodes non-streaming OpenAI responses", () => {
    expect(
      decodeDurableModelJob(
        "openai",
        JSON.stringify({ choices: [{ message: { content: "complete" } }] }),
        false,
      ),
    ).toBe("complete");
  });
});
