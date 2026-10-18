// @vitest-environment node

import { once } from "node:events";
import type { Server } from "node:http";
import express, { type Express } from "express";
import { expect, test } from "vitest";
import {
  registerBackupRoutes,
  type BackupConfig,
  type BackupProgress,
  type BackupRouteDependencies,
  type BackupStorage,
  type MaskedBackupParams,
} from "./routes.ts";

async function withBackupApi(
  run: (
    baseUrl: string,
    controls: {
      setSecure: (secure: boolean) => void;
      deps: BackupRouteDependencies;
    },
  ) => Promise<void>,
  configure?: (deps: BackupRouteDependencies) => void,
): Promise<void> {
  const app: Express = express();
  app.use(express.json());

  let secure: boolean = true;
  let config: BackupConfig = {
    vendor: "postgres",
    enabled: true,
    poolMax: 10,
    params: { connectionString: "postgres://user:secret@localhost/db" },
    mirroring: { enabled: true },
    snapshot: { enabled: false, intervalMinutes: 60 },
  };
  const activeStorage: BackupStorage = {
    enabled: true,
    getState: async (): Promise<{
      revision: number;
      initialized: boolean;
    }> => ({
      revision: 8,
      initialized: true,
    }),
  };
  let storage: BackupStorage | null = activeStorage;
  const deps: BackupRouteDependencies = {
    limiter: (_req, _res, next): void => next(),
    checkAuth: async (): Promise<boolean> => true,
    isSecureConfigRequest: (): boolean => secure,
    getPrimaryStorage: () => ({
      enabled: true,
      getState: async (): Promise<{
        revision: number;
        initialized: boolean;
      }> => ({
        revision: 10,
        initialized: true,
      }),
    }),
    getBackupStorage: (): BackupStorage | null => storage,
    setBackupStorage: (nextStorage: null): void => {
      storage = nextStorage;
    },
    getBackupConfig: (): BackupConfig => config,
    setBackupConfig: (nextConfig: BackupConfig): void => {
      config = nextConfig;
    },
    runtime: {
      initialized: true,
      lastMirrorAt: null,
      lastMirrorError: null,
      lastSnapshotAt: null,
      lastSnapshotError: null,
      lastFullSyncAt: null,
      lastFullSyncError: null,
      inFlight: false,
    },
    savePath: "/unused",
    maskPostgresConnectionString: (): string =>
      "postgres://user:***@localhost/db",
    supportedVendors: ["postgres"],
    testConnection: async (): Promise<{ success: boolean }> => ({
      success: true,
    }),
    normalizeVendorParams: (): BackupConfig["params"] => config.params,
    isVendorConfigComplete: (): boolean => true,
    applyBackupConfig: () => ({ backup: config, storage: activeStorage }),
    activateBackupStorage: async (nextStorage): Promise<void> => {
      storage = nextStorage;
    },
    syncBackupSnapshotTimer: (): void => {},
    enqueueBackupWrite: async <T>(task: () => Promise<T>): Promise<T> => task(),
    mirrorFullBackupToBackup: async (
      onProgress?: (event: BackupProgress) => void,
    ): Promise<{ success: boolean; settingsCount: number }> => {
      onProgress?.({ stage: "reading", percentage: 10 });
      return { success: true, settingsCount: 2 };
    },
    restoreBackupToMainDatabase: async (
      onProgress?: (event: BackupProgress) => void,
    ): Promise<{ success: boolean; settingsCount: number }> => {
      onProgress?.({ stage: "reading", percentage: 10 });
      return { success: true, settingsCount: 2 };
    },
    deactivateBackupStorage: async (): Promise<void> => {
      storage = null;
    },
    removeBackupConfig: (): void => {
      config = { ...config, enabled: false };
    },
    StoragePayloadError: Error,
  };
  configure?.(deps);
  registerBackupRoutes(app, deps);

  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No TCP address");
    await run(`http://127.0.0.1:${address.port}`, {
      deps,
      setSecure: (nextSecure: boolean): void => {
        secure = nextSecure;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject): void => {
      server.close((error?: Error): void =>
        error ? reject(error) : resolve(),
      );
    });
  }
}

test("설정 조회는 비밀번호를 가리고 revision 차이를 반환한다 / status masks credentials and reports revision lag", async (): Promise<void> => {
  await withBackupApi(async (baseUrl: string): Promise<void> => {
    const response: Response = await fetch(`${baseUrl}/api/db-backup`);
    const body: { params: MaskedBackupParams.Postgres; lag: number } =
      await response.json();
    expect(body).toMatchInlineSnapshot(`
      {
        "backupInitialized": true,
        "backupRevision": 8,
        "configured": true,
        "enabled": true,
        "inFlight": false,
        "lag": 2,
        "lastFullSyncAt": null,
        "lastFullSyncError": null,
        "lastMirrorAt": null,
        "lastMirrorError": null,
        "lastSnapshotAt": null,
        "lastSnapshotError": null,
        "managedByEnvironment": false,
        "mirroring": {
          "enabled": true,
        },
        "params": {
          "connectionString": "postgres://user:***@localhost/db",
          "poolMax": 10,
        },
        "primaryRevision": 10,
        "snapshot": {
          "enabled": false,
          "intervalMinutes": 60,
        },
        "vendor": "postgres",
      }
    `);
    expect(response.status).toBe(200);
    expect(body.params.connectionString).toBe(
      "postgres://user:***@localhost/db",
    );
    expect(body.lag).toBe(2);
  });
});

test("미설정 상태에서는 params가 null로 반환된다 / unconfigured status returns null params", async (): Promise<void> => {
  await withBackupApi(async (baseUrl: string): Promise<void> => {
    const deleteRes: Response = await fetch(`${baseUrl}/api/db-backup`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const body: { configured: boolean; params: MaskedBackupParams | null } =
      await deleteRes.json();
    expect(body.configured).toBe(false);
    expect(body.params).toBeNull();
  });
});

test("설정 변경에는 안전한 연결을 요구한다 / configuration requires a secure connection", async (): Promise<void> => {
  await withBackupApi(async (baseUrl: string, controls): Promise<void> => {
    controls.setSecure(false);
    const response: Response = await fetch(`${baseUrl}/api/db-backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor: "postgres", params: {} }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "secure_transport_required",
    });
  });
});

test("비동기 설정 저장 후 백업 저장소를 활성화한다 / awaits async configuration before activating storage", async (): Promise<void> => {
  let appliedConfig: BackupConfig;
  let activatedStorage: BackupStorage | undefined;
  const nextStorage: BackupStorage = {
    enabled: true,
    getState: async () => ({ revision: 10, initialized: true }),
  };
  await withBackupApi(
    async (baseUrl, { deps }): Promise<void> => {
      const response = await fetch(`${baseUrl}/api/db-backup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor: "postgres", params: {} }),
      });

      expect(response.status).toBe(200);
      expect(activatedStorage).toBe(nextStorage);
      expect(deps.getBackupConfig()).toBe(appliedConfig);
      expect(await response.json()).toMatchObject({
        success: true,
        enabled: true,
        backupRevision: 10,
        lag: 0,
        snapshot: { enabled: true, intervalMinutes: 120 },
      });
    },
    (deps) => {
      appliedConfig = {
        ...deps.getBackupConfig(),
        snapshot: { enabled: true, intervalMinutes: 120 },
      };
      const activateBackupStorage = deps.activateBackupStorage;
      deps.applyBackupConfig = async () => ({
        backup: appliedConfig,
        storage: nextStorage,
      });
      deps.activateBackupStorage = async (storage) => {
        activatedStorage = storage;
        await activateBackupStorage(storage);
      };
    },
  );
});

test("전체 백업은 진행과 완료 NDJSON을 보낸다 / resync streams progress and completion", async (): Promise<void> => {
  await withBackupApi(async (baseUrl: string): Promise<void> => {
    const response: Response = await fetch(`${baseUrl}/api/db-backup/resync`, {
      method: "POST",
    });
    const frames: Array<{
      type: string;
      stage?: string;
      settingsCount?: number;
    }> = (await response.text())
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(response.status).toBe(200);
    expect(frames).toMatchObject([
      { type: "progress", stage: "reading" },
      { type: "done", settingsCount: 2 },
    ]);
  });
});
