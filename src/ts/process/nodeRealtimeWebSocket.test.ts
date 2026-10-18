import { afterEach, expect, test, vi } from "vitest";
import { consumeNodeRealtimeWebSocket } from "./nodeRealtimeWebSocket";

type Listener = (event: Event) => void;

class FakeWebSocket {
  static sentFrames: Array<Record<string, unknown>> = [];

  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(raw: string): void {
    FakeWebSocket.sentFrames.push(JSON.parse(raw));
    queueMicrotask(() => this.emit("close"));
  }

  close(): void {
    this.emit("close");
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.sentFrames = [];
});

async function connect(
  lastEventId: number | null,
): Promise<Record<string, unknown>> {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  await consumeNodeRealtimeWebSocket({
    apiClient: {
      resolve: (path: string) => `https://node.example${path}`,
    } as never,
    auth: "secret",
    clientId: "android-client",
    lastEventId,
    signal: new AbortController().signal,
    onFrame: async () => {},
  });
  return FakeWebSocket.sentFrames[0];
}

test("omits a missing replay cursor from fresh native connections", async () => {
  const frame = await connect(null);

  expect(frame).toMatchObject({
    type: "authenticate",
    auth: "secret",
    clientId: "android-client",
  });
  expect(frame).not.toHaveProperty("lastEventId");
});

test("preserves a real replay cursor on reconnect", async () => {
  const frame = await connect(0);

  expect(frame.lastEventId).toBe(0);
});
