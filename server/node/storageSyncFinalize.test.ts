import { describe, expect, it, vi } from "vitest";

const { preflightStorageSyncFinalize } = require("./storageSyncFinalize.cjs");

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
