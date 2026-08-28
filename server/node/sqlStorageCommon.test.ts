import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    BOOTSTRAP_SETTING_KEYS,
    DEFERRED_SETTING_KEYS,
    SqlStorageBase,
    createSqlStorageHelpers,
    createMessageRelations,
    groupRows,
    groupMessageRows,
    rebuildDatabaseGraph,
} = require('./sqlStorageCommon.cjs') as {
    BOOTSTRAP_SETTING_KEYS: string[]
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
        let settingLoadCount = 0
        storage.loadSettingKeys = async (keys: string[]) => {
            settingLoadCount += 1
            return {
                settings: Object.fromEntries(keys.map((key) => [key, `${key}-value`])),
                hash: 'hash',
            }
        }

        await expect(storage.loadPersonas()).resolves.toEqual({ personas: 'personas-value', hash: 'hash' })
        await expect(storage.loadSettingKey('theme')).resolves.toEqual({
            key: 'theme', value: 'theme-value', exists: true, hash: 'hash',
        })
        await expect(storage.loadPrompts()).resolves.toMatchObject({ hash: 'hash' })
        await expect(storage.loadBootstrapData()).resolves.toMatchObject({
            database: { plugins: 'plugins-value' },
            hash: 'hash',
        })
        const countAfterWarm = settingLoadCount
        await storage.loadBootstrapData()
        expect(settingLoadCount).toBe(countAfterWarm)
        storage.invalidateBootstrapCache(['characters'])
        await storage.loadBootstrapData()
        expect(settingLoadCount).toBe(countAfterWarm)
        storage.invalidateBootstrapCache(['botPresets'])
        await storage.loadBootstrapData()
        expect(settingLoadCount).toBe(countAfterWarm)
        expect(BOOTSTRAP_SETTING_KEYS).not.toContain('botPresets')
        expect(BOOTSTRAP_SETTING_KEYS).toContain('globalscript')
        expect(BOOTSTRAP_SETTING_KEYS).toContain('customModels')
        expect(BOOTSTRAP_SETTING_KEYS).toContain('translatorPresets')
        expect(BOOTSTRAP_SETTING_KEYS).toContain('loadouts')
        expect(BOOTSTRAP_SETTING_KEYS).toContain('customBackground')

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
            action: 'character',
            characters: [{ id: 'character-1', position: 0, data: {} }],
            characterDeletes: ['character-old'],
            chatManifests: [{ characterId: 'character-1', ids: ['chat-1'] }],
            chatDeletes: ['chat-old'],
        })

        expect(payload.action).toBe('character')
        expect(payload.characters).toEqual([{ id: 'character-1', position: 0, data: {} }])
        expect(payload.characterDeletes).toEqual(['character-old'])
        expect(payload.chatManifests).toEqual([{ characterId: 'character-1', ids: ['chat-1'] }])
        expect(payload.chatDeletes).toEqual(['chat-old'])
        expect(() => helpers.validateSyncPayload({
            baseRevision: 2,
            messageManifests: [{ chatId: 'chat-1', ids: [null] }],
        })).toThrow(TestPayloadError)
        expect(() => helpers.validateSyncPayload({
            baseRevision: 2,
            characterDeletes: [null],
        })).toThrow(TestPayloadError)
        expect(() => helpers.validateSyncPayload({
            baseRevision: 2,
            chatDeletes: [null],
        })).toThrow(TestPayloadError)
    })

    it('validates scalar character interaction touches', () => {
        const helpers = createSqlStorageHelpers({ PayloadError: TestPayloadError })
        const payload = helpers.validateSyncPayload({
            baseRevision: 3,
            characterTouches: [{ id: 'character-1', lastInteraction: 123456789 }],
        })

        expect(payload.characterTouches).toEqual([
            { id: 'character-1', lastInteraction: 123456789 },
        ])
        expect(() => helpers.validateSyncPayload({
            baseRevision: 3,
            characterTouches: [{ id: 'character-1', lastInteraction: -1 }],
        })).toThrow(TestPayloadError)
    })

    it('normalizes ID-based preset mutations and rejects legacy root arrays', () => {
        const helpers = createSqlStorageHelpers({ PayloadError: TestPayloadError })
        const id = '123e4567-e89b-42d3-a456-426614174000'
        const payload = helpers.validateSyncPayload({
            baseRevision: 4,
            root: { upserts: [], deletes: [] },
            presets: { upserts: [{ id, position: 0, data: { name: 'Only summary fields escape list API', openAIKey: 'secret' } }], deletes: [], order: [id], activeId: id },
        })
        expect(payload.presets).toMatchObject({ order: [id], activeId: id })
        expect(payload.presets.upserts[0].data.openAIKey).toBe('secret')
        expect(() => helpers.validateSyncPayload({
            baseRevision: 4,
            root: { upserts: [{ key: 'botPresets', value: [] }], deletes: [] },
        })).toThrow(/written through presets/)
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
