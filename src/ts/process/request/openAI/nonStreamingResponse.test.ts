import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mockDb: {
    jsonSchemaEnabled: false,
    simplifiedToolUse: false,
    requestRetrys: 1,
  },
  alertError: vi.fn(),
  callTool: vi.fn(),
  encodeToolCall: vi.fn(),
  extractJSON: vi.fn((value: unknown) => `extracted:${String(value)}`),
}));

vi.mock("src/lang", () => ({
  language: { errors: { httpError: "HTTP: " } },
}));
vi.mock("src/ts/alert", () => ({ alertError: mocks.alertError }));
vi.mock("src/ts/model/modellist", () => ({
  LLMFlags: { deepSeekThinkingOutput: 77 },
}));
vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: mocks.mockDb },
}));
vi.mock("../../mcp/mcp", () => ({
  callTool: mocks.callTool,
  encodeToolCall: mocks.encodeToolCall,
}));
vi.mock("../../templates/jsonSchema", () => ({
  extractJSON: mocks.extractJSON,
}));

import { interpretOpenAINonStreamingResponse } from "./nonStreamingResponse";

function makeArg(overrides: Record<string, unknown> = {}) {
  return {
    modelInfo: { flags: [] },
    tools: [],
    rememberToolUsage: false,
    multiGen: false,
    ...overrides,
  } as any;
}

describe("OpenAI non-streaming response interpreter", () => {
  beforeEach(() => {
    mocks.mockDb.jsonSchemaEnabled = false;
    mocks.mockDb.simplifiedToolUse = false;
    mocks.mockDb.requestRetrys = 1;
    mocks.alertError.mockReset();
    mocks.callTool.mockReset();
    mocks.encodeToolCall.mockReset();
    mocks.extractJSON.mockClear();
  });

  it("keeps reasoning interpretation in the browser response layer", async () => {
    const result = await interpretOpenAINonStreamingResponse({
      ok: true,
      data: {
        choices: [{ message: { content: "answer", reasoning_content: "thinking" } }],
      },
      body: { messages: [] },
      arg: makeArg(),
      retry: vi.fn(),
    });
    expect(result).toEqual({
      type: "success",
      result: "<Thoughts>\nthinking\n</Thoughts>\nanswer",
    });
  });

  it("preserves multi-generation response interpretation", async () => {
    const result = await interpretOpenAINonStreamingResponse({
      ok: true,
      data: {
        choices: [
          { message: { content: "first" } },
          { message: { content: "second" } },
        ],
      },
      body: { messages: [] },
      arg: makeArg({ multiGen: true }),
      retry: vi.fn(),
    });
    expect(result).toEqual({
      type: "multiline",
      result: [["char", "first"], ["char", "second"]],
    });
  });

  it("returns raw provider errors with the existing localized prefix", async () => {
    const result = await interpretOpenAINonStreamingResponse({
      ok: false,
      data: { error: { message: "rate limited" } },
      body: { messages: [] },
      arg: makeArg(),
      retry: vi.fn(),
    });
    expect(result).toEqual({ type: "fail", result: "HTTP: rate limited" });
  });

  it("executes tool effects locally and retries through the injected transport", async () => {
    const body = { messages: [{ role: "user", content: "weather?" }] };
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ type: "fail", result: "temporary" })
      .mockResolvedValueOnce({ type: "success", result: "final answer" });
    mocks.callTool.mockResolvedValue([{ type: "text", text: "sunny" }]);
    mocks.encodeToolCall.mockResolvedValue("<encoded-tool-call>");

    const result = await interpretOpenAINonStreamingResponse({
      ok: true,
      data: {
        choices: [{
          message: {
            role: "assistant",
            content: "checking",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Seoul"}' },
            }],
          },
        }],
      },
      body,
      arg: makeArg({
        rememberToolUsage: true,
        tools: [{ name: "weather", description: "", inputSchema: {} }],
      }),
      retry,
    });

    expect(mocks.callTool).toHaveBeenCalledWith(
      "weather",
      { city: "Seoul" },
      undefined,
      { currentChar: undefined, chatTarget: undefined },
    );
    expect(retry).toHaveBeenCalledTimes(2);
    expect(body.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "sunny",
      tool_call_id: "call-1",
    });
    expect(result).toEqual({
      type: "success",
      result: "checking\n\n<encoded-tool-call>\n\nfinal answer",
    });
  });
});
