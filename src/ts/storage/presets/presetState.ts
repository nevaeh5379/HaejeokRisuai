import rfdc from "rfdc";
import type { StoredBotPreset } from "../sql/ISqlStorage";
import {
  createPresetSettings,
  PRESET_SETTING_KEYS,
  retainsMissingPresetField,
  type PresetSettings,
} from "./presetSchema";
import { normalizePromptTemplate } from "./promptTemplateNormalization";

const clone = rfdc();

export interface PresetApplyPolicy {
  doNotChangeSeperateModels: boolean;
  doNotChangeFallbackModels: boolean;
  disableSeperateParameterChangeOnPresetChange: boolean;
}
export const defaultPresetApplyPolicy: PresetApplyPolicy = {
  doNotChangeSeperateModels: false,
  doNotChangeFallbackModels: false,
  disableSeperateParameterChangeOnPresetChange: false,
};

/** Normalizes documents without consulting aggregate database/settings state. */
export function createPresetSettingsState(
  preset: Partial<PresetSettings>,
  previous?: PresetSettings,
  policy: PresetApplyPolicy = defaultPresetApplyPolicy,
): PresetSettings {
  const input = { ...preset };
  input.openrouterSubRequestModel ??= preset.openrouterRequestModel;
  if (previous) {
    for (const key of PRESET_SETTING_KEYS) {
      if (input[key] == null && retainsMissingPresetField(key)) {
        Object.assign(input, { [key]: previous[key] });
      }
    }
    if (policy.doNotChangeSeperateModels) {
      input.seperateModelsForAxModels = previous.seperateModelsForAxModels;
      input.seperateModels = previous.seperateModels;
      input.providerModelOverrides = previous.providerModelOverrides;
    }
    if (policy.doNotChangeFallbackModels) {
      input.fallbackModels = previous.fallbackModels;
      input.fallbackWhenBlankResponse = previous.fallbackWhenBlankResponse;
    }
    if (policy.disableSeperateParameterChangeOnPresetChange) {
      input.seperateParameters = previous.seperateParameters;
    }
  }
  input.openrouterSubRequestModel ??=
    preset.openrouterRequestModel ?? input.openrouterRequestModel;
  input.customProxySubRequestModel ??= preset.customProxyRequestModel ?? "";
  // Old portable presets sometimes stored the provider as a single name.
  if (typeof input.openrouterProvider === "string") {
    input.openrouterProvider = {
      order: input.openrouterProvider ? [input.openrouterProvider] : [],
      only: [],
      ignore: [],
    };
  }
  const state = createPresetSettings(input);
  state.promptTemplate = normalizePromptTemplate(state.promptTemplate);
  return state;
}

export function createActivePresetSnapshot(
  state: PresetSettings,
  metadata: Pick<StoredBotPreset, "id" | "name" | "image">,
  policy: Pick<
    PresetApplyPolicy,
    "doNotChangeSeperateModels"
  > = defaultPresetApplyPolicy,
): StoredBotPreset {
  const snapshot: StoredBotPreset = { ...clone(state), ...metadata };
  if (policy.doNotChangeSeperateModels) {
    snapshot.seperateModelsForAxModels = false;
    snapshot.seperateModels = null;
    snapshot.providerModelOverrides = null;
  }
  return snapshot;
}
