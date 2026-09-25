/**
 * A lifecycle state accepted by realtime generation synchronization.
 * 실시간 생성 동기화에서 허용하는 생명주기 상태입니다.
 */
export type { GenerationLifecycleState } from "../../../packages/protocol/realtimeEvents.cjs";

import type {
  GenerationLifecycleState,
  RealtimeBroadcastEventName,
  RealtimeEventEnvelope,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeEventPayload,
  RealtimeGenerationState,
  RealtimeTransientEventName,
} from "../../../packages/protocol/realtimeEvents.cjs";

/**
 * A validated generation state retained and broadcast by the hub.
 * 허브가 보관하고 전파하는 검증된 생성 상태입니다.
 */
export interface GenerationStateRecord extends RealtimeGenerationState {
  readonly updatedAt: number;
}

/**
 * The minimal request contract needed to establish an SSE connection.
 * SSE 연결을 맺는 데 필요한 최소 요청 계약입니다.
 */
export interface RealtimeSseRequest {
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  once(event: "close", listener: () => void): unknown;
}

/**
 * The minimal response contract needed to stream SSE records.
 * SSE 레코드를 스트리밍하는 데 필요한 최소 응답 계약입니다.
 */
export interface RealtimeSseResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  status(statusCode: number): RealtimeSseResponse;
  set(field: string, value: string): RealtimeSseResponse;
  flushHeaders(): void;
  write(chunk: string): boolean;
  once(event: "close", listener: () => void): unknown;
}

/**
 * The minimal WebSocket contract used by the realtime event hub.
 * 실시간 이벤트 허브가 사용하는 최소 WebSocket 계약입니다.
 */
export interface RealtimeWebSocket {
  readonly readyState: number;
  send(frame: string): void;
  ping?(): void;
  once(event: "close" | "error", listener: () => void): unknown;
}

/**
 * Optional settings that bound heartbeat, replay history, and generation age.
 * 하트비트, 재생 기록, 생성 상태 보존 시간을 제한하는 선택 설정입니다.
 */
export interface RealtimeEventHubOptions {
  readonly heartbeatMs?: number;
  readonly historyLimit?: number;
  readonly generationMaxAgeMs?: number;
}

/**
 * Connection metadata supplied after a WebSocket has been authenticated.
 * WebSocket 인증이 끝난 뒤 전달되는 연결 메타데이터입니다.
 */
export interface RealtimeWebSocketOptions {
  readonly clientId?: unknown;
  readonly lastEventId?: unknown;
}

/**
 * A raw generation-state update received at the HTTP boundary.
 * HTTP 경계에서 받은 원시 생성 상태 갱신값입니다.
 */
export interface GenerationStateInput {
  readonly chatId?: unknown;
  readonly lifecycleId?: unknown;
  readonly state?: unknown;
  readonly error?: unknown;
}

/**
 * The public operations exposed by a realtime event hub. Broadcasting is
 * typed by the canonical realtime event map, so each event name accepts
 * exactly its mapped payload.
 * 실시간 이벤트 허브가 외부에 제공하는 작업 모음입니다. 전파는 표준 실시간
 * 이벤트 맵으로 형식화되어, 이벤트 이름별로 대응하는 페이로드만 허용합니다.
 */
export interface RealtimeEventHub {
  connect(req: RealtimeSseRequest, res: RealtimeSseResponse): void;
  connectWebSocket(
    ws: RealtimeWebSocket,
    options?: RealtimeWebSocketOptions,
  ): void;
  broadcast<K extends RealtimeBroadcastEventName>(
    event: K,
    data: RealtimeEventMap[K],
  ): void;
  broadcastTransient<K extends RealtimeTransientEventName>(
    event: K,
    data: RealtimeEventMap[K],
  ): void;
  updateGenerationState(
    input: GenerationStateInput | null | undefined,
    sourceClientId: unknown,
  ): GenerationStateRecord | null;
  cancelGeneration(
    chatId: string,
    sourceClientId: unknown,
  ): GenerationStateRecord | null;
  listActiveGenerations(): GenerationStateRecord[];
  clientCount(): number;
  latestEventId(): number;
}

interface RealtimeEventRecord {
  readonly id?: number;
  readonly event: RealtimeEventName;
  readonly data: RealtimeEventPayload;
}

interface BroadcastEventRecord extends RealtimeEventRecord {
  readonly id: number;
  readonly data: RealtimeEventEnvelope;
}

interface SseClient {
  readonly transport: "sse";
  readonly res: RealtimeSseResponse;
  readonly clientId: string | null;
}

interface WebSocketClient {
  readonly transport: "websocket";
  readonly ws: RealtimeWebSocket;
  readonly clientId: string | null;
}

type RealtimeClient = SseClient | WebSocketClient;

/**
 * Checks whether a raw value is an accepted generation lifecycle state.
 * 원시 값이 허용된 생성 생명주기 상태인지 확인합니다.
 *
 * @param value - Value to inspect. 검사할 값입니다.
 * @returns Whether the value is a lifecycle state. 생명주기 상태인지 여부입니다.
 */
function isGenerationLifecycleState(
  value: unknown,
): value is GenerationLifecycleState {
  return (
    value === "started" ||
    value === "finished" ||
    value === "failed" ||
    value === "aborted"
  );
}

/**
 * Normalizes a client identifier for use in realtime records.
 * 실시간 레코드에 사용할 클라이언트 식별자를 정규화합니다.
 *
 * @param value - Raw client identifier. 원시 클라이언트 식별자입니다.
 * @returns A trimmed identifier of at most 128 characters, or null. 최대 128자인 정리된 식별자 또는 null입니다.
 */
export function normalizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

/**
 * Creates an in-memory hub that broadcasts realtime events over SSE and WebSocket.
 * SSE와 WebSocket으로 실시간 이벤트를 전파하는 메모리 내 허브를 만듭니다.
 *
 * @param options - Heartbeat and retention limits. 하트비트 및 보존 제한 설정입니다.
 * @returns The configured realtime event hub. 설정된 실시간 이벤트 허브입니다.
 */
export function createRealtimeEventHub(
  options: RealtimeEventHubOptions = {},
): RealtimeEventHub {
  const heartbeatMs: number = options.heartbeatMs ?? 15_000;
  const historyLimit: number = options.historyLimit ?? 512;
  const generationMaxAgeMs: number =
    options.generationMaxAgeMs ?? 60 * 60 * 1000;
  const clients: Set<RealtimeClient> = new Set<RealtimeClient>();
  const history: BroadcastEventRecord[] = [];
  const activeGenerations: Map<string, GenerationStateRecord> = new Map<
    string,
    GenerationStateRecord
  >();
  let sequence: number = 0;

  /** Writes one event using the SSE wire format. / 이벤트 하나를 SSE 형식으로 기록합니다. */
  function writeEvent(
    res: RealtimeSseResponse,
    record: RealtimeEventRecord,
  ): void {
    if (record.id !== undefined) res.write(`id: ${record.id}\n`);
    res.write(`event: ${record.event}\n`);
    res.write(`data: ${JSON.stringify(record.data)}\n\n`);
  }

  /** Allocates the next shared event ID. / 다음 공용 이벤트 ID를 할당합니다. */
  function makeBroadcastEvent<K extends RealtimeBroadcastEventName>(
    event: K,
    data: RealtimeEventMap[K],
  ): BroadcastEventRecord {
    const id: number = ++sequence;
    const envelope: RealtimeEventEnvelope<K> = { ...data, eventId: id };
    return { id, event, data: envelope };
  }

  /** Sends a record through the client's selected transport. / 선택된 전송 방식으로 레코드를 보냅니다. */
  function sendToClient(
    client: RealtimeClient,
    record: RealtimeEventRecord,
  ): boolean {
    if (client.transport === "websocket") {
      if (client.ws.readyState !== 1) return false;
      client.ws.send(JSON.stringify(record));
      return true;
    }
    if (client.res.destroyed || client.res.writableEnded) return false;
    writeEvent(client.res, record);
    return true;
  }

  /** Broadcasts and retains one replayable event. / 재생 가능한 이벤트 하나를 보관하고 전파합니다. */
  function broadcast<K extends RealtimeBroadcastEventName>(
    event: K,
    data: RealtimeEventMap[K],
  ): void {
    const record: BroadcastEventRecord = makeBroadcastEvent(event, data);
    history.push(record);
    if (history.length > historyLimit) {
      history.splice(0, history.length - historyLimit);
    }
    for (const client of [...clients]) {
      try {
        if (!sendToClient(client, record)) clients.delete(client);
      } catch {
        clients.delete(client);
      }
    }
  }

  /** Sends an ephemeral event without consuming replay history. */
  function broadcastTransient<K extends RealtimeTransientEventName>(
    event: K,
    data: RealtimeEventMap[K],
  ): void {
    const record: RealtimeEventRecord = { event, data };
    for (const client of [...clients]) {
      try {
        if (!sendToClient(client, record)) clients.delete(client);
      } catch {
        clients.delete(client);
      }
    }
  }

  /** Removes generation states older than the retention window. / 보존 시간을 넘긴 생성 상태를 제거합니다. */
  function pruneGenerationStates(): void {
    const cutoff: number = Date.now() - generationMaxAgeMs;
    for (const [chatId, state] of activeGenerations) {
      if (state.updatedAt < cutoff) activeGenerations.delete(chatId);
    }
  }

  /** Validates, stores, and broadcasts a generation-state update. / 생성 상태 갱신을 검증하고 보관한 뒤 전파합니다. */
  function updateGenerationState(
    input: GenerationStateInput | null | undefined,
    sourceClientId: unknown,
  ): GenerationStateRecord | null {
    const chatId: string =
      typeof input?.chatId === "string" ? input.chatId.trim() : "";
    const lifecycleId: string =
      typeof input?.lifecycleId === "string" ? input.lifecycleId.trim() : "";
    const state: unknown = input?.state;
    if (
      chatId.length === 0 ||
      chatId.length > 256 ||
      lifecycleId.length === 0 ||
      lifecycleId.length > 128 ||
      !isGenerationLifecycleState(state)
    ) {
      return null;
    }
    pruneGenerationStates();
    const record: GenerationStateRecord = {
      chatId,
      lifecycleId,
      state,
      sourceClientId: normalizeClientId(sourceClientId),
      error:
        state === "failed" && typeof input?.error === "string"
          ? input.error.slice(0, 8000)
          : undefined,
      updatedAt: Date.now(),
    };
    if (state === "started") {
      activeGenerations.set(chatId, record);
    } else if (activeGenerations.get(chatId)?.lifecycleId === lifecycleId) {
      activeGenerations.delete(chatId);
    }
    broadcast("generation-state", record);
    return record;
  }

  function cancelGeneration(
    chatId: string,
    sourceClientId: unknown,
  ): GenerationStateRecord | null {
    pruneGenerationStates();
    const active = activeGenerations.get(chatId);
    if (!active) return null;
    return updateGenerationState(
      { chatId, lifecycleId: active.lifecycleId, state: "aborted" },
      sourceClientId,
    );
  }

  /** Returns the current non-expired generation states. / 만료되지 않은 현재 생성 상태를 반환합니다. */
  function listActiveGenerations(): GenerationStateRecord[] {
    pruneGenerationStates();
    return [...activeGenerations.values()];
  }

  /** Replays missed events or requests a full resynchronization. / 누락 이벤트를 재생하거나 전체 재동기화를 요청합니다. */
  function replayClient(client: RealtimeClient, rawLastEventId: unknown): void {
    const hasCursorValue: boolean =
      (typeof rawLastEventId === "number" && Number.isFinite(rawLastEventId)) ||
      (typeof rawLastEventId === "string" && rawLastEventId.trim().length > 0);
    const lastEventId: number = Number(rawLastEventId);
    const hasLastEventId: boolean =
      hasCursorValue && Number.isSafeInteger(lastEventId) && lastEventId >= 0;
    const oldestRetainedId: number = history[0]?.id ?? sequence + 1;
    const replayGap: boolean =
      hasLastEventId &&
      (lastEventId > sequence ||
        (lastEventId < sequence && lastEventId < oldestRetainedId - 1));

    if (replayGap) {
      sendToClient(client, {
        event: "resync-required",
        data: { latestEventId: sequence, oldestRetainedId },
      });
    } else if (hasLastEventId) {
      for (const record of history) {
        if (record.id > lastEventId) sendToClient(client, record);
      }
    }
  }

  /** Registers a client and sends its ready snapshot. / 클라이언트를 등록하고 준비 스냅샷을 보냅니다. */
  function readyClient(client: RealtimeClient): void {
    clients.add(client);
    sendToClient(client, {
      event: "ready",
      data: {
        clientId: client.clientId,
        connectedAt: Date.now(),
        latestEventId: sequence,
        activeGenerations: listActiveGenerations(),
      },
    });
  }

  /** Establishes an SSE client and starts its heartbeat. / SSE 클라이언트를 연결하고 하트비트를 시작합니다. */
  function connect(req: RealtimeSseRequest, res: RealtimeSseResponse): void {
    res.status(200);
    res.set("content-type", "text/event-stream; charset=utf-8");
    res.set("cache-control", "no-cache, no-transform");
    res.set("connection", "keep-alive");
    res.set("x-accel-buffering", "no");
    res.flushHeaders();
    const rawClientId: string | readonly string[] | undefined =
      req.headers["x-risu-client-id"];
    const client: SseClient = {
      transport: "sse",
      res,
      clientId: normalizeClientId(rawClientId),
    };
    const rawLastEventId: string | readonly string[] | undefined =
      req.headers["last-event-id"];
    replayClient(
      client,
      Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId,
    );
    readyClient(client);

    const heartbeat: NodeJS.Timeout = setInterval((): void => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, heartbeatMs);
    heartbeat.unref();

    const close: () => void = (): void => {
      clearInterval(heartbeat);
      clients.delete(client);
    };
    req.once("close", close);
    res.once("close", close);
  }

  /** Establishes a WebSocket client and starts its heartbeat. / WebSocket 클라이언트를 연결하고 하트비트를 시작합니다. */
  function connectWebSocket(
    ws: RealtimeWebSocket,
    connectionOptions: RealtimeWebSocketOptions = {},
  ): void {
    const client: WebSocketClient = {
      transport: "websocket",
      ws,
      clientId: normalizeClientId(connectionOptions.clientId),
    };
    replayClient(client, connectionOptions.lastEventId);
    readyClient(client);

    const heartbeat: NodeJS.Timeout = setInterval((): void => {
      if (ws.readyState !== 1) return;
      try {
        ws.ping?.();
      } catch {
        // Transport failures are handled by the registered close callback.
        // 전송 실패 정리는 등록된 종료 콜백이 맡습니다.
      }
    }, heartbeatMs);
    heartbeat.unref();

    const close: () => void = (): void => {
      clearInterval(heartbeat);
      clients.delete(client);
    };
    ws.once("close", close);
    ws.once("error", close);
  }

  return {
    connect,
    connectWebSocket,
    broadcast,
    broadcastTransient,
    updateGenerationState,
    cancelGeneration,
    listActiveGenerations,
    clientCount: (): number => clients.size,
    latestEventId: (): number => sequence,
  };
}
