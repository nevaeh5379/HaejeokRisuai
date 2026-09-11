import type { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";

export type NodeRealtimeWebSocketFrame = {
  id?: number;
  event?: string;
  data?: unknown;
};

export type NodeRealtimeWebSocketOptions = {
  apiClient: NodeApiClient;
  auth: string;
  clientId: string;
  lastEventId: number | null;
  signal: AbortSignal;
  onFrame: (frame: NodeRealtimeWebSocketFrame) => Promise<void>;
};

/**
 * Native HTTP transports may buffer an endless SSE response. WebSocket keeps
 * realtime delivery independent from fetch streaming while preserving the
 * same event envelope and replay cursor used by the SSE transport.
 */
export async function consumeNodeRealtimeWebSocket(
  options: NodeRealtimeWebSocketOptions,
): Promise<void> {
  const url = new URL(options.apiClient.resolve("/api/realtime/ws"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url.toString());
    let settled = false;
    let messageChain = Promise.resolve();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      try {
        socket.close();
      } finally {
        finish();
      }
    };

    options.signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "authenticate",
          auth: options.auth,
          clientId: options.clientId,
          lastEventId: options.lastEventId,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      messageChain = messageChain
        .then(async () => {
          const frame = JSON.parse(event.data) as NodeRealtimeWebSocketFrame;
          if (!frame.event) return;
          await options.onFrame(frame);
        })
        .catch((error) => {
          console.error("[NodeRealtimeSync] WebSocket event failed", error);
        });
    });
    socket.addEventListener(
      "close",
      () => {
        void messageChain.finally(() => finish());
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => finish(new Error("Realtime WebSocket connection failed")),
      { once: true },
    );
  });
}
