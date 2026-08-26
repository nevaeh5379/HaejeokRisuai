// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { settingsStore } from "./settingsStore.svelte";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import type { SqlCommit } from "../../storage/sqlCommit";

describe("SettingsStore Reactivity and Persistence", () => {
  let committed: SqlCommit[] = [];
  let mockStorage: ISqlStorage;

  beforeEach(() => {
    committed = [];
    mockStorage = {
      getRevision: vi.fn(() => committed.length),
      loadPluginCustomStorageKey: vi.fn(async () => undefined),
      commit: vi.fn(async (commit: SqlCommit) => {
        committed.push(structuredClone(commit));
        return { revision: committed.length };
      }),
    } as unknown as ISqlStorage;
  });

  it("initializes without firing an immediate commit", async () => {
    settingsStore.init(
      {
        theme: "dark",
        customModels: [
          {
            id: "xcustom:::test-1",
            name: "Initial Model",
            internalId: "gpt-4o",
            url: "https://api.openai.com",
            format: 0,
            tokenizer: 1,
            key: "sk-test",
            params: "",
            flags: [],
          },
        ],
      } as any,
      mockStorage,
    );

    // Wait a tick to let initial effect run
    await new Promise((r) => setTimeout(r, 50));
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("detects deep mutations on customModels across consecutive edits", async () => {
    settingsStore.init(
      {
        customModels: [],
      } as any,
      mockStorage,
    );

    // 1st Edit: Push new custom model
    settingsStore.state.customModels.push({
      id: "xcustom:::model-1",
      name: "Initial Name",
      internalId: "claude-3-5",
      url: "",
      format: 2,
      tokenizer: 6,
      key: "",
      params: "",
      flags: [],
    });

    // Flush 1st edit
    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].root.upserts).toContainEqual({
      key: "customModels",
      value: [
        expect.objectContaining({
          id: "xcustom:::model-1",
          name: "Initial Name",
          internalId: "claude-3-5",
        }),
      ],
    });

    // 2nd Edit: Mutate nested properties (name, url, flags)
    settingsStore.state.customModels[0].name = "Updated Claude 3.5";
    settingsStore.state.customModels[0].url = "https://api.anthropic.com";
    settingsStore.state.customModels[0].flags.push(4); // LLMFlags.hasPrefill

    // Flush 2nd edit
    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(2);
    });

    expect(committed[1].root.upserts).toContainEqual({
      key: "customModels",
      value: [
        expect.objectContaining({
          id: "xcustom:::model-1",
          name: "Updated Claude 3.5",
          url: "https://api.anthropic.com",
          flags: [4],
        }),
      ],
    });

    // 3rd Edit: Add a second model
    settingsStore.state.customModels.push({
      id: "xcustom:::model-2",
      name: "DeepSeek V3",
      internalId: "deepseek-chat",
      url: "https://api.deepseek.com",
      format: 0,
      tokenizer: 13,
      key: "sk-ds",
      params: "temperature=0.7",
      flags: [8],
    });

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(3);
    });

    expect(committed[2].root.upserts).toContainEqual({
      key: "customModels",
      value: [
        expect.objectContaining({
          id: "xcustom:::model-1",
          name: "Updated Claude 3.5",
        }),
        expect.objectContaining({
          id: "xcustom:::model-2",
          name: "DeepSeek V3",
        }),
      ],
    });
  });

  it("detects setting key deletions and stages them for commit", async () => {
    settingsStore.init(
      {
        theme: "dark",
        customBackground: "bg.jpg",
      } as any,
      mockStorage,
    );

    // Delete a setting key
    delete settingsStore.state.customBackground;

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].root.deletes).toContain("customBackground");
  });

  it("simulates reload flow preserving custom models", async () => {
    // Initial setup & save
    settingsStore.init(
      {
        customModels: [],
      } as any,
      mockStorage,
    );

    settingsStore.state.customModels.push({
      id: "xcustom:::my-custom-model",
      name: "My Custom LLM",
      internalId: "gemini-2.0-flash",
      url: "https://generativelanguage.googleapis.com",
      format: 5,
      tokenizer: 10,
      key: "AIzaSyTestKey",
      params: "temperature=0.9\nmax_tokens=4096",
      flags: [0, 8, 15],
    });

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    const savedPayload = committed[0].root.upserts.find(
      (u) => u.key === "customModels",
    )?.value as any[];
    expect(savedPayload).toBeDefined();
    expect(savedPayload.length).toBe(1);

    // Reload simulation: re-initialize with saved payload
    const reloadedSettings = {
      customModels: savedPayload,
    };

    const newCommitted: SqlCommit[] = [];
    const newMockStorage = {
      getRevision: vi.fn(() => newCommitted.length),
      commit: vi.fn(async (commit: SqlCommit) => {
        newCommitted.push(structuredClone(commit));
        return { revision: newCommitted.length };
      }),
    } as unknown as ISqlStorage;

    settingsStore.init(reloadedSettings as any, newMockStorage);

    expect(settingsStore.state.customModels).toHaveLength(1);
    expect(settingsStore.state.customModels[0]).toEqual(
      expect.objectContaining({
        id: "xcustom:::my-custom-model",
        name: "My Custom LLM",
        internalId: "gemini-2.0-flash",
        url: "https://generativelanguage.googleapis.com",
        key: "AIzaSyTestKey",
        params: "temperature=0.9\nmax_tokens=4096",
        flags: [0, 8, 15],
      }),
    );

    // Verify that further edits after reload still trigger commits
    settingsStore.state.customModels[0].name = "Renamed After Reload";
    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(newCommitted.length).toBe(1);
    });

    expect(newCommitted[0].root.upserts).toContainEqual({
      key: "customModels",
      value: [
        expect.objectContaining({
          id: "xcustom:::my-custom-model",
          name: "Renamed After Reload",
        }),
      ],
    });
  });

  it("persists pluginCustomStorage mutations and key removals", async () => {
    settingsStore.init(
      {
        pluginCustomStorage: {
          existingPlugin: { opt: true },
        },
      } as any,
      mockStorage,
    );

    // 1. Add/update plugin key
    settingsStore.setPluginCustomStorageKey("myPlugin", { count: 42 });

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].pluginStorage?.upserts).toContainEqual({
      key: "myPlugin",
      value: { count: 42 },
    });

    // 2. Remove a plugin key
    settingsStore.removePluginCustomStorageKey("existingPlugin");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(2);
    });

    expect(committed[1].pluginStorage?.deletes).toContain("existingPlugin");

    // 3. Clear all plugin storage
    settingsStore.clearPluginCustomStorage();

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(3);
    });

    expect(committed[2].pluginStorage?.clear).toBe(true);
  });

  it("tracks plugin storage keys without loading values and hydrates one key without committing it", async () => {
    mockStorage.loadPluginCustomStorageKey = vi.fn(async (key: string) => {
      return key === "large-cache" ? { entries: [1, 2, 3] } : undefined;
    });
    settingsStore.init({ pluginCustomStorage: {} } as any, mockStorage);
    settingsStore.hydratePluginCustomStorageKeys([
      "large-cache",
      "other-cache",
    ]);

    expect(settingsStore.getPluginCustomStorageKeys()).toEqual([
      "large-cache",
      "other-cache",
    ]);
    expect(settingsStore.hasLoadedPluginCustomStorageKey("large-cache")).toBe(
      false,
    );
    expect(settingsStore.state.pluginCustomStorage).toEqual({});

    await expect(
      settingsStore.loadPluginCustomStorageKey("large-cache"),
    ).resolves.toEqual({ entries: [1, 2, 3] });
    expect(settingsStore.hasLoadedPluginCustomStorageKey("large-cache")).toBe(
      true,
    );
    expect(settingsStore.state.pluginCustomStorage["large-cache"]).toEqual({
      entries: [1, 2, 3],
    });

    await settingsStore.flush();
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("hydrates remote setting keys without re-saving them or dropping local dirty keys", async () => {
    settingsStore.init(
      { theme: "dark", temperature: 70, username: "Old" } as any,
      mockStorage,
    );
    settingsStore.set("username" as any, "Local edit" as any);
    settingsStore.hydrateSettingKey("theme", "light", true);
    settingsStore.hydrateSettingKey("temperature", undefined, false);

    await settingsStore.flush();

    expect(settingsStore.state.theme).toBe("light");
    expect(settingsStore.state.temperature).toBeUndefined();
    expect(committed).toHaveLength(1);
    expect(committed[0].root.upserts).toEqual([
      { key: "username", value: "Local edit" },
    ]);
    expect(committed[0].root.deletes).toEqual([]);
  });

  it("hydrates remote plugin storage without overwriting local pending writes", async () => {
    settingsStore.init(
      {
        pluginCustomStorage: {
          stale: { value: 1 },
          remote: { value: 1 },
          local: { value: 1 },
        },
      } as any,
      mockStorage,
    );
    settingsStore.setPluginCustomStorageKey("local", { value: 2 });
    settingsStore.hydrateRemotePluginCustomStorageKey("remote", { value: 9 });
    settingsStore.hydrateRemotePluginCustomStorageKey("local", { value: 99 });
    settingsStore.hydrateRemotePluginCustomStorageDelete("stale");
    settingsStore.hydrateRemotePluginCustomStorageClear();
    settingsStore.hydrateRemotePluginCustomStorageKey("after-clear", { value: 3 });

    await settingsStore.flush();

    expect(settingsStore.state.pluginCustomStorage).toEqual({
      local: { value: 2 },
      "after-clear": { value: 3 },
    });
    expect(committed).toHaveLength(1);
    expect(committed[0].pluginStorage?.upserts).toEqual([
      { key: "local", value: { value: 2 } },
    ]);
    expect(committed[0].pluginStorage?.clear).toBeUndefined();
  });
});
