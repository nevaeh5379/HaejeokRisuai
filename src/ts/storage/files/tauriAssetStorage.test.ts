import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 16 },
  SeekMode: { Start: 0, Current: 1, End: 2 },
  ...fsMocks,
}));

import { TauriAssetStorage } from "./tauriAssetStorage";

describe("TauriAssetStorage.setItem", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeFile.mockResolvedValue(undefined);
  });

  it("saves fifty assets on a fresh install after their directory is ready", async () => {
    const files = new Map<string, Uint8Array>();
    let directoryReady = false;
    let finishMkdir!: () => void;
    const mkdirFinished = new Promise<void>((resolve) => {
      finishMkdir = resolve;
    });
    fsMocks.mkdir.mockImplementation(async () => {
      await mkdirFinished;
      directoryReady = true;
    });
    fsMocks.writeFile.mockImplementation(
      async (key: string, data: Uint8Array) => {
        if (!directoryReady)
          throw new Error("ENOENT: assets directory missing");
        files.set(key, data);
      },
    );
    const storage = new TauriAssetStorage();
    const assets = Array.from({ length: 50 }, (_, index) => ({
      key: `assets/hash-${index}.png`,
      data: new Uint8Array([index]),
    }));
    const saves = assets.map(({ key, data }) => storage.setItem(key, data));

    expect(files.size).toBe(0);
    finishMkdir();
    await Promise.all(saves);

    expect(files).toEqual(new Map(assets.map(({ key, data }) => [key, data])));
    expect(fsMocks.mkdir).toHaveBeenCalledWith("assets", {
      baseDir: 16,
      recursive: true,
    });
  });

  it("creates nested directories for restored assets", async () => {
    await new TauriAssetStorage().setItem(
      "assets/nested/avatar.png",
      new Uint8Array([1]),
    );

    expect(fsMocks.mkdir).toHaveBeenCalledWith("assets/nested", {
      baseDir: 16,
      recursive: true,
    });
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "assets/nested/avatar.png",
      new Uint8Array([1]),
      { baseDir: 16 },
    );
  });

  it("propagates directory errors and permits a later retry", async () => {
    const error = new Error("Access denied");
    fsMocks.mkdir.mockRejectedValueOnce(error);
    const storage = new TauriAssetStorage();
    const data = new Uint8Array([1]);

    await expect(storage.setItem("assets/avatar.png", data)).rejects.toBe(
      error,
    );
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    await expect(
      storage.setItem("assets/avatar.png", data),
    ).resolves.toBeUndefined();
    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
  });
});

describe("TauriAssetStorage.hasStoredData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.readDir.mockResolvedValue([]);
  });

  it("does not treat an empty assets directory as existing user data", async () => {
    fsMocks.exists.mockImplementation(
      async (path: string) => path === "assets",
    );

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(false);
  });

  it("detects existing assets", async () => {
    fsMocks.exists.mockImplementation(
      async (path: string) => path === "assets",
    );
    fsMocks.readDir.mockResolvedValue([{ name: "avatar.png" }]);

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(true);
  });

  it.each([
    "database/database.bin",
    "save/database/database.bin",
    "save/database.bin",
  ])("detects the legacy database path %s", async (legacyPath) => {
    fsMocks.exists.mockImplementation(
      async (path: string) => path === legacyPath,
    );

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(true);
  });
  it("recursively lists sync assets and reads a bounded range", async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readDir.mockImplementation(async (path: string) => {
      if (path === "assets") {
        return [
          { name: "root.bin", isFile: true, isDirectory: false },
          { name: "nested", isFile: false, isDirectory: true },
        ];
      }
      return [{ name: "deep.bin", isFile: true, isDirectory: false }];
    });
    fsMocks.stat.mockResolvedValue({ size: 8 });
    const seek = vi.fn().mockResolvedValue(3);
    const close = vi.fn().mockResolvedValue(undefined);
    const chunks = [new Uint8Array([4, 5]), new Uint8Array([6])];
    const read = vi.fn(async (buffer: Uint8Array) => {
      const next = chunks.shift();
      if (!next) return null;
      buffer.set(next);
      return next.length;
    });
    fsMocks.open.mockResolvedValue({ seek, read, close });

    const storage = new TauriAssetStorage();
    await expect(storage.listSyncAssetKeys()).resolves.toEqual([
      "assets/nested/deep.bin",
      "assets/root.bin",
    ]);
    await expect(storage.getSyncAssetSize("assets/root.bin")).resolves.toBe(8);
    await expect(
      storage.readSyncAssetChunk("assets/root.bin", 3, 3),
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(seek).toHaveBeenCalledWith(3, 0);
    expect(close).toHaveBeenCalledOnce();
  });
});
