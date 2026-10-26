import { describe, expect, it, vi } from "vitest";
import type { AssetEntry } from "../serverTypes.ts";
import {
  createAssetCatalogBatch,
  readAssetCatalogBatchSize,
} from "./assetCatalogBatch.ts";

describe("backup asset catalog batch size", () => {
  it.each([undefined, "", "256", " 256 ", "1", "512"])(
    "accepts the default or a positive integer: %s",
    (value) => {
      const warn = vi.fn();
      expect(readAssetCatalogBatchSize(value, warn)).toBe(
        value?.trim() ? Number(value) : 256,
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1.5", "256files", "Infinity", "9007199254740992"])(
    "warns and falls back to 256 for %s",
    (value) => {
      const warn = vi.fn();
      expect(readAssetCatalogBatchSize(value, warn)).toBe(256);
      expect(warn).toHaveBeenCalledOnce();
    },
  );
});

describe("backup asset catalog batching", () => {
  it.each([
    [0, []],
    [255, [255]],
    [256, [256]],
    [257, [256, 1]],
  ] as const)(
    "flushes %i entries without an empty batch",
    async (count, sizes) => {
      const batches: AssetEntry[][] = [];
      const batch = createAssetCatalogBatch(256, async (entries) => {
        batches.push(entries);
      });
      for (let i = 0; i < count; i++) {
        await batch.add({ key: `assets/${i}.png`, size: i });
      }
      expect(batches).toHaveLength(Math.floor(count / 256));
      await batch.flush();
      await batch.flush();
      expect(batches.map((entries) => entries.length)).toEqual(sizes);
      expect(batches.flat()).toEqual(
        Array.from({ length: count }, (_, i) => ({
          key: `assets/${i}.png`,
          size: i,
        })),
      );
    },
  );

  it("records 50,000 assets as 195 full batches and an 80-entry remainder", async () => {
    const sizes: number[] = [];
    const batch = createAssetCatalogBatch(256, async (entries) => {
      sizes.push(entries.length);
    });
    for (let i = 0; i < 50_000; i++) {
      await batch.add({ key: `assets/${i}.png`, size: 1 });
    }
    await batch.flush();
    expect(sizes).toEqual([...Array<number>(195).fill(256), 80]);
  });

  it("uses the configured size and waits for the catalog write", async () => {
    let release!: () => void;
    const write = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const batch = createAssetCatalogBatch(2, write);
    await batch.add({ key: "assets/a.png", size: 1 });
    expect(write).not.toHaveBeenCalled();
    let finished = false;
    const pending = batch.add({ key: "assets/b.png", size: 2 }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await pending;
    expect(finished).toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });

  it("propagates a catalog error without retrying its batch during cleanup", async () => {
    const error = new Error("catalog unavailable");
    const write = vi.fn(async () => {
      throw error;
    });
    const batch = createAssetCatalogBatch(1, write);
    await expect(batch.add({ key: "assets/a.png", size: 1 })).rejects.toBe(
      error,
    );
    await batch.flush();
    expect(write).toHaveBeenCalledOnce();
  });

  it("records late completions immediately after the restore finishes", async () => {
    const write = vi.fn(async () => {});
    const batch = createAssetCatalogBatch(256, write);
    await batch.finish();
    await batch.add({ key: "assets/late.png", size: 1 });
    expect(write).toHaveBeenCalledExactlyOnceWith([
      { key: "assets/late.png", size: 1 },
    ]);
  });
});
