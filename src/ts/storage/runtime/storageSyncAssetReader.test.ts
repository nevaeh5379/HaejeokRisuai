import { describe, expect, it } from "vitest";
import {
  STORAGE_SYNC_ASSET_CHUNK_BYTES,
  StorageSyncAssetReadError,
  buildStorageSyncAssetManifest,
  createStorageSyncAssetReader,
  summarizeStorageSyncAssets,
} from "./storageSyncAssetReader";

class FakeBoundedStorage {
  active = 0;
  maxActive = 0;
  readonly values = new Map([
    ["assets/c.bin", new Uint8Array([3, 3, 3])],
    ["assets/a.bin", new Uint8Array([1, 2, 3, 4])],
    ["assets/b.bin", new Uint8Array([9, 8])],
    ["database/ignored.bin", new Uint8Array([7])],
  ]);

  async listSyncAssetKeys(prefix: string) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async getSyncAssetSize(key: string) {
    return this.values.get(key)!.byteLength;
  }
  async readSyncAssetChunk(key: string, offset: number, length: number) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return this.values.get(key)!.slice(offset, offset + length);
    } finally {
      this.active--;
    }
  }
}

describe("storage sync asset reader", () => {
  it("hashes only the requested asset prefix in deterministic order", async () => {
    const storage = new FakeBoundedStorage();
    const manifest = await buildStorageSyncAssetManifest(
      createStorageSyncAssetReader(storage),
    );
    expect(manifest.map((entry) => entry.key)).toEqual([
      "assets/a.bin",
      "assets/b.bin",
      "assets/c.bin",
    ]);
    expect(manifest.map((entry) => entry.size)).toEqual([4, 2, 3]);
    expect(manifest.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(
      true,
    );
    expect(storage.maxActive).toBeLessThanOrEqual(2);
  });
  it("rejects unsupported legacy browser storage explicitly", () => {
    expect(() =>
      createStorageSyncAssetReader({ keys: async () => [] }),
    ).toThrowError(StorageSyncAssetReadError);
    try {
      createStorageSyncAssetReader({ keys: async () => [] });
    } catch (error) {
      expect((error as StorageSyncAssetReadError).code).toBe(
        "bounded_asset_read_unsupported",
      );
    }
  });

  it("rejects chunks larger than the protocol limit before touching storage", async () => {
    const storage = new FakeBoundedStorage();
    const reader = createStorageSyncAssetReader(storage);
    await expect(
      reader.readChunk("assets/a.bin", 0, STORAGE_SYNC_ASSET_CHUNK_BYTES + 1),
    ).rejects.toMatchObject({ code: "invalid_asset_range" });
    expect(storage.active).toBe(0);
  });
  it("summarizes asset bytes without reading file contents and bounds stat concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const reader = {
      listKeys: async () => [
        "assets/c.bin",
        "other.bin",
        "assets/a.bin",
        "assets/b.bin",
      ],
      getSize: async (key: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return (
          {
            "assets/a.bin": 2,
            "assets/b.bin": 3,
            "assets/c.bin": 5,
          }[key] ?? 0
        );
      },
      readChunk: async () => {
        throw new Error("readChunk should not be called during preview");
      },
    };

    await expect(
      summarizeStorageSyncAssets(reader, "assets/", 2),
    ).resolves.toEqual({
      count: 3,
      sizeBytes: 10,
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });
});
