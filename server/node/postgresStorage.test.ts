import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    DEFERRED_SETTING_KEYS,
    buildUpsertClause,
    decodePostgresJsonValue,
    encodePostgresJsonValue,
    PostgresPayloadError,
    PostgresStorage,
    normalizeColdStorageKey,
    validateColdStorageKeys,
    validateColdStorageValue,
    validateSyncPayload,
} = require('./postgresStorage.cjs') as {
    DEFERRED_SETTING_KEYS:string[]
    buildUpsertClause:(table:string, pkColumns:string[], valueColumns:string[], updateTimestamp?:boolean) => string
    decodePostgresJsonValue:(value:unknown) => unknown
    encodePostgresJsonValue:(value:unknown) => unknown
    PostgresStorage:any
    PostgresPayloadError:new (message:string) => Error
    normalizeColdStorageKey:(key:unknown) => string
    validateColdStorageKeys:(keys:unknown) => string[]
    validateColdStorageValue:(value:unknown) => unknown
    validateSyncPayload:(payload:unknown) => {
        baseRevision:number
        messages:unknown[]
    }
}
const {
    rebuildSettings,
    splitSetting,
} = require('./postgresSettingsCodec.cjs') as {
    rebuildSettings:(settings:{key:string}[], values:Record<string, any>[]) => Record<string, any>
    splitSetting:(key:string, value:unknown) => {
        setting:{key:string}
        values:Record<string, any>[]
    }
}

describe('PostgreSQL sync payload validation', () => {
    it('accepts a normalized incremental payload', () => {
        const result = validateSyncPayload({
            baseRevision: 4,
            root: {
                upserts: [{ key: 'theme', value: null }],
                deletes: [],
            },
            characters: [],
            characterIds: ['character-1'],
            chats: [],
            chatManifests: [],
            messages: [{
                id: 'message-1',
                chatId: 'chat-1',
                position: 0,
                data: { role: 'user', data: 'hello' },
            }],
            messageManifests: [],
        })

        expect(result.baseRevision).toBe(4)
        expect(result.messages).toHaveLength(1)
    })

    it('rejects invalid revisions before opening a transaction', () => {
        expect(() => validateSyncPayload({ baseRevision: -1 })).toThrow(PostgresPayloadError)
    })

    it('rejects invalid entity identifiers', () => {
        expect(() => validateSyncPayload({
            baseRevision: 0,
            characters: [{ id: '', position: 0, data: {} }],
        })).toThrow(/characters.*\.id/)
    })

    it('normalizes and deduplicates PostgreSQL cold storage UUIDs', () => {
        const key = 'A0A8A9CA-3E7A-4F1D-A127-8844981542DD'

        expect(normalizeColdStorageKey(key)).toBe(key.toLowerCase())
        expect(validateColdStorageKeys([key, key.toLowerCase()])).toEqual([key.toLowerCase()])
    })

    it('accepts queryable cold storage data and rejects opaque values', () => {
        expect(validateColdStorageValue({ message: [{ data: 'hello' }] })).toEqual({
            message: [{ data: 'hello' }],
        })
        expect(validateColdStorageValue([{ role: 'user' }])).toEqual([{ role: 'user' }])
        expect(() => validateColdStorageValue('compressed bytes')).toThrow(PostgresPayloadError)
    })

    it('losslessly encodes NUL text and object keys for PostgreSQL JSONB', () => {
        const reservedTag = '__risu_pg_text_utf16le_v1_8e81b0b9__'
        const original = {
            ordinary: 'queryable text',
            source: 'before\0after',
            unpairedSurrogate: `\ud800\0tail`,
            nested: [{ 'key\0suffix': 'value\0suffix' }],
            collision: { [reservedTag]: 'user data' },
        }

        const encoded = encodePostgresJsonValue(original)
        expect(JSON.stringify(encoded)).not.toContain('\\u0000')
        expect(decodePostgresJsonValue(encoded)).toEqual(original)
        expect((encoded as typeof original).ordinary).toBe('queryable text')
    })

    it('does not copy ordinary JSON trees that need no PostgreSQL encoding', () => {
        const ordinary = { nested: [{ text: 'plain', count: 2 }] }

        expect(encodePostgresJsonValue(ordinary)).toBe(ordinary)
        expect(decodePostgresJsonValue(ordinary)).toBe(ordinary)
    })

    it('decomposes structured settings into typed relational rows without JSON payloads', () => {
        const value = {
            theme: { name: 'night', opacity: 0.75, enabled: true },
            ordered: ['first', null, { source: 'before\0after' }],
            ['key\0suffix']: `unpaired-\ud800`,
            ['__proto__']: { retained: true },
        }
        const split = splitSetting('complexSetting', value)

        expect(split.values.every((row) => !Object.hasOwn(row, 'json_value'))).toBe(true)
        expect(split.values.find((row) => row.member_key === 'theme')).toMatchObject({
            value_type: 'object',
        })
        expect(split.values.find((row) => row.text_value === 'night')).toMatchObject({
            value_type: 'text',
        })
        expect(split.values.some((row) => row.value_type === 'encoded-text')).toBe(true)
        expect(rebuildSettings([split.setting], split.values)).toEqual({ complexSetting: value })
    })

    it('exports DEFERRED_SETTING_KEYS including heavy domains and prompt keys', () => {
        expect(DEFERRED_SETTING_KEYS).toContain('personas')
        expect(DEFERRED_SETTING_KEYS).toContain('botPresets')
        expect(DEFERRED_SETTING_KEYS).toContain('loreBook')
        expect(DEFERRED_SETTING_KEYS).toContain('modules')
        expect(DEFERRED_SETTING_KEYS).toContain('globalscript')
        expect(DEFERRED_SETTING_KEYS).toContain('mainPrompt')
        expect(DEFERRED_SETTING_KEYS).toContain('plugins')
    })

    it('generates diff-based upsert clauses with IS DISTINCT FROM conditions', () => {
        const clause = buildUpsertClause('character.lore_entries', ['character_id', 'position'], ['lore_id', 'primary_key', 'content'])
        expect(clause).toContain('ON CONFLICT ("character_id", "position") DO UPDATE SET')
        expect(clause).toContain('"lore_id" = EXCLUDED."lore_id"')
        expect(clause).toContain('"primary_key" = EXCLUDED."primary_key"')
        expect(clause).toContain('"content" = EXCLUDED."content"')
        expect(clause).toContain('WHERE ("character"."lore_entries"."lore_id", "character"."lore_entries"."primary_key", "character"."lore_entries"."content") IS DISTINCT FROM (EXCLUDED."lore_id", EXCLUDED."primary_key", EXCLUDED."content")')
    })

    it('appends updated_at timestamp update when requested in upsert clauses', () => {
        const clause = buildUpsertClause('character.characters', ['id'], ['name', 'description'], true)
        expect(clause).toContain('ON CONFLICT ("id") DO UPDATE SET')
        expect(clause).toContain('"updated_at" = NOW()')
        expect(clause).toContain('WHERE ("character"."characters"."name", "character"."characters"."description") IS DISTINCT FROM (EXCLUDED."name", EXCLUDED."description")')
    })

    it('returns DO NOTHING when valueColumns is empty', () => {
        const clause = buildUpsertClause('character.tags', ['character_id', 'position'], [])
        expect(clause).toBe('ON CONFLICT ("character_id", "position") DO NOTHING')
    })

    it('reinitializes a missing schema before queries on a newly connected pool client', async () => {
        const storage = new PostgresStorage({})
        const listeners: Record<string, (value: any) => void> = {}
        const queries: string[] = []
        let schemaPresent = false
        storage.loadPostgresSchemaSql = vi.fn(async () => 'SCHEMA SQL')
        const client:any = {
            query: vi.fn((sql:string, valuesOrCallback?:any, maybeCallback?:any) => {
                const callback = typeof valuesOrCallback === 'function' ? valuesOrCallback : maybeCallback
                const run = async () => {
                    queries.push(sql)
                    if (sql.includes("to_regclass('system.storage_meta')")) {
                        return { rows: [{ table_name: schemaPresent ? 'system.storage_meta' : null }] }
                    }
                    if (sql === 'SCHEMA SQL') {
                        schemaPresent = true
                        return { rows: [] }
                    }
                    if (sql.includes('SELECT schema_version, schema_layout')) {
                        return { rows: [{ schema_version: 4, schema_layout: 'relational-schema-v3' }] }
                    }
                    return { rows: [{ ok: true }] }
                }
                const result = run()
                if (callback) {
                    result.then((value) => callback(null, value), callback)
                    return undefined
                }
                return result
            }),
        }
        const pool:any = {
            on: vi.fn((event:string, handler:(value:any) => void) => {
                listeners[event] = handler
            }),
        }

        storage.installPoolSchemaRecovery(pool)
        listeners.connect(client)
        const result = await client.query('SELECT application_data')

        expect(result.rows[0].ok).toBe(true)
        expect(schemaPresent).toBe(true)
        expect(queries.indexOf('SCHEMA SQL')).toBeLessThan(queries.indexOf('SELECT application_data'))
        expect(storage.loadPostgresSchemaSql).toHaveBeenCalledTimes(1)
    })

    it('skips generation and prompt metadata queries for generation history loads', async () => {
        const queries:string[] = []
        const client = {
            query: async (sql:string) => {
                queries.push(sql)
                if (sql.includes('FROM chat.messages ')) {
                    return { rows: [{
                        chat_id: '00000000-0000-4000-8000-000000000001',
                        id: '00000000-0000-4000-8000-000000000002',
                        position: 0, role: 'user', content_text: 'hello',
                        content_binary: null, saying_character_id: null, sent_time: null,
                        sender_name: null, other_user: null, disabled_scope: null, is_comment: null,
                    }] }
                }
                return { rows: [] }
            },
            release: () => {},
        }
        const storage = new PostgresStorage({ connectionString: 'postgres://test' })
        storage.pool = { connect: async () => client }

        const messages = await storage.loadChatMessages(
            '00000000-0000-4000-8000-000000000001',
            { mode: 'generation' },
        )

        const selects = queries.filter((query) => query.startsWith('SELECT'))
        expect(selects).toHaveLength(2)
        expect(selects.some((query) => query.includes('message_generation'))).toBe(false)
        expect(selects.some((query) => query.includes('message_prompt'))).toBe(false)
        expect(messages).toEqual([{
            role: 'user',
            data: 'hello',
            chatId: '00000000-0000-4000-8000-000000000002',
        }])
    })

    it('has revision methods on PostgresStorage prototype', () => {
        expect(typeof PostgresStorage.prototype.listRevisions).toBe('function')
        expect(typeof PostgresStorage.prototype.getRevisionDetails).toBe('function')
        expect(typeof PostgresStorage.prototype.getRevisionDiff).toBe('function')
        expect(typeof PostgresStorage.prototype.previewRestore).toBe('function')
    })
})
