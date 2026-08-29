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
});
