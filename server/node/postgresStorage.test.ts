import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    decodePostgresJsonValue,
    encodePostgresJsonValue,
    PostgresPayloadError,
    normalizeColdStorageKey,
    validateColdStorageKeys,
    validateColdStorageValue,
    validateSyncPayload,
} = require('./postgresStorage.cjs') as {
    decodePostgresJsonValue:(value:unknown) => unknown
    encodePostgresJsonValue:(value:unknown) => unknown
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
        })).toThrow('characters[].id')
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
})
