import type { SettingItem, SettingContext, SettingKey } from "./types";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { isPresetStoreSettingKey } from "../storage/sql/sqlDeferredSettings";
import { language } from "src/lang";
import { accessibilitySettingsItems } from "./accessibilitySettingsData";
import { advancedSettingsItems } from "./advancedSettingsData";
import {
  basicParameterItems,
  modelSpecificParameterItems,
  penaltyParameterItems,
  samplingParameterItems,
  seedSetting,
} from "./botSettingsParamsData";
import { chatFormatSettingsItems } from "./chatFormatSettingsData";
import { displaySettingsItems } from "./displaySettingsData.svelte";

/**
 * Sentinel value representing an uninitialized local state in wrapper components.
 * Used instead of `undefined` so that a legitimate `undefined` DB value
 * can still be written back without being silently ignored.
 */
export const UNINITIALIZED = Symbol("uninitialized");

function getSetting(key: SettingKey) {
  return isPresetStoreSettingKey(key)
    ? presetStore.state[key]
    : settingsStore.state[key];
}

function setSetting(key: SettingKey, value: any): void {
  if (isPresetStoreSettingKey(key)) presetStore.set(key, value);
  else settingsStore.set(key, value);
}

export function getLabel(item: SettingItem): string {
  if (item.labelKey && (language as any)[item.labelKey]) {
    return (language as any)[item.labelKey];
  }
  return item.fallbackLabel ?? "";
}

export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
  if (item.getValue) {
    return item.getValue(ctx);
  }
  if (item.bindPath) {
    const parts = item.bindPath.split(".");
    // SettingPath checks the root and nested key when the item is defined.
    let value: any = getSetting(parts.shift() as SettingKey);
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
  if (item.bindKey) {
    return getSetting(item.bindKey);
  }
  return undefined;
}

export function setSettingValue(
  item: SettingItem,
  newValue: any,
  ctx: SettingContext,
): void {
  if (item.setValue) {
    item.setValue(ctx, newValue);
    if (item.bindKey) setSetting(item.bindKey, getSetting(item.bindKey));
  } else if (item.bindPath) {
    const parts = item.bindPath.split(".");
    const root = parts.shift() as SettingKey;
    const state: any = getSetting(root) ?? {};
    let obj: any = state;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] ??= {};
    }
    obj[parts[parts.length - 1]] = newValue;
    setSetting(root, state);
  } else if (item.bindKey) {
    setSetting(item.bindKey, newValue);
  }

  if (item.onChange) {
    item.onChange(newValue, ctx);
  }
}

/**
 * Check if item should be visible based on condition
 */
export function checkCondition(
  item: SettingItem,
  ctx: SettingContext,
): boolean {
  if (!item.condition) return true;
  return item.condition(ctx);
}

export function getFullSettingsData(searchTerm = "") {
  const full = accessibilitySettingsItems.concat(
    advancedSettingsItems,
    basicParameterItems,
    seedSetting,
    samplingParameterItems,
    penaltyParameterItems,
    modelSpecificParameterItems,
    chatFormatSettingsItems,
    displaySettingsItems,
  );

  if (!searchTerm) return full;

  const lowerSearch = searchTerm.toLowerCase();
  return full.filter((item) => {
    const label = getLabel(item).toLowerCase();
    const keywords = item.keywords?.map((k) => k.toLowerCase()) || [];
    return (
      label.includes(lowerSearch) ||
      keywords.some((k) => k.includes(lowerSearch))
    );
  });
}
