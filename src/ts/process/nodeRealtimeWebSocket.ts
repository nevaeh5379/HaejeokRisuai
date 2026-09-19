import type { NodeApiClient } from "@risuai/storage-remote/nodeApiClient";

export type NodeRealtimeWebSocketFrame = {
  id?: number;
  event: string;
  data?: unknown;
};

/**
 * Narrows an untrusted WebSocket JSON message into a transport frame. The
 * payload stays `unknown` here: dispatchEvent narrows it again against the
 * shared realtime event map.
 * 신뢰할 수 없는 WebSocket JSON 메시지를 전송 프레임 형태로 좁힙니다.
 * 페이로드는 여기서 unknown으로 유지되며, dispatchEvent가 공유 실시간
 * 이벤트 맵으로 다시 좁힙니다.
 *
 * @param value - Parsed JSON message (unknown). 해석된 JSON 메시지(unknown)입니다.
 * @returns A typed frame, or null when the message is not an event. 형식화된 프레임 또는 null입니다.
 */
function parseWebSocketFrame(
  value: unknown,
): NodeRealtimeWebSocketFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (typeof record.event !== "string" || record.event.length === 0) {
    return null;
  }
  const id: number | undefined =
    typeof record.id === "number" &&
    Number.isSafeInteger(record.id) &&
    record.id >= 0
      ? record.id
      : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    event: record.event,
    data: record.data,
  };
}

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
          // Omit an absent cursor entirely. Older Node servers coerced null to
          // event id 0 and replayed their whole history on every fresh native
          // connection, including stale response-completion alarms.
          ...(options.lastEventId == null
            ? {}
            : { lastEventId: options.lastEventId }),
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      messageChain = messageChain
        .then(async () => {
          let parsedMessage: unknown;
          try {
            parsedMessage = JSON.parse(event.data);
          } catch {
            return;
          }
          const frame = parseWebSocketFrame(parsedMessage);
          if (frame === null) return;
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
