import type { Database } from '../../storage/database.svelte'
import { directUpdateSetting, directDeleteSetting } from '../../api/client/directClient'
import { DBState } from '../../stores.svelte'

class SettingsStore {
    get<K extends keyof Database>(key: K): Database[K] | undefined {
        return DBState.db ? DBState.db[key] : undefined
    }

    async set<K extends keyof Database>(key: K, value: Database[K]): Promise<void> {
        if (DBState.db) {
            DBState.db[key] = value
        }
        await directUpdateSetting(String(key), value)
    }

    async delete(key: keyof Database): Promise<void> {
        if (DBState.db) {
            delete DBState.db[key]
        }
        await directDeleteSetting(String(key))
    }
}

export const settingsStore = new SettingsStore()
