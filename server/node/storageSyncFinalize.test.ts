import { describe, expect, it, vi } from "vitest";

const {
  StorageSyncFinalizeGate,
  finalizeStorageSyncReplacement,
  preflightStorageSyncFinalize,
} = require("./storageSyncFinalize.cjs");

function summary() {
  return {
    protocolVersion: 1,
    revision: 7,
    initialized: true,
    records: {
      settings: 1,
      characters: 2,
      chats: 3,
      messages: 4,
      total: 10,
    },
    assets: { count: 2, sizeBytes: 30 },
  };
}

function session() {
  return {
    id: "session-1",
    direction: "local-to-remote",
    role: "target",
    status: "sql-ready",
    serverRevision: 7,
    peerRevision: 12,
    summary: summary(),
  } as any;
}
function dependencies(overrides: Record<string, unknown> = {}) {
  const assetStaging = {
    getPlan: vi.fn(() => ({
      remainingBytes: 0,
      assets: [{ state: "skipped" }, { state: "ready" }],
    })),
    verifySkippedAssets: vi.fn(async () => ({ verifiedCount: 1 })),
  };
  const sqlStaging = {
    validate: vi.fn(async () => ({
      sourceRevision: 12,
      recordCount: 25,
    })),
  };
  const sqlStorage = {
    getStorageSyncSummary: vi.fn(async () => ({
      revision: 7,
      initialized: true,
      records: summary().records,
    })),
  };
  const assetStorage = {
    getStats: vi.fn(async () => ({
      totalObjects: summary().assets.count,
      totalSizeBytes: summary().assets.sizeBytes,
    })),
  };
  return {
    assetStaging,
    sqlStaging,
    sqlStorage,
    assetStorage,
    ...overrides,
  } as any;
}
describe("preflightStorageSyncFinalize", () => {
  it("revalidates the target, skipped assets, and SQL stream", async () => {
    const deps = dependencies();
    await expect(
      preflightStorageSyncFinalize({ session: session(), ...deps }),
    ).resolves.toEqual({
      status: "ready",
      targetRevision: 7,
      sourceRevision: 12,
      recordCount: 25,
      skippedAssetsVerified: 1,
    });
    expect(deps.assetStaging.verifySkippedAssets).toHaveBeenCalledOnce();
    expect(deps.sqlStaging.validate).toHaveBeenCalledOnce();
  });

  it("rejects when the active target summary changes", async () => {
    const deps = dependencies();
    deps.assetStorage.getStats.mockResolvedValue({
      totalObjects: 2,
      totalSizeBytes: 31,
    });
    await expect(
      preflightStorageSyncFinalize({ session: session(), ...deps }),
    ).rejects.toMatchObject({ code: "target_changed" });
    expect(deps.assetStaging.verifySkippedAssets).not.toHaveBeenCalled();
  });
  it("rejects when SQL staging is not ready", async () => {
    const deps = dependencies();
    const pending = session();
    pending.status = "receiving-sql";
    await expect(
      preflightStorageSyncFinalize({ session: pending, ...deps }),
    ).rejects.toMatchObject({ code: "sql_not_ready" });
  });

  it("rejects a validated stream from the wrong source revision", async () => {
    const deps = dependencies();
    deps.sqlStaging.validate.mockResolvedValue({
      sourceRevision: 13,
      recordCount: 25,
    });
    await expect(
      preflightStorageSyncFinalize({ session: session(), ...deps }),
    ).rejects.toMatchObject({ code: "source_revision_mismatch" });
  });
});

describe("StorageSyncFinalizeGate", () => {
  it("drains in-flight requests before finalize and rejects a second finalize", async () => {
    const gate = new StorageSyncFinalizeGate();
    const leaveRequest = gate.enterRequest();
    expect(leaveRequest).toBeTypeOf("function");

    const pendingAcquire = gate.acquire("session-a");
    expect(gate.status()).toMatchObject({
      sessionId: "session-a",
      phase: "draining",
      activeRequests: 1,
    });
    await expect(gate.acquire("session-b")).rejects.toThrow(/already running/);
    expect(gate.enterRequest()).toBeNull();

    leaveRequest();
    const release = await pendingAcquire;
    expect(gate.status()).toMatchObject({
      phase: "finalizing",
      activeRequests: 0,
    });
    release();
    expect(gate.isLocked()).toBe(false);

    const releaseB = await gate.acquire("session-b");
    releaseB();
  });
});

function finalizeDependencies(options: { failTransaction?: boolean } = {}) {
  const deps = dependencies();
  const order: string[] = [];
  deps.assetStaging.applyReadyAssets = vi.fn(async () => {
    order.push("assets");
    return { applied: 1 };
  });
  deps.sqlStorage.runStorageSyncFinalizeTransaction = vi.fn(
    async (_revision: number, callback: any) => {
      order.push("transaction");
      if (options.failTransaction) {
        const error = Object.assign(new Error("stale"), { revision: 8 });
        throw error;
      }
      const callbackResult = await callback(
        {},
        {
          currentRevision: 7,
          nextRevision: 8,
          revisionId: 41,
          previousRevisionId: 40,
          databaseInitialized: true,
        },
      );
      return { revision: 8, revisionId: 41, ...callbackResult };
    },
  );
  const recoveryStore = {
    prepare: vi.fn(async () => {
      order.push("recovery");
      return { version: 1, id: "session-1", assets: [] };
    }),
    attachDatabaseRecoveryPoint: vi.fn(() => order.push("db-recovery")),
    read: vi.fn(() => ({ version: 1, id: "session-1", assets: [] })),
    restoreAssets: vi.fn(async () => order.push("restore-assets")),
    promote: vi.fn(async () => order.push("promote")),
  };
  const applySqlRecords = vi.fn(async () => {
    order.push("sql");
    return { applied: 25 };
  });
  return {
    ...deps,
    recoveryStore,
    applySqlRecords,
    gate: new StorageSyncFinalizeGate(),
    order,
  };
}

describe("finalizeStorageSyncReplacement", () => {
  it("promotes recovery only after assets and SQL commit succeed", async () => {
    const deps = finalizeDependencies();
    await expect(
      finalizeStorageSyncReplacement({ session: session(), ...deps }),
    ).resolves.toMatchObject({
      status: "completed",
      revision: 8,
      revisionId: 41,
      assetsApplied: 1,
      recoveryPromoted: true,
    });
    expect(deps.order).toEqual([
      "recovery",
      "assets",
      "transaction",
      "db-recovery",
      "sql",
      "promote",
    ]);
    expect(deps.recoveryStore.restoreAssets).not.toHaveBeenCalled();
    expect(deps.gate.isLocked()).toBe(false);
  });
  it("restores assets and releases the gate when the DB revision loses the race", async () => {
    const deps = finalizeDependencies({ failTransaction: true });
    await expect(
      finalizeStorageSyncReplacement({ session: session(), ...deps }),
    ).rejects.toMatchObject({ code: "target_changed", currentRevision: 8 });
    expect(deps.order).toEqual([
      "recovery",
      "assets",
      "transaction",
      "restore-assets",
    ]);
    expect(deps.recoveryStore.promote).not.toHaveBeenCalled();
    expect(deps.applySqlRecords).not.toHaveBeenCalled();
    expect(deps.gate.isLocked()).toBe(false);
  });
});
