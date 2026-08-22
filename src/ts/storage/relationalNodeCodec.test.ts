import { describe, expect, it } from 'vitest'
import sqliteSchemaSql from './sqlite-schema.sql?raw'
import {
    flattenRelationalValue,
    MAX_RELATIONAL_NODE_DEPTH,
    rebuildRelationalValue,
    RELATIONAL_SCHEMA_LAYOUT,
} from './relationalNodeCodec'

describe('typed relational node codec', () => {
    it('round trips nested values without JSON serialization', () => {
        const value: Record<string, unknown> = {
            null: null,
            emptyArray: [],
            emptyObject: {},
            nested: [{ 'odd\0key': 'nul\0value', surrogate: '\ud800' }, [true, false, 0]],
            undefined,
            nan: Number.NaN,
            positiveInfinity: Number.POSITIVE_INFINITY,
        }
        Object.defineProperty(value, '__proto__', { value: { safe: true }, enumerable: true })

        const rows = flattenRelationalValue(value)
        const rebuilt = rebuildRelationalValue(rows) as Record<string, any>

        expect(rebuilt).toEqual(value)
        expect(Object.prototype.hasOwnProperty.call(rebuilt, '__proto__')).toBe(true)
        expect(rebuilt.__proto__).toEqual({ safe: true })
        expect(rows.every((row) => !Object.keys(row).some((key) => key.includes('json')))).toBe(true)
    })

    it('enforces depth and row limits before persistence', () => {
        let value: unknown = null
        for (let index = 0; index <= MAX_RELATIONAL_NODE_DEPTH; index++) value = [value]
        expect(() => flattenRelationalValue(value)).toThrow(/maximum depth/)
        expect(() => flattenRelationalValue([1, 2, 3], { maxRows: 3 })).toThrow(/maximum row count/)
    })

    it('declares the v3 local schema with presets as the bounded document exception', () => {
        expect(sqliteSchemaSql).toContain(`'${RELATIONAL_SCHEMA_LAYOUT}'`)
        expect(sqliteSchemaSql).toContain('schema_version INTEGER NOT NULL DEFAULT 3')
        expect(sqliteSchemaSql).toMatch(/bot_presets[\s\S]{0,350}data TEXT NOT NULL/)
        expect(sqliteSchemaSql).not.toMatch(/\b(?:system_settings|characters|chats|messages|cold_storage)\s*\([^;]*\b(?:data|value|payload)\s+TEXT/is)
        expect(sqliteSchemaSql).toMatch(/plugin_custom_storage[\s\S]*json_valid\(value\)/)
    })
})
