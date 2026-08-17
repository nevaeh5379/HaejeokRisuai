import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from './database.svelte'
import {
    NodePostgresPayloadTooLargeError,
    NodePostgresStorage,
} from './nodePostgresStorage'

const emptyChanges = {
    character: [],
    chat: [],
    botPreset: false,
    modules: false,
    loadouts: false,
    plugins: false,
    pluginCustomStorage: false,
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('Node PostgreSQL storage client', () => {
    it('treats a 413 save response as a non-retryable payload error', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                enabled: true,
                configured: true,
                managedByEnvironment: false,
                connectionDisplay: 'postgresql://localhost/risuai',
                poolMax: 10,
                revision: 0,
                initialized: false,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                error: 'PostgreSQL JSON payload exceeds the configured 1gb limit',
                code: 'payload_too_large',
            }), { status: 413 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()

        await expect(storage.saveDatabase(
            { characters: [] } as Database,
            emptyChanges,
        )).rejects.toBeInstanceOf(NodePostgresPayloadTooLargeError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('loads immutable revision history and requests a restore revision', async () => {
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
                revisions: [{
                    id: 2, storage_revision: 2, database_initialized: true,
                    scope: 'database', action: 'sync', restored_from_revision: null,
                    created_at: '2026-08-15T00:00:00.000Z', change_count: 3,
                }],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true, revision: 3, revisionId: 3,
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()
        expect(await storage.listRevisions(20)).toMatchObject([{ id: 2, change_count: 3 }])
        expect(await storage.restoreRevision(2)).toMatchObject({ revision: 3, revisionId: 3 })
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/revisions?limit=20')
        expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual({ revisionId: 2 })
    })

    it('searches messages, token usage, and characters through the server API', async () => {
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
                results: [{
                    storageState: 'active', archiveId: null, characterId: 'c1',
                    characterName: 'Char', chatId: 'chat1', chatName: 'Chat',
                    messageId: 'm1', position: 0, role: 'user', sentTime: 1,
                    senderName: null, snippet: '<mark>hello</mark>',
                }],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                usage: [{ model: 'model-a', messageCount: 2, totalInputTokens: 15, totalOutputTokens: 27 }],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                results: [{ id: 'c1', name: 'Char', image: null, kind: 'character' }],
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodePostgresStorage(async () => 'test-auth')
        await storage.getServerConfig()

        expect(await storage.searchMessages('hello', 'all', 50)).toMatchObject([{ characterName: 'Char' }])
        expect(await storage.getTokenUsage()).toMatchObject([{ model: 'model-a', totalOutputTokens: 27 }])
        expect(await storage.searchCharactersByTag('fant', 100)).toMatchObject([{ id: 'c1' }])
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/search?q=hello&scope=all&limit=50')
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2/token-usage')
        expect(fetchMock.mock.calls[3][0]).toBe('/api/database-v2/characters/search?tag=fant&limit=100')
    })

    it('lists database tables and pages table rows through the server API', async () => {
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
                    { name: 'risu_characters', rowCount: 2 },
                    { name: 'risu_messages', rowCount: 42 },
                ],
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                data: {
                    table: 'risu_characters',
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
            { name: 'risu_characters', rowCount: 2 },
            { name: 'risu_messages', rowCount: 42 },
        ])
        expect(await storage.getDbTableData('risu_characters', {
            offset: 50,
            limit: 50,
            sortColumn: 'id',
            sortOrder: 'desc',
        })).toMatchObject({ table: 'risu_characters', total: 2, rows: [{ id: 'c1' }] })
        expect(fetchMock.mock.calls[1][0]).toBe('/api/database-v2/tables')
        expect(fetchMock.mock.calls[2][0]).toBe('/api/database-v2/tables/risu_characters/rows?offset=50&limit=50&sort=id&dir=desc')
    })
})
