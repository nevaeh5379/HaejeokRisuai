import localforage from 'localforage'
import type { Database, Message, character, groupChat, Chat, RisuPersona, botPreset, loreBook, customscript } from './database.svelte'
import type { RisuModule } from '../process/modules'
import type { toSaveType } from './risuSave'
import {
    buildNodeDatabaseSync,
    createNodeDatabaseSyncCache,
    primeNodeDatabaseSyncCache,
    type NodeDatabaseSyncCache,
} from './nodeDatabaseSync'
import { createPostgresDatabaseAdapter } from './databaseAdapters.svelte'

export type DbVendor = 'postgres' | 'oracle' | 'azure'

export interface SqlVendorFormValues {
    connectionString?:string
    server?:string
    database?:string
    user?:string
    password?:string
    tnsAlias?:string
    walletPath?:string
    walletPassword?:string
    port?:number
    poolMax:number
}

export function buildSqlVendorParams(vendor:DbVendor, values:SqlVendorFormValues):Record<string, unknown> {
    if(vendor === 'postgres'){
        return {
            connectionString: values.connectionString?.trim() || '',
            poolMax: values.poolMax,
        }
    }
    if(vendor === 'oracle'){
        return {
            user: values.user?.trim() || '',
            password: values.password || '',
            tnsAlias: values.tnsAlias?.trim() || '',
            walletPath: values.walletPath?.trim() || undefined,
            walletPassword: values.walletPassword || undefined,
            poolMax: values.poolMax,
        }
    }
    return {
        server: values.server?.trim() || '',
        database: values.database?.trim() || '',
        user: values.user?.trim() || '',
        password: values.password || '',
        port: values.port || 1433,
        poolMax: values.poolMax,
    }
}

export function isSqlVendorParamsComplete(vendor:DbVendor, values:SqlVendorFormValues):boolean {
    const params = buildSqlVendorParams(vendor, values)
    if(vendor === 'postgres'){
        return Boolean(params.connectionString)
    }
    if(vendor === 'oracle'){
        return Boolean(params.user && params.password && params.tnsAlias)
    }
    return Boolean(params.server && params.database && params.user && params.password)
}

export interface NodePostgresServerConfig {
    enabled:boolean
    configured:boolean
    managedByEnvironment:boolean
    vendor:DbVendor
    connectionDisplay:string
    poolMax:number
    revision:number|null
    initialized:boolean
}

export interface NodePostgresServerConfigUpdate {
    enabled:boolean
    connectionString?:string
    poolMax:number
    legacySnapshotReady?:boolean
}

export interface NodePostgresRevision {
    id:number
    storage_revision:number|null
    database_initialized:boolean|null
    scope:'database'|'cold-storage'|'restore'
    action:string
    restored_from_revision:number|null
    created_at:string
    change_count:number
}

export interface NodePostgresMessageSearchResult {
    storageState:'active'|'cold'
    archiveId:string|null
    characterId:string|null
    characterName:string|null
    chatId:string|null
    chatName:string
    messageId:string
    position:number
    role:'user'|'char'
    sentTime:number|null
    senderName:string|null
    snippet:string
}

export interface NodePostgresTokenUsage {
    model:string
    messageCount:number
    totalInputTokens:number
    totalOutputTokens:number
}

export interface NodePostgresCharacterSearchResult {
    id:string
    name:string
    image:string|null
    kind:'character'|'group'
}

export interface NodePostgresTableInfo {
    name:string
    rowCount:number
}

export interface NodePostgresColumnInfo {
    name:string
    dataType:string
    nullable:boolean
    primaryKey:boolean
}

export interface NodePostgresTableData {
    table:string
    columns:NodePostgresColumnInfo[]
    allColumns?:NodePostgresColumnInfo[]
    rows:Record<string, unknown>[]
    offset:number
    limit:number
    total:number
}

export interface NodeBackupMirroringConfig {
    enabled:boolean
}

export interface NodeBackupSnapshotConfig {
    enabled:boolean
    intervalMinutes:number
}

export interface NodeBackupConfig {
    configured:boolean
    enabled:boolean
    vendor:DbVendor|null
    managedByEnvironment:boolean
    mirroring:NodeBackupMirroringConfig
    snapshot:NodeBackupSnapshotConfig
    params:Record<string, any>
    primaryRevision:number|null
    backupRevision:number|null
    lag:number|null
    backupInitialized:boolean
    inFlight:boolean
    lastMirrorAt:string|null
    lastMirrorError:string|null
    lastSnapshotAt:string|null
    lastSnapshotError:string|null
    lastFullSyncAt:string|null
    lastFullSyncError:string|null
}

export interface NodeBackupConfigUpdate {
    vendor:DbVendor
    params:Record<string, any>
    mirroring:NodeBackupMirroringConfig
    snapshot:NodeBackupSnapshotConfig
}

export interface NodeBackupProgressEvent {
    type?: 'progress' | 'done' | 'error'
    stage?: 'reading' | 'preparing' | 'connecting' | 'settings' | 'characters' | 'chats' | 'messages' | 'finalizing' | 'done' | string
    message?: string
    percentage?: number
    current?: number
    total?: number
    settingsCount?: number
    charactersCount?: number
    chatsCount?: number
    messagesCount?: number
    lastFullSyncAt?: string
    error?: string
    [key: string]: unknown
}

export interface NodeBackupFullSyncResult {
    success: boolean
    lastFullSyncAt?: string
    settingsCount?: number
    charactersCount?: number
    chatsCount?: number
    messagesCount?: number
    revision?: number
    changed?: {
        root?: number
        characters?: number
        chats?: number
        messages?: number
    }
}

async function encodeJsonBody(payload:unknown):Promise<{
    body:BodyInit
    contentEncoding?:string
}> {
    const json = JSON.stringify(payload)
    if(json.length < 64 * 1024 || typeof CompressionStream === 'undefined'){
        return { body: json }
    }
    const input = new Blob([json]).stream()
    const compressed = input.pipeThrough(new CompressionStream('gzip'))
    return {
        body: await new Response(compressed).arrayBuffer(),
        contentEncoding: 'gzip',
    }
}

async function responseError(response:Response, fallback:string) {
    const body = await response.json().catch(() => null)
    return new Error(body?.error || `${fallback} (${response.status})`)
}

export class NodePostgresRevisionConflictError extends Error {
    constructor(revision:unknown) {
        super(`PostgreSQL data changed in another session (server revision ${revision ?? 'unknown'}). Reload before saving again.`)
        this.name = 'NodePostgresRevisionConflictError'
    }
}

export class NodePostgresPayloadTooLargeError extends Error {
    constructor(message?:string) {
        super(message || 'PostgreSQL save payload is larger than the Node server allows.')
        this.name = 'NodePostgresPayloadTooLargeError'
    }
}

export class NodePostgresStorage {
    private status:'unknown'|'enabled'|'disabled' = 'unknown'
    private cache:NodeDatabaseSyncCache = createNodeDatabaseSyncCache()
    private pluginsCacheForage = localforage.createInstance({ name: 'risuaiPostgresPlugins' })
    private pluginStorageCacheForage = localforage.createInstance({ name: 'risuaiPostgresPluginStorage' })

    private personasCacheForage = localforage.createInstance({ name: 'risuaiPostgresPersonas' })
    private botPresetsCacheForage = localforage.createInstance({ name: 'risuaiPostgresBotPresets' })
    private loreBookCacheForage = localforage.createInstance({ name: 'risuaiPostgresLoreBook' })
    private modulesCacheForage = localforage.createInstance({ name: 'risuaiPostgresModules' })
    private promptsCacheForage = localforage.createInstance({ name: 'risuaiPostgresPrompts' })
    private scriptsCacheForage = localforage.createInstance({ name: 'risuaiPostgresScripts' })

    private memoryPluginsCache:{ hash:string, plugins:any[] }|null = null
    private memoryPluginStorageCache:{ hash:string, pluginCustomStorage:Record<string, any> }|null = null
    private memoryPersonasCache:{ hash:string, personas:RisuPersona[] }|null = null
    private memoryBotPresetsCache:{ hash:string, botPresets:botPreset[] }|null = null
    private memoryLoreBookCache:{ hash:string, loreBook:{ name:string, data:loreBook[] }[] }|null = null
    private memoryModulesCache:{ hash:string, modules:RisuModule[] }|null = null
    private memoryPromptsCache:{ hash:string, prompts:Record<string, any> }|null = null
    private memoryScriptsCache:{ hash:string, globalscript:customscript[] }|null = null

    constructor(private readonly getAuth:() => Promise<string>) {}

    isEnabled() {
        return this.status === 'enabled'
    }

    private async authHeaders() {
        return {
            'risu-auth': await this.getAuth()
        }
    }

    private async ensureEnabled() {
        if(this.status === 'unknown'){
            await this.loadDatabase()
        }
        return this.status === 'enabled'
    }

    async getServerConfig():Promise<NodePostgresServerConfig> {
        const response = await fetch('/api/postgres-config', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL configuration load failed')
        }
        const config:NodePostgresServerConfig = await response.json()
        this.status = config.enabled ? 'enabled' : 'disabled'
        this.cache = createNodeDatabaseSyncCache(config.revision ?? 0)
        return config
    }

    async configureServer(update:NodePostgresServerConfigUpdate):Promise<NodePostgresServerConfig> {
        const encodedBody = await encodeJsonBody(update)
        const response = await fetch('/api/postgres-config', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL configuration update failed')
        }
        const config:NodePostgresServerConfig = await response.json()
        this.status = config.enabled ? 'enabled' : 'disabled'
        this.cache = createNodeDatabaseSyncCache(config.revision ?? 0)
        return config
    }

    // ── 범용 DB 설정 API (postgres / oracle / azure 공통) ──

    /**
     * 현재 DB 설정 조회 (vendor, enabled, 마스킹된 연결 정보).
     * /api/db-config GET 대응.
     */
    async getDatabaseConfig():Promise<NodePostgresServerConfig & {
        params:Record<string, any>
        storedVendor:DbVendor|null
    }> {
        const response = await fetch('/api/db-config', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'DB configuration load failed')
        }
        const config = await response.json()
        this.status = config.enabled ? 'enabled' : 'disabled'
        if(config.revision != null){
            this.cache = createNodeDatabaseSyncCache(config.revision)
        }
        return config
    }

    /**
     * DB 설정 적용 (vendor + params + migrate). 서버가 storage를 재생성.
     * /api/db-config POST 대응.
     */
    async applyDatabaseConfig(vendor:DbVendor, params:Record<string, any>, migrate:boolean):Promise<NodePostgresServerConfig & {
        params:Record<string, any>
        storedVendor:DbVendor|null
    }> {
        const encodedBody = await encodeJsonBody({ vendor, params, migrate })
        const response = await fetch('/api/db-config', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'DB configuration update failed')
        }
        const body = await response.json()
        this.status = body.enabled ? 'enabled' : 'disabled'
        if(body.revision != null){
            this.cache = createNodeDatabaseSyncCache(body.revision)
        }
        return body
    }

    /**
     * 연결 테스트 (실제 storage 재생성 없이 연결만 확인).
     * /api/db-config/test POST 대응.
     */
    async testConnection(vendor:DbVendor, params:Record<string, any>):Promise<{ success:boolean, error?:string }> {
        const encodedBody = await encodeJsonBody({ vendor, params })
        const response = await fetch('/api/db-config/test', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'DB connection test failed')
        }
        return await response.json()
    }

    /**
     * 명시적 로컬 → SQL 마이그레이션 트리거.
     * /api/database-v2/migrate-legacy POST 대응.
     */
    async migrateLegacyData():Promise<{ success:boolean, migrated:number, skipped:number }> {
        if(!await this.ensureEnabled()){
            throw new Error('SQL storage is not enabled')
        }
        const response = await fetch('/api/database-v2/migrate-legacy', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'Legacy migration failed')
        }
        return await response.json()
    }

    getCache():NodeDatabaseSyncCache {
        return this.cache
    }

    async loadPlugins():Promise<any[]|null> {
        if(!await this.ensureEnabled()){
            return null
        }
        let cached:{ hash:string, plugins:any[] }|null = this.memoryPluginsCache
        if(!cached){
            try {
                cached = await this.pluginsCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }

        const headers:Record<string, string> = await this.authHeaders()
        if(cached?.hash){
            headers['If-None-Match'] = `"risu-plugins-${cached.hash}"`
        }

        const response = await fetch('/api/database-v2/plugins', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })

        if(response.status === 304 && cached){
            this.memoryPluginsCache = cached
            return cached.plugins ?? []
        }

        if(response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL plugins load failed')
        }

        const body:{ plugins:any[], hash:string } = await response.json()
        const entry = {
            hash: body.hash,
            plugins: body.plugins ?? [],
        }
        this.memoryPluginsCache = entry
        try {
            await this.pluginsCacheForage.setItem('cache', entry)
        } catch {}
        return body.plugins ?? []
    }

    async loadPluginCustomStorage():Promise<Record<string, any>|null> {
        if(!await this.ensureEnabled()){
            return null
        }
        let cached:{ hash:string, pluginCustomStorage:Record<string, any> }|null = this.memoryPluginStorageCache
        if(!cached){
            try {
                cached = await this.pluginStorageCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }

        const headers:Record<string, string> = await this.authHeaders()
        if(cached?.hash){
            headers['If-None-Match'] = `"risu-plugin-storage-${cached.hash}"`
        }

        const response = await fetch('/api/database-v2/plugin-custom-storage', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })

        if(response.status === 304 && cached){
            this.memoryPluginStorageCache = cached
            return cached.pluginCustomStorage ?? {}
        }

        if(response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL plugin custom storage load failed')
        }

        const body:{ pluginCustomStorage:Record<string, any>, hash:string } = await response.json()
        const entry = {
            hash: body.hash,
            pluginCustomStorage: body.pluginCustomStorage ?? {},
        }
        this.memoryPluginStorageCache = entry
        try {
            await this.pluginStorageCacheForage.setItem('cache', entry)
        } catch {}
        return body.pluginCustomStorage ?? {}
    }

    private pluginKeyCacheForage = localforage.createInstance({ name: 'risuaiPostgresPluginKeyStorage' })
    private memoryPluginKeyCache = new Map<string, { hash: string, value: any }>()

    async listPluginCustomStorageKeys():Promise<string[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const response = await fetch('/api/database-v2/plugin-custom-storage/keys', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders(),
        })
        if(response.status === 404){
            return []
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL list plugin custom storage keys failed')
        }
        const body:{ keys:string[] } = await response.json()
        return body.keys ?? []
    }

    async loadPluginCustomStorageKey(key:string):Promise<any> {
        if(!await this.ensureEnabled()){
            return undefined
        }
        let cached = this.memoryPluginKeyCache.get(key)
        if(!cached){
            try {
                cached = (await this.pluginKeyCacheForage.getItem(key)) ?? undefined
            } catch {
                cached = undefined
            }
        }

        const headers:Record<string, string> = await this.authHeaders()
        if(cached?.hash){
            headers['If-None-Match'] = `"risu-plugin-key-${cached.hash}"`
        }

        const response = await fetch(`/api/database-v2/plugin-custom-storage/keys/${encodeURIComponent(key)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })

        if(response.status === 304 && cached){
            return cached.value
        }
        if(response.status === 404){
            return undefined
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, `PostgreSQL plugin custom storage key '${key}' load failed`)
        }

        const body:{ key:string, value:any, hash:string } = await response.json()
        const entry = {
            hash: body.hash,
            value: body.value,
        }
        this.memoryPluginKeyCache.set(key, entry)
        try {
            await this.pluginKeyCacheForage.setItem(key, entry)
        } catch {}
        return body.value
    }

    async loadPersonas(): Promise<RisuPersona[]> {
        if (!await this.ensureEnabled()) return []
        let cached = this.memoryPersonasCache
        if (!cached) {
            try {
                cached = await this.personasCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-personas-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/personas', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.personas ?? []
        }
        if (response.status === 404) return []
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL personas load failed')
        }
        const body: { personas: RisuPersona[], hash: string } = await response.json()
        const entry = { hash: body.hash, personas: body.personas ?? [] }
        this.memoryPersonasCache = entry
        try {
            await this.personasCacheForage.setItem('cache', entry)
        } catch {}
        return body.personas ?? []
    }

    async loadBotPresets(): Promise<botPreset[]> {
        if (!await this.ensureEnabled()) return []
        let cached = this.memoryBotPresetsCache
        if (!cached) {
            try {
                cached = await this.botPresetsCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-bot-presets-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/bot-presets', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.botPresets ?? []
        }
        if (response.status === 404) return []
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL bot presets load failed')
        }
        const body: { botPresets: botPreset[], hash: string } = await response.json()
        const entry = { hash: body.hash, botPresets: body.botPresets ?? [] }
        this.memoryBotPresetsCache = entry
        try {
            await this.botPresetsCacheForage.setItem('cache', entry)
        } catch {}
        return body.botPresets ?? []
    }

    async loadLorebooks(): Promise<{ name: string, data: loreBook[] }[]> {
        if (!await this.ensureEnabled()) return []
        let cached = this.memoryLoreBookCache
        if (!cached) {
            try {
                cached = await this.loreBookCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-lorebooks-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/lorebooks', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.loreBook ?? []
        }
        if (response.status === 404) return []
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL global lorebooks load failed')
        }
        const body: { loreBook: { name: string, data: loreBook[] }[], hash: string } = await response.json()
        const entry = { hash: body.hash, loreBook: body.loreBook ?? [] }
        this.memoryLoreBookCache = entry
        try {
            await this.loreBookCacheForage.setItem('cache', entry)
        } catch {}
        return body.loreBook ?? []
    }

    async loadModules(): Promise<RisuModule[]> {
        if (!await this.ensureEnabled()) return []
        let cached = this.memoryModulesCache
        if (!cached) {
            try {
                cached = await this.modulesCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-modules-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/modules', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.modules ?? []
        }
        if (response.status === 404) return []
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL modules load failed')
        }
        const body: { modules: RisuModule[], hash: string } = await response.json()
        const entry = { hash: body.hash, modules: body.modules ?? [] }
        this.memoryModulesCache = entry
        try {
            await this.modulesCacheForage.setItem('cache', entry)
        } catch {}
        return body.modules ?? []
    }

    async loadPrompts(): Promise<Record<string, any>> {
        if (!await this.ensureEnabled()) return {}
        let cached = this.memoryPromptsCache
        if (!cached) {
            try {
                cached = await this.promptsCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-prompts-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/prompts', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.prompts ?? {}
        }
        if (response.status === 404) return {}
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL prompts load failed')
        }
        const body: { prompts: Record<string, any>, hash: string } = await response.json()
        const entry = { hash: body.hash, prompts: body.prompts ?? {} }
        this.memoryPromptsCache = entry
        try {
            await this.promptsCacheForage.setItem('cache', entry)
        } catch {}
        return body.prompts ?? {}
    }

    async loadScripts(): Promise<customscript[]> {
        if (!await this.ensureEnabled()) return []
        let cached = this.memoryScriptsCache
        if (!cached) {
            try {
                cached = await this.scriptsCacheForage.getItem('cache')
            } catch {
                cached = null
            }
        }
        const headers: Record<string, string> = await this.authHeaders()
        if (cached?.hash) {
            headers['If-None-Match'] = `"risu-scripts-${cached.hash}"`
        }
        const response = await fetch('/api/database-v2/scripts', {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 304 && cached) {
            return cached.globalscript ?? []
        }
        if (response.status === 404) return []
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'PostgreSQL scripts load failed')
        }
        const body: { globalscript: customscript[], hash: string } = await response.json()
        const entry = { hash: body.hash, globalscript: body.globalscript ?? [] }
        this.memoryScriptsCache = entry
        try {
            await this.scriptsCacheForage.setItem('cache', entry)
        } catch {}
        return body.globalscript ?? []
    }

    async loadSettingKey(key: string): Promise<any> {
        if (!await this.ensureEnabled()) return undefined
        const headers: Record<string, string> = await this.authHeaders()
        const response = await fetch(`/api/database-v2/settings/${encodeURIComponent(key)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers,
        })
        if (response.status === 404) return undefined
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, `PostgreSQL load setting key '${key}' failed`)
        }
        const body: { key: string, value: any, hash: string } = await response.json()
        return body.value
    }

    async loadDatabase(options: { shallow?: boolean } = { shallow: true }):Promise<Database|null> {
        const shallowParam = options.shallow !== false ? '?shallow=true' : '?shallow=false'
        const response = await fetch(`/api/database-v2${shallowParam}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status === 404){
            this.status = 'disabled'
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL database load failed')
        }

        const body:{
            status:'ready'|'empty'
            revision:number
            database:Database|null
        } = await response.json()
        this.status = 'enabled'
        if(body.status === 'ready' && body.database){
            if (options.shallow !== false) {
                const plugins = await this.loadPlugins()
                if (plugins) {
                    body.database.plugins = plugins
                }
                body.database.pluginCustomStorage ??= {}
                this.cache = primeNodeDatabaseSyncCache(body.database, body.revision)
                return createPostgresDatabaseAdapter(body.database, this)
            }
            this.cache = primeNodeDatabaseSyncCache(body.database, body.revision)
            return body.database
        }
        this.cache = createNodeDatabaseSyncCache(body.revision)
        return null
    }

    async loadCharacter(characterId:string):Promise<character|groupChat|null> {
        if(!await this.ensureEnabled()){
            return null
        }
        const response = await fetch(`/api/database-v2/characters/${encodeURIComponent(characterId)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL character load failed')
        }
        const body:{ character:character|groupChat } = await response.json()
        return body.character ?? null
    }

    async loadChat(chatId:string):Promise<Chat|null> {
        if(!await this.ensureEnabled()){
            return null
        }
        const response = await fetch(`/api/database-v2/chats/${encodeURIComponent(chatId)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL chat load failed')
        }
        const body:{ chat:Chat } = await response.json()
        return body.chat ?? null
    }

    async loadChatMessages(chatId:string):Promise<Message[]> {
        const chat = await this.loadChat(chatId)
        return chat?.message ?? []
    }

    async listRevisions(limit = 50):Promise<NodePostgresRevision[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const response = await fetch(`/api/database-v2/revisions?limit=${encodeURIComponent(limit)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL revision history load failed')
        }
        const body:{ revisions:NodePostgresRevision[] } = await response.json()
        return body.revisions
    }

    async restoreRevision(revisionId:number):Promise<{revision:number, revisionId:number}> {
        if(!await this.ensureEnabled()){
            throw new Error('PostgreSQL storage is disabled')
        }
        const encodedBody = await encodeJsonBody({ revisionId })
        const response = await fetch('/api/database-v2/revisions/restore', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL revision restore failed')
        }
        const result:{revision:number, revisionId:number} = await response.json()
        this.cache = createNodeDatabaseSyncCache(result.revision)
        return result
    }

    async getColdStorageItem(key:string):Promise<unknown|null> {
        if(!await this.ensureEnabled()){
            return null
        }
        const response = await fetch(`/api/database-v2/cold-storage/${encodeURIComponent(key)}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL cold storage load failed')
        }
        const body:{ data:unknown } = await response.json()
        return body.data
    }

    async listColdStorageItems():Promise<{items:string[]}> {
        if(!await this.ensureEnabled()){
            return { items: [] }
        }
        const response = await fetch('/api/database-v2/cold-storage', {
            method: 'GET',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL cold storage list failed')
        }
        const body:{ items:{ key:string }[] } = await response.json()
        return {
            items: body.items.map((item) => item.key)
        }
    }

    async setColdStorageItem(key:string, value:unknown):Promise<boolean> {
        if(!await this.ensureEnabled()){
            return false
        }
        const encodedBody = await encodeJsonBody({ data: value })
        const response = await fetch(`/api/database-v2/cold-storage/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL cold storage save failed')
        }
        return true
    }

    async removeColdStorageItems(keys:string[]):Promise<number> {
        if(!await this.ensureEnabled() || keys.length === 0){
            return 0
        }
        const encodedBody = await encodeJsonBody({ keys })
        const response = await fetch('/api/database-v2/cold-storage', {
            method: 'DELETE',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL cold storage delete failed')
        }
        const body:{ deleted:number } = await response.json()
        return body.deleted
    }

    async pruneColdStorage(retainedKeys:string[]):Promise<number> {
        if(!await this.ensureEnabled()){
            return 0
        }
        const encodedBody = await encodeJsonBody({ retainedKeys })
        const response = await fetch('/api/database-v2/cold-storage/prune', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL cold storage cleanup failed')
        }
        const body:{ deleted:number } = await response.json()
        return body.deleted
    }

    async saveDatabase(
        database:Database,
        changes:toSaveType,
        options:{ forceFull?:boolean; onProgress?:(status:string) => void } = {}
    ):Promise<boolean> {
        if(!await this.ensureEnabled()){
            return false
        }

        options.onProgress?.('Building relational sync payload...')
        const built = buildNodeDatabaseSync(database, changes, this.cache, options)
        if(!built){
            return true
        }
        options.onProgress?.('Compressing database payload...')
        const encodedBody = await encodeJsonBody(built.payload)
        options.onProgress?.('Writing to PostgreSQL database tables...')
        const response = await fetch('/api/database-v2/sync', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status === 409){
            const conflict = await response.json().catch(() => null)
            throw new NodePostgresRevisionConflictError(conflict?.revision)
        }
        if(response.status === 413){
            const body = await response.json().catch(() => null)
            throw new NodePostgresPayloadTooLargeError(body?.error)
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL database save failed')
        }
        const result:{ revision:number } = await response.json()
        built.nextCache.revision = result.revision
        built.nextCache.initialized = true
        this.cache = built.nextCache
        return true
    }

    async replaceDatabase(database:Database, onProgress?:(status:string) => void) {
        return await this.saveDatabase(database, {
            character: [],
            chat: [],
            botPreset: false,
            modules: false,
            loadouts: false,
            plugins: false,
            pluginCustomStorage: false,
        }, {
            forceFull: true,
            onProgress
        })
    }

    async searchMessages(query:string, scope:'all'|'active'|'cold' = 'all', limit = 50):Promise<NodePostgresMessageSearchResult[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const params = new URLSearchParams({ q: query, scope, limit: String(limit) })
        const response = await fetch(`/api/database-v2/search?${params.toString()}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL message search failed')
        }
        const body:{ results:NodePostgresMessageSearchResult[] } = await response.json()
        return body.results
    }

    async getTokenUsage():Promise<NodePostgresTokenUsage[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const response = await fetch('/api/database-v2/token-usage', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL token usage load failed')
        }
        const body:{ usage:NodePostgresTokenUsage[] } = await response.json()
        return body.usage
    }

    async searchCharactersByTag(tag:string, limit = 100):Promise<NodePostgresCharacterSearchResult[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const params = new URLSearchParams({ tag, limit: String(limit) })
        const response = await fetch(`/api/database-v2/characters/search?${params.toString()}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL character tag search failed')
        }
        const body:{ results:NodePostgresCharacterSearchResult[] } = await response.json()
        return body.results
    }

    async searchCharactersByName(name:string, limit = 100):Promise<NodePostgresCharacterSearchResult[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const params = new URLSearchParams({ name, limit: String(limit) })
        const response = await fetch(`/api/database-v2/characters/search?${params.toString()}`, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL character name search failed')
        }
        const body:{ results:NodePostgresCharacterSearchResult[] } = await response.json()
        return body.results
    }

    async listDbTables():Promise<NodePostgresTableInfo[]> {
        if(!await this.ensureEnabled()){
            return []
        }
        const response = await fetch('/api/database-v2/tables', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status === 404){
            this.status = 'disabled'
            return []
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL table list load failed')
        }
        const body:{ tables:NodePostgresTableInfo[] } = await response.json()
        return body.tables
    }

    async getDbTableData(
        table:string,
        options:{
            offset?:number
            limit?:number
            sortColumn?:string
            sortOrder?:'asc'|'desc'
            search?:string
            columns?:string[]
        } = {}
    ):Promise<NodePostgresTableData> {
        if(!await this.ensureEnabled()){
            throw new Error('PostgreSQL storage is disabled')
        }
        const params = new URLSearchParams({
            offset: String(options.offset ?? 0),
            limit: String(options.limit ?? 50),
        })
        if(options.sortColumn){
            params.set('sort', options.sortColumn)
        }
        if(options.sortOrder){
            params.set('dir', options.sortOrder)
        }
        if(options.search && options.search.length > 0){
            params.set('search', options.search)
        }
        if(options.columns && options.columns.length > 0){
            params.set('columns', options.columns.join(','))
        }
        const response = await fetch(
            `/api/database-v2/tables/${encodeURIComponent(table)}/rows?${params.toString()}`,
            {
                method: 'GET',
                cache: 'no-cache',
                headers: await this.authHeaders()
            }
        )
        if(response.status === 404){
            this.status = 'disabled'
            throw new Error('PostgreSQL storage is disabled')
        }
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'PostgreSQL table data load failed')
        }
        const body:{ data:NodePostgresTableData } = await response.json()
        return body.data
    }

    // ── 백업 데이터베이스 API ──

    /**
     * 백업 DB 설정 + 실시간 상태 조회 (revision lag, 마지막 미러/스냅샷 시점).
     * /api/db-backup GET 대응.
     */
    async getBackupStatus():Promise<NodeBackupConfig> {
        const response = await fetch('/api/db-backup', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'Backup database status load failed')
        }
        return await response.json()
    }

    /**
     * 백업 DB 연결 테스트 (실제 저장소 생성 없이 연결만 확인).
     * /api/db-backup/test POST 대응.
     */
    async testBackupConnection(vendor:DbVendor, params:Record<string, any>):Promise<{ success:boolean, error?:string }> {
        const encodedBody = await encodeJsonBody({ vendor, params })
        const response = await fetch('/api/db-backup/test', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'Backup database connection test failed')
        }
        return await response.json()
    }

    /**
     * 백업 DB 설정 적용 + 초기화 + 최초 전체 백업 트리거.
     * /api/db-backup POST 대응.
     */
    async configureBackup(update:NodeBackupConfigUpdate):Promise<NodeBackupConfig> {
        const encodedBody = await encodeJsonBody(update)
        const response = await fetch('/api/db-backup', {
            method: 'POST',
            body: encodedBody.body,
            headers: {
                'content-type': 'application/json',
                ...(encodedBody.contentEncoding ? { 'content-encoding': encodedBody.contentEncoding } : {}),
                ...await this.authHeaders()
            }
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'Backup database configuration failed')
        }
        return await response.json()
    }

    /**
     * 수동 전체 백업: 메인 DB 전체를 백업 DB에 replaceAll 적요 (실시간 진행상황 콜백 지원).
     * /api/db-backup/resync POST 대응.
     */
    async resyncBackup(onProgress?: (event: NodeBackupProgressEvent) => void): Promise<NodeBackupFullSyncResult> {
        const response = await fetch('/api/db-backup/resync', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...await this.authHeaders()
            }
        })
        if (response.status < 200 || response.status >= 300) {
            const body = await response.json().catch(() => null)
            throw new Error(body?.error || 'Backup full sync failed')
        }

        const reader = response.body?.getReader()
        if (!reader) {
            return await response.json()
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let finalResult: NodeBackupFullSyncResult = { success: true }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line)
                    if (parsed.type === 'progress') {
                        onProgress?.(parsed)
                    } else if (parsed.type === 'done') {
                        finalResult = {
                            success: parsed.success !== false,
                            lastFullSyncAt: parsed.lastFullSyncAt,
                            settingsCount: parsed.settingsCount,
                            charactersCount: parsed.charactersCount,
                            chatsCount: parsed.chatsCount,
                            messagesCount: parsed.messagesCount,
                            revision: parsed.revision,
                            changed: parsed.changed,
                        }
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error || 'Backup full sync failed')
                    }
                } catch (err: any) {
                    if (err?.message && !err.message.includes('JSON')) {
                        throw err
                    }
                }
            }
        }

        return finalResult
    }

    /**
     * 백업 DB 설정 해제 (풀 close + 설정 제거).
     * /api/db-backup DELETE 대응.
     */
    async removeBackup():Promise<NodeBackupConfig> {
        const response = await fetch('/api/db-backup', {
            method: 'DELETE',
            headers: await this.authHeaders()
        })
        if(response.status < 200 || response.status >= 300){
            throw await responseError(response, 'Backup database removal failed')
        }
        return await response.json()
    }
}
