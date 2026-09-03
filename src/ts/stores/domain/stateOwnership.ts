import type { ProtocolSettingKeys } from "../../../../packages/protocol/settingKeys";
import type { DatabaseSettings } from "../../storage/database/schema";

export type PresetSettingKey = ProtocolSettingKeys["PRESET_STORE_SETTING_KEYS"];
type OtherDomainKey =
  | ProtocolSettingKeys["DOMAIN_STORE_SETTING_KEYS"]
  | ProtocolSettingKeys["NON_SETTINGS_ROOT_KEYS"];

/** Public live state, distinct from the combined import/backup schema. */
export type PresetState = Pick<DatabaseSettings, PresetSettingKey>;
export type SettingsState = Omit<DatabaseSettings, PresetSettingKey | OtherDomainKey>;
export type SettingsKey = keyof SettingsState;
