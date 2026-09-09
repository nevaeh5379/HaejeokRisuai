import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 16 },
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
    fsMocks.exists.mockImplementation(async (path: string) => path === "assets");

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(false);
  });

  it("detects existing assets", async () => {
    fsMocks.exists.mockImplementation(async (path: string) => path === "assets");
    fsMocks.readDir.mockResolvedValue([{ name: "avatar.png" }]);

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(true);
  });

  it.each([
    "database/database.bin",
    "save/database/database.bin",
    "save/database.bin",
  ])("detects the legacy database path %s", async (legacyPath) => {
    fsMocks.exists.mockImplementation(async (path: string) => path === legacyPath);

    await expect(new TauriAssetStorage().hasStoredData()).resolves.toBe(true);
  });
});
