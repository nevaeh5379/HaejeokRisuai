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
})
