import { describe, expect, it, vi } from "vitest";

const {
  STORAGE_SYNC_PROTOCOL_VERSION,
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
});
