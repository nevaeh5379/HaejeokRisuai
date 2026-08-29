import { changeLanguage } from "../../lang";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import type { ISqlStorage, SqlStartupDataResult } from "./ISqlStorage";
import { normalizeSettingsDefaults, type SettingsInput } from "./databaseDefaults";

export function installStartupData(
  startup: SqlStartupDataResult,
  storage: ISqlStorage,
): void {
  normalizeSettingsDefaults(startup.settings as SettingsInput);

  const language = startup.settings.language;
  if (language) {
    void changeLanguage(language).then(() => {
      if (settingsStore.state.language === language) {
        settingsStore.state.language = language;
      }
    });
  }

  characterStore.init(startup.characters, storage);
  settingsStore.init(startup.settings, storage, {
    deferredUnloaded: startup.deferredSettingKeys ?? [],
  });
}
