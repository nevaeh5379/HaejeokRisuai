import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decodeToolCall: vi.fn(),
}));

vi.mock("../../mcp/mcp", () => ({
  decodeToolCall: mocks.decodeToolCall,
}));

import { prepareOpenAIProviderMessages } from "./messagePreparation";

describe("OpenAI browser message preparation", () => {
  beforeEach(() => {
    mocks.decodeToolCall.mockReset();
  });

  it("expands remembered tool calls into assistant and tool messages", async () => {
    mocks.decodeToolCall.mockResolvedValue({
      call: { id: "call-1", name: "weather", arg: '{"city":"Seoul"}' },
      response: [
        { type: "text", text: "sunny" },
        { type: "image", data: "ignored" },
      ],
    });
    const result = await prepareOpenAIProviderMessages([{
      role: "assistant",
      content: "before<tool_call>stored-id</tool_call>after",
    }], "auto");

    expect(mocks.decodeToolCall).toHaveBeenCalledWith("stored-id");    expect(result).toEqual([
      {
        role: "assistant",
        content: "before",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Seoul"}' },
        }],
      },
      {
        role: "tool",
        content: "sunny",
        tool_call_id: "call-1",
        cachePoint: true,
      },
      { role: "assistant", content: "after" },
    ]);
  });

  it("converts user multimodals without mutating the source message", async () => {
    const source = {
      role: "user" as const,
      content: "describe this",
      multimodals: [
        { type: "image" as const, base64: "data:image/png;base64,abc" },
      ],
    };
    const result = await prepareOpenAIProviderMessages([source], "high");

    expect(source.content).toBe("describe this");    expect(source.multimodals[0].base64).toBe("data:image/png;base64,abc");
    expect(result).toEqual([{
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,abc",
            detail: "high",
          },
        },
        { type: "text", text: "describe this" },
      ],
      multimodals: source.multimodals,
    }]);
    expect(result[0]).not.toBe(source);
  });
});
