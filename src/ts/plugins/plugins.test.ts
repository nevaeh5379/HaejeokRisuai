// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getV2PluginAPIs, importPlugin } from "./plugins.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import type { SqlCommit } from "../storage/sql/sqlCommit";

describe("Plugin Storage & SafeDatabase Persistence", () => {
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

    settingsStore.init(
      {
        pluginCustomStorage: {},
      } as any,
      mockStorage,
    );
    moduleStore.resetForTesting();
  });

  it("persists pluginStorage.setItem to settingsStore and SQL", async () => {
    const apis = getV2PluginAPIs();

    apis.pluginStorage.setItem("testKey", { value: 123 });

    expect(await apis.pluginStorage.getItem("testKey")).toEqual({ value: 123 });
    expect(apis.pluginStorage.length()).toBe(1);
    expect(apis.pluginStorage.keys()).toEqual(["testKey"]);
    expect(apis.pluginStorage.key(0)).toBe("testKey");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].pluginStorage?.upserts).toContainEqual({
      key: "testKey",
      value: { value: 123 },
    });
  });

  it("lists unloaded keys and fetches a plugin storage value on first access", async () => {
    mockStorage.loadPluginCustomStorageKey = vi.fn(async (key: string) => {
      return key === "lazyKey" ? { loaded: true } : undefined;
    });
    settingsStore.hydratePluginCustomStorageKeys(["lazyKey"]);
    const apis = getV2PluginAPIs();

    expect(apis.pluginStorage.keys()).toEqual(["lazyKey"]);
    expect(apis.pluginStorage.length()).toBe(1);
    expect(settingsStore.state.pluginCustomStorage).toEqual({});

    await expect(apis.pluginStorage.getItem("lazyKey")).resolves.toEqual({
      loaded: true,
    });
    await expect(apis.pluginStorage.getItem("lazyKey")).resolves.toEqual({
      loaded: true,
    });
    expect(mockStorage.loadPluginCustomStorageKey).toHaveBeenCalledTimes(1);

    await settingsStore.flush();
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("persists pluginStorage.removeItem and clear to settingsStore and SQL", async () => {
    const apis = getV2PluginAPIs();

    apis.pluginStorage.setItem("keyA", "valA");
    apis.pluginStorage.setItem("keyB", "valB");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    // Remove keyA
    apis.pluginStorage.removeItem("keyA");
    expect(await apis.pluginStorage.getItem("keyA")).toBeNull();
    expect(await apis.pluginStorage.getItem("keyB")).toBe("valB");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(2);
    });

    expect(committed[1].pluginStorage?.deletes).toContain("keyA");

    // Clear
    apis.pluginStorage.clear();
    expect(apis.pluginStorage.length()).toBe(0);
    expect(apis.pluginStorage.keys()).toEqual([]);

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(3);
    });

    expect(committed[2].pluginStorage?.clear).toBe(true);
  });

  it("persists custom property writes via safeDatabase proxy", async () => {
    const apis = getV2PluginAPIs();
    const db = apis.getDatabase();

    // Write custom property
    db.myCustomPluginData = { enabled: true, mode: "fast" };

    expect(db.myCustomPluginData).toEqual({ enabled: true, mode: "fast" });
    expect("myCustomPluginData" in db).toBe(true);
    expect(Object.keys(db)).toContain("myCustomPluginData");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].pluginStorage?.upserts).toContainEqual({
      key: "myCustomPluginData",
      value: { enabled: true, mode: "fast" },
    });

    // Delete custom property
    delete db.myCustomPluginData;
    expect(db.myCustomPluginData).toBeUndefined();
    expect("myCustomPluginData" in db).toBe(false);

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(2);
    });

    expect(committed[1].pluginStorage?.deletes).toContain("myCustomPluginData");
  });

  it("persists allowed DB property writes via safeDatabase proxy", async () => {
    const apis = getV2PluginAPIs();
    const db = apis.getDatabase();

    db.theme = "dracula";
    expect(db.theme).toBe("dracula");

    await vi.waitFor(async () => {
      await settingsStore.flush();
      expect(committed.length).toBe(1);
    });

    expect(committed[0].root.upserts).toContainEqual({
      key: "theme",
      value: "dracula",
    });
  });

  it("commits plugin module upserts without replacing existing modules", async () => {
    const existing = { id: "existing", name: "Existing module" };
    const untouched = { id: "untouched", name: "Untouched module" };
    const updated = { id: "existing", name: "Updated existing module" };
    const created = { id: "plugin-module", name: "Plugin module" };
    mockStorage.loadModules = vi.fn(async () => [existing, untouched] as any);
    mockStorage.loadSettingKey = vi.fn(async () => []);
    await moduleStore.init(mockStorage);

    const apis = getV2PluginAPIs();
    const db = apis.getDatabase();

    expect(db.modules).toEqual([existing, untouched]);
    expect(Object.keys(db)).toContain("modules");

    await expect(
      apis.setDatabase({ modules: [updated, created] }),
    ).resolves.toBeUndefined();
    await moduleStore.flush();

    expect(moduleStore.modules).toEqual([updated, untouched, created]);
    expect(db.modules).toEqual([updated, untouched, created]);
    expect(committed).toHaveLength(1);
    expect(committed[0].replaceAll).not.toBe(true);
    expect(committed[0].root.upserts).not.toContainEqual(
      expect.objectContaining({ key: "modules" }),
    );
    expect(committed[0].modules).toEqual({
      upserts: [
        { id: updated.id, position: 0, data: updated },
        { id: created.id, position: 2, data: created },
      ],
      deletes: [],
      order: [updated.id, untouched.id, created.id],
    });
  });

  it("commits an updated plugin to SQL before reloading plugins", async () => {
    settingsStore.init(
      {
        plugins: [
          {
            name: "UpdateTest",
            script: "old script",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: "3.0",
            versionOfPlugin: "1.0.0",
            enabled: false,
          },
        ],
        pluginCustomStorage: {},
      } as any,
      mockStorage,
    );

    await importPlugin(
      [
        "//@name UpdateTest",
        "//@api 3.0",
        "//@version 1.1.0",
        "",
        'Risuai.log("updated");',
      ].join("\n"),
      {
        isUpdate: true,
        originalPluginName: "UpdateTest",
      },
    );

    const pluginCommit = committed.find((commit) =>
      commit.root.upserts.some((upsert) => upsert.key === "plugins"),
    );
    expect(pluginCommit).toBeDefined();
    expect(pluginCommit?.root.upserts).toContainEqual({
      key: "plugins",
      value: [
        expect.objectContaining({
          name: "UpdateTest",
          versionOfPlugin: "1.1.0",
          script: expect.stringContaining('Risuai.log("updated");'),
        }),
      ],
    });
  });
});
