import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    DEFERRED_SETTING_KEYS,
    SqlStorageBase,
    createSqlStorageHelpers,
    createMessageRelations,
    groupRows,
    groupMessageRows,
    rebuildDatabaseGraph,
} = require('./sqlStorageCommon.cjs') as {
    DEFERRED_SETTING_KEYS: string[]
    SqlStorageBase: new () => Record<string, (...args: any[]) => any>
    createSqlStorageHelpers: (options: Record<string, unknown>) => Record<string, (...args: any[]) => any>
    createMessageRelations: (rows: Record<string, Record<string, unknown>[]>) => Record<string, Map<string, unknown>>
    groupRows: (rows: Record<string, unknown>[], key: string) => Map<unknown, Record<string, unknown>[]>
    groupMessageRows: (rows: Record<string, unknown>[]) => Map<string, Record<string, unknown>[]>
    rebuildDatabaseGraph: (options: Record<string, unknown>) => Record<string, unknown>
}

class TestPayloadError extends Error {}

describe('shared SQL storage helpers', () => {
    it('provides provider-independent setting loaders through the base class', async () => {
        const storage = new SqlStorageBase()
        storage.loadSettingKeys = async (keys: string[]) => ({
            settings: Object.fromEntries(keys.map((key) => [key, `${key}-value`])),
            hash: 'hash',
        })

        await expect(storage.loadPersonas()).resolves.toEqual({ personas: 'personas-value', hash: 'hash' })
        await expect(storage.loadSettingKey('theme')).resolves.toEqual({
            key: 'theme', value: 'theme-value', exists: true, hash: 'hash',
        })
        await expect(storage.loadPrompts()).resolves.toMatchObject({ hash: 'hash' })

        expect(storage.pluginsCache).toBeNull()
        expect(storage.pluginCustomStorageCache).toBeNull()
        storage.pluginsCache = { plugins: [{ name: 'test' }], hash: 'abc' }
        storage.pluginCustomStorageCache = { pluginCustomStorage: { k: 'v' }, hash: 'def' }
        storage.invalidatePluginsCache()
        expect(storage.pluginsCache).toBeNull()
        storage.invalidatePluginCustomStorageCache()
        expect(storage.pluginCustomStorageCache).toBeNull()
    })

    it('keeps the deferred settings list in one provider-independent definition', () => {
        expect(DEFERRED_SETTING_KEYS).toContain('plugins')
        expect(DEFERRED_SETTING_KEYS).toContain('customBackground')
        expect(new Set(DEFERRED_SETTING_KEYS).size).toBe(DEFERRED_SETTING_KEYS.length)
    })

    it('preserves provider-specific identifier and cold-storage limits', () => {
        const strict = createSqlStorageHelpers({ PayloadError: TestPayloadError, maxIdLength: 4 })
        const compatible = createSqlStorageHelpers({
            PayloadError: TestPayloadError,
            allowShortColdStorageKeys: true,
        })
        const shortKey = 'a0a8a9ca-3e7a-4f1d-a127-884498'

        expect(() => strict.assertId('12345', 'id')).toThrow(/at most 4/)
        expect(() => strict.normalizeColdStorageKey(shortKey)).toThrow(TestPayloadError)
        expect(compatible.normalizeColdStorageKey(shortKey)).toBe(shortKey)
    })

    it('validates message objects consistently for every provider', () => {
        const helpers = createSqlStorageHelpers({ PayloadError: TestPayloadError })

        expect(helpers.validateColdStorageValue({ message: [{ role: 'user' }] })).toEqual({
            message: [{ role: 'user' }],
        })
        expect(() => helpers.validateColdStorageValue({ message: [null] })).toThrow(TestPayloadError)
    })

    it('normalizes sync payloads and rejects malformed manifests', () => {
        const helpers = createSqlStorageHelpers({ PayloadError: TestPayloadError })
        const payload = helpers.validateSyncPayload({
            baseRevision: 2,
            characters: [{ id: 'character-1', position: 0, data: {} }],
            chatManifests: [{ characterId: 'character-1', ids: ['chat-1'] }],
        })

        expect(payload.characters).toEqual([{ id: 'character-1', position: 0, data: {} }])
        expect(payload.chatManifests).toEqual([{ characterId: 'character-1', ids: ['chat-1'] }])
        expect(() => helpers.validateSyncPayload({
            baseRevision: 2,
            messageManifests: [{ chatId: 'chat-1', ids: [null] }],
        })).toThrow(TestPayloadError)
    })

    it('groups relational child rows by entity and message', () => {
        const rows = [
            { owner_id: 'a', chat_id: 'chat', message_id: 'one' },
            { owner_id: 'a', chat_id: 'chat', message_id: 'one' },
            { owner_id: 'b', chat_id: 'chat', message_id: 'two' },
        ]

        expect(groupRows(rows, 'owner_id').get('a')).toHaveLength(2)
        expect(groupMessageRows(rows).get('chat\0one')).toHaveLength(2)
    })

    it('rebuilds the message, chat, and character graph with load-state flags', () => {
        const database: Record<string, unknown> = {}
        const messageRelations = createMessageRelations({
            attributes: [{ chat_id: 'chat-1', message_id: 'message-1', value: 'attribute' }],
            generations: [],
            promptInfos: [],
            promptToggles: [],
            promptItems: [],
        })

        rebuildDatabaseGraph({
            database,
            characters: [{ id: 'character-1' }],
            chats: [{ id: 'chat-1', character_id: 'character-1' }],
            messages: [{ id: 'message-1', chat_id: 'chat-1' }],
            characterRelations: { tags: new Map([['character-1', [{ tag: 'test' }]]]) },
            chatRelations: { bookmarks: new Map() },
            messageRelations,
            rebuildMessage: (row: object, relations: object) => ({ ...row, relations }),
            rebuildChat: (row: object, relations: object) => ({ ...row, relations }),
            rebuildCharacter: (row: object, relations: object) => ({ ...row, relations }),
        })

        const character = (database.characters as any[])[0]
        const chat = character.relations.chats[0]
        const message = chat.relations.messages[0]
        expect(character.detailsLoaded).toBe(true)
        expect(chat.messagesLoaded).toBe(true)
        expect(message.relations.attributes).toHaveLength(1)
    })
})
