import type { ProtocolSettingKeys } from "@risuai/protocol/settings.ts";
import type { NormalizedSettingsState } from "../../storage/database/databaseDefaults";
import type { DatabaseSettings } from "../../storage/database/schema";

export type PresetSettingKey = ProtocolSettingKeys["PRESET_STORE_SETTING_KEYS"];
type OtherDomainKey =
  | ProtocolSettingKeys["DOMAIN_STORE_SETTING_KEYS"]
  | ProtocolSettingKeys["NON_SETTINGS_ROOT_KEYS"];

/** Public live state, distinct from the combined import/backup schema. */
export type PresetState = Pick<DatabaseSettings, PresetSettingKey>;
export type SettingsState = Omit<
  NormalizedSettingsState,
  PresetSettingKey | OtherDomainKey
>;
export type SettingsKey = keyof SettingsState;
