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

    let livePrompt = "live prompt";
    presetStore.bindActivePresetProvider(() => ({
      ...stored,
      mainPrompt: livePrompt,
    }));

    expect(presetStore.cache.has(stored.id)).toBe(false);
    expect(presetStore.activePreset?.mainPrompt).toBe("live prompt");
    livePrompt = "edited live prompt";
    expect((await presetStore.load(stored.id)).mainPrompt).toBe(
      "edited live prompt",
    );
    expect(storage.loadBotPreset).toHaveBeenCalledTimes(1);
  });
});
