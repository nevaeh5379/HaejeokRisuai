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
} from "./routes.js";

async function withBackupApi(
  run: (
    baseUrl: string,
    controls: { setSecure: (secure: boolean) => void },
  ) => Promise<void>,
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
    activateBackupStorage: async (): Promise<void> => {},
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
  registerBackupRoutes(app, deps);

  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No TCP address");
    await run(`http://127.0.0.1:${address.port}`, {
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
    const body: { params: { connectionString: string }; lag: number } =
      await response.json();
    expect(response.status).toBe(200);
    expect(body.params.connectionString).toBe(
      "postgres://user:***@localhost/db",
    );
    expect(body.lag).toBe(2);
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
