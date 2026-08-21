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
    private rootDispose: (() => void) | null = null
    private previousFingerprints = new Map<string, string>()

    state = $state<Record<string, any>>({})

    init(initialSettings: Partial<Database>, storage: ISqlStorage): void {
        this.storage = storage
        this.rootDispose?.()
        this.previousFingerprints.clear()
        this.pendingUpserts.clear()
        this.pendingDeletes.clear()

        const settingsCopy = { ...initialSettings }
        delete (settingsCopy as any).characters
        delete (settingsCopy as any).isSql

        this.state = settingsCopy
        this.observe()
    }

    private observe(): void {
        let initial = true
        this.rootDispose = $effect.root(() => {
            $effect(() => {
                const keys = Object.keys(this.state)
                for (const key of keys) {
                    if (key === 'characters' || key === 'isSql') continue
                    const val = this.state[key]
                    const snapshot = $state.snapshot(val)
                    const fp = snapshotFingerprint(snapshot)
                    if (initial) {
                        trackDeep(val)
                        this.previousFingerprints.set(key, fp)
                    } else {
                        const prev = this.previousFingerprints.get(key)
                        if (prev !== fp) {
                            this.previousFingerprints.set(key, fp)
                            this.pendingDeletes.delete(key)
                            this.pendingUpserts.set(key, snapshot)
                            this.scheduleCommit()
                        }
                    }
                }
                initial = false
            })
        })
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
        return this.state[keyStr]
    }

    set<K extends keyof Database>(key: K, value: Database[K]): void {
        const keyStr = String(key)
        this.state[keyStr] = value
        this.pendingDeletes.delete(keyStr)
        this.pendingUpserts.set(keyStr, $state.snapshot(value))
        this.scheduleCommit()
    }

    update(updater: (state: Record<string, any>) => void): void {
        updater(this.state)
        for (const [key, value] of Object.entries(this.state)) {
            this.pendingDeletes.delete(key)
            this.pendingUpserts.set(key, $state.snapshot(value))
        }
        this.scheduleCommit()
    }

    delete(key: keyof Database): void {
        const keyStr = String(key)
        delete this.state[keyStr]
        this.previousFingerprints.delete(keyStr)
        this.pendingUpserts.delete(keyStr)
        this.pendingDeletes.add(keyStr)
        this.scheduleCommit()
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        this.rootDispose?.()
        this.rootDispose = null
    }
}

export const settingsStore = new SettingsStore()
