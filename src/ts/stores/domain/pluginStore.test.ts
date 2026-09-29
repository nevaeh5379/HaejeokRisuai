// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadata } from "../../plugins/pluginTypes";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
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
      getRevision: vi.fn(() => 0),
      loadSettingKey: vi.fn(async () => undefined),
      commit: vi.fn(async (_commit: SqlCommit) => ({ revision: 1 })),
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
});
