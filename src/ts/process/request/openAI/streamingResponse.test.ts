import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    jsonSchemaEnabled: false,
    simplifiedToolUse: false,
    requestRetrys: 1,
    deepseekThinkingType: "disabled",
  },
  alertError: vi.fn(),
  addFetchLog: vi.fn(),
  fetchNative: vi.fn(),
  callTool: vi.fn(),
  encodeToolCall: vi.fn(),
  extractJSON: vi.fn((value: unknown) => String(value)),
}));

vi.mock("src/ts/alert", () => ({ alertError: mocks.alertError }));
vi.mock("src/ts/globalApi.svelte", () => ({
  addFetchLog: mocks.addFetchLog,
  fetchNative: mocks.fetchNative,
}));
vi.mock("src/ts/model/modellist", () => ({
  LLMFlags: {
    deepSeekThinkingInput: 18,
    deepSeekThinkingOutput: 19,
    deepSeekThinkingToggle: 24,
  },
}));
vi.mock("src/ts/storage/database.svelte", () => ({
  getDatabase: () => mocks.db,
}));
vi.mock("../../mcp/mcp", () => ({
  callTool: mocks.callTool,
  encodeToolCall: mocks.encodeToolCall,
}));
vi.mock("../../templates/jsonSchema", () => ({
  extractJSON: mocks.extractJSON,
}));

import { getTranStream } from "./streamingResponse";

function makeArg(overrides: Record<string, unknown> = {}) {
  return {
    modelInfo: { flags: [] },
    extractJson: "",
    multiGen: false,
    ...overrides,
  } as any;
}

async function runChunks(chunks: string[], arg = makeArg()) {
  const stream = getTranStream(arg);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const outputs: Record<string, string>[] = [];
  const reading = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      outputs.push(value);
    }
  })();
  const encoder = new TextEncoder();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  await reading;
  return outputs;
}

describe("OpenAI streaming response parser", () => {
  it("accumulates incremental content without duplicating prior snapshots", async () => {
    const outputs = await runChunks([
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\ndata: [DONE]\n',
    ]);
    expect(outputs.at(-1)?.["0"]).toBe("Hello");
  });

  it("wraps structured streaming reasoning ahead of the final text", async () => {
    const outputs = await runChunks([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\ndata: [DONE]\n',
    ]);
    expect(outputs.at(-1)?.["0"]).toBe(
      "<Thoughts>\nthink\n</Thoughts>\nanswer",
    );
  });

  it("assembles incremental tool-call arguments across SSE chunks", async () => {
    const outputs = await runChunks([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"weather","arguments":"{\\\"ci"}}]}}]}\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\\":\\\"Seoul\\\"}"}}]}}]}\ndata: [DONE]\n',
    ]);
    const toolCalls = JSON.parse(outputs.at(-1)?.["__tool_calls"] ?? "{}");
    expect(toolCalls[0]).toEqual({
      id: "call-1",
      type: "function",
      function: {
        name: "weather",
        arguments: '{"city":"Seoul"}',
      },
    });
  });
});
