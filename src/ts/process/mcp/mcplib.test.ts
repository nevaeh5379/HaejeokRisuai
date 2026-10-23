import { expect, it, vi } from "vitest";

vi.mock("../../globalApi.svelte", () => ({
  fetchNative: vi.fn(),
  openURL: vi.fn(),
}));
vi.mock("../../alert", () => ({ alertInput: vi.fn() }));

import { MCPClient, type SseEventDetail } from "./mcplib";

it("keeps split UTF-8 characters isolated between concurrent SSE connections", async () => {
  const events: SseEventDetail[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent<SseEventDetail>).detail);
  };
  document.addEventListener("mcp-sse", listener);
  let a!: ReadableStreamDefaultController<Uint8Array>;
  let b!: ReadableStreamDefaultController<Uint8Array>;
  const client = new MCPClient("https://mcp.invalid");
  const first = client.connectSSE(
    new ReadableStream({ start: (controller) => (a = controller) }),
  );
  const second = client.connectSSE(
    new ReadableStream({ start: (controller) => (b = controller) }),
  );
  const encoder = new TextEncoder();
  const message = encoder.encode(
    'data: {"jsonrpc":"2.0","id":"a","result":"한글"}\n\n',
  );
  const split = message.indexOf(0xed) + 1;

  try {
    a.enqueue(message.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 0));
    b.enqueue(
      encoder.encode('data: {"jsonrpc":"2.0","id":"b","result":"ok"}\n\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    a.enqueue(message.subarray(split));
    a.close();
    b.close();
    await Promise.all([first, second]);

    expect(events.map((event) => event.data)).toEqual([
      { jsonrpc: "2.0", id: "b", result: "ok" },
      { jsonrpc: "2.0", id: "a", result: "한글" },
    ]);
  } finally {
    document.removeEventListener("mcp-sse", listener);
  }
});
