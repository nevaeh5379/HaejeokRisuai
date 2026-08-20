import type {
    Database as DatabaseType,
    character,
    groupChat,
    Chat,
    Message,
    RisuPersona,
    botPreset,
    loreBook,
    customscript,
} from './database.svelte'
import type { RisuModule } from '../process/modules'
import type { toSaveType } from './risuSave'
import type {
    ISqlStorage,
    SqlLoadDatabaseOptions,
    SqlLoadDatabaseResult,
    SqlSaveDatabaseOptions,
} from './ISqlStorage'
import type {
    NodePostgresRevision,
    NodePostgresMessageSearchResult,
    NodePostgresTokenUsage,
    NodePostgresCharacterSearchResult,
} from './nodePostgresStorage'
import {
    createNodeDatabaseSyncCache,
    primeNodeDatabaseSyncCache,
    buildNodeDatabaseSync,
    type NodeDatabaseSyncCache,
} from './nodeDatabaseSync'
import { createSqlDatabaseAdapter } from './databaseAdapters.svelte'
import { isTauri } from '../platform'
import { appDataDir, join } from '@tauri-apps/api/path'
import sqliteSchemaSql from './sqlite-schema.sql?raw'

type SqlDatabase = import('@tauri-apps/plugin-sql').default

// Lazily imported to avoid loading the plugin in non-Tauri environments
let SQL: typeof import('@tauri-apps/plugin-sql') | null = null

async function getSQL() {
    if (!SQL) {
        SQL = await import('@tauri-apps/plugin-sql')
    }
    return SQL
}

/**
 * Tauri desktop SQLite storage backend.
 *
 * Uses @tauri-apps/plugin-sql (tauri-plugin-sql) to manage a SQLite
 * database file in the app data directory. The Rust plugin handles
 * the native sqlite3 connection; this class issues SQL via the JS API.
 */
export class TauriSqliteStorage implements ISqlStorage {
    readonly backendKind = 'tauri-sqlite' as const

    private db: SqlDatabase | null = null
    private cache: NodeDatabaseSyncCache = createNodeDatabaseSyncCache()
    private initialized = false
    private _enabled = false

    isEnabled(): boolean {
        return this._enabled
    }

    getCache(): NodeDatabaseSyncCache {
        return this.cache
    }

    async init(): Promise<boolean> {
        if (this.initialized) {
            return this._enabled
        }
        if (!isTauri) {
            this.initialized = true
            this._enabled = false
            return false
        }
        try {
            const sql = await getSQL()
            const appDir = await appDataDir()
            const dbPath = await join(appDir, 'risuai-local.sqlite3')
            this.db = await sql.default.load(`sqlite:${dbPath}`)

            // Apply schema
            await this.db.execute(sqliteSchemaSql)

            // Read revision
            const rows = await this.db.select<{ initialized: number; revision: number }[]>(
                'SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1',
            )
            if (rows && rows.length > 0) {
                this.cache = createNodeDatabaseSyncCache(Number(rows[0].revision) || 0)
            }
            this._enabled = true
            this.initialized = true
            return true
        } catch (error) {
            console.error('TauriSqliteStorage init failed:', error)
            this.initialized = true
            this._enabled = false
            return false
        }
    }

    // ── Low-level helpers ───────────────────────────────────────────────

    private async selectRows<T extends Record<string, unknown>>(sql: string, bind: unknown[] = []): Promise<T[]> {
        if (!this.db) throw new Error('Database not opened')
        return this.db.select<T[]>(sql, bind)
    }

    private async selectOne<T extends Record<string, unknown>>(sql: string, bind: unknown[] = []): Promise<T | null> {
        const rows = await this.selectRows<T>(sql, bind)
        return rows[0] ?? null
    }

    private async execute(sql: string, bind: unknown[] = []): Promise<void> {
        if (!this.db) throw new Error('Database not opened')
        await this.db.execute(sql, bind)
    }

    // ── Database-level load / save ───────────────────────────────────────

    async loadDatabase(options?: SqlLoadDatabaseOptions): Promise<SqlLoadDatabaseResult | null> {
        if (!this._enabled) {
            const ok = await this.init()
            if (!ok) return null
        }

        const shallow = options?.shallow !== false
        const db: DatabaseType = {} as any

        // Load all settings
        const settingsRows = await this.selectRows<{ key: string; value: string }>(
            'SELECT key, value FROM system_settings',
        )
        for (const row of settingsRows) {
            try {
                ;(db as any)[row.key] = JSON.parse(row.value)
            } catch {
                ;(db as any)[row.key] = row.value
            }
        }

        // Load characters
        const charRows = await this.selectRows<{
            id: string; position: number; kind: string; name: string; image: string | null;
            trash_time: number | null; creation_time: number | null;
            modification_time: number | null; last_interaction_time: number | null;
            details_loaded: number; data: string | null
        }>('SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, data FROM characters ORDER BY position')

        const characters: (character | groupChat)[] = []
        for (const row of charRows) {
            if (shallow) {
                characters.push({
                    chaId: row.id,
                    type: (row.kind as 'character' | 'group') ?? 'character',
                    name: row.name ?? '',
                    image: row.image ?? '',
                    trashTime: row.trash_time ?? undefined,
                    creationDate: row.creation_time ?? undefined,
                    modificationDate: row.modification_time ?? undefined,
                    lastInteraction: row.last_interaction_time ?? undefined,
                    detailsLoaded: false,
                    chats: [],
                    chatPage: 0,
                } as any)
            } else {
                const fullChar = row.data ? JSON.parse(row.data) : {}
                fullChar.chaId = row.id
                fullChar.detailsLoaded = true
                const chatRows = await this.selectRows<{
                    id: string; name: string; note: string; folder_id: string | null;
                    last_message_time: number | null; data: string | null
                }>('SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE character_id = ? ORDER BY position', [row.id])
                const chats: Chat[] = []
                for (const chatRow of chatRows) {
                    const chatData = chatRow.data ? JSON.parse(chatRow.data) : {}
                    chatData.id = chatRow.id
                    chatData.name = chatRow.name ?? ''
                    chatData.note = chatRow.note ?? ''
                    chatData.folderId = chatRow.folder_id ?? undefined
                    chatData.lastDate = chatRow.last_message_time ?? undefined
                    chatData.message = []
                    chatData.messagesLoaded = false
                    chatData.detailsLoaded = true
                    chats.push(chatData)
                }
                fullChar.chats = chats
                characters.push(fullChar)
            }
        }
        db.characters = characters

        const metaRow = await this.selectOne<{ initialized: number }>(
            'SELECT initialized FROM system_storage_meta WHERE singleton = 1',
        )
        const isInitialized = metaRow?.initialized === 1 || characters.length > 0 || settingsRows.length > 0

        if (!isInitialized) {
            return { status: 'empty', revision: this.cache.revision, database: null }
        }

        this.cache = primeNodeDatabaseSyncCache(db, this.cache.revision)

        if (shallow) {
            const adapter = createSqlDatabaseAdapter(db, this)
            return { status: 'ready', revision: this.cache.revision, database: adapter }
        }

        return { status: 'ready', revision: this.cache.revision, database: db }
    }

    async saveDatabase(
        database: DatabaseType,
        changes: toSaveType,
        options?: SqlSaveDatabaseOptions,
    ): Promise<boolean> {
        if (!this._enabled || !this.db) return false

        const forceFull = options?.forceFull ?? false
        options?.onProgress?.('Saving to local SQLite...')

        const built = buildNodeDatabaseSync(database, changes, this.cache, { forceFull })
        if (!built) return true

        const payload = built.payload

        // Save root settings
        for (const upsert of payload.root.upserts) {
            await this.execute(
                "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                [upsert.key, JSON.stringify(upsert.value)],
            )
        }
        for (const del of payload.root.deletes) {
            await this.execute('DELETE FROM system_settings WHERE key = ?', [del])
        }

        // Save characters
        for (const charEntry of payload.characters) {
            const charData = charEntry.data as Record<string, unknown>
            const chaId = charEntry.id
            const dataJson = JSON.stringify({
                ...charData,
                chaId: undefined,
                chats: undefined,
                detailsLoaded: undefined,
            })
            await this.execute(
                `INSERT OR REPLACE INTO characters
                 (id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, data, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
                [
                    chaId,
                    charEntry.position,
                    (charData as any).type ?? 'character',
                    (charData as any).name ?? '',
                    (charData as any).image ?? null,
                    (charData as any).trashTime ?? null,
                    (charData as any).creationDate ?? null,
                    (charData as any).modificationDate ?? null,
                    (charData as any).lastInteraction ?? null,
                    dataJson,
                ],
            )
        }
        if (payload.characterIds) {
            const placeholders = payload.characterIds.map(() => '?').join(',')
            await this.execute(`DELETE FROM characters WHERE id NOT IN (${placeholders})`, payload.characterIds)
        }

        // Save chats
        for (const chatEntry of payload.chats) {
            const chatData = chatEntry.data as Record<string, unknown>
            const chatId = chatEntry.id
            const dataJson = JSON.stringify({
                ...chatData,
                id: undefined,
                message: undefined,
                messagesLoaded: undefined,
                detailsLoaded: undefined,
            })
            await this.execute(
                `INSERT OR REPLACE INTO chats
                 (id, character_id, position, name, note, folder_id, last_message_time, messages_loaded, data, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
                [
                    chatId,
                    chatEntry.characterId,
                    chatEntry.position,
                    (chatData as any).name ?? '',
                    (chatData as any).note ?? '',
                    (chatData as any).folderId ?? null,
                    (chatData as any).lastDate ?? null,
                    dataJson,
                ],
            )
        }
        for (const manifest of payload.chatManifests) {
            if (manifest.ids.length > 0) {
                const placeholders = manifest.ids.map(() => '?').join(',')
                await this.execute(
                    `DELETE FROM chats WHERE character_id = ? AND id NOT IN (${placeholders})`,
                    [manifest.characterId, ...manifest.ids],
                )
            } else {
                await this.execute('DELETE FROM chats WHERE character_id = ?', [manifest.characterId])
            }
        }

        // Save messages
        for (const msgEntry of payload.messages) {
            const msgData = msgEntry.data as Record<string, unknown>
            const dataJson = JSON.stringify(msgData)
            await this.execute(
                `INSERT OR REPLACE INTO messages (chat_id, id, position, role, sent_time, data) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    msgEntry.chatId,
                    msgEntry.id,
                    msgEntry.position,
                    (msgData as any).role ?? 'char',
                    (msgData as any).time ?? null,
                    dataJson,
                ],
            )
        }
        for (const manifest of payload.messageManifests) {
            if (manifest.ids.length > 0) {
                const placeholders = manifest.ids.map(() => '?').join(',')
                await this.execute(
                    `DELETE FROM messages WHERE chat_id = ? AND id NOT IN (${placeholders})`,
                    [manifest.chatId, ...manifest.ids],
                )
            } else {
                await this.execute('DELETE FROM messages WHERE chat_id = ?', [manifest.chatId])
            }
        }

        // Update revision
        const newRevision = this.cache.revision + 1
        await this.execute(
            "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
            [newRevision],
        )
        built.nextCache.revision = newRevision
        built.nextCache.initialized = true
        this.cache = built.nextCache

        options?.onProgress?.('Save complete')
        return true
    }

    async replaceDatabase(database: DatabaseType, onProgress?: (status: string) => void): Promise<boolean> {
        onProgress?.('Clearing local database...')
        await this.execute('DELETE FROM messages')
        await this.execute('DELETE FROM chats')
        await this.execute('DELETE FROM characters')
        await this.execute('DELETE FROM system_settings')

        return this.saveDatabase(
            database,
            { character: [], chat: [], botPreset: false, modules: false, loadouts: false, plugins: false, pluginCustomStorage: false },
            { forceFull: true, onProgress },
        )
    }

    // ── Per-entity lazy loaders ──────────────────────────────────────────

    async loadCharacter(characterId: string): Promise<character | groupChat | null> {
        const row = await this.selectOne<{ data: string | null }>(
            'SELECT data FROM characters WHERE id = ?', [characterId],
        )
        if (!row || !row.data) return null
        const fullChar = JSON.parse(row.data)
        fullChar.chaId = characterId
        fullChar.detailsLoaded = true

        const chatRows = await this.selectRows<{
            id: string; name: string; note: string; folder_id: string | null;
            last_message_time: number | null; data: string | null
        }>('SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE character_id = ? ORDER BY position', [characterId])
        const chats: Chat[] = []
        for (const chatRow of chatRows) {
            const chatData = chatRow.data ? JSON.parse(chatRow.data) : {}
            chatData.id = chatRow.id
            chatData.name = chatRow.name ?? ''
            chatData.note = chatRow.note ?? ''
            chatData.folderId = chatRow.folder_id ?? undefined
            chatData.lastDate = chatRow.last_message_time ?? undefined
            chatData.message = []
            chatData.messagesLoaded = false
            chatData.detailsLoaded = true
            chats.push(chatData)
        }
        fullChar.chats = chats
        return fullChar
    }

    async loadChat(chatId: string): Promise<Chat | null> {
        const chatRow = await this.selectOne<{
            id: string; name: string; note: string; folder_id: string | null;
            last_message_time: number | null; data: string | null
        }>('SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE id = ?', [chatId])
        if (!chatRow) return null

        const chatData = chatRow.data ? JSON.parse(chatRow.data) : {}
        chatData.id = chatRow.id
        chatData.name = chatRow.name ?? ''
        chatData.note = chatRow.note ?? ''
        chatData.folderId = chatRow.folder_id ?? undefined
        chatData.lastDate = chatRow.last_message_time ?? undefined

        const msgRows = await this.selectRows<{ data: string }>(
            'SELECT data FROM messages WHERE chat_id = ? ORDER BY position', [chatId],
        )
        chatData.message = msgRows.map((r) => JSON.parse(r.data))
        chatData.messagesLoaded = true
        chatData.detailsLoaded = true
        return chatData
    }

    async loadChatMessages(chatId: string): Promise<Message[]> {
        const msgRows = await this.selectRows<{ data: string }>(
            'SELECT data FROM messages WHERE chat_id = ? ORDER BY position', [chatId],
        )
        return msgRows.map((r) => JSON.parse(r.data))
    }

    // ── Domain loaders ───────────────────────────────────────────────────

    async loadPersonas(): Promise<RisuPersona[]> {
        const row = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'personas'")
        if (!row) return []
        try { return JSON.parse(row.value) } catch { return [] }
    }

    async loadBotPresets(): Promise<botPreset[]> {
        const row = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'botPresets'")
        if (!row) return []
        try { return JSON.parse(row.value) } catch { return [] }
    }

    async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
        const row = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'loreBook'")
        if (!row) return []
        try { return JSON.parse(row.value) } catch { return [] }
    }

    async loadModules(): Promise<RisuModule[]> {
        const row = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'modules'")
        if (!row) return []
        try { return JSON.parse(row.value) } catch { return [] }
    }

    async loadPrompts(): Promise<Record<string, any>> {
        const rows = await this.selectRows<{ key: string; value: string }>(
            "SELECT key, value FROM system_settings WHERE key IN ('mainPrompt','jailbreak','globalNote','additionalPrompt','supaMemoryPrompt','personaPrompt','emotionPrompt','emotionPrompt2','autoSuggestPrompt','translatorPrompt','instructChatTemplate','JinjaTemplate','customTokenizer','promptTemplate','promptSettings','customPromptTemplateToggle')",
        )
        const prompts: Record<string, any> = {}
        for (const row of rows) {
            try { prompts[row.key] = JSON.parse(row.value) } catch { prompts[row.key] = row.value }
        }
        return prompts
    }

    async loadScripts(): Promise<customscript[]> {
        const row = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'globalscript'")
        if (!row) return []
        try { return JSON.parse(row.value) } catch { return [] }
    }

    // ── Plugins ──────────────────────────────────────────────────────────

    async loadPlugins(): Promise<any[] | null> {
        const row = await this.selectOne<{ data: string }>("SELECT data FROM plugins WHERE key = 'plugins'")
        if (!row) return null
        try { return JSON.parse(row.data) } catch { return [] }
    }

    async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
        const rows = await this.selectRows<{ key: string; value: string }>(
            'SELECT key, value FROM plugin_custom_storage',
        )
        if (rows.length === 0) return null
        const storage: Record<string, any> = {}
        for (const row of rows) {
            try { storage[row.key] = JSON.parse(row.value) } catch { storage[row.key] = row.value }
        }
        return storage
    }

    // ── Settings ─────────────────────────────────────────────────────────

    async loadSettingKey(key: string): Promise<any> {
        const row = await this.selectOne<{ value: string }>('SELECT value FROM system_settings WHERE key = ?', [key])
        if (!row) return undefined
        try { return JSON.parse(row.value) } catch { return row.value }
    }

    // ── Cold storage ─────────────────────────────────────────────────────

    async getColdStorageItem(key: string): Promise<unknown | null> {
        const row = await this.selectOne<{ data: string }>('SELECT data FROM cold_storage WHERE key = ?', [key])
        if (!row) return null
        try { return JSON.parse(row.data) } catch { return null }
    }

    async listColdStorageItems(): Promise<{ items: string[] }> {
        const rows = await this.selectRows<{ key: string }>('SELECT key FROM cold_storage')
        return { items: rows.map((r) => r.key) }
    }

    async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
        await this.execute(
            "INSERT OR REPLACE INTO cold_storage (key, data, updated_at) VALUES (?, ?, datetime('now'))",
            [key, JSON.stringify(value)],
        )
        return true
    }

    async removeColdStorageItems(keys: string[]): Promise<number> {
        if (keys.length === 0) return 0
        const placeholders = keys.map(() => '?').join(',')
        await this.execute(`DELETE FROM cold_storage WHERE key IN (${placeholders})`, keys)
        return keys.length
    }

    async pruneColdStorage(retainedKeys: string[]): Promise<number> {
        const allRows = await this.selectRows<{ key: string }>('SELECT key FROM cold_storage')
        const toDelete = allRows.map((r) => r.key).filter((k) => !retainedKeys.includes(k))
        return this.removeColdStorageItems(toDelete)
    }

    // ── Revisions ────────────────────────────────────────────────────────

    async listRevisions(limit: number = 50): Promise<NodePostgresRevision[]> {
        const rows = await this.selectRows<{
            id: number; storage_revision: number | null; database_initialized: number | null;
            scope: string; action: string; restored_from_revision: number | null; created_at: string
        }>('SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC LIMIT ?', [limit])
        return rows.map((r) => ({
            id: Number(r.id),
            storage_revision: r.storage_revision != null ? Number(r.storage_revision) : null,
            database_initialized: r.database_initialized != null ? Boolean(r.database_initialized) : null,
            scope: r.scope as 'database' | 'cold-storage' | 'restore',
            action: r.action,
            restored_from_revision: r.restored_from_revision != null ? Number(r.restored_from_revision) : null,
            created_at: r.created_at,
            change_count: 0,
        }))
    }

    async restoreRevision(revisionId: number): Promise<{ revision: number; revisionId: number }> {
        return { revision: this.cache.revision, revisionId }
    }

    // ── Search ───────────────────────────────────────────────────────────

    async searchMessages(query: string, scope: 'all' | 'active' | 'cold' = 'all', limit: number = 50): Promise<NodePostgresMessageSearchResult[]> {
        const rows = await this.selectRows<{ chat_id: string; id: string; position: number; role: string; sent_time: number | null; data: string }>(
            `SELECT chat_id, id, position, role, sent_time, data FROM messages WHERE data LIKE ? ORDER BY sent_time DESC LIMIT ?`,
            [`%${query}%`, limit],
        )
        return rows.map((r) => {
            const msgData = JSON.parse(r.data)
            return {
                storageState: 'active' as const,
                archiveId: null,
                characterId: null,
                characterName: null,
                chatId: r.chat_id,
                chatName: '',
                messageId: r.id,
                position: Number(r.position),
                role: r.role as 'user' | 'char',
                sentTime: r.sent_time != null ? Number(r.sent_time) : null,
                senderName: msgData.name ?? null,
                snippet: (msgData.data ?? '').slice(0, 200),
            }
        })
    }

    async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
        const rows = await this.selectRows<{ data: string }>("SELECT data FROM messages WHERE data LIKE '%\"generationInfo\"%'")
        const usage: Record<string, { model: string; messageCount: number; totalInputTokens: number; totalOutputTokens: number }> = {}
        for (const row of rows) {
            try {
                const msg = JSON.parse(row.data)
                const gi = msg.generationInfo
                if (!gi) continue
                const model = gi.model || 'unknown'
                if (!usage[model]) {
                    usage[model] = { model, messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 }
                }
                usage[model].messageCount++
                usage[model].totalInputTokens += gi.inputTokens ?? 0
                usage[model].totalOutputTokens += gi.outputTokens ?? 0
            } catch {}
        }
        return Object.values(usage)
    }

    async searchCharactersByTag(tag: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = await this.selectRows<{ id: string; name: string; image: string | null; kind: string }>(
            `SELECT id, name, image, kind FROM characters WHERE data LIKE ? LIMIT ?`,
            [`%"tags":%${tag}%`, limit],
        )
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            image: r.image ?? null,
            kind: (r.kind as 'character' | 'group') ?? 'character',
        }))
    }

    async searchCharactersByName(name: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = await this.selectRows<{ id: string; name: string; image: string | null; kind: string }>(
            `SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?`,
            [`%${name}%`, limit],
        )
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            image: r.image ?? null,
            kind: (r.kind as 'character' | 'group') ?? 'character',
        }))
    }
}