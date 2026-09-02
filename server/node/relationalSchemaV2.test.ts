import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('relational schema metadata and setting trees', () => {
    it.each([
        ['PostgreSQL', 'postgres-schema.sql'],
        ['Oracle', 'oracle-schema.sql'],
        ['Azure SQL', 'azure-schema.sql'],
    ])('%s declares server schema v4 and relational-schema-v3', (_vendor, filename) => {
        const sql = schema(filename)
        expect(sql).toContain('relational-schema-v3')
        expect(sql).toMatch(/schema_version[^\n]*(?:DEFAULT\s+4|4\s+NOT NULL)/i)
        expect(sql).toMatch(/setting_values/i)
        expect(sql).toMatch(/parent_node_id/i)
        expect(sql).toMatch(/encoded_text_value/i)
    })

    it('keeps plugin custom values as the intentional JSON exception', () => {
        expect(schema('postgres-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,250}value JSONB NOT NULL/i)
        expect(schema('oracle-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,250}value JSON NOT NULL/i)
        expect(schema('azure-schema.sql')).toMatch(/plugin_custom_storage[\s\S]{0,350}ISJSON\(value\) = 1/i)
    })
    it('keeps last-message trigger DDL in SQL resources', () => {
        expect(schema('postgres-last-message-time.sql')).toMatch(/CREATE TRIGGER messages_last_message_time_after_insert/i)
        expect(schema('postgres-last-message-time.sql')).toMatch(/REFERENCING NEW TABLE AS new_rows/i)
        expect(schema('azure-last-message-time.sql')).toMatch(/CREATE OR ALTER TRIGGER \[chat\]\.\[messages_last_message_time\]/i)
        expect(schema('azure-last-message-time.sql')).toMatch(/SELECT chat_id FROM inserted[\s\S]*SELECT chat_id FROM deleted/i)
        expect(schema('oracle-last-message-time.sql')).toMatch(/COMPOUND TRIGGER/i)
        expect(schema('oracle-last-message-time.sql')).toMatch(/AFTER STATEMENT IS/i)
    })

})
