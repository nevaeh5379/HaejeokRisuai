import { loadPluginRecords } from "../../plugins/apiV3/host/data.svelte";
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadata } from "@risuai/protocol/domain/pluginTypes.ts";
import type { ISqlStorage } from "@risuai/storage-core/sqlStorage";
import { pluginStore } from "./pluginStore.svelte";

function plugin(id: string, name: string): PluginMetadata {
  return {
    id,
    position: 0,
    name,
    arguments: {},
    realArg: {},
    customLink: [],
    argMeta: {},
    version: "3.0",
    enabled: true,
  };
}

describe("PluginStore", () => {
  let records: PluginMetadata[];
  let storage: ISqlStorage;

  beforeEach(() => {
    records = [plugin("plugin-1", "Before")];
    storage = {
      setting: { get: vi.fn(async () => undefined) },

      getRevision: vi.fn(() => 0),

      commit: vi.fn(async () => ({ revision: 1 })),
      plugin: {
        load: vi.fn(async () => null),
        loadAll: vi.fn(async () => structuredClone(records)),
        upsert: vi.fn(async () => undefined),
        upsertMany: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        deleteMany: vi.fn(async () => undefined),
        setEnabled: vi.fn(async () => undefined),
        reorder: vi.fn(async () => undefined),
        script: {
          load: vi.fn(async () => null),
          upsert: vi.fn(async () => undefined),
          upsertMany: vi.fn(async () => undefined),
        },
      },
    } as unknown as ISqlStorage;
  });

  it("refreshes plugin metadata from storage after a remote change", async () => {
    await pluginStore.init(storage);
    expect(pluginStore.getById("plugin-1")?.name).toBe("Before");

    records = [plugin("plugin-1", "After")];
    await pluginStore.refreshFromStorage();

    expect(pluginStore.getById("plugin-1")?.name).toBe("After");
    expect(storage.plugin.loadAll).toHaveBeenCalledTimes(2);
    expect(storage.commit).not.toHaveBeenCalled();
  });

  it("loads uncached scripts before creating a compatibility snapshot", async () => {
    records = [plugin("plugin-1", "Enabled"), plugin("plugin-2", "Disabled")];
    records[1].position = 1;
    records[1].enabled = false;
    storage.plugin.script.load = vi.fn(async (pluginId: string) => ({
      pluginId,
      script: `${pluginId}-source`,
    }));
    await pluginStore.init(storage);

    await expect(loadPluginRecords()).resolves.toEqual([
      expect.objectContaining({ name: "Enabled", script: "plugin-1-source" }),
      expect.objectContaining({ name: "Disabled", script: "plugin-2-source" }),
    ]);
    expect(storage.plugin.script.load).toHaveBeenCalledTimes(2);
  });
});
