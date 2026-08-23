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
import type {
    ISqlStorage,
    SqlLoadDatabaseOptions,
    SqlLoadDatabaseResult,
    BotPresetSummary,
    StoredBotPreset,
} from './ISqlStorage'
import type {
    NodePostgresRevision,
    NodePostgresRevisionDetails,
    NodePostgresRevisionDiff,
    NodePostgresRestorePreview,
    NodePostgresMessageSearchResult,
    NodePostgresTokenUsage,
    NodePostgresCharacterSearchResult,
    NodePostgresBotChatStats,
} from './nodePostgresStorage'
import { createSqlDatabaseAdapter } from './databaseAdapters.svelte'
import sqliteSchemaSql from './sqlite-schema.sql?raw'
import { buildSqlReplaceCommit, SqlRevisionConflictError, type SqlCommit, type SqlCommitResult } from './sqlCommit'
import { applySqliteCommit, writeSqliteColdStorage } from './sqliteCommit'
import { rebuildRelationalValue, RELATIONAL_SCHEMA_LAYOUT, SQLITE_SCHEMA_VERSION, SqlSchemaResetRequiredError } from './relationalNodeCodec'

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
    private revision = 0
    private initialized = false
    private _enabled = false

    isEnabled(): boolean {
        return this._enabled
    }

    getRevision(): number {
        return this.revision
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
            const existingMeta = this.selectRows(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_storage_meta'",
            )
            if (existingMeta.length) {
                const meta = this.selectOne('SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1')
                if (Number(meta?.schema_version) !== SQLITE_SCHEMA_VERSION || meta?.schema_layout !== RELATIONAL_SCHEMA_LAYOUT) {
                    throw new SqlSchemaResetRequiredError(meta?.schema_version, meta?.schema_layout)
                }
            }
            this.db.exec(sqliteSchemaSql)

            const rows = this.selectRows('SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1')
            if (rows.length > 0) {
                this.revision = Number(rows[0].revision) || 0
            }
            this._enabled = true
            this.initialized = true
            return this._enabled
        } catch (error) {
            console.error('WebSqliteStorage init failed:', error)
            this.initialized = true
            this._enabled = false
            if (error instanceof SqlSchemaResetRequiredError) throw error
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

    private loadNodeValue(table: string, ownerWhere: string, bind: unknown[]): unknown {
        const rows = this.selectRows(`SELECT node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value, number_value,
            boolean_value FROM ${table} WHERE ${ownerWhere} ORDER BY node_id`, bind)
        return rows.length ? rebuildRelationalValue(rows) : undefined
    }

    private loadSettingValue(key: string): unknown {
        return this.loadNodeValue('setting_extension_nodes', 'setting_key = ?', [key])
    }

    private validatePresetCommit(commit: SqlCommit): void {
        if (!commit.presets) return
        const originalIds = this.selectRows('SELECT preset_id FROM bot_presets ORDER BY position').map((row) => row.preset_id as string)
        const ids = new Set(originalIds)
        if (commit.replaceAll) ids.clear()
        for (const id of commit.presets.deletes) ids.delete(id)
        for (const entry of commit.presets.upserts) ids.add(entry.id)
        if (ids.size === 0) throw new Error('At least one bot preset must remain')
        if (commit.presets.order && (commit.presets.order.length !== ids.size ||
            new Set(commit.presets.order).size !== ids.size || commit.presets.order.some((id) => !ids.has(id)))) {
            throw new Error('Preset order must contain every preset ID exactly once')
        }
        if (commit.presets.activeId !== undefined && !ids.has(commit.presets.activeId)) throw new Error('Active bot preset does not exist')
        if (commit.presets.activeId === undefined) {
            const current = this.loadSettingValue('activeBotPresetId') as string | undefined
            if (!current || !ids.has(current)) {
                const index = originalIds.indexOf(current ?? '')
                commit.presets.activeId = originalIds.slice(index + 1).find((id) => ids.has(id)) ||
                    originalIds.slice(0, Math.max(0, index)).reverse().find((id) => ids.has(id)) ||
                    (commit.presets.order || Array.from(ids))[0]
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

        const settingsRows = this.selectRows('SELECT key FROM system_settings')
        for (const row of settingsRows) {
            ;(db as any)[row.key as string] = this.loadSettingValue(row.key as string)
        }

        // Also merge plugin_custom_storage table if present
        if (!db.pluginCustomStorage || Object.keys(db.pluginCustomStorage).length === 0) {
            const pluginStorageRows = this.selectRows('SELECT key, value FROM plugin_custom_storage')
            if (pluginStorageRows.length > 0) {
                db.pluginCustomStorage = {}
                for (const row of pluginStorageRows) {
                    try { db.pluginCustomStorage[row.key as string] = JSON.parse(row.value as string) }
                    catch { db.pluginCustomStorage[row.key as string] = row.value }
                }
            }
        }
        db.pluginCustomStorage ??= {}

        const charRows = this.selectRows(
            'SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position',
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
                const fullChar = (this.loadNodeValue('character_extension_nodes', 'character_id = ?', [row.id]) ?? {}) as any
                fullChar.chaId = row.id
                fullChar.detailsLoaded = true
                const chatRows = this.selectRows(
                    'SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position',
                    [row.id],
                )
                const chats: Chat[] = []
                for (const cr of chatRows) {
                    const cd = (this.loadNodeValue('chat_extension_nodes', 'chat_id = ?', [cr.id]) ?? {}) as any
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
        if (!isInit) return { status: 'empty', revision: this.revision, database: null }
        if (shallow) {
            const adapter = createSqlDatabaseAdapter(
                db,
                this,
                ['personas', 'loreBook', 'modules', 'prompts', 'scripts'],
            )
            return { status: 'ready', revision: this.revision, database: adapter }
        }
        return { status: 'ready', revision: this.revision, database: db }
    }

    async commit(commit: SqlCommit): Promise<SqlCommitResult> {
        if (!this._enabled) throw new Error('SQLite storage is not enabled')
        this.run('BEGIN IMMEDIATE')
        try {
            const meta = this.selectOne('SELECT revision FROM system_storage_meta WHERE singleton = 1')
            const currentRevision = Number(meta?.revision) || 0
            if (commit.baseRevision !== currentRevision) throw new SqlRevisionConflictError(currentRevision)
            this.validatePresetCommit(commit)
            if (commit.replaceAll) {
                this.run('DELETE FROM system_settings')
                this.run('DELETE FROM plugin_custom_storage')
                this.run('DELETE FROM characters')
            }
            await applySqliteCommit(commit, (sql, bind = []) => this.run(sql, bind))
            const revision = currentRevision + 1
            this.run("UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1", [revision])
            const action = commit.action || (commit.replaceAll ? 'replace-all' : 'sync')
            this.run("INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', datetime('now'))", [revision, action])
            this.run('COMMIT')
            this.revision = revision
            return { revision }
        } catch (error) {
            this.run('ROLLBACK')
            throw error
        }
    }

    async replaceDatabase(database: Database, onProgress?: (status: string) => void): Promise<boolean> {
        onProgress?.('Replacing local database...')
        await this.commit(buildSqlReplaceCommit(database, this.revision))
        return true
    }

    async loadCharacter(characterId: string): Promise<character | groupChat | null> {
        const row = this.selectOne('SELECT id FROM characters WHERE id = ?', [characterId])
        if (!row) return null
        const fc = (this.loadNodeValue('character_extension_nodes', 'character_id = ?', [characterId]) ?? {}) as any
        fc.chaId = characterId; fc.detailsLoaded = true
        const cr = this.selectRows('SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position', [characterId])
        const chats: Chat[] = []
        for (const r of cr) {
            const cd = (this.loadNodeValue('chat_extension_nodes', 'chat_id = ?', [r.id]) ?? {}) as any
            cd.id = r.id; cd.name = (r.name as string) ?? ''; cd.note = (r.note as string) ?? ''
            cd.folderId = (r.folder_id as string) ?? undefined
            cd.lastDate = (r.last_message_time as number) ?? undefined
            cd.message = []; cd.messagesLoaded = false; cd.detailsLoaded = true
            chats.push(cd)
        }
        fc.chats = chats
        return fc
    }

    async loadChat(chatId: string, options?: { messageLimit?: number }): Promise<Chat | null> {
        const cr = this.selectOne('SELECT id, name, note, folder_id, last_message_time FROM chats WHERE id = ?', [chatId])
        if (!cr) return null
        const cd = (this.loadNodeValue('chat_extension_nodes', 'chat_id = ?', [chatId]) ?? {}) as any
        cd.id = cr.id; cd.name = (cr.name as string) ?? ''; cd.note = (cr.note as string) ?? ''
        cd.folderId = (cr.folder_id as string) ?? undefined
        cd.lastDate = (cr.last_message_time as number) ?? undefined
        const totalRow = this.selectOne('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?', [chatId])
        const total = Number(totalRow?.total ?? 0)
        const limit = options?.messageLimit
        const offset = limit === undefined ? 0 : Math.max(0, total - Math.max(1, Math.floor(limit)))
        const mr = limit === undefined
            ? this.selectRows('SELECT id FROM messages WHERE chat_id = ? ORDER BY position', [chatId])
            : this.selectRows('SELECT id FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?', [chatId, limit, offset])
        cd.message = mr.map((r) => this.loadNodeValue('message_extension_nodes', 'chat_id = ? AND message_id = ?', [chatId, r.id]))
        cd.messageOffset = offset; cd.messageTotal = total; cd.messagesFullyLoaded = offset === 0
        cd.messagesLoaded = true; cd.detailsLoaded = true
        return cd
    }

    async loadChatMessages(chatId: string): Promise<Message[]> {
        return this.selectRows('SELECT id FROM messages WHERE chat_id = ? ORDER BY position', [chatId])
            .map((r) => this.loadNodeValue('message_extension_nodes', 'chat_id = ? AND message_id = ?', [chatId, r.id]) as Message)
    }

    async loadChatMessagePage(chatId: string, before: number | undefined, limit: number) {
        const totalRow = this.selectOne('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?', [chatId])
        const total = Number(totalRow?.total ?? 0)
        const end = Math.min(total, Math.max(0, before ?? total))
        const offset = Math.max(0, end - Math.max(1, Math.floor(limit)))
        const rows = this.selectRows(
            'SELECT id FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?',
            [chatId, end - offset, offset],
        )
        return {
            messages: rows.map((row) => this.loadNodeValue('message_extension_nodes', 'chat_id = ? AND message_id = ?', [chatId, row.id]) as Message),
            offset,
            total,
            hasMore: offset > 0,
        }
    }

    async loadPersonas(): Promise<RisuPersona[]> {
        return (this.loadSettingValue('personas') as RisuPersona[] | undefined) ?? []
    }
    async listBotPresets(): Promise<BotPresetSummary[]> {
        return this.selectRows('SELECT preset_id, position, name, image, api_type, ai_model, content_hash FROM bot_presets ORDER BY position')
            .map((row) => ({ id: row.preset_id as string, position: Number(row.position),
                name: row.name as string, image: row.image as string, apiType: row.api_type as string,
                aiModel: row.ai_model as string, hash: row.content_hash as string }))
    }
    async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
        const row = this.selectOne('SELECT data FROM bot_presets WHERE preset_id = ?', [id])
        if (!row) return null
        return { ...(JSON.parse(row.data as string) as botPreset), id }
    }
    async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
        return (this.loadSettingValue('loreBook') as { name: string; data: loreBook[] }[] | undefined) ?? []
    }
    async loadModules(): Promise<RisuModule[]> {
        return (this.loadSettingValue('modules') as RisuModule[] | undefined) ?? []
    }
    async loadPrompts(): Promise<Record<string, any>> {
        const rows = this.selectRows("SELECT key FROM system_settings WHERE domain = 'prompt'")
        const p: Record<string, any> = {}
        for (const r of rows) p[r.key as string] = this.loadSettingValue(r.key as string)
        return p
    }
    async loadScripts(): Promise<customscript[]> {
        return (this.loadSettingValue('globalscript') as customscript[] | undefined) ?? []
    }

    async loadPlugins(): Promise<any[] | null> {
        return (this.loadSettingValue('plugins') as any[] | undefined) ?? null
    }
    async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
        const rows = this.selectRows('SELECT key, value FROM plugin_custom_storage')
        if (rows.length === 0) return null
        const s: Record<string, any> = {}
        for (const r of rows) { try { s[r.key as string] = JSON.parse(r.value as string) } catch { s[r.key as string] = r.value } }
        return s
    }

    async listPluginCustomStorageKeys(): Promise<string[]> {
        return this.selectRows('SELECT key FROM plugin_custom_storage ORDER BY key')
            .map((row) => row.key as string)
    }

    async loadPluginCustomStorageKey(key: string): Promise<any> {
        const row = this.selectOne('SELECT value FROM plugin_custom_storage WHERE key = ?', [key])
        if (!row) return undefined
        try { return JSON.parse(row.value as string) } catch { return row.value }
    }

    async loadSettingKey(key: string): Promise<any> {
        return this.loadSettingValue(key)
    }

    async getColdStorageItem(key: string): Promise<unknown | null> {
        const r = this.selectOne('SELECT archive_id FROM cold_archives WHERE archive_id = ?', [key])
        return r ? this.loadNodeValue('cold_extension_nodes', 'archive_id = ?', [key]) : null
    }
    async listColdStorageItems(): Promise<{ items: string[] }> {
        return { items: this.selectRows('SELECT archive_id FROM cold_archives').map((r) => r.archive_id as string) }
    }
    async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
        await writeSqliteColdStorage((sql, bind = []) => this.run(sql, bind), key, value)
        return true
    }
    async removeColdStorageItems(keys: string[]): Promise<number> {
        if (keys.length === 0) return 0
        const ph = keys.map(() => '?').join(',')
        this.run(`DELETE FROM cold_archives WHERE archive_id IN (${ph})`, keys)
        return keys.length
    }
    async pruneColdStorage(retainedKeys: string[]): Promise<number> {
        const all = this.selectRows('SELECT archive_id FROM cold_archives').map((r) => r.archive_id as string)
        return this.removeColdStorageItems(all.filter((k) => !retainedKeys.includes(k)))
    }

    async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
        const hasLimit = limit !== undefined && limit !== null && limit > 0
        const sql = 'SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC' + (hasLimit ? ' LIMIT ?' : '')
        const rows = this.selectRows(sql, hasLimit ? [limit] : [])
        return rows.map((r) => ({
            id: Number(r.id), storage_revision: r.storage_revision != null ? Number(r.storage_revision) : null,
            database_initialized: r.database_initialized != null ? Boolean(r.database_initialized) : null,
            scope: r.scope as 'database' | 'cold-storage' | 'restore', action: r.action as string,
            restored_from_revision: r.restored_from_revision != null ? Number(r.restored_from_revision) : null,
            created_at: r.created_at as string, change_count: 0,
        }))
    }

    async getRevisionDetails(revisionId: number): Promise<NodePostgresRevisionDetails | null> {
        const rows = this.selectRows(
            'SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions WHERE id = ?', [revisionId]
        )
        if (rows.length === 0) return null
        const r = rows[0]
        return {
            id: Number(r.id),
            storage_revision: r.storage_revision != null ? Number(r.storage_revision) : null,
            database_initialized: r.database_initialized != null ? Boolean(r.database_initialized) : null,
            scope: r.scope as 'database' | 'cold-storage' | 'restore',
            action: r.action as string,
            restored_from_revision: r.restored_from_revision != null ? Number(r.restored_from_revision) : null,
            created_at: r.created_at as string,
            change_count: 0,
            tableSummaries: [],
            auditLogs: [],
        }
    }

    async getRevisionDiff(baseId: number, targetId: number): Promise<NodePostgresRevisionDiff | null> {
        return {
            baseRevisionId: baseId,
            targetRevisionId: targetId,
            totalChanges: 0,
            tables: [],
        }
    }

    async previewRestoreRevision(revisionId: number): Promise<NodePostgresRestorePreview | null> {
        return {
            targetRevisionId: revisionId,
            currentRevisionId: this.revision,
            revisionsToRevert: Math.max(0, this.revision - revisionId),
            totalOperations: 0,
            restoreInsertCount: 0,
            restoreDeleteCount: 0,
            restoreUpdateCount: 0,
            affectedTables: [],
        }
    }

    async restoreRevision(revisionId: number): Promise<{ revision: number; revisionId: number }> {
        return { revision: this.revision, revisionId }
    }

    async searchMessages(query: string, scope: 'all' | 'active' | 'cold' = 'all', limit: number = 50): Promise<NodePostgresMessageSearchResult[]> {
        const rows = this.selectRows(
            `SELECT chat_id, id, position, role, sent_time, sender_name, content_text
             FROM messages WHERE content_text LIKE ? ORDER BY sent_time DESC LIMIT ?`,
            [`%${query}%`, limit],
        )
        return rows.map((r) => {
            return {
                storageState: 'active' as const, archiveId: null, characterId: null, characterName: null,
                chatId: r.chat_id as string, chatName: '', messageId: r.id as string,
                position: Number(r.position), role: r.role as 'user' | 'char',
                sentTime: r.sent_time != null ? Number(r.sent_time) : null,
                senderName: (r.sender_name as string) ?? null, snippet: String(r.content_text ?? '').slice(0, 200),
            }
        })
    }
    async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
        return this.selectRows(`SELECT COALESCE(generation_model, 'unknown') AS model,
            COUNT(*) AS message_count, COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens FROM messages
            WHERE generation_model IS NOT NULL GROUP BY generation_model`).map((row) => ({
            model: row.model as string, messageCount: Number(row.message_count),
            totalInputTokens: Number(row.input_tokens), totalOutputTokens: Number(row.output_tokens),
        }))
    }
    async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
        const chars = this.selectRows('SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position ASC') as { id: string; name: string; image: string | null; kind: string; last_interaction_time: number | null }[]
        const chatRows = this.selectRows('SELECT id, character_id, last_message_time FROM chats') as { id: string; character_id: string; last_message_time: number | null }[]
        const msgRows = this.selectRows('SELECT chat_id, role, sent_time, length(COALESCE(content_text, content_encoded, \'\')) AS content_length FROM messages') as { chat_id: string; role: string; sent_time: number | null; content_length: number }[]

        const chatsByChar = new Map<string, { id: string; lastMessageTime: number | null }[]>()
        for (const ch of chatRows) {
            let list = chatsByChar.get(ch.character_id)
            if (!list) {
                list = []
                chatsByChar.set(ch.character_id, list)
            }
            list.push({ id: ch.id, lastMessageTime: ch.last_message_time != null ? Number(ch.last_message_time) : null })
        }

        const msgsByChat = new Map<string, { role: string; sentTime: number | null; len: number }[]>()
        for (const m of msgRows) {
            let list = msgsByChat.get(m.chat_id)
            if (!list) {
                list = []
                msgsByChat.set(m.chat_id, list)
            }
            list.push({ role: m.role, sentTime: m.sent_time != null ? Number(m.sent_time) : null, len: Number(m.content_length) })
        }

        return chars.map((c) => {
            const charChats = chatsByChar.get(c.id) || []
            let totalMessages = 0
            let userMessages = 0
            let botMessages = 0
            let longestSessionMessages = 0
            let lastActiveDate: number | null = c.last_interaction_time != null ? Number(c.last_interaction_time) : null
            let totalBotLen = 0
            let totalUserLen = 0

            for (const ch of charChats) {
                if (ch.lastMessageTime != null && (lastActiveDate == null || ch.lastMessageTime > lastActiveDate)) {
                    lastActiveDate = ch.lastMessageTime
                }
                const msgs = msgsByChat.get(ch.id) || []
                if (msgs.length > longestSessionMessages) {
                    longestSessionMessages = msgs.length
                }
                totalMessages += msgs.length
                for (const m of msgs) {
                    if (m.sentTime != null && (lastActiveDate == null || m.sentTime > lastActiveDate)) {
                        lastActiveDate = m.sentTime
                    }
                    if (m.role === 'user') {
                        userMessages++
                        totalUserLen += m.len
                    } else {
                        botMessages++
                        totalBotLen += m.len
                    }
                }
            }

            const isGroup = c.kind === 'group'
            const totalSessions = charChats.length
            return {
                id: c.id,
                name: c.name || (isGroup ? 'Group' : 'Character'),
                avatarKey: c.image ?? undefined,
                image: c.image ?? undefined,
                isGroup,
                totalSessions,
                totalMessages,
                userMessages,
                botMessages,
                longestSessionMessages,
                lastActiveDate,
                avgBotMessageLen: botMessages > 0 ? Math.round(totalBotLen / botMessages) : 0,
                avgUserMessageLen: userMessages > 0 ? Math.round(totalUserLen / userMessages) : 0,
                avgMessagesPerSession: totalSessions > 0 ? Number((totalMessages / totalSessions).toFixed(1)) : 0,
            }
        })
    }
    async searchCharactersByTag(tag: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = this.selectRows(`SELECT DISTINCT c.id, c.name, c.image, c.kind FROM characters c
            JOIN character_tags t ON t.character_id = c.id WHERE t.tag LIKE ? LIMIT ?`, [`%${tag}%`, limit])
        return rows.map((r) => ({ id: r.id as string, name: r.name as string, image: (r.image as string) ?? null, kind: (r.kind as 'character' | 'group') ?? 'character' }))
    }
    async searchCharactersByName(name: string, limit: number = 100): Promise<NodePostgresCharacterSearchResult[]> {
        const rows = this.selectRows('SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?', [`%${name}%`, limit])
        return rows.map((r) => ({ id: r.id as string, name: r.name as string, image: (r.image as string) ?? null, kind: (r.kind as 'character' | 'group') ?? 'character' }))
    }
}
