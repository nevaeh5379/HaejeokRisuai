import type { DatabaseSettings } from "@risuai/protocol/domain/database.ts";
import type {
  ISqlStorage,
  State,
} from "@risuai/storage-core/sqlStorage";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
} from "../storage/sql/sqlDeferredSettings";

/** App initial state, without any character, chat, message or asset records. */
export interface InitialData extends State {
  settings: Partial<DatabaseSettings>;
  characterCount: number;
  deferredSettingKeys: string[];
}

const EXCLUDED_KEYS = new Set<string>(SETTINGS_STORE_EXCLUDED_KEYS);
const DEFERRED_KEYS = new Set<string>(DEFERRED_STARTUP_SETTING_KEYS);
const SETTINGS_BATCH_SIZE = 32;

/** Composes domain reads; never requests a character list or a database snapshot.
 * Retries boundedly if another writer changes the revision between queries. */
export async function loadInitialData(
  storage: ISqlStorage,
): Promise<InitialData> {
  if (!storage.isEnabled() && !(await storage.init())) {
    throw new Error("Failed to initialize SQL storage for initial loading");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await storage.getState();
    const settings: Record<string, unknown> = {};
    const deferredSettingKeys = [...DEFERRED_KEYS];
    let characterCount = 0;

    if (before.initialized) {
      const keys = [...new Set(await storage.setting.keys())];
      const initialKeys: string[] = [];
      for (const key of keys) {
        if (EXCLUDED_KEYS.has(key)) continue;
        if (!DEFERRED_KEYS.has(key)) initialKeys.push(key);
      }
      for (
        let offset = 0;
        offset < initialKeys.length;
        offset += SETTINGS_BATCH_SIZE
      ) {
        const batch = initialKeys.slice(offset, offset + SETTINGS_BATCH_SIZE);
        const values = await storage.setting.getMany(batch);
        for (const key of batch) {
          if (values.has(key)) settings[key] = values.get(key);
        }
      }
      characterCount = await storage.character.count();
      if (!Number.isSafeInteger(characterCount) || characterCount < 0) {
        throw new Error("SQL storage returned an invalid character count");
      }
    }

    const after = await storage.getState();
    if (
      before.revision === after.revision &&
      before.initialized === after.initialized
    ) {
      return { ...after, settings, characterCount, deferredSettingKeys };
    }
  }
  throw new Error("SQL storage kept changing during initial loading");
}
