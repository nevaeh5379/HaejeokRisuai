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

/** Normalizes one document using its own values and schema defaults. */
export function createPresetSettingsState(
  preset: Partial<PresetSettings>,
): PresetSettings {
  const input = { ...preset };
  input.openrouterSubRequestModel ??= input.openrouterRequestModel;
  input.customProxySubRequestModel ??= input.customProxyRequestModel;
  // Compatibility with old portable presets, independent of the active state.
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

/** Values stored globally when excluded from the active preset document. */
export function getSeparateModelSettings(state: Partial<PresetSettings>) {
  return {
    seperateModelsForAxModels: state.seperateModelsForAxModels,
    seperateModels: state.seperateModels,
    providerModelOverrides: state.providerModelOverrides,
  };
}

/** Applies a different preset to a running state, including legacy keep rules. */
export function applyPresetSettings(
  preset: Partial<PresetSettings>,
  previous: PresetSettings,
  policy: PresetApplyPolicy,
): PresetSettings {
  const incoming = { ...preset };
  incoming.openrouterSubRequestModel ??= preset.openrouterRequestModel;
  const state = createPresetSettingsState(incoming);
  for (const key of PRESET_SETTING_KEYS) {
    if (incoming[key] == null && retainsMissingPresetField(key)) {
      Object.assign(state, { [key]: clone(previous[key]) });
    }
  }
  if (policy.doNotChangeSeperateModels) {
    Object.assign(state, clone(getSeparateModelSettings(previous)));
  }
  if (policy.doNotChangeFallbackModels) {
    state.fallbackModels = clone(previous.fallbackModels);
    state.fallbackWhenBlankResponse = previous.fallbackWhenBlankResponse;
  }
  if (policy.disableSeperateParameterChangeOnPresetChange) {
    state.seperateParameters = clone(previous.seperateParameters);
  }
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
