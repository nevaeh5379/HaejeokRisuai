import { describe, it, expect, beforeEach } from "vitest";
import { makeLoadout, applyLoadout, type Loadout } from "./loadout";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";
import { personaStore } from "./stores/domain/personaStore.svelte";
import { moduleStore } from "./stores/domain/moduleStore.svelte";
import { settingsStore } from "./stores/domain/settingsStore.svelte";

describe("loadout operations", () => {
  beforeEach(() => {
    moduleStore.enabledModules = ["mod-1", "mod-2"];
    settingsStore.state.globalChatVariables = { foo: "bar" };
  });

  it("creates a loadout snapshot without structured clone overhead", () => {
    const loadout = makeLoadout({ name: "Gaming" });
    expect(loadout.name).toBe("Gaming");
    expect(loadout.id).toBeDefined();
    expect(loadout.favorite).toBe(false);
    expect(loadout.modules).toEqual(["mod-1", "mod-2"]);
    expect(loadout.globalVariables).toEqual({ foo: "bar" });
    expect(loadout.lastUsed).toBeGreaterThan(0);

    // Verify mutations do not leak back
    loadout.modules.push("mod-3");
    expect(moduleStore.enabledModules).toEqual(["mod-1", "mod-2"]);
  });

  it("applies loadout settings efficiently with Set-based option checks", () => {
    const loadout: Loadout = {
      name: "Custom",
      id: "custom-id",
      lastUsed: 100,
      favorite: true,
      characterIds: [],
      modules: ["mod-a", "mod-b"],
      globalVariables: { key: "val" },
      presetName: "",
      personaId: "",
    };

    applyLoadout(loadout, ["modules", "globalVariables"]);
    expect(moduleStore.enabledModules).toEqual(["mod-a", "mod-b"]);
    expect(settingsStore.state.globalChatVariables).toEqual({ key: "val" });
    expect(settingsStore.state.lastLoadedLoadoutName).toBe("Custom");
    expect(loadout.lastUsed).toBeGreaterThan(100);
  });
});
