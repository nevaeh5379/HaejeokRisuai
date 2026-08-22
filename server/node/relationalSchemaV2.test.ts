import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('relational schema v2 metadata and setting trees', () => {
    it.each([
        ['PostgreSQL', 'postgres-schema.sql'],
        ['Oracle', 'oracle-schema.sql'],
        ['Azure SQL', 'azure-schema.sql'],
    ])('%s declares server schema v3 and relational-schema-v2', (_vendor, filename) => {
        const sql = schema(filename)
        expect(sql).toContain('relational-schema-v2')
        expect(sql).toMatch(/schema_version[^\n]*(?:DEFAULT\s+3|3\s+NOT NULL)/i)
        expect(sql).toMatch(/setting_values/i)
        expect(sql).toMatch(/parent_node_id/i)
        expect(sql).toMatch(/encoded_text_value/i)
    })

    it('keeps plugin custom values as the intentional JSON exception', () => {
        expect(schema('postgres-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,250}value JSONB NOT NULL/i)
        expect(schema('oracle-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,250}value JSON NOT NULL/i)
        expect(schema('azure-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,350}ISJSON\(value\) = 1/i)
    })
})
