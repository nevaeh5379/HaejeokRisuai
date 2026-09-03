// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { getSettingValue, setSettingValue } from "./utils";
import type { SettingContext, SettingItem } from "./types";

// Only binding behavior is under test; avoid loading all settings panels.
vi.mock("src/lang", () => ({ language: {} }));
vi.mock("./accessibilitySettingsData", () => ({
  accessibilitySettingsItems: [],
}));
vi.mock("./advancedSettingsData", () => ({ advancedSettingsItems: [] }));
vi.mock("./botSettingsParamsData", () => ({
  basicParameterItems: [],
  modelSpecificParameterItems: [],
  penaltyParameterItems: [],
  samplingParameterItems: [],
  seedSetting: [],
}));
vi.mock("./chatFormatSettingsData", () => ({ chatFormatSettingsItems: [] }));
vi.mock("./displaySettingsData.svelte", () => ({ displaySettingsItems: [] }));

const ctx: SettingContext = {
  db: settingsStore.state,
  preset: presetStore.state,
  modelInfo: {} as SettingContext["modelInfo"],
  subModelInfo: {} as SettingContext["subModelInfo"],
};

beforeEach(() => {
  settingsStore.init({ askRemoval: true }, null);
  settingsStore.releasePresetOwnedState();
  presetStore.resetForTesting();
  presetStore.state.localNetworkMode = false;
});
afterEach(() => {
  settingsStore.dispose();
  presetStore.resetForTesting();
});

it("routes bindings to their owning stores", () => {
  const presetItem: SettingItem = {
    id: "local",
    type: "check",
    bindKey: "localNetworkMode",
  };
  const settingsItem: SettingItem = {
    id: "remove",
    type: "check",
    bindKey: "askRemoval",
  };
  expect(getSettingValue(presetItem, ctx)).toBe(false);
  setSettingValue(presetItem, true, ctx);
  setSettingValue(settingsItem, false, ctx);
  expect(presetStore.state.localNetworkMode).toBe(true);
  expect(settingsStore.state.askRemoval).toBe(false);
  expect(Object.keys(settingsStore.getStateRecord())).not.toContain(
    "localNetworkMode",
  );
  expect(Object.keys(presetStore.getStateRecord())).not.toContain("askRemoval");
});

it("forwards valid descriptors and rejects fixed properties before mutation", () => {
  expect(() =>
    Object.defineProperty(presetStore.state, "localNetworkMode", {
      value: true,
    }),
  ).toThrow(/must be configurable/);
  expect(presetStore.state.localNetworkMode).toBe(false);
  expect(() =>
    Object.defineProperty(settingsStore.state, "askRemoval", { value: false }),
  ).toThrow(/must be configurable/);
  expect(settingsStore.state.askRemoval).toBe(true);
  Object.defineProperty(presetStore.state, "localNetworkMode", {
    value: true,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  Object.defineProperty(settingsStore.state, "askRemoval", {
    value: false,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  expect(presetStore.state.localNetworkMode).toBe(true);
  expect(settingsStore.state.askRemoval).toBe(false);
});

it("routes nested paths independently of a fallback bindKey", () => {
  const item: SettingItem = {
    id: "nested",
    type: "text",
    bindKey: "localNetworkMode",
    bindPath: "deeplOptions.key",
  };
  setSettingValue(item, "key-value", ctx);
  expect(getSettingValue(item, ctx)).toBe("key-value");
  expect(settingsStore.state.deeplOptions.key).toBe("key-value");
  expect(presetStore.state.localNetworkMode).toBe(false);
});

it("gives custom accessors explicit settings and preset state", () => {
  const item: SettingItem = {
    id: "accessor",
    type: "check",
    getValue: ({ preset }) => preset.localNetworkMode,
    setValue: ({ preset }, value: boolean) => {
      preset.localNetworkMode = value;
    },
  };
  setSettingValue(item, true, ctx);
  expect(getSettingValue(item, ctx)).toBe(true);
});
