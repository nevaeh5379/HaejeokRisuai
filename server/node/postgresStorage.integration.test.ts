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
        searchMessages:(query:string, scope?:string, limit?:number) => Promise<Record<string, any>[]>
        getTokenUsage:() => Promise<Record<string, any>[]>
        searchCharactersByTag:(tag:string, limit?:number) => Promise<Record<string, any>[]>
        searchCharactersByName:(name:string, limit?:number) => Promise<Record<string, any>[]>
        isAssetCatalogInitialized:(sourceId:string) => Promise<boolean>
        listAssetCatalog:(prefix?:string) => Promise<string[]>
        upsertAssetCatalog:(entries:{key:string, size?:number|null, etag?:string|null}[]) => Promise<number>
        removeAssetCatalog:(keys:string[]) => Promise<number>
        replaceAssetCatalog:(prefix:string, entries:{key:string, size?:number|null, etag?:string|null}[], sourceId:string) => Promise<number>
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
            `TRUNCATE system.revisions, system.settings, character.characters,
                      cold.archives, cold.legacy_imports
             RESTART IDENTITY CASCADE`
        )
        await storage.pool.query(
            'UPDATE system.storage_meta SET revision = 0, initialized = FALSE WHERE singleton = TRUE'
        )
        await storage.pool.query('TRUNCATE system.asset_catalog')
        await storage.pool.query(
            'UPDATE system.asset_catalog_state SET initialized = FALSE, source_id = NULL, synced_at = NULL WHERE singleton = TRUE'
        )
    })

    afterAll(async () => {
        await storage.pool.end()
    })

    it('maintains an S3 asset catalog scoped to its storage source', async () => {
        const source = JSON.stringify({ type: 's3', endpoint: 'http://rustfs:9000', bucket: 'risuai-assets' })
        const otherSource = JSON.stringify({ type: 's3', endpoint: 'http://other:9000', bucket: 'risuai-assets' })

        expect(await storage.isAssetCatalogInitialized(source)).toBe(false)
        await storage.replaceAssetCatalog('assets/', [
            { key: 'assets/a.png', size: 10 },
            { key: 'assets/b.webp', size: 20 },
        ], source)

        expect(await storage.isAssetCatalogInitialized(source)).toBe(true)
        expect(await storage.isAssetCatalogInitialized(otherSource)).toBe(false)
        expect(await storage.listAssetCatalog('assets/')).toEqual([
            'assets/a.png',
            'assets/b.webp',
        ])

        await storage.upsertAssetCatalog([{ key: 'assets/c.mp3', size: 30 }])
        await storage.removeAssetCatalog(['assets/a.png'])
        expect(await storage.listAssetCatalog('assets/')).toEqual([
            'assets/b.webp',
            'assets/c.mp3',
        ])
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
                data: {
                    name: 'Test Character',
                    firstMessage: 'Hello from PostgreSQL',
                    tags: ['tester', 'database'],
                    alternateGreetings: ['Alt 1', 'Alt 2'],
                    emotionImages: [['happy', 'asset://happy']],
                    globalLore: [{
                        id: 'char-lore-1',
                        key: 'sword',
                        secondkey: '',
                        insertorder: 0,
                        comment: 'item',
                        content: 'Legendary sword',
                        mode: 'normal',
                        alwaysActive: true,
                        selective: false,
                    }],
                },
            }],
            chatManifests: [{
                characterId: 'character-1',
                ids: ['chat-1'],
            }],
            chats: [{
                id: 'chat-1',
                characterId: 'character-1',
                position: 0,
                data: {
                    name: 'First Chat',
                    note: 'Important note',
                },
            }],
            messageManifests: [{
                chatId: 'chat-1',
                ids: ['message-1'],
            }],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: {
                    role: 'user',
                    data: 'hello',
                },
            }],
        })

        expect(first.revision).toBe(1)
        expect(await storage.getState()).toEqual({ revision: 1, initialized: true })

        const loaded = await storage.loadDatabase()
        expect(loaded.revision).toBe(1)
        expect(loaded.initialized).toBe(true)
        expect(loaded.database?.username).toBe('user')
        expect(loaded.database?.optionalValue).toBeNull()
        expect(loaded.database?.sourceWithNul).toEqual({ code: 'tool\0separator' })
        expect(loaded.database?.translatorPresets).toEqual([
            { name: 'Korean', prompt: 'Translate', maxResponse: 2048 },
        ])
        expect(loaded.database?.globalChatVariables).toEqual({ player: 'Jihoon' })
        expect(loaded.database?.botPresets?.[0]?.aiModel).toBe('model-sql')
        expect(loaded.database?.personas?.[0]?.id).toBe('persona-sql')
        expect(loaded.database?.modules?.[0]?.mcp).toEqual({ url: 'https://mcp.test' })
        expect(loaded.database?.plugins?.[0]?.name).toBe('plugin-sql')
        expect(loaded.database?.loreBook?.[0]?.data?.[0]?.key).toBe('city')
        expect(loaded.database?.characters).toHaveLength(1)
        expect(loaded.database?.characters[0].name).toBe('Test Character')
        expect(loaded.database?.characters[0].tags).toEqual(['tester', 'database'])
        expect(loaded.database?.characters[0].alternateGreetings).toEqual(['Alt 1', 'Alt 2'])
        expect(loaded.database?.characters[0].emotionImages).toEqual([['happy', 'asset://happy']])
        expect(loaded.database?.characters[0].globalLore?.[0]?.key).toBe('sword')
        expect(loaded.database?.characters[0].chats).toHaveLength(1)
        expect(loaded.database?.characters[0].chats[0].name).toBe('First Chat')
        expect(loaded.database?.characters[0].chats[0].message).toHaveLength(1)
        expect(loaded.database?.characters[0].chats[0].message[0].data).toBe('hello')

        await storage.sync({
            baseRevision: 1,
            root: {
                upserts: [
                    { key: 'username', value: 'renamed' },
                    { key: 'sourceWithNul', value: { code: 'updated\0text' } },
                ],
                deletes: ['optionalValue'],
            },
            characters: [{
                id: 'character-1',
                position: 0,
                data: {
                    name: 'Renamed Character',
                    tags: ['database'],
                    alternateGreetings: ['Alt 1'],
                },
            }],
            chats: [{
                id: 'chat-1',
                characterId: 'character-1',
                position: 0,
                data: {
                    name: 'Renamed Chat',
                },
            }],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: {
                    role: 'user',
                    data: 'hello again',
                },
            }],
        })

        const updated = await storage.loadDatabase()
        expect(updated.revision).toBe(2)
        expect(updated.database?.username).toBe('renamed')
        expect(updated.database?.optionalValue).toBeUndefined()
        expect(updated.database?.sourceWithNul).toEqual({ code: 'updated\0text' })
        expect(updated.database?.translatorPresets).toEqual([
            { name: 'Korean', prompt: 'Translate', maxResponse: 2048 },
        ])
        expect(updated.database?.characters[0].name).toBe('Renamed Character')
        expect(updated.database?.characters[0].tags).toEqual(['database'])
        expect(updated.database?.characters[0].alternateGreetings).toEqual(['Alt 1'])
        expect(updated.database?.characters[0].chats[0].name).toBe('Renamed Chat')
        expect(updated.database?.characters[0].chats[0].message[0].data).toBe('hello again')
    })

    it('decomposes all supported settings collections into queryable child relations', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: {
                upserts: [
                    { key: 'sourceWithNul', value: { code: 'tool\0separator' } },
                    { key: 'translatorPresets', value: [{ name: 'Korean', prompt: 'Translate', maxResponse: 2048 }] },
                    { key: 'globalChatVariables', value: { player: 'Jihoon' } },
                    { key: 'loreBook', value: [{
                        name: 'World',
                        data: [{
                            id: 'lore-1', key: 'city', secondkey: 'capital', insertorder: 1,
                            comment: 'place', content: 'Queryable lore', mode: 'normal',
                            alwaysActive: false, selective: true,
                        }],
                    }] },
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
                ],
                deletes: [],
            },
            characterIds: ['character-1'],
            characters: [{
                id: 'character-1',
                position: 0,
                data: {
                    name: 'Test Character',
                    tags: ['tester', 'database'],
                    alternateGreetings: ['Alt 1', 'Alt 2'],
                    emotionImages: [['happy', 'asset://happy']],
                },
            }],
            chatManifests: [{
                characterId: 'character-1',
                ids: ['chat-1'],
            }],
            chats: [{
                id: 'chat-1',
                characterId: 'character-1',
                position: 0,
                data: {
                    name: 'First Chat',
                },
            }],
            messageManifests: [{
                chatId: 'chat-1',
                ids: ['message-1'],
            }],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: {
                    role: 'user',
                    data: 'hello',
                },
            }],
        })
        expect(await storage.pool.query(
            `SELECT
                NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'system' AND table_name = 'settings' AND column_name = 'json_value'
                ) AS no_settings_json,
                (SELECT count(*)::int FROM system.setting_values
                    WHERE setting_key = 'sourceWithNul' AND value_type = 'encoded-text') AS encoded_texts,
                (SELECT count(*)::int FROM system.setting_values
                    WHERE setting_key = 'sourceWithNul' AND member_key = 'code') AS queryable_members,
                (SELECT count(*)::int FROM system.translator_presets
                    WHERE name = 'Korean' AND max_response = 2048) AS translator_presets,
                (SELECT count(*)::int FROM system.string_map_settings
                    WHERE setting_key = 'globalChatVariables' AND key = 'player'
                        AND value = 'Jihoon') AS global_variables,
                (SELECT count(*)::int FROM system.global_lore_entries
                    WHERE primary_key = 'city' AND content = 'Queryable lore') AS global_lore,
                (SELECT count(*)::int FROM system.bot_presets
                    WHERE name = 'SQL preset' AND ai_model = 'model-sql') AS bot_presets,
                (SELECT count(*)::int FROM system.personas
                    WHERE persona_id = 'persona-sql') AS personas,
                (SELECT count(*)::int FROM system.modules
                    WHERE module_id = 'module-sql' AND mcp_url = 'https://mcp.test') AS modules,
                (SELECT count(*)::int FROM system.plugins
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
    })

    it('persists complex character assets, generation stats, and relational lore into dedicated tables', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-assets'],
            characters: [{
                id: 'character-assets',
                position: 0,
                data: {
                    name: 'Asset holder',
                    vits: null,
                    additionalAssets: [['portrait', 'asset://portrait', 'png']],
                    ccAssets: [{ name: 'card-bg', uri: 'asset://card', ext: 'webp', type: 'background' }],
                    globalLore: [{
                        id: 'lore-asset',
                        key: 'sword',
                        secondkey: 'blade',
                        insertorder: 1,
                        comment: 'lore',
                        content: 'Forged item',
                        mode: 'normal',
                        alwaysActive: true,
                        selective: false,
                        extentions: { risu_case_sensitive: true },
                    }],
                },
            }],
            chatManifests: [{ characterId: 'character-assets', ids: ['chat-assets'] }],
            chats: [{
                id: 'chat-assets',
                characterId: 'character-assets',
                position: 0,
                data: {
                    name: 'Chat with assets',
                    globalLore: [{
                        id: 'chat-lore',
                        key: 'quest',
                        secondkey: 'active',
                        insertorder: 2,
                        comment: 'quest log',
                        content: 'Rescue the knight',
                        mode: 'normal',
                        alwaysActive: true,
                        selective: false,
                    }],
                },
            }],
            messageManifests: [{ chatId: 'chat-assets', ids: ['message-assets'] }],
            messages: [{
                id: 'message-assets',
                chatId: 'chat-assets',
                position: 0,
                data: {
                    role: 'char',
                    data: 'The sword glows.',
                    generationInfo: {
                        model: 'model-1',
                        generationId: 'gen-1',
                        inputTokens: 120,
                        outputTokens: 45,
                        maxContext: 4096,
                        stage1Time: 1.2,
                        stage2Time: 0.8,
                        stage3Time: 0.4,
                        stage4Time: 0.1,
                    },
                    promptInfo: {
                        promptName: 'structured-prompt',
                        promptToggles: [
                            { key: 'strict', value: 'true' },
                            { key: 'optional-style', value: null },
                        ],
                        promptItems: [{ raw: 'item' }],
                    },
                    extensionFlag: { retained: true },
                },
            }],
        })
        expect(await storage.pool.query(
            `SELECT
                (SELECT count(*)::int FROM character.assets) AS assets,
                (SELECT count(*)::int FROM character.lore_entries) AS character_lore,
                (SELECT count(*)::int FROM chat.lore_entries) AS chat_lore,
                (SELECT count(*)::int FROM character.attributes
                    WHERE key = 'vits' AND jsonb_typeof(value) = 'null') AS json_null_attributes,
                (SELECT count(*)::int FROM chat.message_generation WHERE model = 'model-1') AS generations,
                (SELECT count(*)::int FROM chat.message_prompt_toggles
                    WHERE toggle_key = 'optional-style' AND toggle_value IS NULL) AS null_toggles,
                (SELECT count(*)::int FROM chat.message_prompt_items) AS prompt_items`
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
                (SELECT count(*)::int FROM cold.chats WHERE archive_id = $1) AS chats,
                (SELECT count(*)::int FROM cold.messages WHERE archive_id = $1) AS messages,
                (SELECT count(*)::int FROM cold.message_prompt_toggles
                    WHERE archive_id = $1 AND toggle_value IS NULL) AS null_toggles`,
            [retainedKey]
        )).toMatchObject({ rows: [{ chats: 1, messages: 2, null_toggles: 1 }] })
        expect(await storage.pool.query(
            `SELECT count(*)::int AS count
             FROM cold.messages
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
            const result = await storage.migrateLegacyColdStorage(savePath)
            expect(result).toEqual({ migrated: 1, skipped: 0 })
            expect(await storage.pruneColdStorage([])).toEqual({ deleted: 1 })
            const second = await storage.migrateLegacyColdStorage(savePath)
            expect(second).toEqual({ migrated: 0, skipped: 0 })
        } finally {
            await rm(savePath, { recursive: true, force: true })
        }
    })

    it('exports all PostgreSQL cold storage entries to legacy compressed files losslessly', async () => {
        const key = '03ac345e-a59b-4c26-bfe7-b47b20f4b302'
        const raw = {
            character: {
                chaId: 'character-export',
                name: 'Export character',
                chats: [{
                    id: 'chat-export',
                    message: [{ chatId: 'msg-export', role: 'user', data: 'Exported text' }],
                }],
            },
        }
        await storage.upsertColdStorage(key, raw)
        const savePath = await mkdtemp(join(tmpdir(), 'risu-cold-storage-export-'))
        try {
            const result = await storage.exportColdStorageToLegacy(savePath)
            expect(result.exported).toBe(1)
            const filename = Buffer.from(`coldstorage/${key}`, 'utf8').toString('hex')
            const content = await readFile(join(savePath, filename))
            expect(JSON.parse(unzipSync(content).toString('utf8'))).toEqual(raw)
        } finally {
            await rm(savePath, { recursive: true, force: true })
        }
    })

    it('records fine-grained row-level audit logs for all mutations and restores prior states', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: {
                upserts: [
                    { key: 'username', value: 'first' },
                    { key: 'translatorPresets', value: [{ name: 'Old', prompt: 'old', maxResponse: 100 }] },
                    { key: 'loadouts', value: [{
                        id: 'loadout-1', name: 'First loadout', lastUsed: 100, favorite: true,
                        presetName: 'Old', personaId: 'p1', icons: ['asset://old'],
                        characterIds: ['character-old'], modules: ['module-old'],
                        globalVariables: { route: 'old' },
                    }] },
                ],
                deletes: [],
            },
            characterIds: ['character-old'],
            characters: [{ id: 'character-old', position: 0, data: { name: 'Old Character' } }],
            chats: [],
            chatManifests: [],
            messages: [],
            messageManifests: [],
        })

        await storage.sync({
            baseRevision: 1,
            root: {
                upserts: [
                    { key: 'username', value: 'second' },
                    { key: 'translatorPresets', value: [{ name: 'New', prompt: 'new', maxResponse: 200 }] },
                    { key: 'loadouts', value: [{
                        id: 'loadout-1', name: 'Updated loadout', lastUsed: 200, favorite: false,
                        presetName: 'New', personaId: 'p2', icons: ['asset://new'],
                        characterIds: ['character-new'], modules: ['module-new'],
                        globalVariables: { route: 'new' },
                    }] },
                ],
                deletes: [],
            },
            characters: [],
            chats: [],
            messages: [],
        })

        expect(await storage.pool.query(
            `SELECT
                NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE (
                        (table_schema = 'character' AND table_name = 'characters')
                        OR (table_schema = 'chat' AND table_name IN ('chats', 'messages'))
                        AND column_name = 'data'
                    ) OR (table_schema = 'system' AND table_name = 'settings' AND column_name = 'json_value')
                ) AS no_document_columns,
                to_regclass('character.assets') IS NOT NULL AS has_assets,
                to_regclass('chat.message_generation') IS NOT NULL AS has_generation`
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
                (SELECT name FROM system.translator_presets ORDER BY position LIMIT 1) AS preset_name,
                (SELECT character_id FROM system.loadout_character_refs
                    ORDER BY loadout_position, position LIMIT 1) AS character_id,
                (SELECT module_id FROM system.loadout_module_refs
                    ORDER BY loadout_position, position LIMIT 1) AS module_id,
                (SELECT value FROM system.loadout_variables
                    WHERE key = 'route' LIMIT 1) AS variable_value,
                (SELECT asset_id FROM system.loadout_icons
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

    it('searches active and cold messages with full-text matching', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-search'],
            characters: [{
                id: 'character-search', position: 0,
                data: { name: 'Searchable', tags: ['fantasy', 'rpg'] },
            }],
            chatManifests: [{ characterId: 'character-search', ids: ['chat-search'] }],
            chats: [{ id: 'chat-search', characterId: 'character-search', position: 0, data: { name: 'Search chat' } }],
            messageManifests: [{ chatId: 'chat-search', ids: ['message-search'] }],
            messages: [{
                id: 'message-search', chatId: 'chat-search', position: 0,
                data: { role: 'user', data: 'the quick brown fox jumps over the lazy dog' },
            }],
        })
        await storage.upsertColdStorage('7be57c70-e119-4b7c-874f-68fd4d0d93c6', {
            message: [{ role: 'char', data: 'a completely different archived sentence' }],
        })

        const active = await storage.searchMessages('quick brown fox', 'all', 10)
        expect(active.some((r) => r.storageState === 'active' && r.characterName === 'Searchable')).toBe(true)

        const cold = await storage.searchMessages('archived sentence', 'cold', 10)
        expect(cold.some((r) => r.storageState === 'cold')).toBe(true)

        const scoped = await storage.searchMessages('quick brown fox', 'cold', 10)
        expect(scoped).toHaveLength(0)
    })

    it('aggregates token usage across active and cold messages', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-tokens'],
            characters: [{ id: 'character-tokens', position: 0, data: { name: 'Tokens' } }],
            chatManifests: [{ characterId: 'character-tokens', ids: ['chat-tokens'] }],
            chats: [{ id: 'chat-tokens', characterId: 'character-tokens', position: 0, data: { name: 'Token chat' } }],
            messageManifests: [{ chatId: 'chat-tokens', ids: ['message-tokens'] }],
            messages: [{
                id: 'message-tokens', chatId: 'chat-tokens', position: 0,
                data: { role: 'char', data: 'hello', generationInfo: { model: 'model-a', inputTokens: 10, outputTokens: 20 } },
            }],
        })
        await storage.upsertColdStorage('7be57c70-e119-4b7c-874f-68fd4d0d93c6', {
            message: [{ role: 'char', data: 'world', generationInfo: { model: 'model-a', inputTokens: 5, outputTokens: 7 } }],
        })

        const usage = await storage.getTokenUsage()
        const modelA = usage.find((u) => u.model === 'model-a')
        expect(modelA).toMatchObject({
            messageCount: 2,
            totalInputTokens: 15,
            totalOutputTokens: 27,
        })
    })

    it('searches characters by tag and name', async () => {
        await storage.sync({
            baseRevision: 0,
            replaceAll: true,
            root: { upserts: [], deletes: [] },
            characterIds: ['character-tag'],
            characters: [{
                id: 'character-tag', position: 0,
                data: { name: 'Tagged Character', tags: ['fantasy', 'rpg'] },
            }],
            chats: [], chatManifests: [], messageManifests: [], messages: [],
        })

        const byTag = await storage.searchCharactersByTag('fant', 10)
        expect(byTag.some((c) => c.id === 'character-tag')).toBe(true)

        const byName = await storage.searchCharactersByName('tagged', 10)
        expect(byName.some((c) => c.id === 'character-tag')).toBe(true)
    })
})
