import { globalAuthorNoteStore } from "../../stores/domain/globalAuthorNoteStore";
import { changeLanguage } from "../../../lang";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { deferredSettingsLoader } from "../../stores/domain/deferredSettingsLoader";
import type { ISqlStorage, SqlStartupDataResult } from "../sql/ISqlStorage";
import {
  normalizeSettingsDefaults,
  type SettingsInput,
} from "./databaseDefaults";

export async function installStartupData(
  startup: SqlStartupDataResult,
  storage: ISqlStorage,
): Promise<void> {
  normalizeSettingsDefaults(startup.settings as SettingsInput);

  const language = startup.settings.language;
  if (language) {
    void changeLanguage(language).then(() => {
      if (settingsStore.state.language === language) {
        settingsStore.state.language = language;
      }
    });
  }

  await globalAuthorNoteStore.init(storage);
  characterStore.init(startup.characters, storage);
  settingsStore.init(startup.settings, storage);
  deferredSettingsLoader.init({
    storage,
    unloadedKeys: startup.deferredSettingKeys ?? [],
    hydrateSettingKey: (key, value, exists) =>
      settingsStore.hydrateSettingKey(key, value, exists),
    hydrateRemoteSettingKey: (key, value, exists) =>
      settingsStore.hydrateRemoteSettingKey(key, value, exists),
  });
}
