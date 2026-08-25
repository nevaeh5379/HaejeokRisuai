import { describe, expect, it } from "vitest";
import {
  collectOpenAIToolCalls,
  formatOpenAIReasoningText,
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
});
