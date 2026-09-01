import type { SettingItem, SettingContext } from "./types";
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

function stateForKey(key: string): any {
  return isPresetStoreSettingKey(key) ? presetStore.state : settingsStore.state;
}

function stateForItem(item: SettingItem): any {
  const key = item.bindKey ?? item.bindPath?.split(".")[0];
  return key ? stateForKey(key) : settingsStore.state;
}

export function getLabel(item: SettingItem): string {
  if (item.labelKey && (language as any)[item.labelKey]) {
    return (language as any)[item.labelKey];
  }
  return item.fallbackLabel ?? "";
}

export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
  if (item.getValue) {
    return item.getValue(stateForItem(item), ctx);
  }
  if (item.bindPath) {
    const parts = item.bindPath.split(".");
    let value: any = stateForKey(parts[0]);
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
  if (item.bindKey) {
    return stateForKey(item.bindKey)[item.bindKey];
  }
  return undefined;
}

export function setSettingValue(
  item: SettingItem,
  newValue: any,
  ctx: SettingContext,
): void {
  if (item.setValue) {
    const state = stateForItem(item);
    item.setValue(state, newValue, ctx);
    if (item.bindKey) {
      if (!isPresetStoreSettingKey(item.bindKey)) {
        settingsStore.set(item.bindKey as any, state[item.bindKey]);
      }
    }
  } else if (item.bindPath) {
    const parts = item.bindPath.split(".");
    const state = stateForKey(parts[0]);
    let obj: any = state;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] ??= {};
    }
    obj[parts[parts.length - 1]] = newValue;
    if (!isPresetStoreSettingKey(parts[0])) {
      settingsStore.set(parts[0] as any, state[parts[0]]);
    }
  } else if (item.bindKey) {
    if (isPresetStoreSettingKey(item.bindKey)) {
      presetStore.state[item.bindKey] = newValue;
    } else {
      settingsStore.set(item.bindKey as any, newValue);
    }
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
