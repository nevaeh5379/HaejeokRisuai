import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      setItem: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      getItem: vi.fn(async (key: string) => {
        return store.get(key) ?? null;
      }),
    }),
  },
}));

vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { authRefreshes: [] } },
}));
vi.mock("src/ts/stores/domain/moduleStore.svelte", () => ({
  moduleStore: { installModule: vi.fn() },
}));
vi.mock("src/ts/alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
  fetchNative: vi.fn(),
  openURL: vi.fn(),
}));

import { decodeToolCall, encodeToolCall, type toolCallData } from "./mcp";

describe("encodeToolCall and decodeToolCall", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("encodes and decodes a tool call with wrapped XML tags", async () => {
    const data: toolCallData = {
      call: {
        id: "call-123",
        name: "test_tool",
        arg: { query: "hello" },
      },
      response: [{ type: "text", text: "world" }],
    };

    const encoded = await encodeToolCall(data);
    expect(encoded).toContain("<tool_call>call-123\uf100test_tool</tool_call>");

    const decoded = await decodeToolCall(encoded);
    expect(decoded).toEqual(data);
  });

  it("decodes tool call from inner payload without tags", async () => {
    const data: toolCallData = {
      call: {
        id: "call-456",
        name: "calc_tool",
        arg: { a: 1, b: 2 },
      },
      response: [{ type: "text", text: "3" }],
    };

    await encodeToolCall(data);
    const decoded = await decodeToolCall("call-456\uf100calc_tool");
    expect(decoded).toEqual(data);
  });

  it("returns undefined for invalid or unknown tool calls", async () => {
    expect(await decodeToolCall("")).toBeUndefined();
    expect(await decodeToolCall("<tool_call></tool_call>")).toBeUndefined();
    expect(await decodeToolCall("non-existent-id\uf100tool")).toBeUndefined();
  });
});
