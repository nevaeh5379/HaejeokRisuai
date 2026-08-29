// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { personaStore } from "./personaStore.svelte";
import { settingsStore } from "./settingsStore.svelte";

describe("PersonaStore", () => {
  let storage: ISqlStorage;

  beforeEach(() => {
    storage = {
      getRevision: vi.fn(() => 0),
      commit: vi.fn(async () => ({ revision: 1 })),
      loadPluginCustomStorageKey: vi.fn(async () => undefined),
    } as unknown as ISqlStorage;
  });

  it("uses the selected persona as the only active identity", () => {
    settingsStore.init(
      {
        username: "stale-root-name",
        personas: [
          { name: "A", icon: "a.png", personaPrompt: "A prompt" },
          { name: "B", icon: "b.png", personaPrompt: "B prompt" },
        ],
        selectedPersona: 1,
      } as any,
      storage,
    );

    expect(personaStore.activePersona?.name).toBe("B");
    expect(personaStore.activePersona?.personaPrompt).toBe("B prompt");
  });

  it("throws instead of silently falling back for an invalid selection", () => {
    settingsStore.init(
      {
        personas: [{ name: "A", icon: "", personaPrompt: "A prompt" }],
        selectedPersona: 3,
      } as any,
      storage,
    );

    expect(personaStore.activePersona).toBeUndefined();
    expect(() => personaStore.requireActive("test")).toThrow(
      /Invalid persona index: 3/,
    );
  });

  it("does not expose the shallow placeholder while personas are deferred", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "Real A", icon: "", personaPrompt: "A" },
      { name: "Real B", icon: "", personaPrompt: "B" },
    ]) as any;
    settingsStore.init(
      {
        personas: [{ name: "Placeholder", icon: "", personaPrompt: "" }],
        selectedPersona: 1,
      } as any,
      storage,
      { deferredUnloaded: ["personas"] },
    );

    expect(personaStore.activePersona).toBeUndefined();
    await personaStore.ensureLoaded();

    expect(storage.loadPersonas).toHaveBeenCalledTimes(1);
    expect(personaStore.activePersona?.name).toBe("Real B");
  });
});
