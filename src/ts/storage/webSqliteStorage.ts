import type {
    Database,
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
import sqliteSchemaSql from './sqlite-schema.sql?raw'

interface Sqlite3Module {
    oo1: {
        OpfsDb: new (filename: string) => SqliteDb
        DB: new (filename: string, mode: string) => SqliteDb
    }
    version: { libVersion: string }
}

interface SqliteStmt {
    bind: (params: unknown[]) => void
    step: () => boolean
    get: () => unknown[]
    columnNames: string[]
    finalize: () => void
}

interface SqliteDb {
    exec: (sql: string) => void
    prepare: (sql: string) => SqliteStmt
    close: () => void
}

let sqlite3Singleton: Sqlite3Module | null = null
let sqlite3InitFailed = false

async function getSqlite3(): Promise<Sqlite3Module> {
    if (sqlite3InitFailed) {
        throw new Error('SQLite WASM is not available in this browser')
    }
    if (sqlite3Singleton) {
        return sqlite3Singleton
    }
    try {
        const mod = await import('@sqlite.org/sqlite-wasm')
        const sqlite3InitModule = mod.default ?? (mod as any).sqlite3InitModule
        if (!sqlite3InitModule) {
            throw new Error('sqlite3InitModule not found in module')
        }
        const sqlite3 = await sqlite3InitModule()
        sqlite3Singleton = sqlite3 as unknown as Sqlite3Module
        return sqlite3Singleton
    } catch (error) {
        sqlite3InitFailed = true
        console.error('Failed to load SQLite WASM:', error)
        throw new Error('SQLite WASM is not available in this browser')
    }
}

const DB_FILE = '/risuai-local.sqlite3'

export class WebSqliteStorage implements ISqlStorage {
    readonly backendKind = 'web-sqlite' as const

    private db: SqliteDb | null = null
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
        try {
            const sqlite3 = await getSqlite3()
            if (!('opfs' in sqlite3)) {
                throw new Error('OPFS not available')
            }
            this.db = new sqlite3.oo1.OpfsDb(DB_FILE)
            this.db.exec(sqliteSchemaSql)

            const rows = this.selectRows('SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1')
            if (rows.length > 0) {
                this.cache = createNodeDatabaseSyncCache(Number(rows[0].revision) || 0)
            }
            this._enabled = true
            this.initialized = true
            return this._enabled
        } catch (error) {
            console.error('WebSqliteStorage init failed:', error)
            this.initialized = true
            this._enabled = false
            return false
        }
    }

    private selectRows(sql: string, bind: unknown[] = []): Record<string, unknown>[] {
        if (!this.db) throw new Error('Database not opened')
        const stmt = this.db.prepare(sql)
        try {
            if (bind.length > 0) stmt.bind(bind)
            const results: Record<string, unknown>[] = []
            const cols = stmt.columnNames
            while (stmt.step()) {
                const row = stmt.get() as unknown[]
                const obj: Record<string, unknown> = {}
                for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
                results.push(obj)
            }
            return results
        } finally {
            stmt.finalize()
        }
    }

    private selectOne(sql: string, bind: unknown[] = []): Record<string, unknown> | null {
        return this.selectRows(sql, bind)[0] ?? null
    }

    private run(sql: string, bind: unknown[] = []): void {
        if (!this.db) throw new Error('Database not opened')
        if (bind.length === 0) {
            this.db.exec(sql)
        } else {
            const stmt = this.db.prepare(sql)
            try {
                stmt.bind(bind)
                stmt.step()
            } finally {
                stmt.finalize()
            }
        }
    }

    async loadDatabase(options?: SqlLoadDatabaseOptions): Promise<SqlLoadDatabaseResult | null> {
        if (!this._enabled) {
            const ok = await this.init()
            if (!ok) return null
        }
        const shallow = options?.shallow !== false
        const db: Database = {} as any

        const settingsRows = this.selectRows('SELECT key, value FROM system_settings')
        for (const row of settingsRows) {
            try { (db as any)[row.key as string] = JSON.parse(row.value as string) }
            catch { (db as any)[row.key as string] = row.value }
        }

        const charRows = this.selectRows(
            'SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, data FROM characters ORDER BY position',
        )
        const characters: (character | groupChat)[] = []
        for (const row of charRows) {
            if (shallow) {
                characters.push({
                    chaId: row.id as string,
                    type: (row.kind as 'character' | 'group') ?? 'character',
                    name: (row.name as string) ?? '',
                    image: (row.image as string) ?? '',
                    trashTime: (row.trash_time as number) ?? undefined,
                    creationDate: (row.creation_time as number) ?? undefined,
                    modificationDate: (row.modification_time as number) ?? undefined,
                    lastInteraction: (row.last_interaction_time as number) ?? undefined,
                    detailsLoaded: false,
                    chats: [],
                    chatPage: 0,
                } as any)
            } else {
                const fullChar = row.data ? JSON.parse(row.data as string) : {}
                fullChar.chaId = row.id
                fullChar.detailsLoaded = true
                const chatRows = this.selectRows(
                    'SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE character_id = ? ORDER BY position',
                    [row.id],
                )
                const chats: Chat[] = []
                for (const cr of chatRows) {
                    const cd = cr.data ? JSON.parse(cr.data as string) : {}
                    cd.id = cr.id; cd.name = (cr.name as string) ?? ''; cd.note = (cr.note as string) ?? ''
                    cd.folderId = (cr.folder_id as string) ?? undefined
                    cd.lastDate = (cr.last_message_time as number) ?? undefined
                    cd.message = []; cd.messagesLoaded = false; cd.detailsLoaded = true
                    chats.push(cd)
                }
                fullChar.chats = chats
                characters.push(fullChar)
            }
        }
        db.characters = characters

        const metaRow = this.selectOne('SELECT initialized FROM system_storage_meta WHERE singleton = 1')
        const isInit = metaRow?.initialized === 1 || characters.length > 0 || settingsRows.length > 0
        if (!isInit) return { status: 'empty', revision: this.cache.revision, database: null }

        this.cache = primeNodeDatabaseSyncCache(db, this.cache.revision)
        if (shallow) {
            const adapter = createSqlDatabaseAdapter(db, this)
            return { status: 'ready', revision: this.cache.revision, database: adapter }
        }
        return { status: 'ready', revision: this.cache.revision, database: db }
    }

    async saveDatabase(database: Database, changes: toSaveType, options?: SqlSaveDatabaseOptions): Promise<boolean> {
        if (!this._enabled) return false
        const forceFull = options?.forceFull ?? false
        options?.onProgress?.('Saving to local SQLite...')

        const built = buildNodeDatabaseSync(database, changes, this.cache, { forceFull })
        if (!built) return true
        const p = built.payload

        for (const u of p.root.upserts) {
            this.run("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                [u.key, JSON.stringify(u.value)])
        }
        for (const d of p.root.deletes) {
            this.run('DELETE FROM system_settings WHERE key = ?', [d])
        }

        for (const c of p.characters) {
            const cd = c.data as Record<string, unknown>
            const dj = JSON.stringify({ ...cd, chaId: undefined, chats: undefined, detailsLoaded: undefined })
            this.run(`INSERT OR REPLACE INTO characters
                (id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, data, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
                [c.id, c.position, (cd as any).type ?? 'character', (cd as any).name ?? '',
                 (cd as any).image ?? null, (cd as any).trashTime ?? null,
                 (cd as any).creationDate ?? null, (cd as any).modificationDate ?? null,
                 (cd as any).lastInteraction ?? null, dj])
        }
        if (p.characterIds) {
            const ph = p.characterIds.map(() => '?').join(',')
            this.run(`DELETE FROM characters WHERE id NOT IN (${ph})`, p.characterIds)
        }

        for (const c of p.chats) {
            const cd = c.data as Record<string, unknown>
            const dj = JSON.stringify({ ...cd, id: undefined, message: undefined, messagesLoaded: undefined, detailsLoaded: undefined })
            this.run(`INSERT OR REPLACE INTO chats
                (id, character_id, position, name, note, folder_id, last_message_time, messages_loaded, data, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
                [c.id, c.characterId, c.position, (cd as any).name ?? '', (cd as any).note ?? '',
                 (cd as any).folderId ?? null, (cd as any).lastDate ?? null, dj])
        }
        for (const m of p.chatManifests) {
            if (m.ids.length > 0) {
                const ph = m.ids.map(() => '?').join(',')
                this.run(`DELETE FROM chats WHERE character_id = ? AND id NOT IN (${ph})`, [m.characterId, ...m.ids])
            } else {
                this.run('DELETE FROM chats WHERE character_id = ?', [m.characterId])
            }
        }

        for (const m of p.messages) {
            const md = m.data as Record<string, unknown>
            this.run('INSERT OR REPLACE INTO messages (chat_id, id, position, role, sent_time, data) VALUES (?, ?, ?, ?, ?, ?)',
                [m.chatId, m.id, m.position, (md as any).role ?? 'char', (md as any).time ?? null, JSON.stringify(md)])
        }
        for (const m of p.messageManifests) {
            if (m.ids.length > 0) {
                const ph = m.ids.map(() => '?').join(',')
                this.run(`DELETE FROM messages WHERE chat_id = ? AND id NOT IN (${ph})`, [m.chatId, ...m.ids])
            } else {
                this.run('DELETE FROM messages WHERE chat_id = ?', [m.chatId])
            }
        }

        const newRev = this.cache.revision + 1
        this.run("UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1", [newRev])
        built.nextCache.revision = newRev
        built.nextCache.initialized = true
        this.cache = built.nextCache
        options?.onProgress?.('Save complete')
        return true
    }

    async replaceDatabase(database: Database, onProgress?: (status: string) => void): Promise<boolean> {
        onProgress?.('Clearing local database...')
        this.run('DELETE FROM messages')
        this.run('DELETE FROM chats')
        this.run('DELETE FROM characters')
        this.run('DELETE FROM system_settings')
        return this.saveDatabase(database,
            { character: [], chat: [], botPreset: false, modules: false, loadouts: false, plugins: false, pluginCustomStorage: false },
            { forceFull: true, onProgress })
    }

    async loadCharacter(characterId: string): Promise<character | groupChat | null> {
        const row = this.selectOne('SELECT data FROM characters WHERE id = ?', [characterId])
        if (!row || !row.data) return null
        const fc = JSON.parse(row.data as string)
        fc.chaId = characterId; fc.detailsLoaded = true
        const cr = this.selectRows('SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE character_id = ? ORDER BY position', [characterId])
        const chats: Chat[] = []
        for (const r of cr) {
            const cd = r.data ? JSON.parse(r.data as string) : {}
            cd.id = r.id; cd.name = (r.name as string) ?? ''; cd.note = (r.note as string) ?? ''
            cd.folderId = (r.folder_id as string) ?? undefined
            cd.lastDate = (r.last_message_time as number) ?? undefined
            cd.message = []; cd.messagesLoaded = false; cd.detailsLoaded = true
            chats.push(cd)
        }
        fc.chats = chats
        return fc
    }

    async loadChat(chatId: string): Promise<Chat | null> {
        const cr = this.selectOne('SELECT id, name, note, folder_id, last_message_time, data FROM chats WHERE id = ?', [chatId])
        if (!cr) return null
        const cd = cr.data ? JSON.parse(cr.data as string) : {}
        cd.id = cr.id; cd.name = (cr.name as string) ?? ''; cd.note = (cr.note as string) ?? ''
        cd.folderId = (cr.folder_id as string) ?? undefined
        cd.lastDate = (cr.last_message_time as number) ?? undefined
        const mr = this.selectRows('SELECT data FROM messages WHERE chat_id = ? ORDER BY position', [chatId])
        cd.message = mr.map((r) => JSON.parse(r.data as string))
        cd.messagesLoaded = true; cd.detailsLoaded = true
        return cd
    }

    async loadChatMessages(chatId: string): Promise<Message[]> {
        return this.selectRows('SELECT data FROM messages WHERE chat_id = ? ORDER BY position', [chatId])
            .map((r) => JSON.parse(r.data as string))
    }

    async loadPersonas(): Promise<RisuPersona[]> {
        const r = this.selectOne("SELECT value FROM system_settings WHERE key = 'personas'")
        if (!r) return []
        try { return JSON.parse(r.value as string) } catch { return [] }
    }
    async loadBotPresets(): Promise<botPreset[]> {
        const r = this.selectOne("SELECT value FROM system_settings WHERE key = 'botPresets'")
        if (!r) return []
        try { return JSON.parse(r.value as string) } catch { return [] }
    }
    async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
        const r = this.selectOne("SELECT value FROM system_settings WHERE key = 'loreBook'")
        if (!r) return []
        try { return JSON.parse(r.value as string) } catch { return [] }
    }
    async loadModules(): Promise<RisuModule[]> {
        const r = this.selectOne("SELECT value FROM system_settings WHERE key = 'modules'")
        if (!r) return []
        try { return JSON.parse(r.value as string) } catch { return [] }
    }
    async loadPrompts(): Promise<Record<string, any>> {
        const rows = this.selectRows(
            "SELECT key, value FROM system_settings WHERE key IN ('mainPrompt','jailbreak','globalNote','additionalPrompt','supaMemoryPrompt','personaPrompt','emotionPrompt','emotionPrompt2','autoSuggestPrompt','translatorPrompt','instructChatTemplate','JinjaTemplate','customTokenizer','promptTemplate','promptSettings','customPromptTemplateToggle')",
        )
        const p: Record<string, any> = {}
        for (const r of rows) { try { p[r.key as string] = JSON.parse(r.value as string) } catch { p[r.key as string] = r.value } }
        return p
    }
    async loadScripts(): Promise<customscript[]> {
        const r = this.selectOne("SELECT value FROM system_settings WHERE key = 'globalscript'")
        if (!r) return []
        try { return JSON.parse(r.value as string) } catch { return [] }
    }

    async loadPlugins(): Promise<any[] | null> {
        const r = this.selectOne("SELECT data FROM plugins WHERE key = 'plugins'")
        if (!r) return null
        try { return JSON.parse(r.data as string) } catch { return [] }
    }
    async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
        const rows = this.selectRows('SELECT key, value FROM plugin_custom_storage')
        if (rows.length === 0) return null
        const s: Record<string, any> = {}
        for (const r of rows) { try { s[r.key as string] = JSON.parse(r.value as string) } catch { s[r.key as string] = r.value } }
        return s
    }

    async loadSettingKey(key: string): Promise<any> {
        const r = this.selectOne('SELECT value FROM system_settings WHERE key = ?', [key])
        if (!r) return undefined
        try { return JSON.parse(r.value as string) } catch { return r.value }
    }

    async getColdStorageItem(key: string): Promise<unknown | null> {
        const r = this.selectOne('SELECT data FROM cold_storage WHERE key = ?', [key])
        if (!r) return null
        try { return JSON.parse(r.data as string) } catch { return null }
    }
    async listColdStorageItems(): Promise<{ items: string[] }> {
        return { items: this.selectRows('SELECT key FROM cold_storage').map((r) => r.key as string) }
    }
    async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
        this.run("INSERT OR REPLACE INTO cold_storage (key, data, updated_at) VALUES (?, ?, datetime('now'))", [key, JSON.stringify(value)])
        return true
    }
    async removeColdStorageItems(keys: string[]): Promise<number> {
        if (keys.length === 0) return 0
        const ph = keys.map(() => '?').join(',')
        this.run(`DELETE FROM cold_storage WHERE key IN (${ph})`, keys)
        return keys.length
    }
    async pruneColdStorage(retainedKeys: string[]): Promise<number> {
        const all = this.selectRows('SELECT key FROM cold_storage').map((r) => r.key as string)
        return this.removeColdStorageItems(all.filter((k) => !retainedKeys.includes(k)))
    }

    async listRevisions(limit: number = 50): Promise<NodePostgresRevision[]> {
        const rows = this.selectRows(
            'SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC LIMIT ?', [limit],
        )
        return rows.map((r) => ({
            id: Number(r.id), storage_revision: r.storage_revision != null ? Number(r.storage_revision) : null,
            database_initialized: r.database_initialized != null ? Boolean(r.database_initialized) : null,
            scope: r.scope as 'database' | 'cold-storage' | 'restore', action: r.action as string,
            restored_from_revision: r.restored_from_revision != null ? Number(r.restored_from_revision) : null,
            created_at: r.created_at as string, change_count: 0,
        }))
    }
    async restoreRevision(revisionId: number): Promise<{ revision: number; revisionId: number }> {
        return { revision: this.cache.revision, revisionId }
    }

    async searchMessages(query: string, scope: 'all' | 'active' | 'cold' = 'all', limit: number = 50): Promise<NodePostgresMessageSearchResult[]> {
        const rows = this.selectRows(
            'SELECT chat_id, id, position, role, sent_time, data FROM messages WHERE data LIKE ? ORDER BY sent_time DESC LIMIT ?',
            [`%${query}%`, limit],
        )
        return rows.map((r) => {
            const md = JSON.parse(r.data as string)
            return {
                storageState: 'active' as const, archiveId: null, characterId: null, characterName: null,
                chatId: r.chat_id as string, chatName: '', messageId: r.id as string,
                position: Number(r.position), role: r.role as 'user' | 'char',
                sentTime: r.sent_time != null ? Number(r.sent_time) : null,
                senderName: md.name ?? null, snippet: (md.data ?? '').slice(0, 200),
            }
        })
    }
    async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
        const rows = this.selectRows("SELECT data FROM messages WHERE data LIKE '%\"generationInfo\"%'")
        const u: Record<string, { model: string; messageCount: number; totalInputTokens: number; totalOutputTokens: number }> = {}
        for (const r of rows) {
            try {
                const m = JSON.parse(r.data as string)
                const gi = m.generationInfo; if (!gi) continue
                const model = gi.model || 'unknown'
                if (!u[model]) u[model] = { model, messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 }
                u[model].messageCount++; u[model].totalInputTokens += gi.inputTokens ?? 0; u[model].totalOutputTokens += gi.outputTokens ?? 0
            } catch {}
        }
        return Object.values(u)
    }
    async searchCharactersByTag(tag: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = this.selectRows('SELECT id, name, image, kind FROM characters WHERE data LIKE ? LIMIT ?', [`%${tag}%`, limit])
        return rows.map((r) => ({ id: r.id as string, name: r.name as string, image: (r.image as string) ?? null, kind: (r.kind as 'character' | 'group') ?? 'character' }))
    }
    async searchCharactersByName(name: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = this.selectRows('SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?', [`%${name}%`, limit])
        return rows.map((r) => ({ id: r.id as string, name: r.name as string, image: (r.image as string) ?? null, kind: (r.kind as 'character' | 'group') ?? 'character' }))
    }
}