import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
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
