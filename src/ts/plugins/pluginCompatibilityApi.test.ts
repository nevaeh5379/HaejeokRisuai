// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadata } from "./pluginTypes";
import { getV2PluginAPIs } from "./plugins.svelte";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import type { SqlCommit } from "../storage/sql/sqlCommit";
import { pluginStore } from "../stores/domain/pluginStore.svelte";

function storedPlugin(): PluginMetadata {
  return {
    id: "plugin-1",
    position: 0,
    name: "Stored plugin",
    arguments: {},
    realArg: {},
    customLink: [],
    argMeta: {},
    version: "3.0",
    enabled: true,
  };
}

describe("plugin compatibility database writes", () => {
  let releaseCommit: () => void;
  let storage: ISqlStorage;

  beforeEach(async () => {
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    storage = {
      getRevision: vi.fn(() => 0),
      loadSettingKey: vi.fn(async () => undefined),
      commit: vi.fn(async (_commit: SqlCommit) => {
        await commitGate;
        return { revision: 1 };
      }),
      plugin: {
        load: vi.fn(async () => null),
        loadAll: vi.fn(async () => [storedPlugin()]),
        upsert: vi.fn(async () => undefined),
        upsertMany: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        deleteMany: vi.fn(async () => undefined),
        setEnabled: vi.fn(async () => undefined),
        reorder: vi.fn(async () => undefined),
        script: {
          load: vi.fn(async () => ({
            pluginId: "plugin-1",
            script: "stored source",
          })),
          upsert: vi.fn(async () => undefined),
          upsertMany: vi.fn(async () => undefined),
        },
      },
    } as unknown as ISqlStorage;
    await pluginStore.init(storage);
  });

  it("does not resolve setDatabase before the plugin replacement commits", async () => {
    const writing = getV2PluginAPIs().setDatabase({ plugins: [] });
    let settled = false;
    void writing.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pluginStore.plugins).toHaveLength(1);

    releaseCommit();
    await writing;

    expect(settled).toBe(true);
    expect(pluginStore.plugins).toEqual([]);
    expect(storage.commit).toHaveBeenCalledOnce();
  });

  it("propagates plugin replacement failures to setDatabase callers", async () => {
    releaseCommit();
    storage.commit = vi.fn(async () => {
      throw new Error("plugin commit failed");
    });

    await expect(
      getV2PluginAPIs().setDatabase({ plugins: [] }),
    ).rejects.toThrow("plugin commit failed");
    expect(pluginStore.plugins).toHaveLength(1);
  });
});
