import type { DurableModelJobRecord } from "../modelJobs.cjs";
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
  "ready" | "resync-required"
>;
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
> = RealtimeEventMap[K] & {
  readonly eventId: number;
};
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
  [K in RealtimeEventName]: {
    event: K;
    data: RealtimeEventMap[K];
  };
}[RealtimeEventName];
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
export declare function parseRealtimeEvent(
  eventName: string,
  data: unknown,
): RealtimeEventFrame | null;
