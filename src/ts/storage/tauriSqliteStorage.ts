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
import type {
    ISqlStorage,
    SqlLoadDatabaseOptions,
    SqlLoadDatabaseResult,
} from './ISqlStorage'
import type {
    NodePostgresRevision,
    NodePostgresMessageSearchResult,
    NodePostgresTokenUsage,
    NodePostgresCharacterSearchResult,
    NodePostgresBotChatStats,
} from './nodePostgresStorage'
import { createSqlDatabaseAdapter } from './databaseAdapters.svelte'
import { isTauri } from '../platform'
import { appDataDir, join } from '@tauri-apps/api/path'
import sqliteSchemaSql from './sqlite-schema.sql?raw'
import { buildSqlReplaceCommit, SqlRevisionConflictError, type SqlCommit, type SqlCommitResult } from './sqlCommit'
import { applySqliteCommit } from './sqliteCommit'

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
                this.revision = Number(rows[0].revision) || 0
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

        // Also merge plugin_custom_storage table if present
        if (!db.pluginCustomStorage || Object.keys(db.pluginCustomStorage).length === 0) {
            const pluginStorageRows = await this.selectRows<{ key: string; value: string }>(
                'SELECT key, value FROM plugin_custom_storage',
            )
            if (pluginStorageRows.length > 0) {
                db.pluginCustomStorage = {}
                for (const row of pluginStorageRows) {
                    try { db.pluginCustomStorage[row.key] = JSON.parse(row.value) }
                    catch { db.pluginCustomStorage[row.key] = row.value }
                }
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
            return { status: 'empty', revision: this.revision, database: null }
        }

        if (shallow) {
            const adapter = createSqlDatabaseAdapter(
                db,
                this,
                ['personas', 'botPresets', 'loreBook', 'modules', 'prompts', 'scripts'],
            )
            return { status: 'ready', revision: this.revision, database: adapter }
        }

        return { status: 'ready', revision: this.revision, database: db }
    }

    async commit(commit: SqlCommit): Promise<SqlCommitResult> {
        if (!this._enabled || !this.db) throw new Error('SQLite storage is not enabled')
        await this.execute('BEGIN IMMEDIATE')
        try {
            const meta = await this.selectOne<{ revision: number }>('SELECT revision FROM system_storage_meta WHERE singleton = 1')
            const currentRevision = Number(meta?.revision) || 0
            if (commit.baseRevision !== currentRevision) throw new SqlRevisionConflictError(currentRevision)
            if (commit.replaceAll) {
                await this.execute('DELETE FROM system_settings')
                await this.execute('DELETE FROM plugin_custom_storage')
                await this.execute('DELETE FROM characters')
            }
            await applySqliteCommit(commit, (sql, bind = []) => this.execute(sql, bind))
            const revision = currentRevision + 1
            await this.execute("UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1", [revision])
            const action = commit.action || (commit.replaceAll ? 'replace-all' : 'sync')
            await this.execute("INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))", [revision, action])
            await this.execute('COMMIT')
            this.revision = revision
            return { revision }
        } catch (error) {
            await this.execute('ROLLBACK').catch(() => undefined)
            throw error
        }
    }

    async replaceDatabase(database: DatabaseType, onProgress?: (status: string) => void): Promise<boolean> {
        onProgress?.('Replacing local database...')
        await this.commit(buildSqlReplaceCommit(database, this.revision))
        return true
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

    async loadChat(chatId: string, options?: { messageLimit?: number }): Promise<Chat | null> {
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

        const totalRow = await this.selectOne<{ total: number }>('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?', [chatId])
        const total = Number(totalRow?.total ?? 0)
        const limit = options?.messageLimit
        const offset = limit === undefined ? 0 : Math.max(0, total - Math.max(1, Math.floor(limit)))
        const msgRows = limit === undefined
            ? await this.selectRows<{ data: string }>('SELECT data FROM messages WHERE chat_id = ? ORDER BY position', [chatId])
            : await this.selectRows<{ data: string }>('SELECT data FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?', [chatId, limit, offset])
        chatData.message = msgRows.map((r) => JSON.parse(r.data))
        chatData.messageOffset = offset
        chatData.messageTotal = total
        chatData.messagesFullyLoaded = offset === 0
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

    async loadChatMessagePage(chatId: string, before: number | undefined, limit: number) {
        const totalRow = await this.selectOne<{ total: number }>('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?', [chatId])
        const total = Number(totalRow?.total ?? 0)
        const end = Math.min(total, Math.max(0, before ?? total))
        const offset = Math.max(0, end - Math.max(1, Math.floor(limit)))
        const msgRows = await this.selectRows<{ data: string }>(
            'SELECT data FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?',
            [chatId, end - offset, offset],
        )
        return {
            messages: msgRows.map((row) => JSON.parse(row.data)),
            offset,
            total,
            hasMore: offset > 0,
        }
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
        const settingRow = await this.selectOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'pluginCustomStorage'")
        if (settingRow && settingRow.value) {
            try {
                const parsed = JSON.parse(settingRow.value)
                if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                    return parsed
                }
            } catch {}
        }
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
        return { revision: this.revision, revisionId }
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

    async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
        const chars = await this.selectRows<{ id: string; name: string; image: string | null; kind: string; last_interaction_time: number | null }>(
            'SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position ASC'
        )
        const chatRows = await this.selectRows<{ id: string; character_id: string; last_message_time: number | null }>(
            'SELECT id, character_id, last_message_time FROM chats'
        )
        const msgRows = await this.selectRows<{ chat_id: string; role: string; sent_time: number | null; data: string }>(
            'SELECT chat_id, role, sent_time, data FROM messages'
        )

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
            let len = 0
            try {
                const parsed = JSON.parse(m.data)
                len = typeof parsed.data === 'string' ? parsed.data.length : 0
            } catch {
                len = (m.data || '').length
            }
            list.push({ role: m.role, sentTime: m.sent_time != null ? Number(m.sent_time) : null, len })
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
