import type { Database } from '../../storage/database.svelte'
import type { ISqlStorage } from '../../storage/ISqlStorage'
import { getSqlStorage } from '../../storage/sqlStorageFactory'
import { DBState } from '../../stores.svelte'

class SettingsStore {
    private storage: ISqlStorage | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null
    private pendingUpserts = new Map<string, unknown>()
    private pendingDeletes = new Set<string>()

    state = $state<Record<string, any>>({})

    init(initialSettings: Partial<Database>, storage: ISqlStorage): void {
        this.storage = storage
        this.state = { ...initialSettings }
    }

    private scheduleCommit(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
        }
        this.debounceTimer = setTimeout(() => {
            void this.flush()
        }, 300)
    }

    async flush(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        if (this.pendingUpserts.size === 0 && this.pendingDeletes.size === 0) {
            return
        }
        const storage = this.storage || await getSqlStorage()
        const upserts = Array.from(this.pendingUpserts.entries()).map(([key, value]) => ({ key, value }))
        const deletes = Array.from(this.pendingDeletes)
        this.pendingUpserts.clear()
        this.pendingDeletes.clear()

        try {
            await storage.commit({
                baseRevision: storage.getRevision(),
                root: {
                    upserts,
                    deletes,
                },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [],
                messageManifests: [],
            })
        } catch (error) {
            console.error('[SettingsStore] Failed to commit setting changes to SQL storage:', error)
        }
    }

    get<K extends keyof Database>(key: K): Database[K] | undefined {
        const keyStr = String(key)
        if (keyStr in this.state) {
            return this.state[keyStr]
        }
        return DBState.db ? DBState.db[key] : undefined
    }

    set<K extends keyof Database>(key: K, value: Database[K]): void {
        const keyStr = String(key)
        this.state[keyStr] = value
        if (DBState.db && DBState.db[key] !== value) {
            DBState.db[key] = value
        }
        this.pendingDeletes.delete(keyStr)
        this.pendingUpserts.set(keyStr, value)
        this.scheduleCommit()
    }

    update(updater: (state: Record<string, any>) => void): void {
        updater(this.state)
        for (const [key, value] of Object.entries(this.state)) {
            this.pendingUpserts.set(key, value)
        }
        this.scheduleCommit()
    }

    delete(key: keyof Database): void {
        const keyStr = String(key)
        delete this.state[keyStr]
        if (DBState.db) {
            delete DBState.db[key]
        }
        this.pendingUpserts.delete(keyStr)
        this.pendingDeletes.add(keyStr)
        this.scheduleCommit()
    }
}

export const settingsStore = new SettingsStore()
