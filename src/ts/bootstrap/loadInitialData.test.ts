import { describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "@risuai/storage-core/sqlStorage";
import { loadInitialData } from "./loadInitialData";

function fixture(initialized = true) {
  let revision = 1;
  const values = new Map<string, unknown>([
    ["language", "ko"],
    ["mainPrompt", "large prompt"],
    ["characters", [{ chaId: "must-not-load" }]],
    ["personas", [{ id: "must-not-load" }]],
  ]);
  const getState = vi.fn(async () => ({ revision, initialized }));
  const getMany = vi.fn(
    async (keys: string[]) =>
      new Map(keys.map((key) => [key, values.get(key)])),
  );
  const count = vi.fn(async () => 120_000);
  const forbidden = vi.fn(() => {
    throw new Error("Full data hydration is forbidden");
  });
  const storage = {
    isEnabled: () => true,
    init: vi.fn(async () => true),
    getState,
    getStorageSyncSummary: forbidden,
    exportSnapshot: forbidden,
    setting: {
      keys: vi.fn(async () => [...values.keys()]),
      getMany,
      get: forbidden,
    },
    character: { count, list: forbidden, load: forbidden },
  };
  return {
    storage: storage as unknown as ISqlStorage,
    getState,
    getMany,
    count,
    forbidden,
    values,
    advance: () => {
      revision++;
    },
  };
}

describe("loadInitialData", () => {
  it("loads settings and a 120,000-character count without hydrating domain records", async () => {
    const f = fixture();
    const result = await loadInitialData(f.storage);
    expect(result).toMatchObject({
      initialized: true,
      revision: 1,
      settings: { language: "ko" },
      characterCount: 120_000,
    });
    expect(result).not.toHaveProperty("characters");
    expect(result.deferredSettingKeys).toEqual(
      expect.arrayContaining(["mainPrompt", "loreBook", "globalscript"]),
    );
    expect(f.getMany).toHaveBeenCalledExactlyOnceWith(["language"]);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("returns an empty initial state without domain or setting reads", async () => {
    const f = fixture(false);
    const result = await loadInitialData(f.storage);
    expect(result).toMatchObject({
      initialized: false,
      settings: {},
      characterCount: 0,
    });
    expect(f.storage.setting.keys).not.toHaveBeenCalled();
    expect(f.count).not.toHaveBeenCalled();
  });

  it("discards a mixed revision and retries with fresh settings", async () => {
    const f = fixture();
    f.getMany.mockImplementationOnce(async () => {
      f.advance();
      f.values.set("language", "en");
      return new Map([["language", "ko"]]);
    });
    expect(await loadInitialData(f.storage)).toMatchObject({
      revision: 2,
      settings: { language: "en" },
    });
    expect(f.getMany).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when writers keep changing the data", async () => {
    const f = fixture();
    f.count.mockImplementation(async () => {
      f.advance();
      return 120_000;
    });
    await expect(loadInitialData(f.storage)).rejects.toThrow("kept changing");
    expect(f.count).toHaveBeenCalledTimes(3);
  });

  it("reads ordinary settings in bounded batches", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.values.set(`custom-setting-${i}`, i);
    await loadInitialData(f.storage);
    expect(f.getMany).toHaveBeenCalledTimes(4);
    expect(f.getMany.mock.calls.every(([keys]) => keys.length <= 32)).toBe(
      true,
    );
  });

  it("fails if opening storage fails", async () => {
    const f = fixture();
    f.storage.isEnabled = () => false;
    vi.mocked(f.storage.init).mockResolvedValue(false);
    await expect(loadInitialData(f.storage)).rejects.toThrow(
      "Failed to initialize",
    );
    expect(f.getState).not.toHaveBeenCalled();
  });
});
