import { changeLanguage } from "../../lang";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { DEFERRED_STARTUP_SETTING_KEYS } from "./sqlDeferredSettings";
import type { ISqlStorage } from "./ISqlStorage";
import type { Database } from "./schema";
import { normalizeDatabaseDefaults } from "./databaseDefaults";

export interface DomainStoreInitializationOptions {
  deferredUnloaded?: readonly string[];
}

export function initializeDomainStores(
  data: Database,
  storage: ISqlStorage | null = null,
  options: DomainStoreInitializationOptions = {},
): void {
  characterStore.init(data.characters ?? [], storage);
  settingsStore.init(data, storage, options);
}

export function installDatabase(
  data: Database,
  storage: ISqlStorage | null = null,
): void {
  const isSql = (data as Database & { isSql?: boolean }).isSql === true;
  const deferredUnloaded = isSql
    ? DEFERRED_STARTUP_SETTING_KEYS.filter(
        (key) => !Object.prototype.hasOwnProperty.call(data, key),
      )
    : [];

  normalizeDatabaseDefaults(data);
  if (data.language) {
    void changeLanguage(data.language).then(() => {
      if (settingsStore.state.language === data.language) {
        settingsStore.state.language = data.language;
      }
    });
  }
  initializeDomainStores(data, storage, { deferredUnloaded });
}
