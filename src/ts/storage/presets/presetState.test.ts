import { describe, expect, it } from "vitest";
import { createPresetSettings, PRESET_SETTING_KEYS } from "./presetSchema";
import {
  createActivePresetSnapshot,
  createPresetSettingsState,
  defaultPresetApplyPolicy,
} from "./presetState";
import {
  normalizeDatabaseInput,
  normalizeSettingsInput,
} from "../database/databaseDefaults";
import {
  readLegacyPresetFields,
  writeLegacyPresetFields,
} from "./legacyPresetCompatibility";

describe("independent preset model", () => {
  it("uses the template defaults regardless of aggregate/general settings", () => {
    const before = createPresetSettingsState({});
    const general = normalizeSettingsInput({
      maxResponse: 9876,
      mainPrompt: "general",
      NAISettings: { cfg_scale: 3 },
      moduleIntergration: "unrelated",
    });
    expect(general.maxResponse).toBe(9876);
    expect(createPresetSettingsState({})).toEqual(before);
    expect(before.maxResponse).toBe(300);
    expect(before.moduleIntergration).toBe("");
    expect(before.NAISettings.cfg_scale).toBe(1);
  });

  it("returns fresh arrays and nested defaults", () => {
    const first = createPresetSettings();
    first.NAISettings.cfg_scale = 4;
    first.ooba.formating.header = "changed";
    first.seperateModels.memory = "changed";
    first.regex.push({} as any);
    const second = createPresetSettings();
    expect(second.NAISettings.cfg_scale).toBe(1);
    expect(second.ooba.formating.header).not.toBe("changed");
    expect(second.seperateModels.memory).toBe("");
    expect(second.regex).toEqual([]);
  });

  it("preserves legacy missing-field rules using only the previous preset", () => {
    const previous = createPresetSettings({
      mainPrompt: "previous",
      temperature: 17,
      top_p: 0.25,
      reasonEffort: 4,
      moduleIntergration: "old",
      customProxyRequestModel: "old-model",
    });
    const next = createPresetSettingsState(
      { openrouterRequestModel: "new-model" },
      previous,
    );
    expect(next.mainPrompt).toBe("previous");
    expect(next.temperature).toBe(17);
    expect(next.top_p).toBe(1);
    expect(next.reasonEffort).toBe(0);
    expect(next.moduleIntergration).toBe("");
    expect(next.customProxyRequestModel).toBe("");
    expect(next.customProxySubRequestModel).toBe("");
    expect(next.openrouterSubRequestModel).toBe("new-model");
  });

  it.each([
    "doNotChangeSeperateModels",
    "doNotChangeFallbackModels",
    "disableSeperateParameterChangeOnPresetChange",
  ] as const)(
    "preserves values for %s without retaining unrelated values",
    (key) => {
      const previous = createPresetSettings({
        seperateModels: {
          memory: "memory",
          emotion: "",
          translate: "",
          otherAx: "",
        },
        providerModelOverrides: {
          memory: { ollamaModel: "local" },
          emotion: {},
          translate: {},
          otherAx: {},
        },
        fallbackModels: {
          memory: ["fallback"],
          emotion: [],
          translate: [],
          otherAx: [],
          model: [],
        },
        fallbackWhenBlankResponse: true,
        seperateParameters: {
          memory: { temperature: 0.1 },
          emotion: {},
          translate: {},
          otherAx: {},
          overrides: {},
        },
      });
      const next = createPresetSettingsState(
        { mainPrompt: "incoming" },
        previous,
        { ...defaultPresetApplyPolicy, [key]: true },
      );
      expect(next.mainPrompt).toBe("incoming");
      expect(next.seperateModels.memory).toBe(
        key === "doNotChangeSeperateModels" ? "memory" : "",
      );
      expect(next.providerModelOverrides.memory).toEqual(
        key === "doNotChangeSeperateModels" ? { ollamaModel: "local" } : {},
      );
      expect(next.fallbackModels.memory).toEqual(
        key === "doNotChangeFallbackModels" ? ["fallback"] : [],
      );
      expect(next.fallbackWhenBlankResponse).toBe(
        key === "doNotChangeFallbackModels",
      );
      expect(next.seperateParameters.memory).toEqual(
        key === "disableSeperateParameterChangeOnPresetChange"
          ? { temperature: 0.1 }
          : {},
      );
      next.seperateModels.memory = "detached";
      expect(previous.seperateModels.memory).toBe("memory");
    },
  );

  it("normalizes prompt roles and old provider names", () => {
    const state = createPresetSettingsState({
      promptTemplate: [
        { type: "plain", role: "assistant" },
        { type: "cache", role: "bot" },
      ],
      openrouterProvider: "provider",
    } as any);
    expect(state.promptTemplate).toMatchObject([
      { role: "bot" },
      { role: "assistant" },
    ]);
    expect(state.openrouterProvider).toEqual({
      order: ["provider"],
      only: [],
      ignore: [],
    });
  });

  it("takes a detached snapshot with every schema field, including suggestion settings", () => {
    const state = createPresetSettings({
      autoSuggestPrefix: "prefix",
      autoSuggestClean: false,
      localStopStrings: ["stop"],
      min_p: 0.2,
      top_a: 0.3,
      repetition_penalty: 1.2,
      openrouterProvider: { order: [], only: [], ignore: [] },
      dynamicOutput: {
        autoAdjustSchema: false,
        dynamicMessages: false,
        dynamicMemory: false,
        dynamicResponseTiming: false,
        dynamicOutputPrompt: false,
        showTypingEffect: false,
        dynamicRequest: false,
      },
    });
    const snapshot = createActivePresetSnapshot(state, {
      id: "id",
      name: "Preset",
      image: "image.png",
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      [...PRESET_SETTING_KEYS, "id", "name", "image"].sort(),
    );
    expect(snapshot.autoSuggestPrefix).toBe("prefix");
    expect(snapshot.autoSuggestClean).toBe(false);
    snapshot.NAISettings.cfg_scale = 3;
    expect(state.NAISettings.cfg_scale).toBe(1);
    expect(createPresetSettingsState(snapshot).autoSuggestPrefix).toBe(
      "prefix",
    );
  });

  it("maps aggregate legacy root aliases only at the compatibility boundary", () => {
    const input = {
      NAIsettings: { cfg_scale: 2 },
      presetRegex: [{ in: "a" }],
      reasoningEffort: 3,
      characters: [],
    };
    const normalized = normalizeDatabaseInput(structuredClone(input));
    expect(normalized.NAISettings.cfg_scale).toBe(2);
    expect(normalized.reasonEffort).toBe(3);
    expect(normalized.regex).toEqual(input.presetRegex);
    expect(normalized).not.toHaveProperty("NAIsettings");
    const exported = writeLegacyPresetFields(normalized);
    expect(exported).toMatchObject(input);
    expect(exported).not.toHaveProperty("NAISettings");
    expect(exported.characters).toBe(normalized.characters);
    const current = {
      NAISettings: { cfg_scale: 4 },
      NAIsettings: { cfg_scale: 2 },
    };
    readLegacyPresetFields(current);
    expect(current).toEqual({ NAISettings: { cfg_scale: 4 } });
  });
});
