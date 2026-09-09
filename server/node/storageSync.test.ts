import { describe, expect, it, vi } from "vitest";

const {
  STORAGE_SYNC_PROTOCOL_VERSION,
  STORAGE_SYNC_CHUNK_SIZE_BYTES,
  STORAGE_SYNC_MAX_CONCURRENCY,
  StorageSyncRevisionConflictError,
  StorageSyncSessionManager,
  createStorageSyncSummary,
} = require("./storageSync.cjs");

describe("storage sync summary", () => {
  it("combines database revision, record counts, and asset stats", async () => {
    const sqlStorage = {
      getStorageSyncSummary: vi.fn(async () => ({
        revision: 17,
        initialized: true,
        records: {
          settings: 10,
          characters: 3,
          chats: 9,
          messages: 42,
          total: 64,
        },
      })),
    };
    const assetStorage = {
      getStats: vi.fn(async () => ({
        storageType: "fs",
        totalObjects: 12,
        totalSizeBytes: 4096,
      })),
    };

    await expect(
      createStorageSyncSummary(sqlStorage, assetStorage),
    ).resolves.toEqual({
      protocolVersion: STORAGE_SYNC_PROTOCOL_VERSION,
      revision: 17,
      initialized: true,
      records: {
        settings: 10,
        characters: 3,
        chats: 9,
        messages: 42,
        total: 64,
      },
      assets: { count: 12, sizeBytes: 4096 },
    });
  });

  it("normalizes malformed counters instead of exposing invalid sizes", async () => {
    const summary = await createStorageSyncSummary(
      {
        getStorageSyncSummary: async () => ({
          revision: -1,
          initialized: false,
          records: { settings: NaN, characters: 1.5, chats: -2 },
        }),
      },
      {
        getStats: async () => ({ totalObjects: "4", totalSizeBytes: -10 }),
      },
    );

    expect(summary.revision).toBe(0);
    expect(summary.records).toEqual({
      settings: 0,
      characters: 0,
      chats: 0,
      messages: 0,
      total: 0,
    });
    expect(summary.assets).toEqual({ count: 4, sizeBytes: 0 });
  });

  it("creates revision-pinned sessions with bounded transfer limits", () => {
    const manager = new StorageSyncSessionManager({
      randomId: () => "sync-session-1",
      now: () => 1000,
    });
    const session = manager.create({
      direction: "local-to-remote",
      expectedRevision: 7,
      peerRevision: 3,
      summary: { revision: 7 },
    });
    expect(session).toMatchObject({
      id: "sync-session-1",
      direction: "local-to-remote",
      role: "target",
      serverRevision: 7,
      peerRevision: 3,
      chunkSizeBytes: STORAGE_SYNC_CHUNK_SIZE_BYTES,
      maxConcurrency: STORAGE_SYNC_MAX_CONCURRENCY,
    });
    expect(manager.get(session.id)).toBe(session);
  });

  it("rejects a session when the server revision changed after preview", () => {
    const manager = new StorageSyncSessionManager();
    expect(() =>
      manager.create({
        direction: "remote-to-local",
        expectedRevision: 4,
        summary: { revision: 5 },
      }),
    ).toThrow(StorageSyncRevisionConflictError);
  });

  it("expires and cancels sessions without touching active storage", () => {
    let now = 10;
    const manager = new StorageSyncSessionManager({
      randomId: () => "session",
      now: () => now,
    });
    const session = manager.create({
      direction: "remote-to-local",
      expectedRevision: 1,
      summary: { revision: 1 },
    });
    expect(manager.cancel(session.id)?.status).toBe("cancelled");
    expect(manager.get(session.id)).toBeNull();

    manager.create({
      direction: "remote-to-local",
      expectedRevision: 1,
      summary: { revision: 1 },
    });
    now = Number.MAX_SAFE_INTEGER;
    expect(manager.get("session")).toBeNull();
  });

  it("restores persisted sessions and invokes persistence callbacks", () => {
    const created = [];
    const expired = [];
    let now = 1000;
    const restored = {
      id: "restored",
      direction: "local-to-remote",
      role: "target",
      status: "created",
      serverRevision: 2,
      peerRevision: 1,
      summary: { revision: 2 },
      createdAt: 500,
      expiresAt: 2000,
      chunkSizeBytes: STORAGE_SYNC_CHUNK_SIZE_BYTES,
      maxConcurrency: STORAGE_SYNC_MAX_CONCURRENCY,
      needsHydration: true,
    };
    const manager = new StorageSyncSessionManager({
      initialSessions: [restored],
      randomId: () => "new-session",
      now: () => now,
      onCreate: (session) => created.push(session.id),
      onExpire: (id) => expired.push(id),
    });
    expect(manager.get("restored")).toBe(restored);
    manager.create({
      direction: "local-to-remote",
      expectedRevision: 3,
      summary: { revision: 3 },
    });
    expect(created).toEqual(["new-session"]);
    now = 3000;
    expect(manager.get("restored")).toBeNull();
    expect(expired).toContain("restored");
  });

});
