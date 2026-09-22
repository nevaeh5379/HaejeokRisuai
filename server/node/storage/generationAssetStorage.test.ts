import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  GenerationAssetStorage,
  type GenerationAssetBackend,
} from "./generationAssetStorage.js";

const roots: string[] = [];

function keyToHex(key: string): string {
  return Buffer.from(key, "utf8").toString("hex");
}

function hexToKey(key: string): string {
  return Buffer.from(key, "hex").toString("utf8");
}

class MemoryBackend implements GenerationAssetBackend {
  readonly type = "s3";
  readonly objects = new Map<string, Uint8Array>();
  writeCount = 0;

  async read(hexPath: string) {
    const value = this.objects.get(hexToKey(hexPath));
    return value
      ? { exists: true, buffer: value, contentLength: value.length }
      : { exists: false };
  }

  async openReadStream(hexPath: string) {
    return await this.read(hexPath);
  }

  async write(hexPath: string, content: Uint8Array) {
    this.writeCount++;
    this.objects.set(hexToKey(hexPath), new Uint8Array(content));
    return { success: true };
  }

  async writeFromPath(hexPath: string, sourcePath: string) {
    return await this.write(
      hexPath,
      new Uint8Array(await fs.readFile(sourcePath)),
    );
  }

  createWriteStream(hexPath: string) {
    const key = hexToKey(hexPath);
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolveDone, rejectDone) => {
      stream.once("finish", () => {
        this.writeCount++;
        this.objects.set(key, Buffer.concat(chunks));
        resolveDone();
      });
      stream.once("error", rejectDone);
    });
    return {
      stream,
      done: async () => await done,
      abort: async () => {
        stream.destroy();
        this.objects.delete(key);
      },
    };
  }

  async remove(hexPaths: string | string[]) {
    for (const hex of Array.isArray(hexPaths) ? hexPaths : [hexPaths]) {
      this.objects.delete(hexToKey(hex));
    }
    return { success: true };
  }

  async list(prefix = "") {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async exists(hexPath: string) {
    return this.objects.has(hexToKey(hexPath));
  }

  async getAssetDetails() {
    const assets = [...this.objects].map(([key, value]) => ({
      key,
      size: value.length,
      mtime: 0,
    }));
    return {
      storageType: this.type,
      totalObjects: assets.length,
      totalSizeBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
      assets,
    };
  }
}

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-generation-"));
  roots.push(root);
  const backend = new MemoryBackend();
  const storage = new GenerationAssetStorage(
    root,
    () => backend,
    () => "s3:test-bucket",
  );
  return { root, backend, storage };
}

async function writeGeneration(
  storage: GenerationAssetStorage,
  id: string,
  key: string,
  bytes: number[],
): Promise<void> {
  const writer = await storage.openGenerationWriter(id, key, bytes.length);
  for (const byte of bytes) await writer.write(Uint8Array.of(byte));
  await writer.close();
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("GenerationAssetStorage", () => {
  it("writes a shadow generation once and exposes it only on activation", async () => {
    const { backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_001", "assets/new.bin", [1, 2, 3]);

    expect(await storage.list("assets/")).toEqual(["assets/old.bin"]);
    expect((await storage.read(keyToHex("assets/new.bin"))).exists).toBe(false);
    expect(backend.writeCount).toBe(1);

    await storage.beginActivation("restore_001", 8, "db:test");
    expect(await storage.list("assets/")).toEqual(["assets/old.bin"]);
    await storage.commitActivation("restore_001", 8);
    expect(await storage.list("assets/")).toEqual(["assets/new.bin"]);
    expect([
      ...((await storage.read(keyToHex("assets/new.bin"))).buffer ?? []),
    ]).toEqual([1, 2, 3]);
    expect(backend.writeCount).toBe(1);
  });

  it("rolls back a pending activation without changing legacy assets", async () => {
    const { backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_002", "assets/new.bin", [1]);
    await storage.beginActivation("restore_002", 3, "db:test");
    await storage.rollbackActivation("restore_002");
    await storage.discardGeneration("restore_002");

    expect(await storage.list("assets/")).toEqual(["assets/old.bin"]);
    expect(
      [...backend.objects.keys()].some((key) => key.includes("restore_002")),
    ).toBe(false);
  });

  it("does not expose inactive generation objects or thumbnails", async () => {
    const { backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    backend.objects.set(
      "__restore_generations/restore_008/assets/new.png",
      Uint8Array.of(1),
    );
    backend.objects.set(
      "thumbnails/__restore_generations/restore_008/assets/new.png_128x128.webp",
      Uint8Array.of(2),
    );

    expect(await storage.list()).toEqual(["assets/old.bin"]);
    await expect(storage.getAssetDetails()).resolves.toMatchObject({
      totalObjects: 1,
      assets: [{ key: "assets/old.bin" }],
    });
  });

  it("reconciles a crash journal from the committed database revision", async () => {
    const { root, backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_003", "assets/new.bin", [2]);
    await storage.beginActivation("restore_003", 5, "db:test");

    const restarted = new GenerationAssetStorage(
      root,
      () => backend,
      () => "s3:test-bucket",
    );
    await restarted.reconcile(5, "db:test");
    expect(restarted.activeGeneration).toBe("restore_003");
    expect(await restarted.list("assets/")).toEqual(["assets/new.bin"]);
  });

  it("reconciles an uncommitted database revision by restoring the old pointer", async () => {
    const { root, backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_004", "assets/new.bin", [2]);
    await storage.beginActivation("restore_004", 5, "db:test");

    const restarted = new GenerationAssetStorage(
      root,
      () => backend,
      () => "s3:test-bucket",
    );
    await restarted.reconcile(4, "db:test");
    expect(restarted.activeGeneration).toBeNull();
    expect(await restarted.list("assets/")).toEqual(["assets/old.bin"]);
    expect(
      [...backend.objects.keys()].some((key) => key.includes("restore_004")),
    ).toBe(false);
  });

  it("preserves both generations while the database revision is unknown", async () => {
    const { root, backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_006", "assets/new.bin", [2]);
    await storage.beginActivation("restore_006", 5, "db:test");

    const restarted = new GenerationAssetStorage(
      root,
      () => backend,
      () => "s3:test-bucket",
    );
    await restarted.reconcile(null, "db:test");
    expect(restarted.activeGeneration).toBeNull();
    expect(await restarted.list("assets/")).toEqual(["assets/old.bin"]);
    expect(
      [...backend.objects.keys()].some((key) => key.includes("restore_006")),
    ).toBe(true);

    await restarted.reconcile(5, "db:test");
    expect(restarted.activeGeneration).toBe("restore_006");
  });

  it("rejects a pending generation created for a different database", async () => {
    const { root, backend, storage } = await harness();
    backend.objects.set("assets/old.bin", Uint8Array.of(9));
    await writeGeneration(storage, "restore_007", "assets/new.bin", [2]);
    await storage.beginActivation("restore_007", 5, "db:old");

    const restarted = new GenerationAssetStorage(
      root,
      () => backend,
      () => "s3:test-bucket",
    );
    await restarted.reconcile(5, "db:new");
    expect(restarted.activeGeneration).toBeNull();
    expect(await restarted.list("assets/")).toEqual(["assets/old.bin"]);
    expect(
      [...backend.objects.keys()].some((key) => key.includes("restore_007")),
    ).toBe(false);
  });

  it("keeps migration and rollback in the active logical generation", async () => {
    const { root, backend, storage } = await harness();
    await writeGeneration(storage, "restore_005", "assets/kept.bin", [8]);
    await storage.beginActivation("restore_005", 6, "db:test");
    await storage.commitActivation("restore_005", 6);

    const sourceKey = "assets/migrated.bin";
    await fs.writeFile(
      path.join(root, keyToHex(sourceKey)),
      Buffer.from([1, 2]),
    );
    await expect(storage.migrateFromLocal(root)).resolves.toMatchObject({
      migrated: 1,
    });
    expect(
      [...backend.objects.keys()].some(
        (key) => key === `__restore_generations/restore_005/${sourceKey}`,
      ),
    ).toBe(true);

    const rollback = await fs.mkdtemp(path.join(os.tmpdir(), "risu-rollback-"));
    roots.push(rollback);
    await expect(storage.rollbackToLocal(rollback)).resolves.toMatchObject({
      downloaded: 2,
    });
    await expect(
      fs.readFile(path.join(rollback, keyToHex(sourceKey))),
    ).resolves.toEqual(Buffer.from([1, 2]));
    expect(
      (await fs.readdir(rollback)).some((name) =>
        hexToKey(name).startsWith("__restore_generations/"),
      ),
    ).toBe(false);
  });
});
