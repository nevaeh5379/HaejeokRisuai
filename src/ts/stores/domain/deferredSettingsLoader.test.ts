import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { deferredSettingsLoader } from "./deferredSettingsLoader";

describe("DeferredSettingsLoader", () => {
  beforeEach(() => deferredSettingsLoader.reset());

  it("discards a load completed after a newer initialization", async () => {
    let resolveOldLoad!: (value: unknown) => void;
    const oldStorage = {
      loadSettingKey: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            resolveOldLoad = resolve;
          }),
      ),
    } as unknown as ISqlStorage;
    const newStorage = {} as ISqlStorage;
    const oldHydrate = vi.fn();
    const newHydrate = vi.fn();

    deferredSettingsLoader.init({
      storage: oldStorage,
      unloadedKeys: ["plugins"],
      hydrateSettingKey: oldHydrate,
    });
    const oldLoad = deferredSettingsLoader.ensureKey("plugins");

    deferredSettingsLoader.init({
      storage: newStorage,
      unloadedKeys: [],
      hydrateSettingKey: newHydrate,
    });
    resolveOldLoad([{ name: "stale" }]);
    await oldLoad;

    expect(oldHydrate).not.toHaveBeenCalled();
    expect(newHydrate).not.toHaveBeenCalled();
  });

  it("refreshes a resident deferred domain but leaves a cold one unloaded", async () => {
    const storage = {
      loadLorebooks: vi.fn(async () => [{ name: "remote", data: [] }]),
    } as unknown as ISqlStorage;
    const hydrate = vi.fn();
    const hydrateRemote = vi.fn();

    deferredSettingsLoader.init({
      storage,
      unloadedKeys: [],
      hydrateSettingKey: hydrate,
      hydrateRemoteSettingKey: hydrateRemote,
    });
    await deferredSettingsLoader.refreshLoadedKeys(["loreBook"]);
    expect(storage.loadLorebooks).toHaveBeenCalledTimes(1);
    expect(hydrateRemote).toHaveBeenCalledWith("loreBook", [
      { name: "remote", data: [] },
    ]);

    deferredSettingsLoader.init({
      storage,
      unloadedKeys: ["loreBook"],
      hydrateSettingKey: hydrate,
      hydrateRemoteSettingKey: hydrateRemote,
    });
    await deferredSettingsLoader.refreshLoadedKeys(["loreBook"]);
    expect(storage.loadLorebooks).toHaveBeenCalledTimes(1);
  });

  it("discards a remote refresh completed after storage reinitialization", async () => {
    let resolveOldLoad!: (value: unknown[]) => void;
    const oldStorage = {
      loadLorebooks: vi.fn(
        () =>
          new Promise<unknown[]>((resolve) => {
            resolveOldLoad = resolve;
          }),
      ),
    } as unknown as ISqlStorage;
    const oldHydrate = vi.fn();
    const newHydrate = vi.fn();

    deferredSettingsLoader.init({
      storage: oldStorage,
      unloadedKeys: [],
      hydrateSettingKey: oldHydrate,
      hydrateRemoteSettingKey: oldHydrate,
    });
    const refresh = deferredSettingsLoader.refreshLoadedKeys(["loreBook"]);

    deferredSettingsLoader.init({
      storage: {} as ISqlStorage,
      unloadedKeys: [],
      hydrateSettingKey: newHydrate,
      hydrateRemoteSettingKey: newHydrate,
    });
    resolveOldLoad([{ name: "stale", data: [] }]);
    await refresh;

    expect(oldHydrate).not.toHaveBeenCalled();
    expect(newHydrate).not.toHaveBeenCalled();
  });
});
