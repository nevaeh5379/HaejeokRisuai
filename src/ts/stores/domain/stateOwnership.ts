import type { ProtocolSettingKeys } from "@risuai/protocol/settings.ts";
import type { NormalizedSettingsState } from "../../storage/database/databaseDefaults";
import type { PresetSettings } from "../../storage/presets/presetSchema";
export type { PresetSettingKey } from "../../storage/presets/presetSchema";
import type { PresetSettingKey } from "../../storage/presets/presetSchema";

type OtherDomainKey =
  | ProtocolSettingKeys["DOMAIN_STORE_SETTING_KEYS"]
  | ProtocolSettingKeys["NON_SETTINGS_ROOT_KEYS"];

/** Public live state, distinct from the combined import/backup schema. */
export type PresetState = PresetSettings;
export type SettingsState = Omit<
  NormalizedSettingsState,
  PresetSettingKey | OtherDomainKey
>;
export type SettingsKey = keyof SettingsState;
