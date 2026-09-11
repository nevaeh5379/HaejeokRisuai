import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = {
    isEnabled: vi.fn(() => true),
    getColdStorageItem: vi.fn(),
    setColdStorageItem: vi.fn(),
    listColdStorageItems: vi.fn(),
    pruneColdStorage: vi.fn(),
    removeColdStorageItems: vi.fn(),
  };
  const storage = {
    sql,
    getItem: vi.fn(),
    setItem: vi.fn(),
    keys: vi.fn(),
    removeItem: vi.fn(),
  };
  return {
    sql,
    storage,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readDir: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    alertClear: vi.fn(),
  };
});

vi.mock("../globalApi.svelte", () => ({
  forageStorage: { realStorage: mocks.storage },
}));

vi.mock("src/ts/platform", () => ({
  isNodeServer: false,
  isTauri: true,
}));

vi.mock("../storage/files/nodeStorage", () => ({
  NodeStorage: class NodeStorage {
    static [Symbol.hasInstance](instance: unknown) {
      return instance === mocks.storage;
    }
  },
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: "AppData" },
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  readDir: mocks.readDir,
  mkdir: mocks.mkdir,
  remove: mocks.remove,
}));

vi.mock("../stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));

vi.mock("../alert", () => ({
  alertClear: mocks.alertClear,
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertWait: vi.fn(),
}));

vi.mock("src/lang", () => ({
  language: { errors: {} },
}));

import {
  cleanColdStorage,
  collectColdStorageBackupPayloads,
  getColdStorageItem,
  listColdStorageItems,
  setColdStorageItem,
} from "./coldstorage.svelte";

describe("cold storage backend routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.isEnabled.mockReturnValue(true);
  });

  it("uses the active remote SQL backend in Tauri", async () => {
    const value = { character: { chaId: "remote-character" } };
    mocks.sql.getColdStorageItem.mockResolvedValue(value);
    mocks.sql.setColdStorageItem.mockResolvedValue(true);
    mocks.sql.listColdStorageItems.mockResolvedValue({ items: ["remote-key"] });

    await expect(getColdStorageItem("remote-key")).resolves.toBe(value);
    await expect(setColdStorageItem("remote-key", value)).resolves.toBe(true);
    await expect(listColdStorageItems()).resolves.toEqual({
      items: ["remote-key"],
    });

    expect(mocks.sql.getColdStorageItem).toHaveBeenCalledWith("remote-key");
    expect(mocks.sql.setColdStorageItem).toHaveBeenCalledWith(
      "remote-key",
      value,
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.readDir).not.toHaveBeenCalled();
  });

  it("collects remote cold storage for a Tauri backup", async () => {
    const key = "11111111-1111-1111-1111-111111111111";
    const value = { character: { chaId: "remote-character" } };
    mocks.sql.getColdStorageItem.mockResolvedValue(value);

    const result = await collectColdStorageBackupPayloads({
      characters: [
        {
          chaId: "remote-character",
          name: "Remote character",
          coldstorage: key,
          chats: [],
        },
      ],
    } as any);

    expect(result.missingKeys).toEqual([]);
    expect(result.invalidKeys).toEqual([]);
    expect(result.payloads).toEqual([
      expect.objectContaining({
        key,
        backupName: `coldstorage_${key}.json`,
        value,
      }),
    ]);
    expect(mocks.sql.getColdStorageItem).toHaveBeenCalledWith(key);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("prunes the active remote SQL backend in Tauri", async () => {
    mocks.sql.pruneColdStorage.mockResolvedValue(3);

    await cleanColdStorage();

    expect(mocks.sql.pruneColdStorage).toHaveBeenCalledWith([]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.alertClear).toHaveBeenCalledTimes(1);
  });
});
