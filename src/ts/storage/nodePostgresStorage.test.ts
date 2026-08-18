import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NodePostgresStorage } from './nodePostgresStorage'

describe('NodePostgresStorage browser client', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('fetches server config and respects the managedByEnvironment flag', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({
                enabled: true,
                configured: true,
                managedByEnvironment: true,
                connectionDisplay: 'postgresql://localhost/risuai',
                poolMax: 10,
                revision: 42,
                initialized: true,
            }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        const config = await storage.getServerConfig()

        expect(config).toEqual({
            enabled: true,
            configured: true,
            managedByEnvironment: true,
            connectionDisplay: 'postgresql://localhost/risuai',
            poolMax: 10,
            revision: 42,
            initialized: true,
        })
        expect(fetchMock).toHaveBeenCalledWith('/api/postgres-config', expect.objectContaining({
            headers: expect.objectContaining({
                'risu-auth': 'test-auth',
            }),
        }))
    })

    it('submits updated connection options and normalizes pool size', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({
                enabled: true,
                configured: true,
                managedByEnvironment: false,
                connectionDisplay: 'postgresql://remote/risuai',
                poolMax: 15,
                revision: null,
                initialized: false,
            }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        const updated = await storage.configureServer({
            enabled: true,
            connectionString: 'postgresql://user:pass@remote/risuai',
            poolMax: 15,
        })

        expect(updated.connectionDisplay).toBe('postgresql://remote/risuai')
        expect(fetchMock).toHaveBeenCalledWith('/api/postgres-config', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                enabled: true,
                connectionString: 'postgresql://user:pass@remote/risuai',
                poolMax: 15,
            }),
        }))
    })

    it('fetches revision history from the server API', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                enabled: true,
                configured: true,
                managedByEnvironment: false,
                connectionDisplay: 'postgresql://localhost/risuai',
                poolMax: 10,
                revision: 2,
                initialized: true,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                revisions: [
                    {
                        id: 2,
                        storage_revision: 2,
                        database_initialized: true,
                        scope: 'database',
                        action: 'sync',
                        restored_from_revision: null,
                        created_at: '2026-03-30T00:00:00Z',
                        change_count: 5,
                    },
                ],
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()

        const revisions = await storage.listRevisions(10)
        expect(revisions).toHaveLength(1)
        expect(revisions[0].id).toBe(2)
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/revisions?limit=10')
    })

    it('lists database tables and queries table columns and rows through the server API', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                enabled: true,
                configured: true,
                managedByEnvironment: false,
                connectionDisplay: 'postgresql://localhost/risuai',
                poolMax: 10,
                revision: 2,
                initialized: true,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                tables: [
                    { name: 'character.characters', rowCount: 2 },
                    { name: 'chat.messages', rowCount: 42 },
                ],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: {
                    table: 'character.characters',
                    columns: [{ name: 'id', dataType: 'text', nullable: false, primaryKey: true }],
                    rows: [{ id: 'c1' }],
                    offset: 50,
                    limit: 50,
                    total: 2,
                },
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()

        expect(await storage.listDbTables()).toEqual([
            { name: 'character.characters', rowCount: 2 },
            { name: 'chat.messages', rowCount: 42 },
        ])
        expect(await storage.getDbTableData('character.characters', {
            offset: 50,
            limit: 50,
            sortColumn: 'id',
            sortOrder: 'desc',
        })).toMatchObject({ table: 'character.characters', total: 2, rows: [{ id: 'c1' }] })
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/tables')
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2/tables/character.characters/rows?offset=50&limit=50&sort=id&dir=desc')
    })

    it('searches and filters table rows with column selection through the server API', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                enabled: true,
                configured: true,
                managedByEnvironment: false,
                connectionDisplay: 'postgresql://localhost/risuai',
                poolMax: 10,
                revision: 2,
                initialized: true,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: {
                    table: 'chat.messages',
                    columns: [
                        { name: 'id', dataType: 'text', nullable: false, primaryKey: true },
                        { name: 'content', dataType: 'text', nullable: true, primaryKey: false },
                    ],
                    rows: [{ id: 'm1', content: 'hello world' }],
                    offset: 0,
                    limit: 25,
                    total: 1,
                },
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()

        expect(await storage.getDbTableData('chat.messages', {
            search: 'hello',
            columns: ['id', 'content'],
            limit: 25,
        })).toMatchObject({ table: 'chat.messages', total: 1, rows: [{ id: 'm1', content: 'hello world' }] })
        expect(fetchMock.mock.calls[1][0]).toBe(
            '/api/database-v2/tables/chat.messages/rows?offset=0&limit=25&search=hello&columns=id%2Ccontent'
        )
    })

    it('loads database with shallow=true by default and supports full loading', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                status: 'ready',
                revision: 10,
                database: { username: 'test-user', characters: [] },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                plugins: [{ name: 'test-plugin' }],
                hash: 'plugin-hash-1',
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                status: 'ready',
                revision: 10,
                database: { username: 'test-user', characters: [] },
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        const shallowDb = await storage.loadDatabase()
        expect(shallowDb?.username).toBe('test-user')
        expect(shallowDb?.plugins).toHaveLength(1)
        expect(shallowDb?.pluginCustomStorage).toEqual({})
        expect(fetchMock.mock.calls[0][0]).toBe('/api/database-v2?shallow=true')
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/plugins')

        const fullDb = await storage.loadDatabase({ shallow: false })
        expect(fullDb?.username).toBe('test-user')
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2?shallow=false')
    })

    it('loads chat details on demand', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                status: 'ready',
                revision: 10,
                database: { username: 'test-user', characters: [] },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ plugins: [], hash: 'p-empty' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                chat: {
                    id: 'chat-123',
                    name: 'My Chat',
                    localLore: [{ key: 'lore1' }],
                    message: [
                        { chatId: 'msg-1', role: 'user', data: 'hello' },
                        { chatId: 'msg-2', role: 'char', data: 'hi there' },
                    ],
                },
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.loadDatabase()

        const chat = await storage.loadChat('chat-123')
        expect(chat?.id).toBe('chat-123')
        expect(chat?.message).toHaveLength(2)
        expect(chat?.localLore).toHaveLength(1)
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2/chats/chat-123')
    })

    it('loads character details on demand', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                status: 'ready',
                revision: 10,
                database: { username: 'test-user', characters: [] },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ plugins: [], hash: 'p-empty' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                character: {
                    chaId: 'char-123',
                    name: 'Loaded Character',
                    globalLore: [{ key: 'world-lore' }],
                    emotionImages: [['happy', 'data:image/png;base64,...']],
                },
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.loadDatabase()

        const char = await storage.loadCharacter('char-123')
        expect(char?.chaId).toBe('char-123')
        expect(char?.name).toBe('Loaded Character')
        expect((char as any)?.globalLore).toHaveLength(1)
        expect((char as any)?.emotionImages).toHaveLength(1)
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2/characters/char-123')
    })

    it('loads and caches individual plugin custom storage keys on demand', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                keys: ['cache_key_1', 'cache_key_2'],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                key: 'cache_key_1',
                value: { count: 42, label: 'test' },
                hash: 'key-1-hash',
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 304 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        ;(storage as any).status = 'enabled'

        const keys = await storage.listPluginCustomStorageKeys()
        expect(keys).toEqual(['cache_key_1', 'cache_key_2'])
        expect(fetchMock.mock.calls[0][0]).toBe('/api/database-v2/plugin-custom-storage/keys')

        // First load of key: 200 OK -> saves to local cache
        const val1 = await storage.loadPluginCustomStorageKey('cache_key_1')
        expect(val1).toEqual({ count: 42, label: 'test' })
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/plugin-custom-storage/keys/cache_key_1')

        // Second load of key: sends If-None-Match, returns 304 -> uses cached value
        const val2 = await storage.loadPluginCustomStorageKey('cache_key_1')
        expect(val2).toEqual({ count: 42, label: 'test' })
        expect(fetchMock.mock.calls[2][1].headers['If-None-Match']).toBe('"risu-plugin-key-key-1-hash"')
    })

    it('loads deferred domains on demand via PostgresDatabaseAdapter', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                status: 'ready',
                revision: 10,
                database: { username: 'test-user', characters: [] },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ plugins: [], hash: 'p-empty' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                personas: [{ name: 'Persona 1', icon: '', personaPrompt: 'Hello' }],
                hash: 'persona-hash-1',
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                botPresets: [{ name: 'Preset Alpha', temperature: 75 }],
                hash: 'preset-hash-1',
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                loreBook: [{ name: 'World Lore', data: [] }],
                hash: 'lore-hash-1',
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        const db = await storage.loadDatabase() as any
        expect(db).toBeDefined()
        expect(db.isPostgres).toBe(true)

        // Initial state before accessing domains: not loaded
        expect(db.isDomainLoaded('personas')).toBe(false)
        expect(db.isDomainLoaded('botPresets')).toBe(false)
        expect(db.isDomainLoaded('loreBook')).toBe(false)

        // Ensure loaded on personas
        await db.ensureLoaded('personas')
        expect(db.isDomainLoaded('personas')).toBe(true)
        expect(db.personas).toHaveLength(1)
        expect(db.personas[0].name).toBe('Persona 1')

        // Ensure loaded on botPresets
        await db.ensureLoaded('botPresets')
        expect(db.isDomainLoaded('botPresets')).toBe(true)
        expect(db.botPresets).toHaveLength(1)
        expect(db.botPresets[0].name).toBe('Preset Alpha')

        // Accessing loreBook directly triggers loading
        await db.ensureLoaded('loreBook')
        expect(db.isDomainLoaded('loreBook')).toBe(true)
        expect(db.loreBook).toHaveLength(1)
        expect(db.loreBook[0].name).toBe('World Lore')
    })
})

