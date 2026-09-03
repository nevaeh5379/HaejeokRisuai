// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage, StoredBotPreset } from "../../storage/sql/ISqlStorage";
import { presetStore } from "./presetStore.svelte";

describe("PresetStore active ownership", () => {
  let storage: ISqlStorage;
  const stored = {
    id: "preset-1",
    name: "Stored",
    image: "stored.png",
    mainPrompt: "stored prompt",
    jailbreak: "",
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 500,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: [],
    promptPreprocess: false,
    bias: [],
    ooba: {},
    ainconfig: {},
  } as unknown as StoredBotPreset;

  beforeEach(() => {
    presetStore.resetForTesting();
    storage = {
      getRevision: vi.fn(() => 0),
      listBotPresets: vi.fn(async () => [
        {
          id: stored.id,
          name: stored.name ?? "",
          image: stored.image ?? "",
          apiType: stored.apiType,
          aiModel: stored.aiModel,
        },
      ]),
      loadSettingKey: vi.fn(async (key: string) =>
        key === "activeBotPresetId" ? stored.id : undefined,
      ),
      loadBotPreset: vi.fn(async () => structuredClone(stored)),
      commit: vi.fn(async () => ({ revision: 1 })),
    } as unknown as ISqlStorage;
  });

  it("drops the cached active document after binding the live provider", async () => {
    await presetStore.init(storage);
    expect(presetStore.activePreset?.mainPrompt).toBe("stored prompt");

    presetStore.bindActivePresetState(
      { mainPrompt: "live prompt" } as any,
      () => ({ ...stored, mainPrompt: presetStore.state.mainPrompt }),
    );

    expect(presetStore.cache.has(stored.id)).toBe(false);
    expect(presetStore.activePreset?.mainPrompt).toBe("live prompt");
    presetStore.state.mainPrompt = "edited live prompt";
    expect((await presetStore.load(stored.id)).mainPrompt).toBe(
      "edited live prompt",
    );
    expect(storage.loadBotPreset).toHaveBeenCalledTimes(1);
  });

  it("rejects settings and other domain writes through the preset state", () => {
    for (const key of ["theme", "askRemoval", "modules", "characters"]) {
      expect(() => Reflect.set(presetStore.state, key, null)).toThrow(/owned by another domain store/);
      expect(() => Reflect.deleteProperty(presetStore.state, key)).toThrow(/owned by another domain store/);
      expect(() => Object.defineProperty(presetStore.state, key, { value: null }))
        .toThrow(/owned by another domain store/);
    }
  });

  it("flushes the live active preset through the preset domain", async () => {
    await presetStore.init(storage);
    presetStore.bindActivePresetState(
      { mainPrompt: "stored prompt" } as any,
      () => ({ ...stored, mainPrompt: presetStore.state.mainPrompt }),
    );

    presetStore.state.mainPrompt = "edited prompt";
    expect(presetStore.hasPendingWrites()).toBe(true);
    await presetStore.flush();

    expect(storage.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "preset:save",
        presets: expect.objectContaining({
          upserts: [
            expect.objectContaining({
              id: stored.id,
              data: expect.objectContaining({ mainPrompt: "edited prompt" }),
            }),
          ],
        }),
      }),
    );
    expect(presetStore.hasPendingWrites()).toBe(false);
  });
});
