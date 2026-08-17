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
})
