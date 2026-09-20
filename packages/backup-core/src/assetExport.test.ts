import { describe, expect, it, vi } from "vitest";
import {
  exportNativeBackupAssets,
  exportStoredBackupAssets,
  formatMissingBackupAssets,
  selectBackupAssetKeys,
} from "./assetExport";

describe("backup asset export", (): void => {
  it("filters essential keys through the supplied asset inventory", (): void => {
    const assetMap = new Map([
      ["assets/avatar.png", { charName: "A", assetName: "Avatar" }],
    ]);
    expect(
      selectBackupAssetKeys(
        ["assets/avatar.png", "assets/unused.png", "assets/audio.mp3"],
        "essential",
        assetMap,
      ),
    ).toEqual(["assets/avatar.png"]);
  });

  it("writes native assets in bounded batches", async (): Promise<void> => {
    const batches: string[][] = [];
    const progress = vi.fn();
    const missing: string[] = await exportNativeBackupAssets({
      keys: ["a", "b", "c"],
      batchSize: 2,
      async writeBatch(keys: string[]): Promise<{ missing: string[] }> {
        batches.push(keys);
        return { missing: keys.includes("b") ? ["b"] : [] };
      },
      onProgress: progress,
    });

    expect(batches).toEqual([["a", "b"], ["c"]]);
    expect(missing).toEqual(["b"]);
    expect(progress).toHaveBeenLastCalledWith({ current: 3, total: 3 });
  });

  it("prefers cached data and delays only uncached reads", async (): Promise<void> => {
    const writes: string[] = [];
    const delay = vi.fn(async (): Promise<void> => undefined);
    const missing: string[] = await exportStoredBackupAssets({
      keys: ["cached", "stored", "missing"],
      readCached: async (key: string): Promise<Uint8Array | undefined> =>
        key === "cached" ? new Uint8Array([1]) : undefined,
      read: async (key: string): Promise<Uint8Array | undefined> =>
        key === "stored" ? new Uint8Array([2]) : undefined,
      write: async (key: string): Promise<void> => {
        writes.push(key);
      },
      delay,
      delayAfterUncachedMs: 5,
    });

    expect(writes).toEqual(["cached", "stored"]);
    expect(missing).toEqual(["missing"]);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("formats missing assets with inventory metadata", (): void => {
    const result = formatMissingBackupAssets(
      ["assets/avatar.png", "assets/unknown.png"],
      new Map([
        ["assets/avatar.png", { charName: "Alice", assetName: "Profile" }],
      ]),
      false,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Profile");
    expect(result.message).toContain("Alice");
    expect(result.message).toContain("Unknown Asset");
  });
});
