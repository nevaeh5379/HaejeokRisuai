import localforage from 'localforage'
import type { Database, Message, character, groupChat, Chat } from './database.svelte'
import type { toSaveType } from './risuSave'
import {
    buildNodeDatabaseSync,
    createNodeDatabaseSyncCache,
    primeNodeDatabaseSyncCache,
    type NodeDatabaseSyncCache,
} from './nodeDatabaseSync'

export interface NodePostgresServerConfig {
    enabled:boolean
    configured:boolean
    managedByEnvironment:boolean
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

    private memoryPluginsCache:{ hash:string, plugins:any[] }|null = null
    private memoryPluginStorageCache:{ hash:string, pluginCustomStorage:Record<string, any> }|null = null

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
        options:{ forceFull?:boolean } = {}
    ):Promise<boolean> {
        if(!await this.ensureEnabled()){
            return false
        }

        const built = buildNodeDatabaseSync(database, changes, this.cache, options)
        if(!built){
            return true
        }
        const encodedBody = await encodeJsonBody(built.payload)
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

    async replaceDatabase(database:Database) {
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
}
