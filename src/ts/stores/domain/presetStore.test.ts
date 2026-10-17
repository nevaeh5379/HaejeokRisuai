// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import type {
  ISqlStorage,
  StoredBotPreset,
} from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import { presetStore } from "./presetStore.svelte";
import { defaultPresetApplyPolicy } from "../../storage/presets/presetState";
import {
  createPresetSettings,
  PRESET_SETTING_KEYS,
} from "../../storage/presets/presetSchema";

function preset(id: string, mainPrompt = id): StoredBotPreset {
  return {
    ...createPresetSettings(),
    id,
    name: id,
    image: `${id}.png`,
    mainPrompt,
  };
}

describe("PresetStore independent active ownership", () => {
  let storage: ISqlStorage;
  let documents: Map<string, StoredBotPreset>;
  let activeId: string;
  beforeEach(() => {
    presetStore.resetForTesting();
    activeId = "one";
    documents = new Map([
      ["one", preset("one")],
      ["two", preset("two")],
    ]);
    storage = {
      getRevision: () => 0,
      listBotPresets: vi.fn(async () =>
        [...documents.values()].map(
          ({ id, name, image, apiType, aiModel }) => ({
            id,
            name,
            image,
            apiType,
            aiModel,
          }),
        ),
      ),
      loadSettingKey: vi.fn(async () => activeId),
      loadBotPreset: vi.fn(async (id) => structuredClone(documents.get(id))),
      commit: vi.fn(async (commit: SqlCommit) => {
        for (const entry of commit.presets?.upserts ?? [])
          documents.set(entry.id, {
            ...structuredClone(entry.data),
            id: entry.id,
          });
        for (const id of commit.presets?.deletes ?? []) documents.delete(id);
        activeId = commit.presets?.activeId ?? activeId;
        return { revision: 1 };
      }),
    } as unknown as ISqlStorage;
  });
  afterEach(() => presetStore.resetForTesting());

  it("loads only the active document and makes no initial save", async () => {
    await presetStore.init(storage);
    flushSync();
    await presetStore.flush();
    expect(presetStore.state.mainPrompt).toBe("one");
    expect(presetStore.cache.has("one")).toBe(false);
    expect(storage.loadBotPreset).toHaveBeenCalledTimes(1);
    expect(storage.commit).not.toHaveBeenCalled();
  });

  it("keeps live edits in the store, then round-trips every schema field", async () => {
    await presetStore.init(storage);
    presetStore.state.autoSuggestPrefix = "prefix";
    presetStore.state.autoSuggestClean = false;
    presetStore.state.NAISettings.cfg_scale = 1.5;
    presetStore.state.regex = [
      { in: "a", out: "b", type: "editoutput" } as any,
    ];
    presetStore.state.reasonEffort = 3;
    const state = structuredClone($stateSnapshot());
    expect((await presetStore.load("one")).autoSuggestPrefix).toBe("prefix");
    expect(presetStore.hasPendingWrites()).toBe(true);
    await presetStore.flush();
    for (const key of PRESET_SETTING_KEYS)
      expect(documents.get("one")[key], key).toEqual(state[key]);
    await presetStore.activate("two");
    await presetStore.activate("one");
    expect($stateSnapshot()).toEqual(state);
    expect(presetStore.hasPendingWrites()).toBe(false);
  });

  it("persists direct application instead of resetting its baseline", async () => {
    await presetStore.init(storage);
    presetStore.applyPreset(
      { mainPrompt: "applied" },
      defaultPresetApplyPolicy,
    );
    expect(presetStore.hasPendingWrites()).toBe(true);
    await presetStore.flush();
    expect(documents.get("one").mainPrompt).toBe("applied");
  });

  it("saves outgoing edits before activating another preset", async () => {
    await presetStore.init(storage);
    presetStore.state.mainPrompt = "edited";
    await presetStore.activate("two");
    expect(documents.get("one").mainPrompt).toBe("edited");
    expect(presetStore.state.mainPrompt).toBe("two");
    expect(
      vi.mocked(storage.commit).mock.calls.map(([commit]) => commit.action),
    ).toEqual(["preset:save", "preset:activate"]);
  });

  it.each(["save", "load", "activate"])(
    "keeps the previous active state after %s failure",
    async (failure) => {
      await presetStore.init(storage);
      presetStore.state.mainPrompt = "edited";
      const commit = storage.commit.bind(storage);
      storage.commit = vi.fn(async (value) => {
        if (value.action === `preset:${failure}`) throw new Error("disk full");
        return commit(value);
      });
      if (failure === "load")
        storage.loadBotPreset = vi.fn(async () => {
          throw new Error("load failed");
        });
      await expect(presetStore.activate("two")).rejects.toThrow();
      expect(presetStore.activeId).toBe("one");
      expect(presetStore.state.mainPrompt).toBe("edited");
      expect(presetStore.hasPendingWrites()).toBe(failure === "save");
    },
  );

  it("retains failed writes for a later retry", async () => {
    await presetStore.init(storage);
    const commit = storage.commit;
    storage.commit = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    presetStore.state.mainPrompt = "retry";
    await expect(presetStore.flush()).rejects.toThrow("disk full");
    expect(presetStore.hasPendingWrites()).toBe(true);
    storage.commit = commit;
    await presetStore.flush();
    expect(documents.get("one").mainPrompt).toBe("retry");
    expect(presetStore.hasPendingWrites()).toBe(false);
  });

  it("refreshes remote state through the same normalization without writing it back", async () => {
    await presetStore.init(storage);
    documents.set("two", {
      id: "two",
      name: "Remote",
      mainPrompt: "remote",
      promptTemplate: [{ type: "plain", role: "assistant" }],
    } as any);
    activeId = "two";
    await presetStore.refreshFromStorage();
    flushSync();
    expect(presetStore.activeId).toBe("two");
    expect(presetStore.activePreset.name).toBe("Remote");
    expect(presetStore.state.promptTemplate[0]).toMatchObject({ role: "bot" });
    expect(presetStore.state.mainPrompt).toBe("remote");
    await presetStore.flush();
    expect(storage.commit).not.toHaveBeenCalled();
  });

  it("preserves active state and summaries when a remote document fails to load", async () => {
    await presetStore.init(storage);
    activeId = "two";
    storage.loadBotPreset = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(presetStore.refreshFromStorage()).rejects.toThrow("offline");
    expect(presetStore.activeId).toBe("one");
    expect(presetStore.state.mainPrompt).toBe("one");
  });

  it("uses only the injected save policy for separate models", async () => {
    let keep = false;
    presetStore.setPolicyProvider(() => ({
      ...defaultPresetApplyPolicy,
      doNotChangeSeperateModels: keep,
    }));
    await presetStore.init(storage);
    presetStore.state.seperateModels.memory = "memory-model";
    presetStore.state.providerModelOverrides.memory = { ollamaModel: "local" };
    keep = true;
    await presetStore.flush();
    expect(documents.get("one")).toMatchObject({
      seperateModels: null,
      providerModelOverrides: null,
      seperateModelsForAxModels: false,
    });
    expect(presetStore.state.seperateModels.memory).toBe("memory-model");
  });

  it("preserves live separate models when saving active metadata", async () => {
    presetStore.setPolicyProvider(() => ({
      ...defaultPresetApplyPolicy,
      doNotChangeSeperateModels: true,
    }));
    await presetStore.init(storage);
    presetStore.state.seperateModels.memory = "keep-memory";
    const renamed = await presetStore.load("one");
    renamed.name = "Renamed";
    await presetStore.savePreset(renamed);
    expect(presetStore.activePreset.name).toBe("Renamed");
    expect(presetStore.state.seperateModels.memory).toBe("keep-memory");
    expect(documents.get("one").seperateModels).toBeNull();
    expect(presetStore.hasPendingWrites()).toBe(false);
  });

  it("automatically saves deep mutations", async () => {
    vi.useFakeTimers();
    try {
      await presetStore.init(storage);
      flushSync();
      presetStore.state.NAISettings.cfg_scale = 2.5;
      flushSync();
      await vi.advanceTimersByTimeAsync(350);
      expect(documents.get("one").NAISettings.cfg_scale).toBe(2.5);
      expect(presetStore.hasPendingWrites()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs the normalized successor when deleting the active preset", async () => {
    await presetStore.init(storage);
    await presetStore.delete("one");
    expect(presetStore.activeId).toBe("two");
    expect(presetStore.state.mainPrompt).toBe("two");
    expect(documents.has("one")).toBe(false);
  });

  it("replaces the collection and installs its selected preset", async () => {
    await presetStore.init(storage);
    await presetStore.setPresets(
      [
        { name: "new", mainPrompt: "new-main" },
        { name: "selected", mainPrompt: "selected-main" },
      ],
      1,
    );
    expect(presetStore.summaries).toHaveLength(2);
    expect(presetStore.activeIndex).toBe(1);
    expect(presetStore.state.mainPrompt).toBe("selected-main");
    expect(presetStore.hasPendingWrites()).toBe(false);
  });

  it("keeps only six inactive documents in memory", async () => {
    for (let i = 0; i < 20; i++) documents.set(`${i}`, preset(`${i}`));
    await presetStore.init(storage);
    for (let i = 0; i < 20; i++) await presetStore.load(`${i}`);
    expect(presetStore.cache.size).toBeLessThanOrEqual(6);
    expect(presetStore.state.mainPrompt).toBe("one");
  });

  it("creates a default document only when storage is empty", async () => {
    documents.clear();
    await presetStore.init(storage);
    expect(presetStore.summaries).toHaveLength(1);
    expect(presetStore.activePreset.name).toBe("Default");
    expect(presetStore.state.maxResponse).toBe(300);
    expect(storage.commit).toHaveBeenCalledTimes(1);
  });

  it("rejects writes belonging to another domain", () => {
    for (const key of [
      "theme",
      "askRemoval",
      "modules",
      "characters",
      "NAIsettings",
      "presetRegex",
      "reasoningEffort",
    ]) {
      expect(() => Reflect.set(presetStore.state, key, null)).toThrow(
        /owned by another domain store/,
      );
      expect(() => Reflect.deleteProperty(presetStore.state, key)).toThrow(
        /owned by another domain store/,
      );
      expect(() =>
        Object.defineProperty(presetStore.state, key, { value: null }),
      ).toThrow(/owned by another domain store/);
    }
  });
});

// The tests are plain .ts, so detach Svelte's proxy through the store snapshot.
function $stateSnapshot() {
  const { id, name, image, ...state } = presetStore.activePreset;
  return state;
}
