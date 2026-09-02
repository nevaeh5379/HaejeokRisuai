import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    COLUMN_NAME_MAP,
    ORACLE_EMPTY_STRING_SENTINEL,
    OracleStorage,
    normalizeEmptyStringBinds,
    remapRowColumns,
    restoreEmptyStringInRow,
    toOracleColumn,
    wrapConnectionForEmptyStrings,
} = require('./oracleStorage.cjs') as {
    COLUMN_NAME_MAP: Record<string, string>
    ORACLE_EMPTY_STRING_SENTINEL: string
    OracleStorage: new (options: Record<string, unknown>) => {
        _bulkInsertRows: (connection: object, table: string, columns: string[], rows: Record<string, any>[]) => Promise<void>
    }
    normalizeEmptyStringBinds: (binds: unknown) => unknown
    remapRowColumns: (row: Record<string, unknown> | null | undefined) => Record<string, unknown> | null | undefined
    restoreEmptyStringInRow: (row: Record<string, unknown> | null | undefined) => Record<string, unknown> | null | undefined
    toOracleColumn: (name: string) => string
    wrapConnectionForEmptyStrings: (connection: object) => object
}
const { splitSetting } = require('./postgresSettingsCodec.cjs') as {
    splitSetting: (key: string, value: unknown) => {
        setting: { key: string }
        values: Record<string, any>[]
    }
}

describe('Oracle empty-string bind normalization', () => {
    it('replaces empty strings with the sentinel in flat bind arrays', () => {
        const binds = ['a', '', null, 5, true]
        const result = normalizeEmptyStringBinds(binds) as unknown[]
        expect(result).toEqual(['a', ORACLE_EMPTY_STRING_SENTINEL, null, 5, true])
    })

    it('replaces empty strings in nested executeMany bind arrays', () => {
        const binds = [
            ['key-1', 0, '', 'text'],
            ['key-2', 1, null, null],
        ]
        const result = normalizeEmptyStringBinds(binds) as unknown[][]
        expect(result).toEqual([
            ['key-1', 0, ORACLE_EMPTY_STRING_SENTINEL, 'text'],
            ['key-2', 1, null, null],
        ])
    })

    it('handles scalar, undefined, and null binds without crashing', () => {
        expect(normalizeEmptyStringBinds('')).toBe(ORACLE_EMPTY_STRING_SENTINEL)
        expect(normalizeEmptyStringBinds('x')).toBe('x')
        expect(normalizeEmptyStringBinds(null)).toBeNull()
        expect(normalizeEmptyStringBinds(undefined)).toBeUndefined()
        expect(normalizeEmptyStringBinds(0)).toBe(0)
    })

    it('does not touch strings that contain NUL or are the sentinel', () => {
        const mixed = 'a\u0000b'
        expect(normalizeEmptyStringBinds([mixed, ORACLE_EMPTY_STRING_SENTINEL, 7]) as unknown[])
            .toEqual([mixed, ORACLE_EMPTY_STRING_SENTINEL, 7])
    })

    it('does not modify the original bind arrays', () => {
        const binds = [['', 'x']]
        normalizeEmptyStringBinds(binds)
        expect(binds[0][0]).toBe('')
    })
})

describe('Oracle empty-string row restoration', () => {
    it('restores the sentinel to an empty string', () => {
        const row = { name: ORACLE_EMPTY_STRING_SENTINEL, note: '', other: 'kept' }
        expect(restoreEmptyStringInRow(row)).toEqual({ name: '', note: '', other: 'kept' })
    })

    it('keeps strings that contain NUL unchanged', () => {
        const row = { content: 'a\u0000b' }
        expect(restoreEmptyStringInRow(row)).toEqual({ content: 'a\u0000b' })
    })

    it('passes through non-row values', () => {
        expect(restoreEmptyStringInRow(null)).toBeNull()
        expect(restoreEmptyStringInRow(undefined)).toBeUndefined()
    })
})

describe('Oracle connection wrapper', () => {
    function fakeConnection() {
        return {
            // oracledb와 동일하게 arguments.length로 바인드 여부를 판별
            // (2개 이상 인자면 binds가 배열이어야 함 — NJS-005 모방)
            execute: vi.fn(async function (sql, binds, options) {
                if (arguments.length >= 2) {
                    expect(Array.isArray(binds)).toBe(true)
                }
                return { rows: [], rowsAffected: 0 }
            }),
            executeMany: vi.fn(async function (sql, binds, options) {
                expect(Array.isArray(binds)).toBe(true)
                return { rows: [], rowsAffected: 0 }
            }),
            commit: vi.fn(async () => undefined),
            rollback: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            pool: 'sentinel-pool-value',
        }
    }

    it('normalizes binds passed to execute', async () => {
        const conn = fakeConnection()
        const wrapped = wrapConnectionForEmptyStrings(conn)
        await wrapped.execute('INSERT INTO t (a) VALUES (:1)', ['', 'x'], { autoCommit: false })
        expect(conn.execute).toHaveBeenCalledWith(
            'INSERT INTO t (a) VALUES (:1)',
            [ORACLE_EMPTY_STRING_SENTINEL, 'x'],
            { autoCommit: false },
        )
    })

    it('preserves arity for execute without binds (oracledb checks arguments.length)', async () => {
        const conn = fakeConnection()
        const wrapped = wrapConnectionForEmptyStrings(conn)
        await wrapped.execute('SELECT 1 FROM dual')
        expect(conn.execute.mock.calls[0]).toEqual(['SELECT 1 FROM dual'])
        await wrapped.execute('SELECT :1 FROM dual', ['x'])
        expect(conn.execute.mock.calls[1]).toEqual(['SELECT :1 FROM dual', ['x']])
    })

    it('normalizes binds passed to executeMany', async () => {
        const conn = fakeConnection()
        const wrapped = wrapConnectionForEmptyStrings(conn)
        await wrapped.executeMany('INSERT INTO t (a, b) VALUES (:1, :2)', [['', 1], ['x', '']])
        expect(conn.executeMany).toHaveBeenCalledWith(
            'INSERT INTO t (a, b) VALUES (:1, :2)',
            [[ORACLE_EMPTY_STRING_SENTINEL, 1], ['x', ORACLE_EMPTY_STRING_SENTINEL]],
        )
    })

    it('passes through transaction and lifecycle methods', async () => {
        const conn = fakeConnection()
        const wrapped = wrapConnectionForEmptyStrings(conn)
        await wrapped.commit()
        await wrapped.rollback()
        await wrapped.close()
        expect(conn.commit).toHaveBeenCalledTimes(1)
        expect(conn.rollback).toHaveBeenCalledTimes(1)
        expect(conn.close).toHaveBeenCalledTimes(1)
        expect(wrapped.pool).toBe('sentinel-pool-value')
    })

    it('does not wrap the same connection twice', () => {
        const conn = fakeConnection()
        const wrapped = wrapConnectionForEmptyStrings(conn)
        expect(wrapConnectionForEmptyStrings(wrapped)).toBe(wrapped)
    })
})

describe('sync round-trip with empty string setting values', () => {
    // oracleStorage.cjs sync()와 동일한 바인드 구성 방식 재현
    function buildSettingBinds(values: Record<string, any>[]) {
        return values.map((row) => [
            row.setting_key, row.node_id, row.parent_node_id, row.member_key, row.encoded_member_key,
            row.position, row.value_type, row.text_value, row.encoded_text_value, row.number_value,
            row.boolean_value === true ? 1 : (row.boolean_value === false ? 0 : null),
        ])
    }

    it('round-trips an empty string setting value through sentinel storage', () => {
        const { values } = splitSetting('globalNote', '')
        expect(values).toHaveLength(1)
        expect(values[0].value_type).toBe('text')
        expect(values[0].text_value).toBe('')

        // 쓰기로 변환: Oracle에는 sentinel로 저장됨
        const stored = (normalizeEmptyStringBinds(buildSettingBinds(values)) as unknown[][])
            .map((binds) => Object.fromEntries([
                ['setting_key', binds[0]], ['node_id', binds[1]], ['parent_node_id', binds[2]],
                ['member_key', binds[3]], ['encoded_member_key', binds[4]], ['position', binds[5]],
                ['value_type', binds[6]], ['text_value', binds[7]], ['encoded_text_value', binds[8]],
                ['number_value', binds[9]], ['boolean_value', binds[10]],
            ]))
        expect(stored[0].text_value).toBe(ORACLE_EMPTY_STRING_SENTINEL)

        // Oracle에서 ''가 NULL이 되는 것이므로 NOT NULL/CHECK를 만족
        expect(stored[0].text_value).not.toBeNull()
        expect(stored[0].text_value).not.toBe('')

        // 읽기로 복원: 다시 ''로 돌아옴
        const restored = restoreEmptyStringInRow(stored[0]) as Record<string, any>
        expect(restored.text_value).toBe('')
    })

    it('round-trips an empty string object key through member_key', () => {
        const { values } = splitSetting('pluginCustomStorage', { '': 'stored-value' })
        const child = values.find((row) => row.node_id > 0)
        expect(child).toBeDefined()
        expect(child.member_key).toBe('')

        const binds = (normalizeEmptyStringBinds(buildSettingBinds(values)) as unknown[][])
        const childBinds = binds.find((row) => row[1] > 0) as unknown[]
        expect(childBinds[3]).toBe(ORACLE_EMPTY_STRING_SENTINEL)
    })

    it('leaves normal settings untouched', () => {
        const { values } = splitSetting('mainPrompt', 'Hello world')
        const binds = normalizeEmptyStringBinds(buildSettingBinds(values)) as unknown[][]
        expect(binds[0][6]).toBe('text')
        expect(binds[0][7]).toBe('Hello world')
    })

    it('normalizes empty strings in named bind objects and arrays of objects', () => {
        const singleObj = { id: 'char1', name: '', prompt: 'hello' }
        const normalizedSingle = normalizeEmptyStringBinds(singleObj) as Record<string, any>
        expect(normalizedSingle.name).toBe(ORACLE_EMPTY_STRING_SENTINEL)
        expect(normalizedSingle.prompt).toBe('hello')

        const arrayOfObjs = [{ id: 'char1', first_message: '' }, { id: 'char2', first_message: 'hi' }]
        const normalizedArray = normalizeEmptyStringBinds(arrayOfObjs) as Record<string, any>[]
        expect(normalizedArray[0].first_message).toBe(ORACLE_EMPTY_STRING_SENTINEL)
        expect(normalizedArray[1].first_message).toBe('hi')
    })
})

describe('Oracle reserved-word column mapping', () => {
    it('maps codec column names to Oracle schema column names', () => {
        expect(toOracleColumn('alt')).toBe('alt_flag')
        expect(toOracleColumn('control')).toBe('control_flag')
        expect(toOracleColumn('shift')).toBe('shift_flag')
        expect(toOracleColumn('action')).toBe('action')
        expect(toOracleColumn('key')).toBe('key_value')
        expect(toOracleColumn('comment')).toBe('comment_text')
        expect(toOracleColumn('mode')).toBe('lore_mode')
        expect(toOracleColumn('primary_key')).toBe('primarykey')
        expect(toOracleColumn('format')).toBe('format_val')
        expect(toOracleColumn('sequence')).toBe('sequence_num')
        // 이미 Oracle 이름인 컬럼/그 외 컬럼은 그대로
        expect(toOracleColumn('position')).toBe('position')
        expect(toOracleColumn('key_value')).toBe('key_value')
        expect(toOracleColumn('comment_text')).toBe('comment_text')
    })

    it('maps read rows back to codec names (including key_value → key)', () => {
        const row = remapRowColumns({
            KEY_VALUE: 'k1', COMMENT_TEXT: 'note', LORE_MODE: 'normal',
            PRIMARYKEY: 'pk', ALT_FLAG: 1, POSITION: 3,
        })
        expect(row.key).toBe('k1')
        expect(row.comment).toBe('note')
        expect(row.mode).toBe('normal')
        expect(row.primary_key).toBe('pk')
        expect(row.alt).toBe(1)
        expect(row.position).toBe(3)
    })

    it('keeps the mapping tables symmetric', () => {
        for (const [oracleName, codecName] of Object.entries(COLUMN_NAME_MAP)) {
            expect(toOracleColumn(codecName)).toBe(oracleName)
        }
    })

    it('_bulkInsertRows uses Oracle column names and codec-named row properties', async () => {
        const storage = new OracleStorage({})
        const executeMany = vi.fn(async () => ({ rows: [], rowsAffected: 1 }))
        const columns = [
            'character_id', 'position', 'lore_id', 'primarykey', 'secondary_key', 'insert_order',
            'comment_text', 'content', 'lore_mode', 'always_active', 'selective',
            'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload',
        ]
        // 공용 codec 스타일 행 (primary_key/comment/mode 프로퍼티)
        await storage._bulkInsertRows({ executeMany }, 'character_lore_entries', columns, [{
            character_id: 'c1', position: 0, lore_id: 'l1',
            primary_key: 'PK', secondary_key: null, insert_order: 1,
            comment: 'hello', content: 'body', mode: 'normal',
            always_active: false, selective: null, case_sensitive: null,
            activation_percent: null, use_regex: false, book_version: 1, folder: null, cache_payload: null,
        }])
        expect(executeMany).toHaveBeenCalledTimes(1)
        const [sql, binds] = executeMany.mock.calls[0]
        expect(sql).toContain('COMMENT_TEXT')
        expect(sql).toContain('LORE_MODE')
        expect(sql).toContain('PRIMARYKEY')
        expect(sql).not.toContain(' COMMENT ')
        expect(sql).not.toContain(' MODE ')
        // LOB 컬럼(comment_text, content, cache_payload)이 맨 뒤로 이동하여 ORA-24816 방지
        expect(binds[0][3]).toBe('PK')
        expect(binds[0][6]).toBe('normal')
        expect(binds[0][14]).toBe('hello')
        expect(binds[0][15]).toBe('body')
    })

    it('_bulkInsertRows places LOB and JSON columns at the end for character_scripts', async () => {
        const storage = new OracleStorage({})
        const executeMany = vi.fn(async () => ({ rows: [], rowsAffected: 1 }))
        await storage._bulkInsertRows({ executeMany }, 'character_scripts',
            ['character_id', 'script_kind', 'position', 'comment_text', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'],
            [{
                character_id: 'c1',
                script_kind: 'custom',
                position: 0,
                comment_text: 'my comment',
                input_text: 'input...',
                output_text: 'output...',
                script_type: 'regex',
                flag: 'g',
                able_flag: 1,
                trigger_payload: { event: 'test' },
            }])
        const [sql, binds] = executeMany.mock.calls[0]
        // Non-LOB columns: character_id, script_kind, position, script_type, able_flag (first 5)
        // LOB/JSON columns: comment_text, input_text, output_text, flag, trigger_payload (last 5)
        expect(sql).toContain('CHARACTER_ID')
        expect(sql).toContain('SCRIPT_TYPE')
        expect(sql).toContain('ABLE_FLAG')
        expect(sql).toContain('TRIGGER_PAYLOAD')
        expect(binds[0][0]).toBe('c1')
        expect(binds[0][1]).toBe('custom')
        expect(binds[0][2]).toBe(0)
        expect(binds[0][3]).toBe('regex')
        expect(binds[0][4]).toBe(1)
        expect(binds[0][5]).toBe('my comment')
        expect(binds[0][6]).toBe('input...')
        expect(binds[0][7]).toBe('output...')
        expect(binds[0][8]).toBe('g')
        expect(binds[0][9]).toBe('{"event":"test"}')
    })
})


describe('OracleStorage persistent branch API', () => {
    it('exposes persistent branch operations', () => {
        for (const method of ['listChatBranches', 'loadBranchMessages', 'createChatBranch', 'activateChatBranch']) {
            expect(typeof OracleStorage.prototype[method]).toBe('function')
        }
    })
})
