import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyToHex, LocalFsStorage } from "./assetStorage.ts";
import { createAssetCatalogBatch } from "./assetCatalogBatch.ts";
import { openDirectRestoreAsset } from "./localBackupAssetRestore.ts";

let root: string;
let storage: LocalFsStorage;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-catalog-restore-"));
  storage = new LocalFsStorage(root);
  await storage.init();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("local backup asset catalog recording", () => {
  it("records a file that finishes saving after cancellation flushed the batch", async () => {
    let release!: () => void;
    let markStored!: () => void;
    const stored = new Promise<void>((resolve) => (markStored = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    const create = storage.createWriteStream.bind(storage);
    vi.spyOn(storage, "createWriteStream").mockImplementation((...args) => {
      const writer = create(...args);
      return {
        ...writer,
        async done() {
          await writer.done();
          markStored();
          await resume;
        },
      };
    });
    const write = vi.fn(async () => {});
    const batch = createAssetCatalogBatch(256, write);
    const asset = await openDirectRestoreAsset(
      storage,
      "assets/late.png",
      1,
      batch.add,
    );
    await asset.write(new Uint8Array([4]));
    const closing = asset.close();
    await stored;
    await batch.finish();
    release();
    await closing;
    expect(write).toHaveBeenCalledExactlyOnceWith([
      { key: "assets/late.png", size: 1 },
    ]);
  });

  it("records only completed files and flushes the remaining metadata", async () => {
    const write = vi.fn(async () => {});
    const batch = createAssetCatalogBatch(256, write);
    const asset = await openDirectRestoreAsset(
      storage,
      "assets/a.png",
      2,
      batch.add,
    );
    await asset.write(new Uint8Array([1, 2]));
    await batch.flush();
    expect(write).not.toHaveBeenCalled();
    await asset.close();
    expect(write).not.toHaveBeenCalled();
    await batch.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith([
      { key: "assets/a.png", size: 2 },
    ]);
    expect(
      await fs.readFile(path.join(root, keyToHex("assets/a.png"))),
    ).toEqual(Buffer.from([1, 2]));
  });

  it("propagates a catalog error without aborting or deleting a completed file", async () => {
    const error = new Error("catalog write failed");
    const onStored = vi.fn(async () => {
      throw error;
    });
    const asset = await openDirectRestoreAsset(
      storage,
      "assets/a.png",
      1,
      onStored,
    );
    await asset.write(new Uint8Array([3]));
    await expect(asset.close()).rejects.toBe(error);
    await asset.abort();
    expect(
      await fs.readFile(path.join(root, keyToHex("assets/a.png"))),
    ).toEqual(Buffer.from([3]));
    expect(onStored).toHaveBeenCalledOnce();
  });

  it("does not record an incomplete file", async () => {
    const onStored = vi.fn(async () => {});
    const asset = await openDirectRestoreAsset(
      storage,
      "assets/a.png",
      2,
      onStored,
    );
    await asset.write(new Uint8Array([1]));
    await expect(asset.close()).rejects.toThrow("size mismatch");
    expect(onStored).not.toHaveBeenCalled();
  });

  it("does not record a file when destination completion fails", async () => {
    const error = new Error("storage unavailable");
    const create = storage.createWriteStream.bind(storage);
    vi.spyOn(storage, "createWriteStream").mockImplementation((...args) => {
      const writer = create(...args);
      return {
        ...writer,
        async done() {
          await writer.done();
          throw error;
        },
      };
    });
    const onStored = vi.fn(async () => {});
    const asset = await openDirectRestoreAsset(
      storage,
      "assets/a.png",
      1,
      onStored,
    );
    await asset.write(new Uint8Array([1]));
    await expect(asset.close()).rejects.toBe(error);
    expect(onStored).not.toHaveBeenCalled();
  });

  it("can record completed files after cancellation without recording the current file", async () => {
    const write = vi.fn(async () => {});
    const batch = createAssetCatalogBatch(256, write);
    const saved = await openDirectRestoreAsset(
      storage,
      "assets/a.png",
      1,
      batch.add,
    );
    await saved.write(new Uint8Array([1]));
    await saved.close();
    const pending = await openDirectRestoreAsset(
      storage,
      "assets/b.png",
      2,
      batch.add,
    );
    await pending.write(new Uint8Array([2]));
    await pending.abort();
    await batch.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith([
      { key: "assets/a.png", size: 1 },
    ]);
  });
});
