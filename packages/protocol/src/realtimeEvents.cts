import type { DurableModelJobRecord, ModelJobStatus } from "../modelJobs.cjs";
import type { SqlCommitImpact } from "./sqlCommit.cjs";

/**
 * Lifecycle state accepted by realtime generation synchronization.
 * 실시간 생성 동기화에서 허용하는 생명주기 상태입니다.
 */
export type GenerationLifecycleState =
  "started" | "finished" | "failed" | "aborted";

/**
 * The phase of a durable model job lifecycle event.
 * 영구 모델 잡 생명주기 이벤트의 단계입니다.
 */
export type ModelJobEventPhase = "created" | "terminal";

/**
 * The compact subset of {@link DurableModelJobRecord} that realtime consumers
 * need. Producers may broadcast the full record; clients only retain these
 * fields, keeping the event summary small on low-memory devices.
 * 실시간 소비자가 필요로 하는 {@link DurableModelJobRecord}의 압축 부분
 * 집합입니다. 생산자는 전체 레코드를 전파할 수 있고, 클라이언트는 이 필드만
 * 보존하여 저메모리 기기에서도 이벤트 요약을 작게 유지합니다.
 */
export type RealtimeModelJobSummary = Partial<
  Pick<
    DurableModelJobRecord,
    "id" | "chatId" | "generationId" | "status" | "recoverable"
  >
>;

/**
 * Event broadcast when a durable model job is created or reaches a terminal
 * state.
 * 영구 모델 잡이 생성되거나 종료 상태에 도달했을 때 전파되는 이벤트입니다.
 */
export interface RealtimeModelJobEvent {
  readonly phase: ModelJobEventPhase;
  readonly job?: RealtimeModelJobSummary | null;
  readonly sourceClientId?: string | null;
}

/**
 * A validated generation lifecycle state retained and broadcast by the hub.
 * 허브가 보관하고 전파하는 검증된 생성 생명주기 상태입니다.
 */
export interface RealtimeGenerationState {
  readonly chatId: string;
  readonly lifecycleId: string;
  readonly state: GenerationLifecycleState;
  readonly sourceClientId: string | null;
  readonly error?: string;
  readonly updatedAt?: number;
}

/**
 * Event broadcast when a chat generation lifecycle state changes.
 * 채팅 생성 생명주기 상태가 바뀔 때 전파되는 이벤트입니다.
 */
export type RealtimeGenerationStateEvent = RealtimeGenerationState;

export type RealtimeLocalBackupImportStatus =
  "pending" | "uploading" | "restoring" | "complete" | "error";

export type RealtimeLocalBackupImportStage =
  | "uploading"
  | "reading"
  | "database"
  | "coldStorage"
  | "assets"
  | "inlays"
  | "finalizing";

export interface RealtimeLocalBackupImportProgressEvent {
  readonly jobId: string;
  readonly status: RealtimeLocalBackupImportStatus;
  readonly progress?: {
    readonly stage: RealtimeLocalBackupImportStage;
    readonly current?: number;
    readonly total?: number;
    readonly detail?: string;
  };
}

/**
 * Event sent immediately after a realtime client is registered. It carries the
 * connection snapshot: the assigned client id, the current replay cursor, and
 * the generations that were already running.
 * 실시간 클라이언트가 등록된 직후 전송되는 이벤트입니다. 할당된 클라이언트
 * 식별자, 현재 재생 커서, 이미 진행 중인 생성 상태를 담은 연결 스냅샷입니다.
 */
export interface RealtimeReadyEvent {
  readonly clientId?: string | null;
  readonly connectedAt?: number;
  readonly latestEventId: number;
  readonly activeGenerations: RealtimeGenerationState[];
}

/**
 * Event sent when a reconnecting client's replay cursor falls outside the
 * retained history window and a full resynchronization is required.
 * 재접속 클라이언트의 커서가 보관된 기록 범위를 벗어나 전체 재동기화가
 * 필요할 때 전송되는 이벤트입니다.
 */
export interface RealtimeResyncRequiredEvent {
  readonly latestEventId: number;
  readonly oldestRetainedId?: number;
}

/**
 * Realtime payload describing which domains and entity IDs a database commit
 * invalidated. It extends the compact {@link SqlCommitImpact} fields with the
 * envelope metadata attached by the server.
 * 데이터베이스 커밋이 무효화한 영역과 엔터티 ID를 담는 실시간 페이로드입니다.
 * 압축 {@link SqlCommitImpact} 필드에 서버가 덧붙인 봉투 메타데이터를
 * 더합니다.
 */
export type RealtimeDatabaseChangeEvent = Partial<SqlCommitImpact> & {
  readonly revision?: number;
  readonly sourceClientId?: string | null;
  readonly pluginsChanged?: boolean;
  readonly pluginName?: string;
  readonly pluginEnabled?: boolean;
};

/**
 * Canonical realtime event map shared by server producers and frontend
 * consumers. Every hub broadcast and every client-side parse is keyed by these
 * event names.
 * 서버 생산자와 프론트엔드 소비자가 공유하는 표준 실시간 이벤트 맵입니다.
 * 모든 허브 전파와 클라이언트 파싱이 이 이벤트 이름으로 구분됩니다.
 */
export interface RealtimeEventMap {
  "database-change": RealtimeDatabaseChangeEvent;
  "model-job": RealtimeModelJobEvent;
  "generation-state": RealtimeGenerationStateEvent;
  "local-backup-import-progress": RealtimeLocalBackupImportProgressEvent;
  ready: RealtimeReadyEvent;
  "resync-required": RealtimeResyncRequiredEvent;
}

/** Names of all canonical realtime events. 모든 표준 실시간 이벤트의 이름입니다. */
export type RealtimeEventName = keyof RealtimeEventMap;

/**
 * Events retained in replay history and stamped with an event id. Ready and
 * resync-required are per-connection control events and are never broadcast.
 * 재생 기록에 보관되고 이벤트 ID가 붙는 이벤트입니다. ready와
 * resync-required는 연결별 제어 이벤트이므로 전파되지 않습니다.
 */
export type RealtimeBroadcastEventName = Exclude<
  RealtimeEventName,
  "ready" | "resync-required" | "local-backup-import-progress"
>;

export type RealtimeTransientEventName = "local-backup-import-progress";

/** Wire payload for a realtime event name. 실시간 이벤트 이름의 페이로드입니다. */
export type RealtimeEventPayload<
  K extends RealtimeEventName = RealtimeEventName,
> = RealtimeEventMap[K];

/**
 * Payload after the hub has stamped its shared sequence id onto the event.
 * 허브가 공용 시퀀스 ID를 이벤트에 새긴 뒤의 페이로드입니다.
 */
export type RealtimeEventEnvelope<
  K extends RealtimeBroadcastEventName = RealtimeBroadcastEventName,
> = RealtimeEventMap[K] & { readonly eventId: number };

/**
 * Typed broadcast signature: each event name accepts exactly its mapped
 * payload, so producers cannot emit unknown or mistyped realtime events.
 * 이벤트 이름별로 정확히 대응하는 페이로드만 허용하는 전파자 시그니처입니다.
 * 생산자가 모르거나 잘못된 형태의 실시간 이벤트를 내보낼 수 없습니다.
 */
export type RealtimeEventBroadcaster = <K extends RealtimeBroadcastEventName>(
  event: K,
  data: RealtimeEventMap[K],
) => void;

/**
 * A parsed realtime event frame: the event name narrowed to the canonical map
 * together with its runtime-validated payload.
 * 이벤트 이름이 표준 맵으로 좁혀지고 페이로드가 런타임 검증된 실시간 이벤트
 * 프레임입니다.
 */
export type RealtimeEventFrame = {
  [K in RealtimeEventName]: { event: K; data: RealtimeEventMap[K] };
}[RealtimeEventName];

interface UnknownRecord {
  readonly [key: string]: unknown;
}

/**
 * Removes the readonly modifiers of a wire type so parsers can assemble the
 * object field by field; the returned value is still assignable to the
 * readonly wire type.
 * 와이어 타입의 readonly 표시를 벗겨 파서가 필드 단위로 객체를 조립할 수
 * 있게 합니다. 반환값은 여전히 readonly 와이어 타입에 할당 가능합니다.
 */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a non-empty string within the given length budget.
 * 주어진 길이 한도 안의 비어 있지 않은 문자열을 반환합니다.
 */
function readString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

/**
 * Returns a strict boolean, leaving absent or invalid fields undefined.
 * 엄격한 불리언만 통과시키고, 없거나 잘못된 값은 버립니다.
 */
function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Returns a non-negative safe integer, the only numeric shape realtime
 * cursors and revisions use.
 * 실시간 커서와 리비전이 쓰는 유일한 숫자 형태인, 음수가 아닌 안전한
 * 정수를 반환합니다.
 */
function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Validates a string array in place so large change summaries are not copied
 * at the transport boundary.
 * 대형 변경 요약을 전송 경계에서 복사하지 않도록 문자열 배열을 제자리에서
 * 검증합니다.
 */
function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: unknown[] = value as unknown[];
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_EVENT_DATABASE_ID_LENGTH
    ) {
      return undefined;
    }
  }
  return entries as string[];
}

/**
 * Reads a bounded realtime id-or-null field, preserving the difference
 * between an absent field and an explicit null.
 * 길이가 제한된 실시간 "ID 또는 null" 필드를 읽되, 필드 부재와 명시적
 * null의 차이를 유지합니다.
 */
function readIdOrNull(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (typeof value === "string") return readString(value, maxLength);
  if (value === null) return null;
  return undefined;
}

const GENERATION_LIFECYCLE_STATES: readonly GenerationLifecycleState[] = [
  "started",
  "finished",
  "failed",
  "aborted",
];

function isGenerationLifecycleState(
  value: unknown,
): value is GenerationLifecycleState {
  return (GENERATION_LIFECYCLE_STATES as readonly unknown[]).includes(value);
}

const MODEL_JOB_STATUS_VALUES: readonly ModelJobStatus[] = [
  "running",
  "done",
  "failed",
  "aborted",
];

const LOCAL_BACKUP_IMPORT_STATUSES: readonly RealtimeLocalBackupImportStatus[] =
  ["pending", "uploading", "restoring", "complete", "error"];
const LOCAL_BACKUP_IMPORT_STAGES: readonly RealtimeLocalBackupImportStage[] = [
  "uploading",
  "reading",
  "database",
  "coldStorage",
  "assets",
  "inlays",
  "finalizing",
];

function isModelJobStatus(value: unknown): value is ModelJobStatus {
  return (MODEL_JOB_STATUS_VALUES as readonly unknown[]).includes(value);
}

// Length budgets mirror the server-side hub validation, so a malformed or
// hostile stream can never push unbounded strings into client state.
// 길이 한도는 서버 허브 검증과 동일하여, 잘못되거나 악의적인 스트림이
// 무한한 문자열을 클라이언트로 밀어 넣을 수 없습니다.
const MAX_EVENT_ACTION_LENGTH: number = 64;
const MAX_EVENT_DATABASE_ID_LENGTH: number = 4000;
const MAX_EVENT_CHAT_ID_LENGTH: number = 256;
const MAX_EVENT_LIFECYCLE_ID_LENGTH: number = 128;
const MAX_EVENT_CLIENT_ID_LENGTH: number = 128;
const MAX_EVENT_ERROR_LENGTH: number = 8000;

/**
 * Parses the compact database-change event summary. Valid ID arrays are reused
 * without copying so large commits do not create another memory-sized list.
 * 압축된 database-change 이벤트 요약을 해석합니다. 유효한 ID 배열은 복사
 * 없이 재사용하여 대형 커밋이 같은 크기의 목록을 하나 더 만들지 않습니다.
 */
function parseDatabaseChangeEvent(
  value: unknown,
): RealtimeDatabaseChangeEvent | null {
  if (!isRecord(value)) return null;
  const event: Writable<RealtimeDatabaseChangeEvent> = {};
  const replaceAll: boolean | undefined = readBoolean(value.replaceAll);
  if (replaceAll !== undefined) event.replaceAll = replaceAll;
  const chatIds: readonly string[] | undefined = readStringArray(value.chatIds);
  if (value.chatIds !== undefined && chatIds === undefined) return null;
  if (chatIds !== undefined) event.chatIds = chatIds;
  const characterIds: readonly string[] | undefined = readStringArray(
    value.characterIds,
  );
  if (value.characterIds !== undefined && characterIds === undefined) {
    return null;
  }
  if (characterIds !== undefined) event.characterIds = characterIds;
  const rootUpsertKeys: readonly string[] | undefined = readStringArray(
    value.rootUpsertKeys,
  );
  if (value.rootUpsertKeys !== undefined && rootUpsertKeys === undefined) {
    return null;
  }
  if (rootUpsertKeys !== undefined) event.rootUpsertKeys = rootUpsertKeys;
  const rootDeleteKeys: readonly string[] | undefined = readStringArray(
    value.rootDeleteKeys,
  );
  if (value.rootDeleteKeys !== undefined && rootDeleteKeys === undefined) {
    return null;
  }
  if (rootDeleteKeys !== undefined) event.rootDeleteKeys = rootDeleteKeys;
  const pluginStorageUpsertKeys: readonly string[] | undefined =
    readStringArray(value.pluginStorageUpsertKeys);
  if (
    value.pluginStorageUpsertKeys !== undefined &&
    pluginStorageUpsertKeys === undefined
  ) {
    return null;
  }
  if (pluginStorageUpsertKeys !== undefined) {
    event.pluginStorageUpsertKeys = pluginStorageUpsertKeys;
  }
  const pluginStorageDeleteKeys: readonly string[] | undefined =
    readStringArray(value.pluginStorageDeleteKeys);
  if (
    value.pluginStorageDeleteKeys !== undefined &&
    pluginStorageDeleteKeys === undefined
  ) {
    return null;
  }
  if (pluginStorageDeleteKeys !== undefined) {
    event.pluginStorageDeleteKeys = pluginStorageDeleteKeys;
  }
  for (const field of [
    "charactersChanged",
    "rootChanged",
    "pluginStorageCleared",
    "presetsChanged",
    "modulesChanged",
    "pluginsChanged",
  ] as const) {
    const flag: boolean | undefined = readBoolean(value[field]);
    if (flag !== undefined) event[field] = flag;
  }
  const revision: number | undefined = readNonNegativeInteger(value.revision);
  if (revision !== undefined) event.revision = revision;
  const action: string | undefined = readString(
    value.action,
    MAX_EVENT_ACTION_LENGTH,
  );
  if (action !== undefined) event.action = action;
  const sourceClientId: string | null | undefined = readIdOrNull(
    value.sourceClientId,
    MAX_EVENT_CLIENT_ID_LENGTH,
  );
  if (sourceClientId !== undefined) event.sourceClientId = sourceClientId;
  const pluginName: string | undefined = readString(
    value.pluginName,
    MAX_EVENT_CLIENT_ID_LENGTH,
  );
  if (pluginName !== undefined) event.pluginName = pluginName;
  const pluginEnabled: boolean | undefined = readBoolean(value.pluginEnabled);
  if (pluginEnabled !== undefined) event.pluginEnabled = pluginEnabled;
  return event;
}

/**
 * Parses the compact model-job summary a client needs; the full durable job
 * record never has to be decoded on the realtime path.
 * 클라이언트가 필요로 하는 압축 모델 잡 요약을 해석합니다. 전체 영구 잡
 * 레코드를 실시간 경계에서 해석할 필요는 없습니다.
 */
function parseModelJobEvent(value: unknown): RealtimeModelJobEvent | null {
  if (!isRecord(value)) return null;
  const phase: unknown = value.phase;
  if (phase !== "created" && phase !== "terminal") return null;
  const event: Writable<RealtimeModelJobEvent> = { phase };
  if (isRecord(value.job)) {
    const job: RealtimeModelJobSummary = {};
    const id: string | undefined = readString(value.job.id, 256);
    if (id !== undefined) job.id = id;
    const chatId: string | undefined = readString(
      value.job.chatId,
      MAX_EVENT_CHAT_ID_LENGTH,
    );
    if (chatId !== undefined) job.chatId = chatId;
    const generationId: string | null | undefined = readIdOrNull(
      value.job.generationId,
      MAX_EVENT_LIFECYCLE_ID_LENGTH,
    );
    if (generationId !== undefined) job.generationId = generationId;
    if (isModelJobStatus(value.job.status)) job.status = value.job.status;
    const recoverable: boolean | undefined = readBoolean(value.job.recoverable);
    if (recoverable !== undefined) job.recoverable = recoverable;
    event.job = job;
  }
  const sourceClientId: string | null | undefined = readIdOrNull(
    value.sourceClientId,
    MAX_EVENT_CLIENT_ID_LENGTH,
  );
  if (sourceClientId !== undefined) event.sourceClientId = sourceClientId;
  return event;
}

/**
 * Parses a generation lifecycle state, applying the same length budgets the
 * hub enforces when the state was first accepted.
 * 생성 생명주기 상태를 해석합니다. 허브가 상태를 받을 때 적용한 것과 같은
 * 길이 한도를 적용합니다.
 */
function parseGenerationState(value: unknown): RealtimeGenerationState | null {
  if (!isRecord(value)) return null;
  const chatId: string | undefined = readString(
    value.chatId,
    MAX_EVENT_CHAT_ID_LENGTH,
  );
  const lifecycleId: string | undefined = readString(
    value.lifecycleId,
    MAX_EVENT_LIFECYCLE_ID_LENGTH,
  );
  if (chatId === undefined || lifecycleId === undefined) return null;
  const state: unknown = value.state;
  if (!isGenerationLifecycleState(state)) return null;
  const sourceClientId: string | null | undefined = readIdOrNull(
    value.sourceClientId,
    MAX_EVENT_CLIENT_ID_LENGTH,
  );
  const event: Writable<RealtimeGenerationState> = {
    chatId,
    lifecycleId,
    state,
    sourceClientId: sourceClientId ?? null,
  };
  const error: string | undefined = readString(
    value.error,
    MAX_EVENT_ERROR_LENGTH,
  );
  if (error !== undefined) event.error = error;
  const updatedAt: number | undefined = readNonNegativeInteger(value.updatedAt);
  if (updatedAt !== undefined) event.updatedAt = updatedAt;
  return event;
}

function parseLocalBackupImportProgress(
  value: unknown,
): RealtimeLocalBackupImportProgressEvent | null {
  if (!isRecord(value)) return null;
  const jobId = readString(value.jobId, 256);
  if (
    jobId === undefined ||
    !LOCAL_BACKUP_IMPORT_STATUSES.includes(
      value.status as RealtimeLocalBackupImportStatus,
    )
  ) {
    return null;
  }
  const event: Writable<RealtimeLocalBackupImportProgressEvent> = {
    jobId,
    status: value.status as RealtimeLocalBackupImportStatus,
  };
  if (value.progress !== undefined) {
    if (!isRecord(value.progress)) return null;
    if (
      !LOCAL_BACKUP_IMPORT_STAGES.includes(
        value.progress.stage as RealtimeLocalBackupImportStage,
      )
    ) {
      return null;
    }
    const current = readNonNegativeInteger(value.progress.current);
    const total = readNonNegativeInteger(value.progress.total);
    const detail = readString(value.progress.detail, 1024);
    if (value.progress.current !== undefined && current === undefined)
      return null;
    if (value.progress.total !== undefined && total === undefined) return null;
    if (value.progress.detail !== undefined && detail === undefined)
      return null;
    event.progress = {
      stage: value.progress.stage as RealtimeLocalBackupImportStage,
      ...(current === undefined ? {} : { current }),
      ...(total === undefined ? {} : { total }),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return event;
}

/**
 * Parses the ready snapshot sent right after a client is registered. Malformed
 * generation entries are dropped instead of failing the whole snapshot.
 * 클라이언트가 등록된 직후 전송되는 ready 이벤트를 해석합니다. 잘못된 생성
 * 항목은 스냅샷 전체를 실패시키지 않고 버려집니다.
 */
function parseReadyEvent(value: unknown): RealtimeReadyEvent | null {
  if (!isRecord(value)) return null;
  const latestEventId: number | undefined = readNonNegativeInteger(
    value.latestEventId,
  );
  if (latestEventId === undefined) return null;
  const event: Writable<RealtimeReadyEvent> = {
    latestEventId,
    activeGenerations: [],
  };
  const clientId: string | undefined = readString(
    value.clientId,
    MAX_EVENT_CLIENT_ID_LENGTH,
  );
  if (clientId !== undefined) event.clientId = clientId;
  const connectedAt: number | undefined = readNonNegativeInteger(
    value.connectedAt,
  );
  if (connectedAt !== undefined) event.connectedAt = connectedAt;
  if (Array.isArray(value.activeGenerations)) {
    for (const rawGeneration of value.activeGenerations) {
      const generation: RealtimeGenerationState | null =
        parseGenerationState(rawGeneration);
      if (generation !== null) event.activeGenerations.push(generation);
    }
  }
  return event;
}

/**
 * Parses the resync-required event emitted when a client's replay cursor is
 * older than the retained history.
 * 클라이언트 커서가 보관된 기록보다 오래되어 전체 재동기화가 필요할 때
 * 전송되는 resync-required 이벤트를 해석합니다.
 */
function parseResyncRequiredEvent(
  value: unknown,
): RealtimeResyncRequiredEvent | null {
  if (!isRecord(value)) return null;
  const latestEventId: number | undefined = readNonNegativeInteger(
    value.latestEventId,
  );
  if (latestEventId === undefined) return null;
  const event: Writable<RealtimeResyncRequiredEvent> = { latestEventId };
  const oldestRetainedId: number | undefined = readNonNegativeInteger(
    value.oldestRetainedId,
  );
  if (oldestRetainedId !== undefined) event.oldestRetainedId = oldestRetainedId;
  return event;
}

/**
 * Narrows an untrusted SSE/WebSocket JSON value into one of the canonical
 * realtime events. Unknown event names and malformed payloads yield null so
 * callers can skip them without casting JSON.parse results.
 * 신뢰할 수 없는 SSE/WebSocket JSON 값을 표준 실시간 이벤트 중 하나로 좁힙니다.
 * 모르는 이벤트 이름과 잘못된 페이로드는 null을 반환하므로, 호출부는
 * JSON.parse 결과를 그대로 캐스팅하지 않아도 됩니다.
 *
 * @param eventName - Raw event name from the transport. 전송 계층의 원시 이벤트 이름입니다.
 * @param data - Parsed JSON payload (unknown). 해석된 JSON 페이로드(unknown)입니다.
 * @returns The typed event frame, or null when unrecognizable. 형식화된 이벤트 프레임 또는 null입니다.
 */
export function parseRealtimeEvent(
  eventName: string,
  data: unknown,
): RealtimeEventFrame | null {
  if (eventName === "database-change") {
    const payload: RealtimeDatabaseChangeEvent | null =
      parseDatabaseChangeEvent(data);
    return payload === null
      ? null
      : { event: "database-change", data: payload };
  }
  if (eventName === "model-job") {
    const payload: RealtimeModelJobEvent | null = parseModelJobEvent(data);
    return payload === null ? null : { event: "model-job", data: payload };
  }
  if (eventName === "generation-state") {
    const payload: RealtimeGenerationStateEvent | null =
      parseGenerationState(data);
    return payload === null
      ? null
      : { event: "generation-state", data: payload };
  }
  if (eventName === "local-backup-import-progress") {
    const payload = parseLocalBackupImportProgress(data);
    return payload === null
      ? null
      : { event: "local-backup-import-progress", data: payload };
  }
  if (eventName === "ready") {
    const payload: RealtimeReadyEvent | null = parseReadyEvent(data);
    return payload === null ? null : { event: "ready", data: payload };
  }
  if (eventName === "resync-required") {
    const payload: RealtimeResyncRequiredEvent | null =
      parseResyncRequiredEvent(data);
    return payload === null
      ? null
      : { event: "resync-required", data: payload };
  }
  return null;
}
