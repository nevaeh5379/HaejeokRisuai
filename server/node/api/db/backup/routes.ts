import type { Express, Request, RequestHandler, Response } from "express";

export type BackupVendor = "postgres" | "oracle" | "azure";

type RawBackupParams = Record<string, unknown>;

type BackupRequestBody = {
  vendor?: unknown;
  params?: unknown;
  mirroring?: unknown;
  snapshot?: unknown;
};

type BackupParams = {
  connectionString?: string;
  poolMax?: number;
  user?: string;
  tnsAlias?: string;
  walletPath?: string;
  password?: string;
  walletPassword?: string;
  server?: string;
  database?: string;
  port?: number;
};

export type BackupConfig = {
  vendor: BackupVendor | null;
  enabled: boolean;
  poolMax: number;
  params: BackupParams;
  mirroring: { enabled: boolean };
  snapshot: { enabled: boolean; intervalMinutes: number };
};

export type BackupRuntime = {
  initialized: boolean;
  lastMirrorAt: string | null;
  lastMirrorError: string | null;
  lastSnapshotAt: string | null;
  lastSnapshotError: string | null;
  lastFullSyncAt: string | null;
  lastFullSyncError: string | null;
  inFlight: boolean;
};

type StorageState = { revision: number | null; initialized: boolean };
export type BackupStorage = {
  enabled: boolean;
  getState: () => Promise<StorageState>;
  close?: () => Promise<void>;
};
export type BackupProgress = {
  stage: string;
  message?: string;
  percentage?: number;
  settingsCount?: number;
  charactersCount?: number;
  chatsCount?: number;
  messagesCount?: number;
  total?: number;
  success?: boolean;
};
export type BackupResult = {
  success?: boolean;
  skipped?: string;
  revision?: number;
  revisionId?: string;
  settingsCount?: number;
  charactersCount?: number;
  chatsCount?: number;
  messagesCount?: number;
};
type ConnectionTestResult = { success: boolean; error?: string };
type BackupConfigurationInput = {
  vendor: BackupVendor;
  params: BackupParams;
  mirroring: { enabled: boolean };
  snapshot: { enabled: boolean; intervalMinutes: unknown };
};
type AppliedBackupConfig = { backup: BackupConfig; storage: BackupStorage };
type MaskedBackupParams = Record<string, string | number | boolean>;

type BackupConfigResponse = {
  configured: boolean;
  enabled: boolean;
  vendor: BackupVendor | null;
  managedByEnvironment: false;
  mirroring: { enabled: boolean };
  snapshot: { enabled: boolean; intervalMinutes: number };
  params: MaskedBackupParams;
  primaryRevision: number | null;
  backupRevision: number | null;
  lag: number | null;
  backupInitialized: boolean;
  inFlight: boolean;
  lastMirrorAt: string | null;
  lastMirrorError: string | null;
  lastSnapshotAt: string | null;
  lastSnapshotError: string | null;
  lastFullSyncAt: string | null;
  lastFullSyncError: string | null;
};

export type BackupRouteDependencies = {
  limiter: RequestHandler;
  checkAuth: (req: Request, res: Response) => Promise<boolean>;
  isSecureConfigRequest: (req: Request) => boolean;
  getPrimaryStorage: () => {
    enabled: boolean;
    getState: () => Promise<StorageState>;
  };
  getBackupStorage: () => BackupStorage | null;
  setBackupStorage: (storage: null) => void;
  getBackupConfig: () => BackupConfig;
  setBackupConfig: (config: BackupConfig) => void;
  runtime: BackupRuntime;
  savePath: string;
  maskPostgresConnectionString: (value: string) => string;
  supportedVendors: readonly BackupVendor[];
  testConnection: (
    vendor: BackupVendor,
    params: RawBackupParams,
  ) => Promise<ConnectionTestResult>;
  normalizeVendorParams: (
    vendor: BackupVendor,
    params: RawBackupParams,
  ) => BackupParams;
  isVendorConfigComplete: (
    vendor: BackupVendor,
    params: BackupParams,
  ) => boolean;
  applyBackupConfig: (
    savePath: string,
    config: BackupConfigurationInput,
  ) => AppliedBackupConfig;
  activateBackupStorage: (storage: BackupStorage) => Promise<void>;
  syncBackupSnapshotTimer: () => void;
  enqueueBackupWrite: <T>(
    task: () => Promise<T>,
    label: string,
  ) => Promise<T | null>;
  mirrorFullBackupToBackup: (
    onProgress?: (event: BackupProgress) => void,
  ) => Promise<BackupResult>;
  restoreBackupToMainDatabase: (
    onProgress?: (event: BackupProgress) => void,
  ) => Promise<BackupResult>;
  deactivateBackupStorage: () => Promise<void>;
  removeBackupConfig: (savePath: string) => void;
  StoragePayloadError: new (message: string) => Error;
};

function asRecord(value: unknown): RawBackupParams {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawBackupParams)
    : {};
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message;
    if (message) return String(message);
  }
  return fallback;
}

/**
 * @description NDJSON 스트림의 전송 계층만 담당하는 래퍼.
 * @description A wrapper owning only the NDJSON transport layer.
 *
 * @description 헤더 설정과 안전한 라인 쓰기(연결이 끊기면 무시), 스트림 종료만
 * 안다. 각 라인의 "내용"(progress/done/error)은 호출부가 결정한다.
 * @description Knows only header setup, safe line writing (no-op once the
 * connection is closed), and stream closing. The caller decides line content.
 */
type NdjsonStream = {
  sendLine: (line: Record<string, unknown>) => void;
  end: () => void;
};

/**
 * @description 응답을 NDJSON 스트림으로 열고 전송 래퍼를 반환한다.
 * @description Opens the response as an NDJSON stream and returns a transport wrapper.
 *
 * @param res - 스트림으로 사용할 Express 응답 객체. / Express response to stream on.
 * @returns 라인 작성기(sendLine)와 스트림 종료기(end). / Line writer (sendLine) and stream closer (end).
 */
function openNdjsonStream(res: Response): NdjsonStream {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  return {
    sendLine: (line: Record<string, unknown>): void => {
      if (!res.writableEnded && !res.closed) {
        res.write(JSON.stringify(line) + "\n");
      }
    },
    end: (): void => {
      res.end();
    },
  };
}

/** Register the backup database API while sharing the server's live backup state. */
export function registerBackupRoutes(
  app: Express,
  deps: BackupRouteDependencies,
): void {
  const {
    limiter: authenticatedRouteLimiter,
    checkAuth,
    isSecureConfigRequest: isSecurePostgresConfigRequest,
    runtime: backupRuntime,
    savePath,
    maskPostgresConnectionString,
    supportedVendors: SUPPORTED_VENDORS,
    testConnection,
    normalizeVendorParams,
    isVendorConfigComplete,
    applyBackupConfig,
    activateBackupStorage,
    syncBackupSnapshotTimer,
    enqueueBackupWrite,
    mirrorFullBackupToBackup,
    restoreBackupToMainDatabase,
    deactivateBackupStorage,
    removeBackupConfig,
    StoragePayloadError,
  } = deps;

  function isSupportedVendor(value: unknown): value is BackupVendor {
    return (
      typeof value === "string" &&
      SUPPORTED_VENDORS.some(
        (vendor: BackupVendor): boolean => vendor === value,
      )
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 백업 데이터베이스 API
  // /api/db-backup:         백업 설정 + 실시간 상태(revision lag, 마지막 미러/스냅샷)
  // /api/db-backup/test:    전달된 백업 연결 파라미터로 연결 테스트
  // /api/db-backup POST:    백업 설정 적용 + 초기화 + 최초 전체 백업
  // /api/db-backup/resync:  수동 전체 백업 (메인 전체 → 백업 replaceAll)
  // /api/db-backup DELETE:  백업 설정 해제
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * @description vendor별 연결 파라미터 중 민감하지 않은 필드만 노출하는 마스킹 매퍼.
   * @description A vendor-specific masking mapper that exposes only non-sensitive connection fields.
   *
   * @description 비밀번호(password/walletPassword)는 값을 반환하지 않고
   * 존재 여부(`hasPassword`/`hasWalletPassword`)만 boolean으로 노출하며,
   * postgres의 connectionString은 `maskPostgresConnectionString`으로 마스킹한다.
   * @description Passwords (password/walletPassword) are never returned; only their
   * presence (`hasPassword`/`hasWalletPassword`) is exposed as booleans, and the
   * postgres connectionString is masked via `maskPostgresConnectionString`.
   *
   * @param vendor - 마스킹할 vendor. `null`이면 빈 객체를 반환한다.
   * / Vendor to mask for. `null` returns an empty object.
   * @param params - 저장된 원본 연결 파라미터. / Stored raw connection parameters.
   * @returns API 응답에 포함할 마스킹된 파라미터. / Masked parameters safe for API responses.
   */
  function maskBackupParams(
    vendor: BackupVendor | null,
    params: BackupParams = {},
  ): MaskedBackupParams {
    switch (vendor) {
      case "postgres":
        return {
          connectionString: maskPostgresConnectionString(
            params.connectionString || "",
          ),
          poolMax: params.poolMax || 10,
        };
      case "oracle":
        return {
          user: params.user || "",
          tnsAlias: params.tnsAlias || "",
          walletPath: params.walletPath || "",
          poolMax: params.poolMax || 10,
          hasPassword: Boolean(params.password),
          hasWalletPassword: Boolean(params.walletPassword),
        };
      case "azure":
        return {
          server: params.server || "",
          database: params.database || "",
          user: params.user || "",
          port: params.port || 1433,
          poolMax: params.poolMax || 10,
          hasPassword: Boolean(params.password),
        };
      default:
        // vendor는 BackupVendor|"null"이므로 모든 케이스를 다뤘다.
        // 여기 도달하면 부재(null) 상태인데도 마스킹을 요청한 것이므로
        // 호출부 버그로 간주하고 명시적으로 실패시킨다.
        // Every BackupVendor case is handled above; reaching here means a
        // missing (null) vendor was masked, which is a caller bug.
        throw new Error(`maskBackupParams: unsupported vendor: ${String(vendor)}`);
    }
  }

  async function getBackupConfigResponse(): Promise<BackupConfigResponse> {
    const config: BackupConfig = deps.getBackupConfig();
    const storage: BackupStorage | null = deps.getBackupStorage();
    const configured: boolean = Boolean(config.vendor && config.enabled);
    const active: boolean = Boolean(storage?.enabled);
    let primaryRevision: number | null = null;
    let backupRevision: number | null = null;
    let backupInitialized: boolean = false;
    try {
      const primaryStorage: ReturnType<typeof deps.getPrimaryStorage> =
        deps.getPrimaryStorage();
      if (primaryStorage.enabled) {
        const primaryState: StorageState = await primaryStorage.getState();
        primaryRevision = primaryState.revision ?? null;
      }
    } catch {
      // Keep status available when the primary database is unavailable.
    }
    if (active && storage) {
      try {
        const backupState: StorageState = await storage.getState();
        backupRevision = backupState.revision ?? null;
        backupInitialized = Boolean(backupState.initialized);
      } catch {
        // Keep status available when the backup database is unavailable.
      }
    }
    return {
      configured,
      enabled: active,
      vendor: configured ? config.vendor : null,
      managedByEnvironment: false,
      mirroring: {
        enabled: Boolean(config.mirroring?.enabled),
      },
      snapshot: {
        enabled: Boolean(config.snapshot?.enabled),
        intervalMinutes: config.snapshot?.intervalMinutes || 60,
      },
      params: configured ? maskBackupParams(config.vendor, config.params) : {},
      primaryRevision,
      backupRevision,
      lag:
        primaryRevision !== null && backupRevision !== null
          ? Math.max(0, primaryRevision - backupRevision)
          : null,
      backupInitialized,
      inFlight: backupRuntime.inFlight,
      lastMirrorAt: backupRuntime.lastMirrorAt,
      lastMirrorError: backupRuntime.lastMirrorError,
      lastSnapshotAt: backupRuntime.lastSnapshotAt,
      lastSnapshotError: backupRuntime.lastSnapshotError,
      lastFullSyncAt: backupRuntime.lastFullSyncAt,
      lastFullSyncError: backupRuntime.lastFullSyncError,
    };
  }

  app.get(
    "/api/db-backup",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      try {
        res.send(await getBackupConfigResponse());
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/db-backup/test",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
          error:
            "Backup database connection test requires HTTPS or a localhost connection",
          code: "secure_transport_required",
        });
        return;
      }
      try {
        const body: BackupRequestBody = asRecord(req.body as unknown);
        const vendor: unknown = body.vendor;
        const params: RawBackupParams = asRecord(body.params);
        if (!isSupportedVendor(vendor)) {
          res
            .status(400)
            .send({ success: false, error: `Unsupported vendor: ${vendor}` });
          return;
        }
        const result: ConnectionTestResult = await testConnection(
          vendor,
          params,
        );
        res.send(result);
      } catch (error) {
        res.send({ success: false, error: errorMessage(error, String(error)) });
      }
    },
  );

  app.post(
    "/api/db-backup",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
          error:
            "Backup database configuration changes require HTTPS or a localhost connection",
          code: "secure_transport_required",
        });
        return;
      }
      try {
        const body: BackupRequestBody = asRecord(req.body as unknown);
        const vendor: unknown = body.vendor;
        const params: RawBackupParams = asRecord(body.params);
        if (!isSupportedVendor(vendor)) {
          throw new StoragePayloadError(`Unsupported vendor: ${vendor}`);
        }
        const normalized: BackupParams = normalizeVendorParams(vendor, params);
        if (!isVendorConfigComplete(vendor, normalized)) {
          throw new StoragePayloadError(
            "Required backup connection parameters are missing",
          );
        }
        const mirroringInput: RawBackupParams = asRecord(body.mirroring);
        const snapshotInput: RawBackupParams = asRecord(body.snapshot);
        const mirroring: BackupConfigurationInput["mirroring"] = {
          enabled: mirroringInput.enabled === true,
        };
        const snapshot: BackupConfigurationInput["snapshot"] = {
          enabled: snapshotInput.enabled === true,
          intervalMinutes: snapshotInput.intervalMinutes,
        };

        // 기존 백업 풀 정리
        const previousStorage: BackupStorage | null = deps.getBackupStorage();
        if (previousStorage && typeof previousStorage.close === "function") {
          try {
            await previousStorage.close();
          } catch (e) {}
        }
        deps.setBackupStorage(null);
        backupRuntime.initialized = false;

        // 설정 저장 + 신규 인스턴스
        const applied: AppliedBackupConfig = applyBackupConfig(savePath, {
          vendor,
          params: normalized,
          mirroring,
          snapshot,
        });
        deps.setBackupConfig(applied.backup);

        // 초기화 (스키마 생성/확인)
        await activateBackupStorage(applied.storage);
        console.log(
          `[db-backup] Backup storage configured (vendor: ${vendor}).`,
        );

        // 스냅샷 타이머 재설정
        syncBackupSnapshotTimer();

        // 최초 전체 백업: 메인 DB에서 백업 DB로 전체 적요 (직렬 큐)
        void enqueueBackupWrite(
          () =>
            mirrorFullBackupToBackup().then((result: BackupResult) => {
              backupRuntime.lastFullSyncAt = new Date().toISOString();
              backupRuntime.lastFullSyncError = null;
              return result;
            }),
          "full",
        ).catch(() => {});

        const resp: BackupConfigResponse = await getBackupConfigResponse();
        res.send({ success: true, ...resp });
      } catch (error) {
        if (error instanceof StoragePayloadError) {
          res.status(400).send({
            error: error.message,
            code: "invalid_backup_configuration",
          });
          return;
        }
        next(error);
      }
    },
  );

  /**
   * @description 전체 백업 작업(resync/restore)을 NDJSON 스트리밍으로 실행하는 공통 헬퍼.
   * @description Shared helper that streams a full backup operation (resync/restore) as NDJSON.
   *
   * @description 작업 흐름(직렬 큐 실행 → done/error 페이로드 구성)만 담당하고,
   * 실제 전송은 `openNdjsonStream` 래퍼에 위임한다. 실패 시 헤더가 아직
   * 전송되지 않았다면 502 JSON 본문으로, 이미 보냈다면 `error` 라인으로 전달한다.
   * @description Owns only the operation flow (serial-queue execution → done/error
   * payload shaping) and delegates transport to the `openNdjsonStream` wrapper. On
   * failure it responds with a 502 JSON body when headers were not yet sent,
   * otherwise an `error` line.
   *
   * @param res - NDJSON 스트림을 받을 Express 응답 객체. / Express response receiving the NDJSON stream.
   * @param operation - 진행 콜백을 받는 백업 작업. 반환 객체가 `done` 라인에 스프레드된다.
   * / Backup operation receiving a progress emitter; its return value is spread into the `done` line.
   * @param fallbackError - 오류에 메시지가 없을 때 사용하는 기본 메시지. / Fallback message when the error has none.
   * @param errorCode - `error` 라인/502 본문에 넣는 기계 가독 코드. / Machine-readable code for the `error` line / 502 body.
   */
  async function streamFullBackupOperation(
    res: Response,
    operation: (
      sendProgress: (event: BackupProgress) => void,
    ) => Promise<Record<string, unknown> | null>,
    fallbackError: string,
    errorCode: string,
  ): Promise<void> {
    const stream: NdjsonStream = openNdjsonStream(res);

    try {
      const result = await enqueueBackupWrite(
        () => operation((event) => stream.sendLine({ type: "progress", ...event })),
        "full",
      );
      stream.sendLine({ type: "done", success: true, ...result });
    } catch (error) {
      const payload = {
        success: false,
        error: errorMessage(error, fallbackError),
        code: errorCode,
      };
      if (!res.headersSent) {
        res.status(502).send(payload);
      } else {
        stream.sendLine({ type: "error", ...payload });
      }
    } finally {
      stream.end();
    }
  }

  /**
   * @description POST /api/db-backup/resync — 메인 DB 전체를 백업 DB로 다시 적요한다.
   * @description POST /api/db-backup/resync — re-sync the entire main database into the backup database.
   *
   * @description 진행 상황과 결과를 NDJSON으로 스트리밍한다. 성공 시 마지막 전체
   * 동기화 오류(lastFullSyncError)를 초기화하고, lastFullSyncAt 타임스탬프를
   * `done` 라인에 포함한다.
   * @description Streams progress and the result as NDJSON. On success it clears the
   * last full-sync error (lastFullSyncError) and includes the lastFullSyncAt
   * timestamp in the `done` line.
   */
  app.post(
    "/api/db-backup/resync",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      if (!deps.getBackupStorage()?.enabled) {
        res.status(404).send({
          error: "Backup database is not configured",
          code: "backup_disabled",
        });
        return;
      }
      try {
        await streamFullBackupOperation(
          res,
          async (sendProgress) => {
            const result = await mirrorFullBackupToBackup(sendProgress);
            backupRuntime.lastFullSyncAt = new Date().toISOString();
            backupRuntime.lastFullSyncError = null;
            return { ...result, lastFullSyncAt: backupRuntime.lastFullSyncAt };
          },
          "Backup full sync failed",
          "backup_sync_failed",
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * @description POST /api/db-backup/restore — 백업 DB 전체를 메인 DB로 복원한다.
   * @description POST /api/db-backup/restore — restore the entire backup database into the main database.
   *
   * @description 진행 상황과 결과를 NDJSON으로 스트리밍한다. 복원은 메인 DB의
   * 상태 자체를 교체하기 때문에, 실행 중 실패가 발생해도 스트림이 이미 시작
   * 되었다면 `error` 타입의 NDJSON 라인으로 전달된다.
   * @description Streams progress and the result as NDJSON. Because a restore
   * replaces the main database's state outright, a mid-run failure is reported
   * as an NDJSON `error` line once the stream has already started.
   */
  app.post(
    "/api/db-backup/restore",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      if (!deps.getBackupStorage()?.enabled) {
        res.status(404).send({
          error: "Backup database is not configured",
          code: "backup_disabled",
        });
        return;
      }
      try {
        await streamFullBackupOperation(
          res,
          restoreBackupToMainDatabase,
          "Backup restore to main failed",
          "backup_restore_failed",
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/db-backup",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
          error:
            "Backup database removal requires HTTPS or a localhost connection",
          code: "secure_transport_required",
        });
        return;
      }
      try {
        await deactivateBackupStorage();
        removeBackupConfig(savePath);
        res.send({ success: true, ...(await getBackupConfigResponse()) });
      } catch (error) {
        next(error);
      }
    },
  );
}
