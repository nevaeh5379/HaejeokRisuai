/**
 * A lifecycle state accepted by realtime generation synchronization.
 * 실시간 생성 동기화에서 허용하는 생명주기 상태입니다.
 */
export type GenerationLifecycleState =
  "started" | "finished" | "failed" | "aborted";

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
 * A validated generation state retained and broadcast by the hub.
 * 허브가 보관하고 전파하는 검증된 생성 상태입니다.
 */
export interface GenerationStateRecord {
  readonly chatId: string;
  readonly lifecycleId: string;
  readonly state: GenerationLifecycleState;
  readonly sourceClientId: string | null;
  readonly error?: string;
  readonly updatedAt: number;
}

/**
 * The subset of an SQL commit used to describe affected realtime domains.
 * 실시간 변경 영역을 설명하는 데 쓰이는 SQL 커밋의 부분 구조입니다.
 */
export interface SqlCommitChangePayload {
  readonly replaceAll?: boolean;
  readonly root?: {
    readonly upserts?: readonly { readonly key?: unknown }[];
    readonly deletes?: readonly unknown[];
  };
  readonly pluginStorage?: {
    readonly upserts?: readonly { readonly key?: unknown }[];
    readonly deletes?: readonly unknown[];
    readonly clear?: boolean;
  };
  readonly presets?: {
    readonly upserts?: readonly unknown[];
    readonly deletes?: readonly unknown[];
    readonly order?: readonly unknown[];
    readonly activeId?: unknown;
  };
  readonly modules?: {
    readonly upserts?: readonly unknown[];
    readonly deletes?: readonly unknown[];
    readonly order?: readonly unknown[];
  };
  readonly characters?: readonly { readonly id?: unknown }[];
  readonly characterIds?: readonly unknown[];
  readonly characterDeletes?: readonly unknown[];
  readonly chats?: readonly {
    readonly id?: unknown;
    readonly characterId?: unknown;
  }[];
  readonly chatManifests?: readonly {
    readonly characterId?: unknown;
  }[];
  readonly chatDeletes?: readonly unknown[];
  readonly messages?: readonly { readonly chatId?: unknown }[];
  readonly messageManifests?: readonly { readonly chatId?: unknown }[];
  readonly messageDeletes?: readonly { readonly chatId?: unknown }[];
}

/**
 * A compact description of domains and entity IDs affected by an SQL commit.
 * SQL 커밋이 건드린 영역과 엔터티 ID를 압축해 나타낸 설명입니다.
 */
export interface SqlCommitChange {
  readonly replaceAll: boolean;
  readonly chatIds: string[];
  readonly characterIds: string[];
  readonly charactersChanged: boolean;
  readonly rootUpsertKeys: string[];
  readonly rootDeleteKeys: string[];
  readonly rootChanged: boolean;
  readonly pluginStorageUpsertKeys: string[];
  readonly pluginStorageDeleteKeys: string[];
  readonly pluginStorageCleared: boolean;
  readonly presetsChanged: boolean;
  readonly modulesChanged: boolean;
}

/**
 * The public operations exposed by a realtime event hub.
 * 실시간 이벤트 허브가 외부에 제공하는 작업 모음입니다.
 */
export interface RealtimeEventHub {
  connect(req: RealtimeSseRequest, res: RealtimeSseResponse): void;
  connectWebSocket(
    ws: RealtimeWebSocket,
    options?: RealtimeWebSocketOptions,
  ): void;
  broadcast(event: string, data: object): void;
  updateGenerationState(
    input: GenerationStateInput | null | undefined,
    sourceClientId: unknown,
  ): GenerationStateRecord | null;
  listActiveGenerations(): GenerationStateRecord[];
  clientCount(): number;
  latestEventId(): number;
}

interface RealtimeEventRecord {
  readonly id?: number;
  readonly event: string;
  readonly data: object;
}

interface BroadcastEventRecord extends RealtimeEventRecord {
  readonly id: number;
  readonly data: object & { readonly eventId: number };
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
 * Returns a non-empty string unchanged and rejects every other value.
 * 비어 있지 않은 문자열만 그대로 반환하고 나머지는 버립니다.
 *
 * @param value - Candidate string. 문자열 후보입니다.
 * @returns The valid string or null. 유효한 문자열 또는 null입니다.
 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Collects non-empty strings while preserving their original order.
 * 원래 순서를 유지하며 비어 있지 않은 문자열만 모읍니다.
 *
 * @param values - Candidate values. 값 후보 목록입니다.
 * @returns Valid non-empty strings. 유효한 비어 있지 않은 문자열 목록입니다.
 */
function collectNonEmptyStrings(values: readonly unknown[]): string[] {
  return values.flatMap((value: unknown): string[] => {
    const normalized: string | null = readNonEmptyString(value);
    return normalized === null ? [] : [normalized];
  });
}

/**
 * Collects a string property from a list of lightweight commit rows.
 * 간소화된 커밋 행 목록에서 문자열 속성을 모읍니다.
 *
 * @param rows - Rows to inspect. 검사할 행 목록입니다.
 * @param property - Property to read. 읽을 속성입니다.
 * @returns Valid property values. 유효한 속성값 목록입니다.
 */
function collectRowStrings<
  TProperty extends "id" | "key" | "chatId" | "characterId",
>(
  rows: readonly Partial<Record<TProperty, unknown>>[],
  property: TProperty,
): string[] {
  return rows.flatMap((row: Partial<Record<TProperty, unknown>>): string[] => {
    const normalized: string | null = readNonEmptyString(row[property]);
    return normalized === null ? [] : [normalized];
  });
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
 * Describes which realtime domains and entity IDs an SQL commit changed.
 * SQL 커밋이 변경한 실시간 영역과 엔터티 ID를 설명합니다.
 *
 * @param payload - Commit sections relevant to realtime invalidation. 실시간 무효화에 관련된 커밋 구역입니다.
 * @returns A deduplicated change description. 중복을 제거한 변경 설명입니다.
 */
export function describeSqlCommitChange(
  payload: SqlCommitChangePayload = {},
): SqlCommitChange {
  const chatIds: Set<string> = new Set<string>();
  const characterIds: Set<string> = new Set<string>();
  const addChat: (id: unknown) => void = (id: unknown): void => {
    const normalized: string | null = readNonEmptyString(id);
    if (normalized !== null) chatIds.add(normalized);
  };
  const addCharacter: (id: unknown) => void = (id: unknown): void => {
    const normalized: string | null = readNonEmptyString(id);
    if (normalized !== null) characterIds.add(normalized);
  };

  for (const id of collectRowStrings(payload.messages ?? [], "chatId")) {
    addChat(id);
  }
  for (const id of collectRowStrings(
    payload.messageManifests ?? [],
    "chatId",
  )) {
    addChat(id);
  }
  for (const id of collectRowStrings(payload.messageDeletes ?? [], "chatId")) {
    addChat(id);
  }
  for (const row of payload.chats ?? []) {
    addChat(row.id);
    addCharacter(row.characterId);
  }
  for (const id of payload.chatDeletes ?? []) addChat(id);
  for (const id of collectRowStrings(payload.characters ?? [], "id")) {
    addCharacter(id);
  }
  for (const id of payload.characterDeletes ?? []) addCharacter(id);
  for (const id of collectRowStrings(
    payload.chatManifests ?? [],
    "characterId",
  )) {
    addCharacter(id);
  }

  const rootUpsertKeys: string[] = collectRowStrings(
    payload.root?.upserts ?? [],
    "key",
  );
  const rootDeleteKeys: string[] = collectNonEmptyStrings(
    payload.root?.deletes ?? [],
  );
  const pluginStorageUpsertKeys: string[] = collectRowStrings(
    payload.pluginStorage?.upserts ?? [],
    "key",
  );
  const pluginStorageDeleteKeys: string[] = collectNonEmptyStrings(
    payload.pluginStorage?.deletes ?? [],
  );
  const presetUpserts: readonly unknown[] = payload.presets?.upserts ?? [];
  const presetDeletes: readonly unknown[] = payload.presets?.deletes ?? [];
  const moduleUpserts: readonly unknown[] = payload.modules?.upserts ?? [];
  const moduleDeletes: readonly unknown[] = payload.modules?.deletes ?? [];

  return {
    replaceAll: payload.replaceAll === true,
    chatIds: [...chatIds],
    characterIds: [...characterIds],
    charactersChanged: Boolean(
      payload.replaceAll ||
      (payload.characters?.length ?? 0) > 0 ||
      (payload.characterDeletes?.length ?? 0) > 0 ||
      payload.characterIds !== undefined,
    ),
    rootUpsertKeys: [...new Set<string>(rootUpsertKeys)],
    rootDeleteKeys: [...new Set<string>(rootDeleteKeys)],
    rootChanged: Boolean(
      payload.replaceAll || rootUpsertKeys.length || rootDeleteKeys.length,
    ),
    pluginStorageUpsertKeys: [...new Set<string>(pluginStorageUpsertKeys)],
    pluginStorageDeleteKeys: [...new Set<string>(pluginStorageDeleteKeys)],
    pluginStorageCleared: payload.pluginStorage?.clear === true,
    presetsChanged: Boolean(
      payload.replaceAll ||
      presetUpserts.length ||
      presetDeletes.length ||
      payload.presets?.order !== undefined ||
      payload.presets?.activeId !== undefined,
    ),
    modulesChanged: Boolean(
      payload.replaceAll ||
      moduleUpserts.length ||
      moduleDeletes.length ||
      payload.modules?.order !== undefined,
    ),
  };
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
  function makeBroadcastEvent(
    event: string,
    data: object,
  ): BroadcastEventRecord {
    const id: number = ++sequence;
    return { id, event, data: { ...data, eventId: id } };
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
  function broadcast(event: string, data: object): void {
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
    updateGenerationState,
    listActiveGenerations,
    clientCount: (): number => clients.size,
    latestEventId: (): number => sequence,
  };
}
