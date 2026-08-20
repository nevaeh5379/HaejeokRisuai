import type { Database, character, groupChat, Chat, Message, RisuPersona, botPreset, loreBook, customscript } from './database.svelte'
import type { RisuModule } from '../process/modules'
import type { SqlCommit, SqlCommitResult } from './sqlCommit'
import type {
    NodePostgresServerConfig,
    NodePostgresServerConfigUpdate,
    NodePostgresRevision,
    NodePostgresMessageSearchResult,
    NodePostgresTokenUsage,
    NodePostgresCharacterSearchResult,
} from './nodePostgresStorage'

export type SqlBackendKind = 'node' | 'web-sqlite' | 'tauri-sqlite'

export interface SqlLoadDatabaseOptions {
    shallow?: boolean
}

export interface SqlLoadDatabaseResult {
    status: 'ready' | 'empty'
    revision: number
    database: Database | null
}

export interface SqlCharacterMetadata {
    chaId: string
    name: string
    image: string | null
    type: 'character' | 'group'
    trashTime: number | null
    creationTime: number | null
    modificationTime: number | null
    lastInteractionTime: number | null
}

export interface SqlChatMetadata {
    id: string
    name: string
    note: string
    folderId: string | null
    lastDate: number | null
}

/**
 * Core SQL storage interface that every backend (Node server, web SQLite WASM,
 * Tauri SQLite) must implement. This is the single contract the rest of the
 * app talks to — no more database.bin / localForage / OPFS branching at the
 * call sites.
 *
 * Domain lazy-loading contract:
 *  - `loadDatabase({ shallow: true })` returns core settings + character/chat
 *    *metadata only* (no messages, no full character detail).
 *  - `loadCharacter(id)` returns a full character (with chats list but without
 *    message arrays).
 *  - `loadChat(id)` returns a full chat *with* its message array.
 *  - Domain loaders (`loadPersonas`, `loadBotPresets`, …) fetch one domain at
 *    a time, allowing the adapter to keep unloaded domains out of memory.
 */
export interface ISqlStorage {
    readonly backendKind: SqlBackendKind

    isEnabled(): boolean
    getRevision(): number

    // ── Lifecycle / config ──────────────────────────────────────────────

    /**
     * Initialise the backend (open DB, apply schema, connect to remote, …).
     * Must be idempotent. Resolves to `true` when the storage is ready to
     * serve reads/writes.
     */
    init(): Promise<boolean>

    // ── Database-level load / save ───────────────────────────────────────

    loadDatabase(options?: SqlLoadDatabaseOptions): Promise<SqlLoadDatabaseResult | null>

    commit(commit: SqlCommit): Promise<SqlCommitResult>

    replaceDatabase(database: Database, onProgress?: (status: string) => void): Promise<boolean>

    // ── Per-entity lazy loaders ──────────────────────────────────────────

    loadCharacter(characterId: string): Promise<character | groupChat | null>
    loadChat(chatId: string): Promise<Chat | null>
    loadChatMessages(chatId: string): Promise<Message[]>

    // ── Domain loaders (deferred by the adapter) ─────────────────────────

    loadPersonas(): Promise<RisuPersona[]>
    loadBotPresets(): Promise<botPreset[]>
    loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]>
    loadModules(): Promise<RisuModule[]>
    loadPrompts(): Promise<Record<string, any>>
    loadScripts(): Promise<customscript[]>

    // ── Plugins ──────────────────────────────────────────────────────────

    loadPlugins(): Promise<any[] | null>
    loadPluginCustomStorage(): Promise<Record<string, any> | null>

    // ── Settings ─────────────────────────────────────────────────────────

    loadSettingKey(key: string): Promise<any>

    // ── Cold storage ─────────────────────────────────────────────────────

    getColdStorageItem(key: string): Promise<unknown | null>
    listColdStorageItems(): Promise<{ items: string[] }>
    setColdStorageItem(key: string, value: unknown): Promise<boolean>
    removeColdStorageItems(keys: string[]): Promise<number>
    pruneColdStorage(retainedKeys: string[]): Promise<number>

    // ── Revisions / history ──────────────────────────────────────────────

    listRevisions(limit?: number): Promise<NodePostgresRevision[]>
    restoreRevision(revisionId: number): Promise<{ revision: number; revisionId: number }>

    // ── Search ───────────────────────────────────────────────────────────

    searchMessages(
        query: string,
        scope?: 'all' | 'active' | 'cold',
        limit?: number,
    ): Promise<NodePostgresMessageSearchResult[]>
    getTokenUsage(): Promise<NodePostgresTokenUsage[]>
    searchCharactersByTag(tag: string, limit?: number): Promise<NodePostgresCharacterSearchResult[]>
    searchCharactersByName(name: string, limit?: number): Promise<NodePostgresCharacterSearchResult[]>
}

/**
 * Node-server-only operations (external PostgreSQL/Oracle/Azure config,
 * backup DB management, DB explorer table inspection). These are not part of
 * the core {@link ISqlStorage} contract because the browser/Tauri SQLite
 * backends are always "enabled" and have no external connection to configure.
 */
export interface INodeSqlStorageAdmin extends ISqlStorage {
    getServerConfig(): Promise<NodePostgresServerConfig>
    configureServer(update: NodePostgresServerConfigUpdate): Promise<NodePostgresServerConfig>
    getDatabaseConfig(): Promise<NodePostgresServerConfig & {
        params: Record<string, any>
        storedVendor: import('./nodePostgresStorage').DbVendor | null
    }>
    applyDatabaseConfig(
        vendor: import('./nodePostgresStorage').DbVendor,
        params: Record<string, any>,
        migrate: boolean,
    ): Promise<NodePostgresServerConfig & {
        params: Record<string, any>
        storedVendor: import('./nodePostgresStorage').DbVendor | null
    }>
    testConnection(
        vendor: import('./nodePostgresStorage').DbVendor,
        params: Record<string, any>,
    ): Promise<{ success: boolean; error?: string }>
    migrateLegacyData(): Promise<{ success: boolean; migrated: number; skipped: number }>
    listDbTables(): Promise<import('./nodePostgresStorage').NodePostgresTableInfo[]>
    getDbTableData(
        table: string,
        options?: {
            offset?: number
            limit?: number
            sortColumn?: string
            sortOrder?: 'asc' | 'desc'
            search?: string
            columns?: string[]
        },
    ): Promise<import('./nodePostgresStorage').NodePostgresTableData>
}

/**
 * Type guard: does the given storage expose Node-server admin operations?
 */
export function isNodeSqlStorageAdmin(storage: ISqlStorage): storage is INodeSqlStorageAdmin {
    return storage.backendKind === 'node'
}
