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

  function maskBackupParams(
    vendor: BackupVendor | null,
    params: BackupParams = {},
  ): MaskedBackupParams {
    const masked: MaskedBackupParams = {};
    if (vendor === "postgres") {
      masked.connectionString = maskPostgresConnectionString(
        params.connectionString || "",
      );
      masked.poolMax = params.poolMax || 10;
    } else if (vendor === "oracle") {
      masked.user = params.user || "";
      masked.tnsAlias = params.tnsAlias || "";
      masked.walletPath = params.walletPath || "";
      masked.poolMax = params.poolMax || 10;
      masked.hasPassword = Boolean(params.password);
      masked.hasWalletPassword = Boolean(params.walletPassword);
    } else if (vendor === "azure") {
      masked.server = params.server || "";
      masked.database = params.database || "";
      masked.user = params.user || "";
      masked.port = params.port || 1433;
      masked.poolMax = params.poolMax || 10;
      masked.hasPassword = Boolean(params.password);
    }
    return masked;
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
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");

        const sendProgress: (event: BackupProgress) => void = (
          event: BackupProgress,
        ): void => {
          if (res.writableEnded || res.closed) return;
          res.write(JSON.stringify({ type: "progress", ...event }) + "\n");
        };

        const result: BackupResult | null = await enqueueBackupWrite(
          () =>
            mirrorFullBackupToBackup(sendProgress).then((r: BackupResult) => {
              backupRuntime.lastFullSyncAt = new Date().toISOString();
              backupRuntime.lastFullSyncError = null;
              return r;
            }),
          "full",
        );

        res.write(
          JSON.stringify({
            type: "done",
            success: true,
            ...(result || {}),
            lastFullSyncAt: backupRuntime.lastFullSyncAt,
          }) + "\n",
        );
        res.end();
      } catch (error) {
        if (!res.headersSent) {
          res.status(502).send({
            success: false,
            error: errorMessage(error, "Backup full sync failed"),
            code: "backup_sync_failed",
          });
        } else {
          res.write(
            JSON.stringify({
              type: "error",
              error: errorMessage(error, "Backup full sync failed"),
              code: "backup_sync_failed",
            }) + "\n",
          );
          res.end();
        }
      }
    },
  );

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
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");

        const sendProgress: (event: BackupProgress) => void = (
          event: BackupProgress,
        ): void => {
          if (res.writableEnded || res.closed) return;
          res.write(JSON.stringify({ type: "progress", ...event }) + "\n");
        };

        const result: BackupResult | null = await enqueueBackupWrite(
          () => restoreBackupToMainDatabase(sendProgress),
          "full",
        );

        res.write(
          JSON.stringify({
            type: "done",
            success: true,
            ...(result || {}),
          }) + "\n",
        );
        res.end();
      } catch (error) {
        if (!res.headersSent) {
          res.status(502).send({
            success: false,
            error: errorMessage(error, "Backup restore to main failed"),
            code: "backup_restore_failed",
          });
        } else {
          res.write(
            JSON.stringify({
              type: "error",
              error: errorMessage(error, "Backup restore to main failed"),
              code: "backup_restore_failed",
            }) + "\n",
          );
          res.end();
        }
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
