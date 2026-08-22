import type { Database } from '../../storage/database.svelte'
import type { ISqlStorage } from '../../storage/ISqlStorage'
import { getSqlStorage } from '../../storage/sqlStorageFactory'

function snapshotFingerprint(value: unknown): string {
    try {
        const serialized = JSON.stringify(value)
        if (!serialized) return ''
        let hash = 2166136261
        for (let index = 0; index < serialized.length; index++) {
            hash ^= serialized.charCodeAt(index)
            hash = Math.imul(hash, 16777619)
        }
        return `${serialized.length}:${hash >>> 0}`
    } catch {
        return ''
    }
}

function trackDeep(value: unknown, seen = new WeakSet<object>()): void {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return
    seen.add(value as object)
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob || value instanceof Date) return
    if (value instanceof Map) {
        for (const [key, item] of value) {
            trackDeep(key, seen)
            trackDeep(item, seen)
        }
        return
    }
    if (value instanceof Set) {
        for (const item of value) trackDeep(item, seen)
        return
    }
    for (const key of Object.keys(value)) trackDeep((value as Record<string, unknown>)[key], seen)
}

class SettingsStore {
    private storage: ISqlStorage | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null
    private pendingUpserts = new Map<string, unknown>()
    private pendingDeletes = new Set<string>()
    private pendingPluginStorageUpserts = new Map<string, unknown>()
    private pendingPluginStorageDeletes = new Set<string>()
    private pendingPluginStorageClear = false
    private keyDisposers = new Map<string, () => void>()
    private keySetDispose: (() => void) | null = null
    private previousFingerprints = new Map<string, string>()

    state = $state<Record<string, any>>({})

    init(initialSettings: Partial<Database>, storage: ISqlStorage | null): void {
        this.storage = storage
        for (const dispose of this.keyDisposers.values()) dispose()
        this.keyDisposers.clear()
        this.keySetDispose?.(); this.keySetDispose = null
        this.previousFingerprints.clear()
        this.pendingUpserts.clear()
        this.pendingDeletes.clear()
        this.pendingPluginStorageUpserts.clear()
        this.pendingPluginStorageDeletes.clear()
        this.pendingPluginStorageClear = false

        const adapter = initialSettings as Partial<Database> & { getLoadedRootKeys?: () => string[] }
        const keys = adapter.getLoadedRootKeys?.() ?? Object.keys(initialSettings)
        const settingsCopy = Object.fromEntries(keys.map((key) => [key, (initialSettings as any)[key]]))
        delete (settingsCopy as any).characters
        delete (settingsCopy as any).isSql
        delete (settingsCopy as any).botPresets
        delete (settingsCopy as any).botPresetsId
        settingsCopy.pluginCustomStorage ??= {}

        for (const [key, val] of Object.entries(settingsCopy)) {
            if (key === 'characters' || key === 'isSql' || key === 'pluginCustomStorage') continue
            this.previousFingerprints.set(key, snapshotFingerprint($state.snapshot(val)))
        }

        this.state = settingsCopy
        this.observe()
    }

    private observe(): void {
        for (const key of Object.keys(this.state)) this.observeKey(key)
        this.keySetDispose = $effect.root(() => {
            $effect(() => {
                const keys = new Set(Object.keys(this.state))
                for (const key of keys) this.observeKey(key)
                for (const key of this.previousFingerprints.keys()) {
                    if (!keys.has(key)) {
                        this.previousFingerprints.delete(key)
                        this.pendingUpserts.delete(key)
                        this.pendingDeletes.add(key)
                        this.scheduleCommit()
                    }
                }
            })
        })
    }

    private observeKey(key: string): void {
        if (this.keyDisposers.has(key) || key === 'characters' || key === 'isSql' || key === 'pluginCustomStorage' || key === 'botPresets' || key === 'botPresetsId') return
        const dispose = $effect.root(() => {
            $effect(() => {
                const val = this.state[key]
                if (!Object.prototype.hasOwnProperty.call(this.state, key)) {
                    this.previousFingerprints.delete(key)
                    this.pendingUpserts.delete(key)
                    this.pendingDeletes.add(key)
                    this.scheduleCommit()
                    return
                }
                trackDeep(val)
                const snapshot = $state.snapshot(val)
                const fp = snapshotFingerprint(snapshot)
                const prev = this.previousFingerprints.get(key)
                if (prev !== fp) {
                    this.previousFingerprints.set(key, fp)
                    this.pendingDeletes.delete(key)
                    this.pendingUpserts.set(key, snapshot)
                    this.scheduleCommit()
                }
            })
        })
        this.keyDisposers.set(key, dispose)
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
        const hasRootChanges = this.pendingUpserts.size > 0 || this.pendingDeletes.size > 0
        const hasPluginChanges = this.pendingPluginStorageUpserts.size > 0 || this.pendingPluginStorageDeletes.size > 0 || this.pendingPluginStorageClear
        if (!hasRootChanges && !hasPluginChanges) {
            return
        }
        const storage = this.storage || await getSqlStorage()
        const upserts = Array.from(this.pendingUpserts.entries()).map(([key, value]) => ({ key, value }))
        const deletes = Array.from(this.pendingDeletes)
        this.pendingUpserts.clear()
        this.pendingDeletes.clear()

        let pluginStoragePayload: import('../../storage/sqlCommit').SqlCommit['pluginStorage'] = undefined
        if (hasPluginChanges) {
            pluginStoragePayload = {
                upserts: Array.from(this.pendingPluginStorageUpserts.entries()).map(([key, value]) => ({ key, value })),
                deletes: Array.from(this.pendingPluginStorageDeletes),
                clear: this.pendingPluginStorageClear || undefined,
            }
            this.pendingPluginStorageUpserts.clear()
            this.pendingPluginStorageDeletes.clear()
            this.pendingPluginStorageClear = false
        }

        try {
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'settings',
                root: {
                    upserts,
                    deletes,
                },
                pluginStorage: pluginStoragePayload,
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
        return this.state[keyStr]
    }

    set<K extends keyof Database>(key: K, value: Database[K]): void {
        const keyStr = String(key)
        this.state[keyStr] = value
        if (keyStr === 'pluginCustomStorage') {
            if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    this.setPluginCustomStorageKey(k, v)
                }
            }
            return
        }
        this.observeKey(keyStr)
        this.pendingDeletes.delete(keyStr)
        this.pendingUpserts.set(keyStr, $state.snapshot(value))
        this.scheduleCommit()
    }

    update(updater: (state: Record<string, any>) => void): void {
        updater(this.state)
        for (const [key, value] of Object.entries(this.state)) {
            if (key === 'characters' || key === 'isSql' || key === 'pluginCustomStorage') continue
            this.pendingDeletes.delete(key)
            this.pendingUpserts.set(key, $state.snapshot(value))
        }
        this.scheduleCommit()
    }

    /** Apply storage-derived runtime values without turning hydration into a write. */
    hydrate(updater: (state: Record<string, any>) => void): void {
        updater(this.state)
        for (const [key, value] of Object.entries(this.state)) {
            if (key === 'characters' || key === 'isSql' || key === 'pluginCustomStorage' || key === 'botPresets' || key === 'botPresetsId') continue
            this.observeKey(key)
            this.previousFingerprints.set(key, snapshotFingerprint($state.snapshot(value)))
            this.pendingUpserts.delete(key)
            this.pendingDeletes.delete(key)
        }
    }

    delete(key: keyof Database): void {
        const keyStr = String(key)
        if (keyStr === 'pluginCustomStorage') {
            this.clearPluginCustomStorage()
            return
        }
        delete this.state[keyStr]
        this.keyDisposers.get(keyStr)?.()
        this.keyDisposers.delete(keyStr)
        this.previousFingerprints.delete(keyStr)
        this.pendingUpserts.delete(keyStr)
        this.pendingDeletes.add(keyStr)
        this.scheduleCommit()
    }

    getPluginCustomStorage(): Record<string, any> {
        this.state.pluginCustomStorage ??= {}
        return this.state.pluginCustomStorage
    }

    setPluginCustomStorageKey(key: string, value: any): void {
        this.state.pluginCustomStorage ??= {}
        this.state.pluginCustomStorage[key] = value
        this.pendingPluginStorageDeletes.delete(key)
        this.pendingPluginStorageUpserts.set(key, $state.snapshot(value))
        this.scheduleCommit()
    }

    removePluginCustomStorageKey(key: string): void {
        if (this.state.pluginCustomStorage) {
            delete this.state.pluginCustomStorage[key]
        }
        this.pendingPluginStorageUpserts.delete(key)
        this.pendingPluginStorageDeletes.add(key)
        this.scheduleCommit()
    }

    clearPluginCustomStorage(): void {
        this.state.pluginCustomStorage = {}
        this.pendingPluginStorageUpserts.clear()
        this.pendingPluginStorageDeletes.clear()
        this.pendingPluginStorageClear = true
        this.scheduleCommit()
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        for (const dispose of this.keyDisposers.values()) dispose()
        this.keyDisposers.clear()
        this.keySetDispose?.(); this.keySetDispose = null
    }
}

export const settingsStore = new SettingsStore()
