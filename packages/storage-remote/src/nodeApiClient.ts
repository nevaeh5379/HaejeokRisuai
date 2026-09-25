/**
 * HTTP client for the RisuAI storage server (Node / self-hosted).
 *
 * (KO) RisuAI 저장소 서버(Node / 자체 호스팅)용 HTTP 클라이언트 모듈.
 *
 * @remarks
 * (EN) This module is the low-level transport layer shared by every
 * higher-level client in this package (SQL readers/writers, asset clients,
 * auth, backup, compute, storage-sync, etc.). It knows nothing about RisuAI
 * data models. It only:
 * 1. Resolves `/api/...` paths against the configured server origin with
 *    SSRF-style origin pinning.
 * 2. Sends requests through an injectable `fetch` implementation.
 * 3. Validates every server response against the client-side schema before
 *    returning it (defense against malformed or malicious servers).
 * 4. Exposes the storage-sync protocol — a multi-step, resumable, chunked
 *    transfer for syncing a full database plus assets between a local device
 *    and a remote server.
 *
 * (KO) 이 모듈은 이 패키지의 모든 상위 클라이언트(SQL 읽기/쓰기, 에셋,
 * 인증, 백업, 컴퓨트, 스토리지 동기화 등)가 공유하는 저수준 전송 계층이다.
 * RisuAI 데이터 모델은 알지 못하며, 다음 역할만 수행한다:
 * 1. `/api/...` 경로를 설정된 서버 origin 기준으로 해석하고 origin 이탈
 *    (SSRF류)을 차단한다.
 * 2. 주입 가능한 `fetch` 구현으로 요청을 전송한다.
 * 3. 서버 응답을 클라이언트 측 스키마로 검증한 뒤에만 반환한다(잘못되거나
 *    악의적인 서버로부터의 방어).
 * 4. 로컬 기기와 원격 서버 사이에 전체 데이터베이스와 에셋을 동기화하는
 *    다단계 · 재개 가능 · 청크 기반 전송인 스토리지 동기화 프로토콜을
 *    노출한다.
 *
 * @example
 * ```ts
 * const client = new NodeApiClient(profile); // or createSameOriginNodeApiClient()
 * // Compatibility handshake first / 먼저 호환성 확인:
 * const caps = await client.getCapabilities();
 * const summary = await client.getStorageSyncSummary(authKey);
 * const session = await client.createStorageSyncSession(
 *   { direction: "local-to-remote", expectedRevision: summary.revision },
 *   authKey,
 * );
 * ```
 */
import type { RemoteStorageProfile } from "./types";

/**
 * The storage API protocol version this client speaks.
 *
 * (KO) 이 클라이언트가 사용하는 저장소 API 프로토콜 버전.
 *
 * @remarks
 * (EN) The server must report the exact same version in its capabilities
 * response; otherwise the client refuses to connect and throws
 * {@link NodeApiCompatibilityError}.
 *
 * (KO) 서버가 capabilities 응답에서 정확히 같은 버전을 보고해야 하며,
 * 다르면 {@link NodeApiCompatibilityError}를 던지며 연결을 거부한다.
 */
export const CLIENT_STORAGE_API_VERSION = 1;

/**
 * Server feature report fetched via {@link NodeApiClient.getCapabilities}.
 *
 * (KO) {@link NodeApiClient.getCapabilities}로 가져오는 서버 기능 보고서.
 *
 * @remarks
 * (EN) Callers use this to (1) verify the server is compatible before any
 * other request, and (2) detect optional features (`storageSync`,
 * `modelExecution`, `vectorSearch`) that only newer servers provide.
 *
 * (KO) 호출자는 이를 통해 (1) 다른 요청 전에 서버 호환성을 확인하고,
 * (2) 최신 서버만 제공하는 선택적 기능(`storageSync`, `modelExecution`,
 * `vectorSearch`)을 감지한다.
 */
export interface NodeClientCapabilities {
  apiVersion: number;
  features: {
    sqlStorage: boolean;
    assetStorage: boolean;
    dataChangeEvents: boolean;
    storageSync?: boolean;
    modelExecution?: boolean;
    vectorSearch?: boolean;
  };
}

/**
 * Snapshot of what is stored on the server: record counts and asset totals.
 *
 * (KO) 서버에 저장된 데이터의 스냅샷: 레코드 수와 에셋 합계.
 *
 * @remarks
 * (EN) Used by the sync UI to preview a sync, and as the source of
 * `expectedRevision` for optimistic concurrency when creating a sync session
 * via {@link NodeApiClient.createStorageSyncSession}.
 *
 * (KO) 동기화 UI에서 미리보기를 표시하거나,
 * {@link NodeApiClient.createStorageSyncSession}으로 세션을 만들 때
 * `expectedRevision`(낙관적 동시성)의 출처로 사용된다.
 */
export interface NodeStorageSyncSummary {
  protocolVersion: number;
  /**
   * Server-side revision counter, bumped on every data write.
   *
   * (KO) 서버 측 리비전 카운터. 데이터가 쓰일 때마다 증가한다.
   */
  revision: number;
  /**
   * Whether the server database has been initialized with data.
   *
   * (KO) 서버 데이터베이스에 데이터가 초기화되었는지 여부.
   */
  initialized: boolean;
  records: {
    settings: number;
    characters: number;
    chats: number;
    messages: number;
    total: number;
  };
  assets: { count: number; sizeBytes: number };
}

/**
 * Which way a sync session transfers data.
 *
 * (KO) 동기화 세션의 전송 방향.
 *
 * @remarks
 * (EN) `"local-to-remote"` pushes local data up to the server;
 * `"remote-to-local"` pulls server data down to this device.
 *
 * (KO) `"local-to-remote"`는 로컬 데이터를 서버로 올리는 것,
 * `"remote-to-local"`은 서버 데이터를 이 기기로 내려받는 것이다.
 */
export type StorageSyncDirection = "local-to-remote" | "remote-to-local";
/**
 * Lifecycle states of a sync session, always advancing in order.
 *
 * (KO) 동기화 세션의 수명 주기 상태. 항상 순서대로 앞으로만 진행한다.
 *
 * @remarks
 * (EN) Progression: `created` → `planning-assets` → `receiving-assets` →
 * `assets-ready` → `receiving-sql` → `sql-ready` → `finalized`. Assets are
 * transferred first so the SQL data can reference them atomically at
 * finalize time.
 *
 * (KO) 진행 순서: `created` → `planning-assets` → `receiving-assets` →
 * `assets-ready` → `receiving-sql` → `sql-ready` → `finalized`. 에셋을 먼저
 * 전송해 두면 finalize 시점에 SQL 데이터가 이를 원자적으로 참조할 수 있다.
 */
export type NodeStorageSyncSessionStatus =
  | "created"
  | "planning-assets"
  | "receiving-assets"
  | "assets-ready"
  | "receiving-sql"
  | "sql-ready"
  | "finalized";
/**
 * Per-asset upload state within the `receiving-assets` phase.
 *
 * (KO) `receiving-assets` 단계의 에셋별 업로드 상태.
 *
 * @remarks
 * (EN) `"skipped"` = the server already has an identical copy (sha256 match);
 * `"pending"` = not started; `"receiving"` = partially uploaded;
 * `"ready"` = fully uploaded and verified.
 *
 * (KO) `"skipped"` = 서버에 동일한 사본이 이미 있음(sha256 일치);
 * `"pending"` = 시작 전; `"receiving"` = 부분 업로드됨;
 * `"ready"` = 전부 업로드되어 검증 완료.
 */
export type NodeStorageSyncAssetState =
  "skipped" | "pending" | "receiving" | "ready";

/**
 * A server-side resumable sync transaction.
 *
 * (KO) 서버 측 재개 가능 동기화 트랜잭션.
 *
 * @remarks
 * (EN) Created with {@link NodeApiClient.createStorageSyncSession} and
 * progressed through the asset/SQL upload endpoints until
 * {@link NodeApiClient.finalizeStorageSync}. Sessions expire (`expiresAt`),
 * so long syncs should re-fetch the session and resume from the reported
 * offsets instead of trusting in-memory state.
 *
 * (KO) {@link NodeApiClient.createStorageSyncSession}으로 생성하고
 * 에셋/SQL 업로드 엔드포인트로 진행시킨 뒤
 * {@link NodeApiClient.finalizeStorageSync}로 마무리한다. 세션은
 * 만료되므로(`expiresAt`), 긴 동기화에서는 메모리 상태를 믿지 말고 세션을
 * 다시 조회해 보고된 오프셋부터 재개해야 한다.
 */
export interface NodeStorageSyncSession {
  id: string;
  direction: StorageSyncDirection;
  /**
   * This client's role: `"source"` when pushing local data to the server
   * (local-to-remote), `"target"` when the server pulls data in.
   *
   * (KO) 이 클라이언트의 역할: 로컬 데이터를 서버로 올릴 때는 `"source"`,
   * 서버가 데이터를 받아들일 때는 `"target"`.
   */
  role: "source" | "target";
  status: NodeStorageSyncSessionStatus;
  serverRevision: number;
  peerRevision: number | null;
  summary: NodeStorageSyncSummary;
  createdAt: number;
  expiresAt: number;
  /**
   * Server-mandated chunk size for uploads.
   *
   * (KO) 서버가 지정한 업로드 청크 크기.
   *
   * @remarks
   * (EN) Split large payloads into chunks of this size (or less) for
   * {@link NodeApiClient.uploadStorageSyncAssetChunk} and
   * {@link NodeApiClient.uploadStorageSyncSqlChunk}.
   *
   * (KO) 큰 페이로드는 이 크기 이하의 청크로 나눠
   * {@link NodeApiClient.uploadStorageSyncAssetChunk}와
   * {@link NodeApiClient.uploadStorageSyncSqlChunk}에 전송한다.
   */
  chunkSizeBytes: number;
  /**
   * How many chunk uploads the server allows in parallel.
   *
   * (KO) 서버가 허용하는 병렬 청크 업로드 수.
   */
  maxConcurrency: number;
  finalizedResult?: NodeStorageSyncFinalizeResult;
}

/**
 * Client-side description of one asset the source intends to transfer.
 *
 * (KO) 소스가 전송하려는 에셋 하나에 대한 클라이언트 측 설명.
 *
 * @remarks
 * (EN) Contains the storage `key`, byte `size`, and `sha256` hash. Manifests
 * are sent in bulk to {@link NodeApiClient.planStorageSyncAssets} so the
 * server can deduplicate against assets it already has.
 *
 * (KO) 저장소 `key`, 바이트 `size`, `sha256` 해시로 구성된다.
 * {@link NodeApiClient.planStorageSyncAssets}에 일괄 전송되어 서버가 이미
 * 보유한 에셋과 중복 제거할 수 있게 한다.
 */
export interface NodeStorageSyncAssetManifestEntry {
  key: string;
  size: number;
  sha256: string;
}

/**
 * Server-computed per-asset transfer state.
 *
 * (KO) 서버가 계산한 에셋별 전송 상태.
 *
 * @remarks
 * (EN) `id` is a stable content-addressed identifier (sha256 of content) and
 * `offset` is the resume position (bytes already received).
 *
 * (KO) `id`는 내용 기반의 안정적인 식별자(내용의 sha256)이고, `offset`은
 * 재개 위치(이미 수신된 바이트 수)이다.
 */
export interface NodeStorageSyncAssetPlanEntry extends NodeStorageSyncAssetManifestEntry {
  id: string;
  offset: number;
  state: NodeStorageSyncAssetState;
}

/**
 * Result of {@link NodeApiClient.planStorageSyncAssets}: the transfer plan.
 *
 * (KO) {@link NodeApiClient.planStorageSyncAssets}의 결과인 전송 플랜.
 *
 * @remarks
 * (EN) Lists which assets to upload and which were skipped as duplicates,
 * plus progress counters — `remainingBytes` drives progress bars and
 * remaining-chunk calculations.
 *
 * (KO) 업로드할 에셋 목록과 중복으로 건너뛴 에셋 정보, 진행률 카운터를
 * 담는다. `remainingBytes`는 진행 바 표시와 남은 청크 수 판단에 쓰인다.
 */
export interface NodeStorageSyncAssetPlan {
  status: NodeStorageSyncSessionStatus;
  assets: NodeStorageSyncAssetPlanEntry[];
  skippedCount: number;
  missingCount: number;
  totalBytes: number;
  remainingBytes: number;
}

/**
 * Updated state returned after each asset chunk upload.
 *
 * (KO) 에셋 청크 업로드마다 반환되는 갱신된 상태.
 *
 * @remarks
 * (EN) Returned by {@link NodeApiClient.uploadStorageSyncAssetChunk} so
 * callers can update progress and decide when all assets are `"ready"`.
 *
 * (KO) {@link NodeApiClient.uploadStorageSyncAssetChunk}가 반환하며, 호출자는
 * 이로 진행률을 갱신하고 모든 에셋이 `"ready"`가 되었는지 판단할 수 있다.
 */
export interface NodeStorageSyncAssetChunkResult {
  id: string;
  offset: number;
  state: NodeStorageSyncAssetState;
  status: NodeStorageSyncSessionStatus;
}

/**
 * SQL dump transfer state, mirroring the asset plan for a single payload.
 *
 * (KO) 단일 SQL 덤프에 적용되는 전송 상태. 에셋 플랜과 유사한 구조다.
 *
 * @remarks
 * (EN) Progresses `"pending"` → `"receiving"` → `"ready"`, with `offset`
 * tracking the resume position.
 *
 * (KO) `"pending"` → `"receiving"` → `"ready"`로 진행되며, `offset`이
 * 재개 위치를 추적한다.
 */
export type NodeStorageSyncSqlState = "pending" | "receiving" | "ready";

/**
 * Client declaration of the SQL dump it is about to upload.
 *
 * (KO) 업로드할 SQL 덤프에 대한 클라이언트 선언.
 *
 * @remarks
 * (EN) Declares format version, total byte size, expected record count, and
 * sha256. The server validates the finished upload against all of these.
 *
 * (KO) 포맷 버전, 전체 바이트 크기, 예상 레코드 수, sha256을 선언한다.
 * 서버는 업로드가 완료되면 이 값을 기준으로 검증한다.
 */
export interface NodeStorageSyncSqlPlanInput {
  formatVersion: 1;
  size: number;
  recordCount: number;
  sha256: string;
}

/**
 * Server view of the SQL transfer.
 *
 * (KO) SQL 전송에 대한 서버 뷰.
 *
 * @remarks
 * (EN) The client's declared plan plus the resume `offset` and current
 * `state`/`status`. Poll with
 * {@link NodeApiClient.getStorageSyncSqlPlan} to resume an interrupted
 * upload.
 *
 * (KO) 클라이언트가 선언한 플랜에 재개 `offset`과 현재
 * `state`/`status`가 추가된 것이다. 중단된 업로드를 재개하려면
 * {@link NodeApiClient.getStorageSyncSqlPlan}으로 조회한다.
 */
export interface NodeStorageSyncSqlPlan extends NodeStorageSyncSqlPlanInput {
  offset: number;
  state: NodeStorageSyncSqlState;
  status: NodeStorageSyncSessionStatus;
}

/**
 * Server-side integrity report for a fully uploaded SQL dump.
 *
 * (KO) 업로드가 완료된 SQL 덤프에 대한 서버 측 무결성 보고.
 *
 * @remarks
 * (EN) Returned by {@link NodeApiClient.validateStorageSyncSql}: parsed
 * record count, the source revision the dump was taken from, and
 * per-table counts. Call it after the SQL upload completes but before
 * finalize, to catch corruption early.
 *
 * (KO) {@link NodeApiClient.validateStorageSyncSql}가 반환한다: 파싱된
 * 레코드 수, 덤프가 만들어진 소스 리비전, 테이블별 레코드 수. SQL 업로드
 * 완료 후 finalize 전에 호출하여 손상을 조기에 발견한다.
 */
export interface NodeStorageSyncSqlValidation {
  recordCount: number;
  sourceRevision: number;
  counts: Record<string, number>;
}

/**
 * Read-only check that the session is eligible to be finalized.
 *
 * (KO) 세션이 finalize 가능한 상태인지 확인하는 읽기 전용 사전 점검.
 *
 * @remarks
 * (EN) Verifies all data was received and no revision conflicts exist.
 * Run it before showing the user an "overwrite target?" confirmation, since
 * {@link NodeApiClient.finalizeStorageSync} is the destructive commit step.
 *
 * (KO) 모든 데이터 수신 완료와 리비전 충돌 없음을 확인한다. finalize
 * 자체는 파괴적인 커밋 단계이므로, 사용자에게 "대상을 덮어씁니다" 확인을
 * 보여주기 전에 실행한다.
 */
export interface NodeStorageSyncFinalizePreflight {
  status: "ready";
  targetRevision: number;
  sourceRevision: number;
  recordCount: number;
  skippedAssetsVerified: number;
}

/**
 * Outcome of the atomic sync commit.
 *
 * (KO) 원자적 동기화 커밋의 결과.
 *
 * @remarks
 * (EN) Returned by {@link NodeApiClient.finalizeStorageSync}: the new server
 * revision, applied record/asset counts, and recovery metadata. If the
 * server hit trouble applying the result, `recoveryWarning` /
 * `cleanupWarning` describe non-fatal issues with the recovery snapshot kept
 * on the server.
 *
 * (KO) {@link NodeApiClient.finalizeStorageSync}가 반환한다: 새 서버
 * 리비전, 적용된 레코드/에셋 수, 복구 메타데이터. 서버가 적용 중 문제를
 * 겪은 경우 `recoveryWarning` / `cleanupWarning`이 서버에 보관된 복구
 * 스냅샷 관련 치명적이지 않은 문제를 설명한다.
 */
export interface NodeStorageSyncFinalizeResult {
  status: "completed";
  revision: number;
  revisionId: number | string;
  targetRevisionBefore: number;
  sourceRevision: number;
  recordCount: number;
  assetsApplied: number;
  recoveryId: string;
  recoveryPromoted: boolean;
  recoveryWarning: string | null;
  cleanupWarning?: string | null;
}

/**
 * Thrown when the storage revision changed before session creation (HTTP 409).
 *
 * (KO) 세션 생성 전에 저장소 리비전이 변경되었을 때 던져진다 (HTTP 409).
 *
 * @remarks
 * (EN) Thrown by {@link NodeApiClient.createStorageSyncSession} when the
 * server's revision moved on since the caller last read the summary, meaning
 * the planned sync would overwrite newer data. Handle by re-reading
 * {@link NodeApiClient.getStorageSyncSummary} and asking the user to refresh
 * the preview.
 *
 * (KO) 호출자가 마지막으로 요약을 읽은 이후 서버 리비전이 변경되어,
 * 계획된 동기화가 더 최신 데이터를 덮어쓸 수 있을 때
 * {@link NodeApiClient.createStorageSyncSession}이 던진다.
 * {@link NodeApiClient.getStorageSyncSummary}를 다시 읽고 사용자에게
 * 미리보기를 갱신하도록 안내하는 방식으로 처리한다.
 */
export class NodeStorageSyncRevisionConflictError extends Error {
  /**
   * The server's current revision at conflict time.
   *
   * (KO) 충돌 시점의 서버 현재 리비전.
   */
  constructor(readonly currentRevision: number) {
    super(
      `Storage revision changed to ${currentRevision}. Refresh the sync preview before continuing.`,
    );
    this.name = "NodeStorageSyncRevisionConflictError";
  }
}

/**
 * Storage-sync asset phase failure.
 *
 * (KO) 스토리지 동기화 에셋 단계 실패.
 *
 * @remarks
 * (EN) Thrown by the asset plan/chunk upload endpoints. `code` is a
 * machine-readable server error code and `status` the HTTP status.
 *
 * (KO) 에셋 플랜/청크 업로드 엔드포인트에서 던져진다. `code`는 기계 판독
 * 가능한 서버 에러 코드, `status`는 HTTP 상태 코드이다.
 */
export class NodeStorageSyncAssetError extends Error {
  /**
   * @param message - Human-readable error description.
   *                  사람이 읽을 수 있는 에러 설명.
   * @param code    - Machine-readable server error code.
   *                  기계 판독 가능한 서버 에러 코드.
   * @param status  - HTTP status code.
   *                  HTTP 상태 코드.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncAssetError";
  }
}

/**
 * Storage-sync SQL phase failure.
 *
 * (KO) 스토리지 동기화 SQL 단계 실패.
 *
 * @remarks
 * (EN) Thrown by the SQL plan/chunk/validate endpoints. `code` is a
 * machine-readable server error code and `status` the HTTP status.
 *
 * (KO) SQL 플랜/청크/검증 엔드포인트에서 던져진다. `code`는 기계 판독
 * 가능한 서버 에러 코드, `status`는 HTTP 상태 코드이다.
 */
export class NodeStorageSyncSqlError extends Error {
  /**
   * @param message - Human-readable error description.
   *                  사람이 읽을 수 있는 에러 설명.
   * @param code    - Machine-readable server error code.
   *                  기계 판독 가능한 서버 에러 코드.
   * @param status  - HTTP status code.
   *                  HTTP 상태 코드.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncSqlError";
  }
}

/**
 * Storage-sync finalize/preflight failure — the most serious sync error class.
 *
 * (KO) 스토리지 동기화 finalize/사전 점검 실패 — 가장 심각한 동기화 에러.
 *
 * @remarks
 * (EN) Thrown when the commit itself fails. `code` is a machine-readable
 * server error code and `status` the HTTP status.
 *
 * (KO) 커밋 자체가 실패했을 때 던져진다. `code`는 기계 판독 가능한 서버
 * 에러 코드, `status`는 HTTP 상태 코드이다.
 */
export class NodeStorageSyncFinalizeError extends Error {
  /**
   * @param message - Human-readable error description.
   *                  사람이 읽을 수 있는 에러 설명.
   * @param code    - Machine-readable server error code.
   *                  기계 판독 가능한 서버 에러 코드.
   * @param status  - HTTP status code.
   *                  HTTP 상태 코드.
   */
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncFinalizeError";
  }
}

/**
 * Injectable `fetch` signature for {@link NodeApiClient}.
 *
 * (KO) {@link NodeApiClient}에 주입하는 `fetch` 시그니처.
 *
 * @remarks
 * (EN) Tests and special environments replace this to intercept requests
 * (e.g. Tauri's native HTTP plugin, same-origin wrappers) without changing
 * {@link NodeApiClient} logic.
 *
 * (KO) 테스트나 특수 환경에서는 이를 교체해 요청을 가로챈다(예: Tauri
 * 네이티브 HTTP 플러그인, same-origin 래퍼). {@link NodeApiClient} 로직은
 * 그대로 유지된다.
 *
 * @param input - Absolute URL produced by {@link NodeApiClient.resolve}.
 *                {@link NodeApiClient.resolve}가 만든 절대 URL.
 * @param init  - Standard fetch options. 표준 fetch 옵션.
 */
export interface NodeApiRequestInit extends RequestInit {
  /**
   * Per-request transport timeout in milliseconds.
   *
   * (KO) 요청 단위 전송 타임아웃(밀리초).
   *
   * @remarks
   * (EN) Optional for the browser `fetch` (which has no per-request timeout),
   * but native transports honor it: the Tauri and Capacitor HTTP plugins
   * apply it as their connect/read timeout.
   *
   * (KO) 브라우저 `fetch`에는 선택 사항이지만(요청 단위 타임아웃이
   * 없음), 네이티브 전송은 이를 적용한다: Tauri와 Capacitor HTTP 플러그인이
   * 연결/읽기 타임아웃으로 사용한다.
   */
  requestTimeoutMs?: number;
}

export type NodeApiFetch = (
  input: string,
  init?: NodeApiRequestInit,
) => Promise<Response>;

/**
 * Thrown when the server is incompatible or returns malformed data.
 *
 * (KO) 서버가 호환되지 않거나 잘못된 데이터를 반환할 때 던져진다.
 *
 * @remarks
 * (EN) Thrown whenever the server is too old, speaks a different API version,
 * lacks required features, or returns a response that fails client-side
 * schema validation. Always means "upgrade or fix the server" — never a
 * transient network issue.
 *
 * (KO) 서버가 너무 오래되었거나, 다른 API 버전을 사용하거나, 필수 기능이
 * 없거나, 클라이언트 측 스키마 검증에 실패하는 응답을 보낼 때 던져진다.
 * 일시적인 네트워크 문제가 아니라 항상 "서버를 업그레이드/수정하라"는
 * 의미이다.
 */
export class NodeApiCompatibilityError extends Error {
  /**
   * @param message - Human-readable error description.
   *                  사람이 읽을 수 있는 에러 설명.
   */
  constructor(message: string) {
    super(message);
    this.name = "NodeApiCompatibilityError";
  }
}

/**
 * Internal response validators.
 *
 * (KO) 내부 응답 검증기.
 *
 * @remarks
 * (EN) Every server response is treated as untrusted input: these functions
 * shape-check it and throw {@link NodeApiCompatibilityError} on malformed
 * data, so callers never see half-valid objects. The sync protocol stores
 * asset ids and hashes as lowercase hex sha256 (64 chars).
 *
 * (KO) 서버 응답은 모두 신뢰할 수 없는 입력으로 취급한다. 이 함수들이
 * 구조를 검증해서 잘못된 데이터면 {@link NodeApiCompatibilityError}를
 * 던지므로, 호출자는 절반만 유효한 객체를 받지 않는다. 동기화 프로토콜의
 * 에셋 id와 해시는 소문자 16진수 sha256(64자)로 표현된다.
 */

function validateCapabilities(value: unknown): NodeClientCapabilities {
  if (!value || typeof value !== "object") {
    throw new NodeApiCompatibilityError(
      "The storage server returned invalid capabilities.",
    );
  }
  const capabilities = value as Partial<NodeClientCapabilities>;
  if (capabilities.apiVersion !== CLIENT_STORAGE_API_VERSION) {
    throw new NodeApiCompatibilityError(
      `The storage server API is incompatible (server ${String(capabilities.apiVersion ?? "unknown")}, client ${CLIENT_STORAGE_API_VERSION}). Upgrade the server before connecting.`,
    );
  }
  if (
    !capabilities.features ||
    capabilities.features.sqlStorage !== true ||
    capabilities.features.assetStorage !== true ||
    capabilities.features.dataChangeEvents !== true
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server does not provide the required SQL, asset, and data-change features.",
    );
  }
  return capabilities as NodeClientCapabilities;
}

function validateStorageSyncSummary(value: unknown): NodeStorageSyncSummary {
  const summary = value as Partial<NodeStorageSyncSummary> | null;
  const counters = summary?.records;
  const assets = summary?.assets;
  const validCounter = (entry: unknown) =>
    Number.isSafeInteger(entry) && Number(entry) >= 0;
  if (
    !summary ||
    summary.protocolVersion !== 1 ||
    !validCounter(summary.revision) ||
    typeof summary.initialized !== "boolean" ||
    !counters ||
    !validCounter(counters.settings) ||
    !validCounter(counters.characters) ||
    !validCounter(counters.chats) ||
    !validCounter(counters.messages) ||
    !validCounter(counters.total) ||
    !assets ||
    !validCounter(assets.count) ||
    !validCounter(assets.sizeBytes)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync summary.",
    );
  }
  return summary as NodeStorageSyncSummary;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateStorageSyncSession(value: unknown): NodeStorageSyncSession {
  const session = value as Partial<NodeStorageSyncSession> | null;
  const statuses: NodeStorageSyncSessionStatus[] = [
    "created",
    "planning-assets",
    "receiving-assets",
    "assets-ready",
    "receiving-sql",
    "sql-ready",
    "finalized",
  ];
  if (
    !session ||
    typeof session.id !== "string" ||
    !session.id ||
    !["local-to-remote", "remote-to-local"].includes(
      String(session.direction),
    ) ||
    !["source", "target"].includes(String(session.role)) ||
    !statuses.includes(session.status as NodeStorageSyncSessionStatus) ||
    !isNonNegativeSafeInteger(session.serverRevision) ||
    (session.peerRevision !== null &&
      !isNonNegativeSafeInteger(session.peerRevision)) ||
    !isNonNegativeSafeInteger(session.createdAt) ||
    !isNonNegativeSafeInteger(session.expiresAt) ||
    !isNonNegativeSafeInteger(session.chunkSizeBytes) ||
    !isNonNegativeSafeInteger(session.maxConcurrency)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync session.",
    );
  }
  validateStorageSyncSummary(session.summary);
  if (session.status === "finalized") {
    validateStorageSyncFinalizeResult(session.finalizedResult);
  }
  return session as NodeStorageSyncSession;
}

function validateStorageSyncAssetPlan(
  value: unknown,
): NodeStorageSyncAssetPlan {
  const plan = value as Partial<NodeStorageSyncAssetPlan> | null;
  const states: NodeStorageSyncAssetState[] = [
    "skipped",
    "pending",
    "receiving",
    "ready",
  ];
  if (
    !plan ||
    !["receiving-assets", "assets-ready"].includes(String(plan.status)) ||
    !Array.isArray(plan.assets) ||
    !isNonNegativeSafeInteger(plan.skippedCount) ||
    !isNonNegativeSafeInteger(plan.missingCount) ||
    !isNonNegativeSafeInteger(plan.totalBytes) ||
    !isNonNegativeSafeInteger(plan.remainingBytes)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync asset plan.",
    );
  }
  for (const asset of plan.assets) {
    if (
      typeof asset?.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.id) ||
      typeof asset.key !== "string" ||
      !asset.key ||
      !isNonNegativeSafeInteger(asset.size) ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !isNonNegativeSafeInteger(asset.offset) ||
      asset.offset > asset.size ||
      !states.includes(asset.state)
    ) {
      throw new NodeApiCompatibilityError(
        "The storage server returned an invalid storage sync asset entry.",
      );
    }
  }
  return plan as NodeStorageSyncAssetPlan;
}

function validateStorageSyncAssetChunkResult(
  value: unknown,
): NodeStorageSyncAssetChunkResult {
  const result = value as Partial<NodeStorageSyncAssetChunkResult> | null;
  if (
    !result ||
    typeof result.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.id) ||
    !isNonNegativeSafeInteger(result.offset) ||
    !["skipped", "pending", "receiving", "ready"].includes(
      String(result.state),
    ) ||
    !["receiving-assets", "assets-ready"].includes(String(result.status))
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync chunk result.",
    );
  }
  return result as NodeStorageSyncAssetChunkResult;
}

function validateStorageSyncSqlPlan(value: unknown): NodeStorageSyncSqlPlan {
  const plan = value as Partial<NodeStorageSyncSqlPlan> | null;
  if (
    !plan ||
    plan.formatVersion !== 1 ||
    !isNonNegativeSafeInteger(plan.size) ||
    !isNonNegativeSafeInteger(plan.recordCount) ||
    typeof plan.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.sha256) ||
    !isNonNegativeSafeInteger(plan.offset) ||
    Number(plan.offset) > Number(plan.size) ||
    !["pending", "receiving", "ready"].includes(String(plan.state)) ||
    !["receiving-sql", "sql-ready"].includes(String(plan.status))
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync SQL plan.",
    );
  }
  return plan as NodeStorageSyncSqlPlan;
}

function validateStorageSyncSqlValidation(
  value: unknown,
): NodeStorageSyncSqlValidation {
  const result = value as Partial<NodeStorageSyncSqlValidation> | null;
  if (
    !result ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !result.counts ||
    typeof result.counts !== "object" ||
    Array.isArray(result.counts) ||
    Object.values(result.counts).some(
      (count) => !isNonNegativeSafeInteger(count),
    )
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync SQL validation result.",
    );
  }
  return result as NodeStorageSyncSqlValidation;
}

function validateStorageSyncFinalizePreflight(
  value: unknown,
): NodeStorageSyncFinalizePreflight {
  const result = value as Partial<NodeStorageSyncFinalizePreflight> | null;
  if (
    !result ||
    result.status !== "ready" ||
    !isNonNegativeSafeInteger(result.targetRevision) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.skippedAssetsVerified)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid finalize preflight result.",
    );
  }
  return result as NodeStorageSyncFinalizePreflight;
}

function validateStorageSyncFinalizeResult(
  value: unknown,
): NodeStorageSyncFinalizeResult {
  const result = value as Partial<NodeStorageSyncFinalizeResult> | null;
  if (
    !result ||
    result.status !== "completed" ||
    !isNonNegativeSafeInteger(result.revision) ||
    !(
      typeof result.revisionId === "string" ||
      isNonNegativeSafeInteger(result.revisionId)
    ) ||
    !isNonNegativeSafeInteger(result.targetRevisionBefore) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.assetsApplied) ||
    typeof result.recoveryId !== "string" ||
    !result.recoveryId ||
    typeof result.recoveryPromoted !== "boolean" ||
    !(
      result.recoveryWarning === null ||
      typeof result.recoveryWarning === "string"
    ) ||
    !(
      result.cleanupWarning === undefined ||
      result.cleanupWarning === null ||
      typeof result.cleanupWarning === "string"
    )
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid finalize result.",
    );
  }
  return result as NodeStorageSyncFinalizeResult;
}

/**
 * Parses a failed sync response and throws the matching typed error.
 *
 * (KO) 실패한 동기화 응답을 파싱해 대응하는 타입 에러를 던진다.
 *
 * @remarks
 * (EN) Throws the asset/SQL/finalize error with the server's
 * `error`/`code` fields when present in the body.
 *
 * (KO) 본문에 서버의 `error`/`code` 필드가 있으면 그것을 담아
 * asset/SQL/finalize 에러를 던진다.
 */

async function storageSyncAssetError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncAssetError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync asset request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_asset_error",
    response.status,
  );
}

async function storageSyncSqlError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncSqlError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync SQL request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_sql_error",
    response.status,
  );
}

async function storageSyncFinalizeError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncFinalizeError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync finalize request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_finalize_error",
    response.status,
  );
}

/**
 * Low-level HTTP client for the RisuAI storage server.
 *
 * (KO) RisuAI 저장소 서버용 저수준 HTTP 클라이언트.
 *
 * @remarks
 * (EN) Every higher-level client in this package (remoteSqlReadClient,
 * remoteAssetClient, remoteStorageSyncClient, ...) wraps a
 * {@link NodeApiClient} instance and only adds domain logic on top of
 * {@link NodeApiClient.request} and {@link NodeApiClient.resolve}.
 *
 * (KO) 이 패키지의 모든 상위 클라이언트(remoteSqlReadClient,
 * remoteAssetClient, remoteStorageSyncClient 등)는 {@link NodeApiClient}
 * 인스턴스를 감싸고, {@link NodeApiClient.request}와
 * {@link NodeApiClient.resolve} 위에 도메인 로직만 얹는 구조다.
 *
 * @example
 * ```ts
 * // 1. Create from a remote storage profile / 원격 저장소 프로필로 생성:
 * const client = new NodeApiClient(profile);
 *
 * // 2. Check compatibility first / 먼저 호환성 확인:
 * const caps = await client.getCapabilities();
 * if (!caps.features.storageSync) {
 *   throw new Error("Server too old / 서버가 너무 오래됨");
 * }
 *
 * // 3. Call endpoint methods with the auth key
 * //    엔드포인트 메서드에 인증 키를 전달해 호출:
 * const summary = await client.getStorageSyncSummary(authKey);
 * ```
 */
export class NodeApiClient {
  readonly baseUrl: string;
  private readonly fetcher: NodeApiFetch;

  /**
   * Creates a client bound to a server origin.
   *
   * (KO) 서버 origin에 연결된 클라이언트를 생성한다.
   *
   * @param profile - Remote storage profile supplying the server origin.
   *                  서버 origin을 제공하는 원격 저장소 프로필.
   * @param fetcher - Fetch implementation override; defaults to global
   *                  `fetch`. Useful for tests or native HTTP stacks.
   *                  fetch 구현 교체용. 기본값은 전역 `fetch`. 테스트나
   *                  네이티브 HTTP 스택에서 유용하다.
   */
  constructor(
    profile: RemoteStorageProfile,
    fetcher: NodeApiFetch = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = profile.baseUrl;
    this.fetcher = fetcher;
  }

  /**
   * Resolves an API path to an absolute URL on the configured server.
   *
   * (KO) API 경로를 설정된 서버의 절대 URL로 해석한다.
   *
   * @remarks
   * (EN) Rejects paths that would escape the server origin, preventing
   * SSRF-style redirection to other hosts.
   *
   * (KO) 서버 origin을 벗어나는 경로는 거부하여 SSRF류의 다른 호스트로의
   * 우회를 막는다.
   *
   * @param path - API path starting with `/`. `/`로 시작하는 API 경로.
   * @returns Absolute URL on the configured server.
   *          설정된 서버의 절대 URL.
   * @throws {TypeError} If `path` does not start with `/` or would resolve
   *                     to a different origin.
   *                     `path`가 `/`로 시작하지 않거나 다른 origin으로
   *                     해석될 때.
   */
  resolve(path: string): string {
    if (!path.startsWith("/")) {
      throw new TypeError("Node API paths must start with '/'.");
    }
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl) {
      throw new TypeError("Node API paths must stay on the configured server.");
    }
    return url.toString();
  }

  /**
   * Raw request primitive used by every endpoint method.
   *
   * (KO) 모든 엔드포인트 메서드가 사용하는 원시 요청 프리미티브.
   *
   * @remarks
   * (EN) Resolves `path` and hands the result to the injected fetcher.
   * Domain clients built on this class call this for their own endpoints.
   *
   * (KO) `path`를 해석해 주입된 fetcher에 넘긴다. 이 클래스 위에 만들어진
   * 도메인 클라이언트도 자신의 엔드포인트에 이 메서드를 사용한다.
   *
   * @param path - API path starting with `/`. `/`로 시작하는 API 경로.
   * @param init - Standard fetch options. 표준 fetch 옵션.
   * @returns The raw fetch {@link Response}.
   *          fetch의 원시 {@link Response}.
   */
  request(path: string, init?: NodeApiRequestInit): Promise<Response> {
    return this.fetcher(this.resolve(path), init);
  }

  /**
   * Fetches the server's capabilities — the compatibility handshake.
   *
   * (KO) 서버 capabilities를 가져오는 호환성 핸드셰이크.
   *
   * @remarks
   * (EN) Call this before any other method: it verifies the server speaks
   * the same {@link CLIENT_STORAGE_API_VERSION} and provides the mandatory
   * SQL/asset/data-change features. HTTP 404 is translated to a clear
   * "server too old" error.
   *
   * (KO) 다른 메서드보다 먼저 호출한다: 서버가 같은
   * {@link CLIENT_STORAGE_API_VERSION}을 사용하고 필수 SQL/에셋/데이터 변경
   * 기능을 제공하는지 확인한다. HTTP 404는 "서버가 너무 오래됨" 에러로
   * 변환된다.
   *
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated server capabilities.
   *          검증된 서버 capabilities.
   * @throws {NodeApiCompatibilityError} If the endpoint is missing (404), the
   *         API version differs, or the response is malformed.
   *         엔드포인트가 없거나(404), API 버전이 다르거나, 응답이 잘못된 경우.
   */
  async getCapabilities(signal?: AbortSignal): Promise<NodeClientCapabilities> {
    const response = await this.request("/api/client-capabilities", {
      method: "GET",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new NodeApiCompatibilityError(
          "This server is too old for remote storage. Upgrade the server before connecting.",
        );
      }
      throw new Error(
        `Could not read storage server capabilities (HTTP ${response.status}).`,
      );
    }
    return validateCapabilities(await response.json());
  }

  /**
   * Fetches a snapshot of the server's current data.
   *
   * (KO) 서버 현재 데이터의 스냅샷을 가져온다.
   *
   * @remarks
   * (EN) `GET /api/storage-sync/summary`. Use it to preview a sync and to
   * obtain `expectedRevision` for {@link NodeApiClient.createStorageSyncSession}.
   * Requires the server to advertise the `storageSync` capability.
   *
   * (KO) `GET /api/storage-sync/summary`. 동기화 미리보기와
   * {@link NodeApiClient.createStorageSyncSession}에 넘길
   * `expectedRevision` 획득에 사용한다. 서버가 `storageSync` 기능을
   * 지원해야 한다.
   *
   * @param auth  - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated storage summary (revision, record counts, assets).
   *          검증된 저장소 요약(리비전, 레코드 수, 에셋).
   * @throws {NodeApiCompatibilityError} If the server lacks the `storageSync`
   *         capability or returns a malformed summary.
   *         서버가 `storageSync` 기능이 없거나 잘못된 요약을 반환할 때.
   */
  async getStorageSyncSummary(
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSummary> {
    await this.requireStorageSyncCapability(signal);
    const response = await this.request("/api/storage-sync/summary", {
      method: "GET",
      cache: "no-store",
      headers: { "risu-auth": auth },
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Could not read storage sync summary (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSummary(await response.json());
  }

  /**
   * Opens a resumable storage-sync session.
   *
   * (KO) 재개 가능한 스토리지 동기화 세션을 연다.
   *
   * @remarks
   * (EN) `POST /api/storage-sync/sessions`. `expectedRevision` implements
   * optimistic locking: if the server's revision changed since the caller
   * read the summary, the server replies 409 and this method throws
   * {@link NodeStorageSyncRevisionConflictError}. `peerRevision` optionally
   * reports the local revision for the record.
   *
   * (KO) `POST /api/storage-sync/sessions`. `expectedRevision`은 낙관적
   * 잠금을 구현한다: 호출자가 요약을 읽은 이후 서버 리비전이 바뀌었으면
   * 서버가 409로 응답하고 이 메서드는
   * {@link NodeStorageSyncRevisionConflictError}를 던진다. `peerRevision`은
   * 선택적으로 로컬 리비전을 기록한다.
   *
   * @param options.direction       - Transfer direction. 전송 방향.
   * @param options.expectedRevision - Revision the caller last observed; used
   *                                  for conflict detection.
   *                                  호출자가 마지막으로 관측한 리비전.
   *                                  충돌 감지에 사용된다.
   * @param options.peerRevision    - Optional local revision to record.
   *                                  기록할 선택적 로컬 리비전.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated session including chunk size and concurrency limits.
   *          청크 크기와 병렬 제한을 포함한 검증된 세션.
   * @throws {NodeStorageSyncRevisionConflictError} On HTTP 409 (revision
   *         conflict). HTTP 409(리비전 충돌) 시.
   * @throws {NodeApiCompatibilityError} If the server lacks `storageSync`.
   *         서버에 `storageSync` 기능이 없을 때.
   */
  async createStorageSyncSession(
    options: {
      direction: StorageSyncDirection;
      expectedRevision: number;
      peerRevision?: number | null;
    },
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    await this.requireStorageSyncCapability(signal);
    const response = await this.request("/api/storage-sync/sessions", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(options),
      signal,
    });
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      throw new NodeStorageSyncRevisionConflictError(
        Number.isSafeInteger(body?.currentRevision) ? body.currentRevision : 0,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Could not create storage sync session (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSession(await response.json());
  }

  /**
   * Re-reads a sync session's state from the server.
   *
   * (KO) 서버에서 동기화 세션 상태를 다시 읽는다.
   *
   * @remarks
   * (EN) `GET /api/storage-sync/sessions/:id`. Use this to resume an
   * interrupted sync: the session's plans/offsets are the source of truth,
   * not local memory.
   *
   * (KO) `GET /api/storage-sync/sessions/:id`. 중단된 동기화를 재개할 때
   * 사용한다. 플랜/오프셋의 진실은 로컬 메모리가 아니라 서버의 세션에 있다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated session. 검증된 세션.
   */
  async getStorageSyncSession(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) {
      throw new Error(
        `Could not read storage sync session (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSession(await response.json());
  }

  /**
   * Submits the local asset manifest to compute the transfer plan.
   *
   * (KO) 로컬 에셋 매니페스트를 전송해 전송 플랜을 계산한다.
   *
   * @remarks
   * (EN) `POST .../assets/plan`. The server decides which assets it needs
   * (`"pending"`) and which are already identical on disk (`"skipped"`).
   * The returned plan drives the upload loop.
   *
   * (KO) `POST .../assets/plan`. 서버가 필요한 에셋(`"pending"`)과 이미
   * 동일한 에셋(`"skipped"`)을 판별한다. 반환된 플랜이 업로드 루프를
   * 주도한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param assets - Local asset manifest entries (key/size/sha256).
   *                 로컬 에셋 매니페스트 항목(key/size/sha256).
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated asset plan. 검증된 에셋 플랜.
   * @throws {NodeStorageSyncAssetError} On upload plan failures.
   *         플랜 요청 실패 시.
   */
  async planStorageSyncAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/plan`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify({ assets }),
        signal,
      },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetPlan(await response.json());
  }

  /**
   * Re-reads the current asset plan to resume uploads.
   *
   * (KO) 현재 에셋 플랜을 다시 읽어 업로드를 재개한다.
   *
   * @remarks
   * (EN) `GET .../assets/plan`. Use after an interruption (e.g. app restart
   * mid-sync) to resume uploads from the recorded offsets.
   *
   * (KO) `GET .../assets/plan`. 중단 후(예: 동기화 도중 앱 재시작)
   * 기록된 오프셋부터 업로드를 재개할 때 사용한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated asset plan. 검증된 에셋 플랜.
   * @throws {NodeStorageSyncAssetError} On plan read failures.
   *         플랜 조회 실패 시.
   */
  async getStorageSyncAssetPlan(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/plan`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetPlan(await response.json());
  }

  /**
   * Uploads one chunk of a planned asset.
   *
   * (KO) 플랜에 포함된 에셋의 청크 하나를 업로드한다.
   *
   * @remarks
   * (EN) `PUT .../assets/:assetId?offset=N`. Upload at most
   * `session.chunkSizeBytes` per call, resuming at `offset`. Upload chunks of
   * each pending asset sequentially within an asset, and up to
   * `session.maxConcurrency` assets in parallel.
   *
   * (KO) `PUT .../assets/:assetId?offset=N`. 호출마다
   * `session.chunkSizeBytes` 이하를 `offset` 위치부터 업로드한다. 에셋 내
   * 청크는 순서대로, 에셋 간에는 `session.maxConcurrency`개까지 병렬로
   * 업로드할 수 있다.
   *
   * @param id      - Session identifier. 세션 식별자.
   * @param assetId - Content-addressed asset id from the plan.
   *                  플랜의 내용 기반 에셋 id.
   * @param offset  - Byte offset to resume at. 재개할 바이트 오프셋.
   * @param data    - Chunk bytes. 청크 바이트.
   * @param auth    - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal  - Optional abort signal. 선택적 중단 시그널.
   * @returns Updated asset and session state. 갱신된 에셋/세션 상태.
   * @throws {NodeStorageSyncAssetError} On chunk upload failures.
   *         청크 업로드 실패 시.
   */
  async uploadStorageSyncAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetChunkResult> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}?offset=${encodeURIComponent(String(offset))}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "risu-auth": auth,
        },
        body: data as BodyInit,
        signal,
      },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetChunkResult(await response.json());
  }

  /**
   * Declares the SQL dump before uploading it.
   *
   * (KO) SQL 덤프를 업로드 전에 선언한다.
   *
   * @remarks
   * (EN) `POST .../sql/plan`. Called after all assets are `"ready"` and the
   * session has moved to `receiving-sql`.
   *
   * (KO) `POST .../sql/plan`. 모든 에셋이 `"ready"`가 되고 세션이
   * `receiving-sql`로 이동한 후에 호출한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param plan   - SQL dump declaration (size, recordCount, sha256).
   *                 SQL 덤프 선언(size, recordCount, sha256).
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated SQL plan with resume offset. 재개 오프셋이 포함된
   *          검증된 SQL 플랜.
   * @throws {NodeStorageSyncSqlError} On plan submission failures.
   *         플랜 제출 실패 시.
   */
  async planStorageSyncSql(
    id: string,
    plan: NodeStorageSyncSqlPlanInput,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/plan`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify(plan),
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  /**
   * Re-reads SQL transfer state to resume an interrupted upload.
   *
   * (KO) SQL 전송 상태를 다시 읽어 중단된 업로드를 재개한다.
   *
   * @remarks
   * (EN) `GET .../sql/plan`. Resume the dump upload from the reported
   * `offset`.
   *
   * (KO) `GET .../sql/plan`. 보고된 `offset`부터 덤프 업로드를 재개한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Validated SQL plan. 검증된 SQL 플랜.
   * @throws {NodeStorageSyncSqlError} On plan read failures.
   *         플랜 조회 실패 시.
   */
  async getStorageSyncSqlPlan(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/plan`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  /**
   * Uploads one chunk of the serialized SQL dump.
   *
   * (KO) 직렬화된 SQL 덤프의 청크 하나를 업로드한다.
   *
   * @remarks
   * (EN) `PUT .../sql?offset=N`. Upload at most `session.chunkSizeBytes`
   * per call, resuming at `offset`.
   *
   * (KO) `PUT .../sql?offset=N`. 호출마다 `session.chunkSizeBytes` 이하를
   * `offset` 위치부터 업로드한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param offset - Byte offset to resume at. 재개할 바이트 오프셋.
   * @param data   - Chunk bytes. 청크 바이트.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Updated SQL plan. 갱신된 SQL 플랜.
   * @throws {NodeStorageSyncSqlError} On chunk upload failures.
   *         청크 업로드 실패 시.
   */
  async uploadStorageSyncSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql?offset=${encodeURIComponent(String(offset))}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "risu-auth": auth,
        },
        body: data as BodyInit,
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  /**
   * Asks the server to verify the fully uploaded SQL dump.
   *
   * (KO) 업로드가 완료된 SQL 덤프를 서버가 검증하도록 요청한다.
   *
   * @remarks
   * (EN) `POST .../sql/validate`. Checks record count, source revision, and
   * per-table counts. Call after the SQL state becomes `"ready"` but before
   * finalize, so corrupt dumps fail cheaply.
   *
   * (KO) `POST .../sql/validate`. 레코드 수, 소스 리비전, 테이블별 수를
   * 검증한다. SQL 상태가 `"ready"`가 된 후, finalize 전에 호출하여 손상된
   * 덤프를 저렴하게 실패시킨다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Server-side integrity report. 서버 측 무결성 보고.
   * @throws {NodeStorageSyncSqlError} On validation failures.
   *         검증 실패 시.
   */
  async validateStorageSyncSql(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlValidation> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/validate`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlValidation(await response.json());
  }

  /**
   * Runs a non-destructive final check before committing the session.
   *
   * (KO) 세션을 커밋하기 전 비파괴적 최종 점검을 실행한다.
   *
   * @remarks
   * (EN) `POST .../finalize/preflight`. Verifies that everything (assets,
   * SQL, revisions) is consistent and the session may be committed. Show its
   * result alongside the user's "overwrite target?" confirmation;
   * {@link NodeApiClient.finalizeStorageSync} is the step that actually
   * writes.
   *
   * (KO) `POST .../finalize/preflight`. 모든 것(에셋, SQL, 리비전)이 일치하고
   * 세션을 커밋할 수 있는지 확인한다. 사용자의 "대상을 덮어씁니까?" 확인
   * 질문과 함께 결과를 보여줘라. 실제 쓰기를 수행하는 것은
   * {@link NodeApiClient.finalizeStorageSync}다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Preflight report with target/source revisions and counts.
   *          대상/소스 리비전과 수를 담은 사전 점검 보고.
   * @throws {NodeStorageSyncFinalizeError} If the session is not ready to
   *         finalize. 세션이 finalize 준비가 되지 않은 경우.
   */
  async preflightStorageSyncFinalize(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizePreflight> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/finalize/preflight`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncFinalizeError(response);
    return validateStorageSyncFinalizePreflight(await response.json());
  }

  /**
   * Commits the sync session atomically — the destructive step.
   *
   * (KO) 동기화 세션을 원자적으로 커밋한다 — 파괴적 단계.
   *
   * @remarks
   * (EN) `POST .../finalize`. The target database is replaced by the
   * uploaded SQL dump and the assets are linked in, producing a new
   * revision. The server keeps a recovery snapshot (reported in the result)
   * in case something goes wrong.
   *
   * (KO) `POST .../finalize`. 대상 데이터베이스가 업로드된 SQL 덤프로
   * 교체되고 에셋이 연결되어 새 리비전이 만들어진다. 문제 발생에 대비해
   * 서버가 복구 스냅샷(결과에 포함)을 보관한다.
   *
   * @param id     - Session identifier. 세션 식별자.
   * @param auth   - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @returns Finalize result with new revision and recovery metadata.
   *          새 리비전과 복구 메타데이터를 담은 finalize 결과.
   * @throws {NodeStorageSyncFinalizeError} If the commit fails.
   *         커밋 실패 시.
   */
  async finalizeStorageSync(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizeResult> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/finalize`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncFinalizeError(response);
    return validateStorageSyncFinalizeResult(await response.json());
  }

  /**
   * Discards an unfinished session and its partial uploads.
   *
   * (KO) 미완료 세션과 부분 업로드를 폐기한다.
   *
   * @remarks
   * (EN) `DELETE /api/storage-sync/sessions/:id`. HTTP 404 is treated as
   * success (session already gone or expired). Call this in cleanup paths
   * (e.g. user cancels the sync) so the server does not keep orphaned temp
   * data.
   *
   * (KO) `DELETE /api/storage-sync/sessions/:id`. HTTP 404는 성공으로
   * 간주한다(세션이 이미 없거나 만료됨). 사용자가 동기화를 취소하는 등의
   * 정리 경로에서 호출해 서버에 고아 임시 데이터가 남지 않도록 한다.
   *
   * @param id   - Session identifier. 세션 식별자.
   * @param auth - `risu-auth` authentication key. `risu-auth` 인증 키.
   * @throws {Error} On unexpected cancel failures (other than 404).
   *         404 외의 예상 못한 취소 실패 시.
   */
  async cancelStorageSyncSession(id: string, auth: string): Promise<void> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { "risu-auth": auth } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Could not cancel storage sync session (HTTP ${response.status}).`,
      );
    }
  }

  /**
   * Guard for sync entry points: verifies the `storageSync` capability.
   *
   * (KO) 동기화 진입점용 가드: `storageSync` 기능을 확인한다.
   *
   * @remarks
   * (EN) Re-fetches capabilities and throws
   * {@link NodeApiCompatibilityError} unless the server advertises
   * `storageSync`. This gives a clear "upgrade the server" message instead
   * of cryptic 404s.
   *
   * (KO) capabilities를 다시 가져와 서버가 `storageSync`를 지원하지 않으면
   * {@link NodeApiCompatibilityError}를 던진다. 알아볼 수 없는 404 대신
   * "서버를 업그레이드하라"는 명확한 메시지를 제공한다.
   *
   * @param signal - Optional abort signal. 선택적 중단 시그널.
   * @throws {NodeApiCompatibilityError} If the server lacks `storageSync`.
   *         서버에 `storageSync` 기능이 없을 때.
   */
  private async requireStorageSyncCapability(
    signal?: AbortSignal,
  ): Promise<void> {
    const capabilities = await this.getCapabilities(signal);
    if (capabilities.features.storageSync !== true) {
      throw new NodeApiCompatibilityError(
        "This server does not support local/self-hosted storage sync. Upgrade the server before syncing.",
      );
    }
  }
}

/**
 * Creates a {@link NodeApiClient} that keeps browser-relative requests.
 *
 * (KO) 브라우저 상대 경로 요청을 유지하는 {@link NodeApiClient}를 생성한다.
 *
 * @remarks
 * (EN) The Node-hosted web app deliberately keeps browser-relative requests.
 * This avoids changing cookie/cache semantics while still routing every
 * endpoint through the same client abstraction used by remote profiles. The
 * returned client's `baseUrl` is the current page origin, and the wrapped
 * fetcher rewrites absolute URLs to origin-relative paths (`/api/...`).
 *
 * Use this when the web app is served by the same Node server it talks to
 * (no cross-origin requests, auth via cookies/headers as-is). For a
 * genuinely remote server, construct `new NodeApiClient(profile)` directly
 * instead.
 *
 * (KO) Node로 호스팅되는 웹 앱은 일부러 브라우저 상대 경로 요청을 유지한다.
 * 쿠키/캐시 의미론을 바꾸지 않으면서도, 모든 엔드포인트가 원격 프로필에서
 * 사용하는 것과 동일한 클라이언트 추상화를 통과하도록 만든다. 반환되는
 * 클라이언트의 `baseUrl`은 현재 페이지 origin이며, 감싼 fetcher가 절대
 * URL을 origin 상대 경로(`/api/...`)로 다시 쓴다.
 *
 * 웹 앱이 자신이 통신하는 Node 서버와 같은 origin에서 서빙될 때 사용한다
 * (교차 origin 요청 없음, 인증은 쿠키/헤더 그대로). 진짜 원격 서버라면
 * 이 함수 대신 `new NodeApiClient(profile)`를 직접 사용한다.
 *
 * @param fetcher - Fetch implementation override; defaults to global
 *                   `fetch`. fetch 구현 교체용. 기본값은 전역 `fetch`.
 * @param origin  - Page origin to pin requests to; defaults to
 *                   `globalThis.location?.origin`.
 *                   요청을 고정할 페이지 origin. 기본값은
 *                   `globalThis.location?.origin`.
 * @returns A client that sends origin-relative requests.
 *          origin 상대 경로 요청을 보내는 클라이언트.
 */
export function createSameOriginNodeApiClient(
  fetcher: NodeApiFetch = (input, init) => fetch(input, init),
  origin = globalThis.location?.origin || "http://localhost",
): NodeApiClient {
  return new NodeApiClient(
    {
      version: 1,
      mode: "remote",
      baseUrl: origin,
      allowInsecureHttp: origin.startsWith("http:"),
    },
    (input, init) => {
      const url = new URL(input);
      return fetcher(`${url.pathname}${url.search}${url.hash}`, init);
    },
  );
}
