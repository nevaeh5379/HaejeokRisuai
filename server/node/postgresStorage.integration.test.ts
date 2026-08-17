import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, unzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    PostgresRevisionConflictError,
    PostgresStorage,
} = require('./postgresStorage.cjs') as {
    PostgresRevisionConflictError:new (revision:number) => Error
    PostgresStorage:new (options?:{ connectionString?:string }) => {
        enabled:boolean
        initialize:() => Promise<void>
        reconfigure:(options:{connectionString:string, poolMax?:number}) => Promise<void>
        loadDatabase:() => Promise<{
            initialized:boolean
            revision:number
            database:Record<string, any>|null
        }>
        sync:(payload:Record<string, any>) => Promise<{ revision:number }>
        listRevisions:(limit?:number) => Promise<Record<string, any>[]>
        restoreRevision:(revisionId:number) => Promise<{revision:number, changed:number}>
        loadColdStorage:(key:string) => Promise<Record<string, any>|null>
        listColdStorage:() => Promise<Record<string, any>[]>
        upsertColdStorage:(key:string, value:unknown) => Promise<Record<string, any>>
        deleteColdStorage:(keys:string[]) => Promise<{deleted:number}>
        pruneColdStorage:(keys:string[]) => Promise<{deleted:number}>
        migrateLegacyColdStorage:(savePath:string) => Promise<{migrated:number, skipped:number}>
        exportColdStorageToLegacy:(savePath:string) => Promise<{exported:number, archived:number}>
        pool:{ query:(sql:string, params?:unknown[]) => Promise<any>, end:() => Promise<void> }
    }
}

const connectionString = process.env.TEST_DATABASE_URL
const describePostgres = connectionString ? describe : describe.skip

describePostgres('PostgreSQL structured storage integration', () => {
    const storage = new PostgresStorage({ connectionString: connectionString! })

    beforeAll(async () => {
        await storage.initialize()
    })

    beforeEach(async () => {
        await storage.pool.query(
            `TRUNCATE risu_revisions, risu_settings, risu_characters,
                      risu_cold_archives, risu_cold_storage_legacy_imports
             RESTART IDENTITY CASCADE`
        )
        await storage.pool.query(
            'UPDATE risu_storage_meta SET revision = 0, initialized = FALSE WHERE singleton = TRUE'
        )
    })

    afterAll(async () => {
        await storage.pool.end()
    })

    it('imports, reconstructs, and incrementally updates normalized data', async () => {
        const first = await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: {
                upserts: [
                    { key: 'username', value: 'user' },
                    { key: 'optionalValue', value: null },
                    { key: 'sourceWithNul', value: { code: 'tool\0separator' } },
                    { key: 'translatorPresets', value: [{ name: 'Korean', prompt: 'Translate', maxResponse: 2048 }] },
                    { key: 'globalChatVariables', value: { player: 'Jihoon' } },
                    { key: 'botPresets', value: [{
                        name: 'SQL preset', apiType: 'openai', aiModel: 'model-sql',
                        mainPrompt: 'Main', jailbreak: '', globalNote: '', temperature: 0.8,
                        maxContext: 8192, maxResponse: 1024, frequencyPenalty: 0,
                        PresensePenalty: 0, promptPreprocess: true,
                    }] },
                    { key: 'personas', value: [{
                        id: 'persona-sql', name: 'Persona', personaPrompt: 'Prompt', icon: 'asset://persona',
                    }] },
                    { key: 'modules', value: [{
                        id: 'module-sql', name: 'Module', description: 'Description', mcp: { url: 'https://mcp.test' },
                    }] },
                    { key: 'plugins', value: [{
                        name: 'plugin-sql', displayName: 'Plugin', script: 'return true', version: '3.0',
                    }] },
                    { key: 'loreBook', value: [{
                        name: 'World',
                        data: [{
                            id: 'lore-1', key: 'city', secondkey: 'capital', insertorder: 1,
                            comment: 'place', content: 'Queryable lore', mode: 'normal',
                            alwaysActive: false, selective: true,
                        }],
                    }] },
                ],
                deletes: [],
            },
            characterIds: ['character-1'],
            characters: [{
                id: 'character-1',
                position: 0,
                data: { name: 'Character' },
            }],
            chatManifests: [{ characterId: 'character-1', ids: ['chat-1'] }],
            chats: [{
                id: 'chat-1',
                characterId: 'character-1',
                position: 0,
                data: { name: 'Chat' },
            }],
            messageManifests: [{ chatId: 'chat-1', ids: ['message-1'] }],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: { role: 'user', data: 'hello' },
            }],
        })

        expect(first.revision).toBe(1)
        const imported = await storage.loadDatabase()
        expect(imported).toMatchObject({
            initialized: true,
            revision: 1,
            database: {
                username: 'user',
                optionalValue: null,
                sourceWithNul: { code: 'tool\0separator' },
                translatorPresets: [{ name: 'Korean', prompt: 'Translate', maxResponse: 2048 }],
                globalChatVariables: { player: 'Jihoon' },
                characters: [{
                    chaId: 'character-1',
                    name: 'Character',
                    chats: [{
                        id: 'chat-1',
                        name: 'Chat',
                        message: [{
                            chatId: 'message-1',
                            role: 'user',
                            data: 'hello',
                        }],
                    }],
                }],
            },
        })
        expect(await storage.pool.query(
            `SELECT
                NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'risu_settings' AND column_name = 'json_value'
                ) AS no_settings_json,
                (SELECT count(*)::int FROM risu_setting_values
                    WHERE setting_key = 'sourceWithNul' AND value_type = 'encoded-text') AS encoded_texts,
                (SELECT count(*)::int FROM risu_setting_values
                    WHERE setting_key = 'sourceWithNul' AND member_key = 'code') AS queryable_members,
                (SELECT count(*)::int FROM risu_translator_presets
                    WHERE name = 'Korean' AND max_response = 2048) AS translator_presets,
                (SELECT count(*)::int FROM risu_string_map_settings
                    WHERE setting_key = 'globalChatVariables' AND key = 'player'
                        AND value = 'Jihoon') AS global_variables,
                (SELECT count(*)::int FROM risu_global_lore_entries
                    WHERE primary_key = 'city' AND content = 'Queryable lore') AS global_lore,
                (SELECT count(*)::int FROM risu_bot_presets
                    WHERE name = 'SQL preset' AND ai_model = 'model-sql') AS bot_presets,
                (SELECT count(*)::int FROM risu_personas
                    WHERE persona_id = 'persona-sql') AS personas,
                (SELECT count(*)::int FROM risu_modules
                    WHERE module_id = 'module-sql' AND mcp_url = 'https://mcp.test') AS modules,
                (SELECT count(*)::int FROM risu_plugins
                    WHERE name = 'plugin-sql' AND api_version = '3.0') AS plugins`
        )).toMatchObject({ rows: [{
            no_settings_json: true,
            encoded_texts: 1,
            queryable_members: 1,
            translator_presets: 1,
            global_variables: 1,
            global_lore: 1,
            bot_presets: 1,
            personas: 1,
            modules: 1,
            plugins: 1,
        }] })

        const second = await storage.sync({
            baseRevision: 1,
            root: { upserts: [], deletes: [] },
            characters: [],
            chats: [],
            chatManifests: [],
            messageManifests: [],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: { role: 'user', data: 'edited' },
            }],
        })

        expect(second.revision).toBe(2)
        expect((await storage.loadDatabase()).database?.characters[0].chats[0].message[0].data)
            .toBe('edited')
    })

    it('decomposes rich chat data into queryable relational rows without losing dynamic extensions', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-rich'],
            characters: [{
                id: 'character-rich',
                position: 0,
                data: {
                    name: 'Relational character',
                    firstMessage: 'Hello',
                    desc: 'Description',
                    notes: 'Notes',
                    chatPage: 0,
                    viewScreen: 'emotion',
                    tags: ['test', 'sql'],
                    bias: [['term', -1.5]],
                    emotionImages: [['happy', 'asset://happy']],
                    modules: ['module-1'],
                    chatFolders: [{ id: 'folder-1', name: 'Saved', color: '#fff', folded: false }],
                    customscript: [{ comment: 'replace', in: 'a', out: 'b', type: 'edit' }],
                    triggerscript: [{ comment: 'trigger', type: 'manual', conditions: ['x'] }],
                    sdData: [['prompt', 'portrait']],
                    additionalAssets: [['asset://one', 'one', 'png']],
                    ccAssets: [{ type: 'icon', uri: 'asset://two', name: 'two', ext: 'webp' }],
                    globalLore: [{
                        id: 'lore-1', key: 'world', secondkey: '', insertorder: 2,
                        comment: 'lore', content: 'content', mode: 'normal',
                        alwaysActive: true, selective: false,
                    }],
                    creation_date: 1_700_000_000_000,
                    vits: null,
                    pluginExtension: { source: 'tool\0separator' },
                },
            }],
            chatManifests: [{ characterId: 'character-rich', ids: ['chat-rich'] }],
            chats: [{
                id: 'chat-rich', characterId: 'character-rich', position: 0,
                data: {
                    name: 'Queryable chat', note: 'note\0source',
                    localLore: [{ key: 'local', secondkey: '', insertorder: 1, comment: '', content: 'local content', mode: 'normal', alwaysActive: false, selective: false }],
                    suggestMessages: ['one', 'two'], modules: ['module-2'],
                    scriptstate: { count: 2, enabled: true },
                    hypaV2Data: { summaries: ['memory'] },
                    bookmarks: ['message-rich'], bookmarkNames: { 'message-rich': 'Important' },
                    lastDate: 1_700_000_000_100,
                },
            }],
            messageManifests: [{ chatId: 'chat-rich', ids: ['message-rich'] }],
            messages: [{
                id: 'message-rich', chatId: 'chat-rich', position: 0,
                data: {
                    role: 'char', data: 'answer\0binary', time: 1_700_000_000_200,
                    disabled: false,
                    generationInfo: {
                        model: 'model-1', generationId: 'generation-1', inputTokens: 12,
                        outputTokens: 34, maxContext: 4096, stageTiming: { stage1: 1.25 },
                    },
                    promptInfo: {
                        promptName: 'preset',
                        promptToggles: [
                            { key: 'lore', value: 'on' },
                            { key: 'optional-style', value: null },
                        ],
                        promptText: [{ role: 'system', content: 'prompt' }],
                    },
                    extensionFlag: { retained: true },
                },
            }],
        })

        const loaded = (await storage.loadDatabase()).database
        expect(loaded?.characters[0]).toMatchObject({
            name: 'Relational character',
            creation_date: 1_700_000_000_000,
            tags: ['test', 'sql'],
            additionalAssets: [['asset://one', 'one', 'png']],
            ccAssets: [{ type: 'icon', uri: 'asset://two', name: 'two', ext: 'webp' }],
            pluginExtension: { source: 'tool\0separator' },
            vits: null,
            chats: [{
                id: 'chat-rich', note: 'note\0source', suggestMessages: ['one', 'two'],
                hypaV2Data: { summaries: ['memory'] },
                message: [{
                    chatId: 'message-rich', data: 'answer\0binary', disabled: false,
                    generationInfo: { model: 'model-1', inputTokens: 12, stageTiming: { stage1: 1.25 } },
                    promptInfo: {
                        promptName: 'preset',
                        promptToggles: [
                            { key: 'lore', value: 'on' },
                            { key: 'optional-style', value: null },
                        ],
                    },
                    extensionFlag: { retained: true },
                }],
            }],
        })
        expect(await storage.pool.query(
            `SELECT
                (SELECT count(*)::int FROM risu_character_assets) AS assets,
                (SELECT count(*)::int FROM risu_character_lore_entries) AS character_lore,
                (SELECT count(*)::int FROM risu_chat_lore_entries) AS chat_lore,
                (SELECT count(*)::int FROM risu_character_attributes
                    WHERE key = 'vits' AND jsonb_typeof(value) = 'null') AS json_null_attributes,
                (SELECT count(*)::int FROM risu_message_generation WHERE model = 'model-1') AS generations,
                (SELECT count(*)::int FROM risu_message_prompt_toggles
                    WHERE toggle_key = 'optional-style' AND toggle_value IS NULL) AS null_toggles,
                (SELECT count(*)::int FROM risu_message_prompt_items) AS prompt_items`
        )).toMatchObject({ rows: [{
            assets: 2, character_lore: 1, chat_lore: 1, json_null_attributes: 1,
            generations: 1, null_toggles: 1, prompt_items: 1,
        }] })
    })

    it('rejects a stale writer without changing stored data', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [{ key: 'username', value: 'first' }], deletes: [] },
            characterIds: [],
            characters: [],
            chats: [],
            chatManifests: [],
            messages: [],
            messageManifests: [],
        })

        await expect(storage.sync({
            baseRevision: 0,
            root: { upserts: [{ key: 'username', value: 'stale' }], deletes: [] },
        })).rejects.toBeInstanceOf(PostgresRevisionConflictError)
        expect((await storage.loadDatabase()).database?.username).toBe('first')
    })

    it('stores cold data in relational chat and message tables and prunes it with one set operation', async () => {
        const retainedKey = 'a0a8a9ca-3e7a-4f1d-a127-8844981542dd'
        const deletedKey = 'bc3f7c8d-38bd-47ec-8371-f2d081349157'
        const coldCharacter = {
            character: {
                chaId: 'character-1',
                name: 'Cold character',
                chats: [{
                    id: 'cold-chat-1',
                    note: 'Archived\0source',
                    message: [
                        { chatId: 'cold-message-1', role: 'user', data: 'First\0part' },
                        {
                            chatId: 'cold-message-2', role: 'char', data: 'Second',
                            promptInfo: {
                                promptName: 'legacy',
                                promptToggles: [{ key: '✏커스텀 서술 스타일', value: null }],
                            },
                        },
                    ],
                }],
            },
        }
        const first = await storage.upsertColdStorage(retainedKey, coldCharacter)
        await storage.upsertColdStorage(deletedKey, {
            message: [{ role: 'user', data: 'Cold chat' }],
        })

        expect(first.kind).toBe('character')
        expect((await storage.loadColdStorage(retainedKey))?.data).toEqual(coldCharacter)
        expect(await storage.pool.query(
            `SELECT
                (SELECT count(*)::int FROM risu_cold_chats WHERE archive_id = $1) AS chats,
                (SELECT count(*)::int FROM risu_cold_messages WHERE archive_id = $1) AS messages,
                (SELECT count(*)::int FROM risu_cold_message_prompt_toggles
                    WHERE archive_id = $1 AND toggle_value IS NULL) AS null_toggles`,
            [retainedKey]
        )).toMatchObject({ rows: [{ chats: 1, messages: 2, null_toggles: 1 }] })
        expect(await storage.pool.query(
            `SELECT count(*)::int AS count
             FROM risu_cold_messages
             WHERE role = $1 AND content_text = $2`,
            ['char', 'Second']
        )).toMatchObject({ rows: [{ count: 1 }] })

        expect(await storage.pruneColdStorage([retainedKey])).toEqual({ deleted: 1 })
        expect((await storage.listColdStorage()).map((item) => item.key)).toEqual([retainedKey])
    })

    it('imports each legacy compressed file once without resurrecting pruned data', async () => {
        const key = '03ac345e-a59b-4c26-bfe7-b47b20f4b301'
        const logicalPath = `coldstorage/${key}`
        const savePath = await mkdtemp(join(tmpdir(), 'risu-cold-storage-'))
        try {
            await writeFile(
                join(savePath, Buffer.from(logicalPath).toString('hex')),
                deflateSync(JSON.stringify({ message: [{ role: 'char', data: 'legacy' }] }))
            )

            expect(await storage.migrateLegacyColdStorage(savePath)).toEqual({ migrated: 1, skipped: 0 })
            expect((await storage.loadColdStorage(key))?.data.message[0].data).toBe('legacy')
            expect(await storage.exportColdStorageToLegacy(savePath)).toEqual({ exported: 1, archived: 0 })
            expect(JSON.parse(unzipSync(await readFile(
                join(savePath, Buffer.from(logicalPath).toString('hex'))
            )).toString('utf8'))).toEqual({ message: [{ role: 'char', data: 'legacy' }] })
            expect(await storage.deleteColdStorage([key])).toEqual({ deleted: 1 })
            expect(await storage.migrateLegacyColdStorage(savePath)).toEqual({ migrated: 0, skipped: 0 })
            expect(await storage.loadColdStorage(key)).toBeNull()

            expect(await storage.exportColdStorageToLegacy(savePath)).toEqual({ exported: 0, archived: 1 })
            expect(await storage.migrateLegacyColdStorage(savePath)).toEqual({ migrated: 0, skipped: 0 })
            expect(await readdir(join(savePath, '__postgres_cold_storage_rollback')))
                .toHaveLength(1)
        } finally {
            await rm(savePath, { recursive: true, force: true })
        }
    })

    it('uses relational entity columns and restores an immutable revision as a new revision', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [
                { key: 'username', value: 'first' },
                { key: 'translatorPresets', value: [{ name: 'Old', prompt: 'old', maxResponse: 100 }] },
                { key: 'loadouts', value: [{
                    id: 'loadout-old', name: 'Old loadout', lastUsed: 1000, favorite: true,
                    characterIds: ['character-old'], modules: ['module-old'],
                    globalVariables: { route: 'old' }, presetName: 'Old', personaId: 'persona-old',
                    icons: ['asset://old'],
                }] },
            ], deletes: [] },
            characterIds: [], characters: [], chats: [], chatManifests: [], messages: [], messageManifests: [],
        })
        await storage.sync({
            baseRevision: 1,
            root: { upserts: [
                { key: 'username', value: 'second' },
                { key: 'translatorPresets', value: [{ name: 'New', prompt: 'new', maxResponse: 200 }] },
                { key: 'loadouts', value: [{
                    id: 'loadout-new', name: 'New loadout', lastUsed: 2000, favorite: false,
                    characterIds: ['character-new'], modules: [], globalVariables: {},
                    presetName: 'New', personaId: 'persona-new',
                }] },
            ], deletes: [] },
            characters: [], chats: [], chatManifests: [], messages: [], messageManifests: [],
        })

        expect(await storage.pool.query(
            `SELECT
                NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE (
                        table_name IN ('risu_characters', 'risu_chats', 'risu_messages')
                        AND column_name = 'data'
                    ) OR (table_name = 'risu_settings' AND column_name = 'json_value')
                ) AS no_document_columns,
                to_regclass('risu_character_assets') IS NOT NULL AS has_assets,
                to_regclass('risu_message_generation') IS NOT NULL AS has_generation`
        )).toMatchObject({ rows: [{ no_document_columns: true, has_assets: true, has_generation: true }] })

        const history = await storage.listRevisions()
        expect(history.map((revision) => revision.id)).toEqual([2, 1])
        await storage.restoreRevision(1)
        expect((await storage.loadDatabase()).database?.username).toBe('first')
        expect((await storage.loadDatabase()).database?.translatorPresets).toEqual([
            { name: 'Old', prompt: 'old', maxResponse: 100 },
        ])
        expect(await storage.pool.query(
            `SELECT
                (SELECT name FROM risu_translator_presets ORDER BY position LIMIT 1) AS preset_name,
                (SELECT character_id FROM risu_loadout_character_refs
                    ORDER BY loadout_position, position LIMIT 1) AS character_id,
                (SELECT module_id FROM risu_loadout_module_refs
                    ORDER BY loadout_position, position LIMIT 1) AS module_id,
                (SELECT value FROM risu_loadout_variables
                    WHERE key = 'route' LIMIT 1) AS variable_value,
                (SELECT asset_id FROM risu_loadout_icons
                    ORDER BY loadout_position, position LIMIT 1) AS asset_id`
        )).toMatchObject({ rows: [{
            preset_name: 'Old', character_id: 'character-old', module_id: 'module-old',
            variable_value: 'old', asset_id: 'asset://old',
        }] })
        expect((await storage.listRevisions())[0]).toMatchObject({
            scope: 'restore',
            restored_from_revision: 1,
        })
    })

    it('repairs relational-v1 prompt toggle columns created before nullable values were supported', async () => {
        await storage.pool.query(
            'ALTER TABLE risu_message_prompt_toggles ALTER COLUMN toggle_value SET NOT NULL'
        )
        await storage.pool.query(
            'ALTER TABLE risu_cold_message_prompt_toggles ALTER COLUMN toggle_value SET NOT NULL'
        )
        await storage.pool.query(await readFile(
            join(process.cwd(), 'server/node/postgres-schema.sql'),
            'utf8'
        ))
        expect(await storage.pool.query(
            `SELECT table_name, is_nullable
             FROM information_schema.columns
             WHERE table_name IN (
                 'risu_message_prompt_toggles',
                 'risu_cold_message_prompt_toggles'
             ) AND column_name = 'toggle_value'
             ORDER BY table_name`
        )).toMatchObject({ rows: [
            { table_name: 'risu_cold_message_prompt_toggles', is_nullable: 'YES' },
            { table_name: 'risu_message_prompt_toggles', is_nullable: 'YES' },
        ] })
    })

    it('restores relational message children and cold archives across multiple later revisions', async () => {
        const coldKey = '7be57c70-e119-4b7c-874f-68fd4d0d93c6'
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-restore'],
            characters: [{
                id: 'character-restore', position: 0,
                data: { name: 'Restore', vits: null, extensionLabel: 'old' },
            }],
            chatManifests: [{ characterId: 'character-restore', ids: ['chat-restore'] }],
            chats: [{ id: 'chat-restore', characterId: 'character-restore', position: 0, data: { name: 'Restore chat' } }],
            messageManifests: [{ chatId: 'chat-restore', ids: ['message-restore'] }],
            messages: [{
                id: 'message-restore', chatId: 'chat-restore', position: 0,
                data: { role: 'user', data: 'before\0binary', generationInfo: { model: 'old-model' } },
            }],
        })
        await storage.sync({
            baseRevision: 1,
            root: { upserts: [], deletes: [] },
            characters: [{
                id: 'character-restore', position: 0,
                data: { name: 'Restore', vits: { model: 'changed' }, extensionLabel: 'new' },
            }],
            chats: [], chatManifests: [], messageManifests: [],
            messages: [{
                id: 'message-restore', chatId: 'chat-restore', position: 0,
                data: { role: 'user', data: 'after', generationInfo: { model: 'new-model' } },
            }],
        })
        await storage.upsertColdStorage(coldKey, { message: [{ role: 'char', data: 'archived' }] })
        await storage.deleteColdStorage([coldKey])

        await storage.restoreRevision(3)
        expect((await storage.loadColdStorage(coldKey))?.data).toEqual({
            message: [{ role: 'char', data: 'archived' }],
        })
        expect((await storage.loadDatabase()).database?.characters[0].chats[0].message[0]).toMatchObject({
            data: 'after', generationInfo: { model: 'new-model' },
        })

        await storage.restoreRevision(1)
        expect(await storage.loadColdStorage(coldKey)).toBeNull()
        expect((await storage.loadDatabase()).database?.characters[0].chats[0].message[0]).toMatchObject({
            data: 'before\0binary', generationInfo: { model: 'old-model' },
        })
        expect((await storage.loadDatabase()).database?.characters[0]).toMatchObject({
            vits: null,
            extensionLabel: 'old',
        })
    })

    it('can validate and swap a PostgreSQL connection at runtime', async () => {
        const dynamicStorage = new PostgresStorage()
        await dynamicStorage.reconfigure({ connectionString: connectionString! })
        expect(dynamicStorage.enabled).toBe(true)
        await dynamicStorage.reconfigure({ connectionString: '' })
        expect(dynamicStorage.enabled).toBe(false)
    })
})
