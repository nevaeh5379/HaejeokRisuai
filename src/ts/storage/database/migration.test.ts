// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../sql/ISqlStorage";

const forageStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock("../../platform", () => ({
  isTauri: false,
  isNodeServer: false,
  isCapacitor: false,
  isWeb: true,
}));
vi.mock("../../globalApi.svelte", () => ({ forageStorage }));

import { migrateLegacyDatabase } from "./migration";

describe("legacy SQL migration data safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forageStorage.getItem.mockResolvedValue(null);
  });

  it("does not retire the legacy source when replaceDatabase returns false", async () => {
    const storage = {
      replaceDatabase: vi.fn(async () => false),
    } as unknown as ISqlStorage;
    forageStorage.getItem.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await expect(
      migrateLegacyDatabase(storage, { characters: [] } as any),
    ).resolves.toBe(false);
    expect(forageStorage.setItem).not.toHaveBeenCalled();
    expect(forageStorage.removeItem).not.toHaveBeenCalled();
  });

  it("does not retire the legacy source when SQL replacement throws", async () => {
    const storage = {
      replaceDatabase: vi.fn(async () => {
        throw new Error("transaction rolled back");
      }),
    } as unknown as ISqlStorage;

    await expect(
      migrateLegacyDatabase(storage, { characters: [] } as any),
    ).resolves.toBe(false);
    expect(forageStorage.removeItem).not.toHaveBeenCalled();
  });

  it("retires the legacy source only after a successful replacement", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    forageStorage.getItem.mockImplementation(async (key: string) =>
      key === "database/database.bin" ? bytes : null,
    );
    const storage = {
      replaceDatabase: vi.fn(async () => true),
    } as unknown as ISqlStorage;

    await expect(
      migrateLegacyDatabase(storage, { characters: [] } as any),
    ).resolves.toBe(true);
    expect(forageStorage.setItem).toHaveBeenCalledWith(
      "database/database.bin.migrated",
      bytes,
    );
    expect(forageStorage.removeItem).toHaveBeenCalledWith(
      "database/database.bin",
    );
  });
});
