// Oracle Storage 구현체 (PostgresStorage 인터페이스 호환)
// PostgreSQL의 postgresStorage.cjs를 Oracle 23c+ (Autonomous Database) 방언으로 구현.
// postgresRelationalCodec.cjs / postgresJsonCodec.cjs / postgresSettingsCodec.cjs 재사용.
//
// 주요 차이점:
// - pg.Pool → oracledb.createPool (walletLocation + walletPassword)
// - $1 바인드 → :1 바인드
// - ON CONFLICT DO UPDATE → MERGE INTO
// - UNNEST bulk → executeMany
// - JSONB → JSON (oracledb 자동 직렬화)
// - BYTEA → BLOB (fetchInfo BUFFER)
// - current_setting() → SYS_CONTEXT()
// - 스키마 점 표기(system.settings) → 접두어(system_settings)
// - row 컬럼명 대문자 → 소문자 변환 필요

'use strict';

const oracledb = require('oracledb');
const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { promisify } = require('util');
const { deflate, unzip } = require('zlib');
const {
    decodePostgresJsonValue,
    encodePostgresJsonValue,
} = require('./postgresJsonCodec.cjs');
const {
    rebuildCharacter,
    rebuildChat,
    rebuildMessage,
    rebuildLore,
    splitCharacter,
    splitChat,
    splitMessage,
    splitLore,
} = require('./postgresRelationalCodec.cjs');
const {
    decodeMember,
    encodeMember,
    rebuildSettings,
    rebuildSettingSubtree,
    splitSetting,
} = require('./postgresSettingsCodec.cjs');
const {
    projectSettings,
    SETTING_RELATION_DEFINITIONS,
} = require('./postgresSettingRelations.cjs');
const {
    StorageRevisionConflictError,
    StoragePayloadError,
} = require('./storageDriver.cjs');
const {
    SqlStorageBase,
    createSqlStorageHelpers,
    groupRows,
    groupMessageRows,
    createCharacterRelations,
    createChatRelations,
    createMessageRelations,
    rebuildDatabaseGraph,
} = require('./sqlStorageCommon.cjs');

const {
    asArray,
    assertId,
    assertPosition,
    assertData,
    normalizeColdStorageKey,
    validateColdStorageValue,
    splitColdStorageValue,
    validateColdStorageKeys,
    findLegacyColdStorageFiles,
    validateSyncPayload,
} = createSqlStorageHelpers({
    PayloadError: StoragePayloadError,
    allowShortColdStorageKeys: true,
    suppressLegacyReadErrors: true,
});

// Oracle LOB 컬럼을 자동으로 string 및 Buffer로 가져오도록 글로벌 설정 (성능 최적화 및 스트림 행 방지)
try {
    oracledb.fetchAsString = [oracledb.CLOB];
    oracledb.fetchAsBuffer = [oracledb.BLOB];
} catch (e) {}

const ORACLE_SCHEMA_VERSION = 2;
const MAX_SYNC_ROWS = 250000;

// Oracle은 스키마(사용자)가 하나이므로 점 표기(system.settings)를 접두어(system_settings)로 변환
const SCHEMA_PREFIX_MAP = {
    'system.': 'system_',
    'character.': 'character_',
    'chat.': 'chat_',
    'cold.': 'cold_',
};

// 점 표기 테이블명을 접두어 테이블명으로 변환
function mapTableName(qualifiedName) {
    for (const [prefix, replacement] of Object.entries(SCHEMA_PREFIX_MAP)) {
        if (qualifiedName.startsWith(prefix)) {
            return replacement + qualifiedName.slice(prefix.length);
        }
    }
    return qualifiedName;
}

// 감사 대상 테이블 목록 (PostgreSQL AUDITED_TABLES와 동일, 접두어 변환)
const AUDITED_TABLES_QUALIFIED = [
    'system.settings', 'system.setting_values', 'character.characters',
    ...SETTING_RELATION_DEFINITIONS.map((d) => d.table),
    'character.attributes', 'character.tags',
    'character.greetings', 'character.biases', 'character.emotions',
    'character.modules', 'character.group_members', 'character.chat_folders',
    'character.scripts', 'character.sd_data', 'character.assets',
    'character.lore_entries', 'chat.chats', 'chat.attributes',
    'chat.suggestions', 'chat.modules', 'chat.script_state',
    'chat.bookmarks', 'chat.memory', 'chat.lore_entries', 'chat.messages',
    'chat.message_attributes', 'chat.message_generation', 'chat.message_prompt_info',
    'chat.message_prompt_toggles', 'chat.message_prompt_items', 'cold.archives',
    'cold.archive_attributes', 'cold.field_presence', 'cold.character_tags',
    'cold.character_greetings', 'cold.character_biases',
    'cold.character_emotions', 'cold.character_modules', 'cold.group_members',
    'cold.chat_folders', 'cold.character_scripts', 'cold.character_sd_data',
    'cold.character_assets', 'cold.character_lore_entries', 'cold.chats',
    'cold.chat_attributes', 'cold.chat_suggestions', 'cold.chat_modules',
    'cold.chat_script_state', 'cold.chat_bookmarks', 'cold.chat_memory',
    'cold.chat_lore_entries', 'cold.messages', 'cold.message_attributes',
    'cold.message_generation', 'cold.message_prompt_info',
    'cold.message_prompt_toggles', 'cold.message_prompt_items',
];
const AUDITED_TABLES = AUDITED_TABLES_QUALIFIED.map(mapTableName);

const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);

// Oracle은 점 표기를 식별자로 사용 불가. 접두어 테이블명으로 변환 후 따옴표 처리.
function assertSqlIdentifier(value) {
    if (typeof value !== 'string') {
        throw new Error(`Unsafe SQL identifier: ${value}`);
    }
    // 점 표기 → 접두어 변환
    const mapped = mapTableName(value);
    const parts = mapped.split('.');
    // Oracle은 따옴표 없는 식별자를 대문자로 자동 처리.
    // 스키마에서 따옴표 없이 CREATE TABLE character_characters로 생성했으므로
    // Oracle은 CHARACTER_CHARACTERS로 저장. 따옴표 없이 반환하면 자동 매칭.
    if (parts.length === 1 && /^[a-z][a-z0-9_]*$/i.test(parts[0])) {
        return parts[0].toUpperCase();
    }
    if (parts.length === 2 && /^[a-z][a-z0-9_]*$/i.test(parts[0]) && /^[a-z][a-z0-9_]*$/i.test(parts[1])) {
        return `${parts[0].toUpperCase()}.${parts[1].toUpperCase()}`;
    }
    throw new Error(`Unsafe SQL identifier: ${value}`);
}

// oracledb OUT_FORMAT_OBJECT는 컬럼명을 대문자로 반환.
// postgresRelationalCodec.cjs는 소문자 컬럼명을 가정하므로 변환 필요.
function lowercaseRowKeys(row) {
    if (!row || typeof row !== 'object') return row;
    const result = {};
    for (const key of Object.keys(row)) {
        result[key.toLowerCase()] = row[key];
    }
    return result;
}

function lowercaseRows(rows) {
    return (rows || []).map(lowercaseRowKeys);
}

// Oracle BLOB을 Buffer로 변환 (fetchInfo BUFFER 모드 사용 시 이미 Buffer)
async function blobToBuffer(value) {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    if (value && typeof value === 'object') {
        if (typeof value.getData === 'function') {
            const data = await value.getData();
            return Buffer.isBuffer(data) ? data : Buffer.from(data);
        }
        if (typeof value.on === 'function') {
            return await new Promise((resolve, reject) => {
                const chunks = [];
                value.on('data', (chunk) => chunks.push(chunk));
                value.on('end', () => resolve(Buffer.concat(chunks)));
                value.on('error', reject);
            });
        }
    }
    return Buffer.from(value);
}

// Oracle DATE/TIMESTAMP를 Unix epoch ms (PostgreSQL 호환) 로 변환
function timestampToNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    return null;
}

// NUMBER(1) → boolean 변환
function num1ToBool(value) {
    if (value === null || value === undefined) return null;
    return value === 1;
}

function booleanToNum1(value) {
    if (value === null || value === undefined) return null;
    return value ? 1 : 0;
}

// ============================================================
// Oracle 빈 문자열 처리 (sentinel)
// Oracle은 VARCHAR2/CLOB의 빈 문자열 ''를 NULL로 저장한다.
// 이 때문에 NOT NULL / CHECK (... IS NOT NULL ...) 제약이
// 위반되어 ORA-01400 / ORA-02290이 발생한다 (예:
// system_setting_values의 value_type/값 일치 CHECK,
// chat_messages의 content_text XOR CHECK, 빈 캐릭터/채팅 이름).
// 쓰는 쪽에서 ''를 sentinel '\u0000'으로, 읽는 쪽에서
// sentinel을 ''로 되돌린다. NUL 1자 문자열은 실제 데이터로
// 쓰이지 않으므로 안전한 sentinel이다.
// ============================================================
const ORACLE_EMPTY_STRING_SENTINEL = '\u0000';

function normalizeEmptyStringBind(value) {
    return typeof value === 'string' && value === '' ? ORACLE_EMPTY_STRING_SENTINEL : value;
}

// execute 바인드(플랫 배열/스칼라/객체)와 executeMany 바인드(배열의 배열/객체의 배열) 모두 처리
function normalizeEmptyStringBinds(binds) {
    if (binds === undefined || binds === null) return binds;
    if (!Array.isArray(binds)) {
        if (typeof binds === 'object' && !Buffer.isBuffer(binds)) {
            const obj = {};
            for (const [k, v] of Object.entries(binds)) {
                obj[k] = normalizeEmptyStringBind(v);
            }
            return obj;
        }
        return normalizeEmptyStringBind(binds);
    }
    return binds.map((entry) => {
        if (Array.isArray(entry)) return entry.map(normalizeEmptyStringBind);
        if (entry && typeof entry === 'object' && !Buffer.isBuffer(entry)) {
            const obj = {};
            for (const [k, v] of Object.entries(entry)) {
                obj[k] = normalizeEmptyStringBind(v);
            }
            return obj;
        }
        return normalizeEmptyStringBind(entry);
    });
}

function restoreEmptyStringInRow(row) {
    if (!row || typeof row !== 'object') return row;
    for (const key of Object.keys(row)) {
        if (row[key] === ORACLE_EMPTY_STRING_SENTINEL) row[key] = '';
    }
    return row;
}

// 풀에서 나온 연결의 execute/executeMany에 바인드 정규화를 적용하는 Proxy 래퍼
// oracledb는 arguments.length로 바인드 전달 여부를 판별하므로
// (execute: 1~3개, executeMany: 2~3개), undefined를 명시 전달하면
// NJS-005가 발생한다. 호출 arity를 그대로 보존한다.
function wrapConnectionForEmptyStrings(connection) {
    if (!connection || connection.__risuEmptyStringWrapped) return connection;
    connection.__risuEmptyStringWrapped = true;
    return new Proxy(connection, {
        get(target, prop) {
            const value = target[prop];
            if (prop === 'execute' || prop === 'executeMany') {
                return (...args) => {
                    if (args.length < 2 || args[1] === undefined) {
                        return target[prop](args[0]);
                    }
                    const normalizedBinds = normalizeEmptyStringBinds(args[1]);
                    if (args.length < 3 || args[2] === undefined) {
                        return target[prop](args[0], normalizedBinds);
                    }
                    return target[prop](args[0], normalizedBinds, args[2]);
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

// 컬럼명 예약어 회피: Oracle 예약어를 안전한 이름으로 매핑
// (스키마에서 이미 변경했지만, codec에서 소문자 컬럼명을 가정하므로 역매핑 필요)
const COLUMN_NAME_MAP = {
    // 스키마에서 변경한 Oracle 컬럼명 → codec이 기대하는 원래 이름 (읽기쪽)
    'key_value': 'key',
    'comment_text': 'comment',
    'lore_mode': 'mode',
    'primarykey': 'primary_key',
    'format_val': 'format',
    'control_flag': 'control',
    'shift_flag': 'shift',
    'alt_flag': 'alt',
    'sequence_num': 'sequence',
};

// 쓰기쪽: codec(=PostgreSQL) 컬럼명 → Oracle 컬럼명
const ORACLE_COLUMN_NAME_MAP = Object.fromEntries(
    Object.entries(COLUMN_NAME_MAP).map(([oracleName, codecName]) => [codecName, oracleName])
);

function toOracleColumn(name) {
    return ORACLE_COLUMN_NAME_MAP[name] || name;
}

// row의 컬럼명을 codec 호환 이름으로 역매핑
function remapRowColumns(row) {
    if (!row || typeof row !== 'object') return row;
    const result = {};
    for (const key of Object.keys(row)) {
        const lowerKey = key.toLowerCase();
        const mappedKey = COLUMN_NAME_MAP[lowerKey] || lowerKey;
        result[mappedKey] = row[key];
    }
    return result;
}

function remapRows(rows) {
    return (rows || []).map((row) => remapRowColumns(lowercaseRowKeys(row)));
}

// CLOB → string 변환 (oracledb는 CLOB을 Lob 스트림으로 반환할 수 있음)
async function clobToString(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value && typeof value === 'object') {
        if (typeof value.getData === 'function') {
            const data = await value.getData();
            return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        }
        if (typeof value.on === 'function') {
            return await new Promise((resolve, reject) => {
                const chunks = [];
                value.setEncoding('utf8');
                value.on('data', (chunk) => chunks.push(chunk));
                value.on('end', () => resolve(chunks.join('')));
                value.on('error', reject);
            });
        }
        if (Buffer.isBuffer(value)) return value.toString('utf8');
        // 이미 파싱된 JSON 객체/배열인 경우 "[object Object]"로 강제 변환하지 않고 그대로 유지
        return value;
    }
    return String(value);
}

// row의 모든 CLOB/LOB 컬럼을 미리 읽어서 string/Buffer로 변환
async function hydrateLobs(row, lobColumns = [], blobColumns = []) {
    if (!row || typeof row !== 'object') return row;
    const result = { ...row };
    // 대소문자 구분 없이 LOB 컬럼 매칭 (Oracle은 대문자, clobColumns는 소문자)
    const lowerLobCols = new Set(lobColumns.map((c) => c.toLowerCase()));
    const lowerBlobCols = new Set(blobColumns.map((c) => c.toLowerCase()));
    for (const key of Object.keys(result)) {
        const lowerKey = key.toLowerCase();
        if (lowerLobCols.has(lowerKey) && result[key] !== null && result[key] !== undefined) {
            result[key] = await clobToString(result[key]);
        }
        if (lowerBlobCols.has(lowerKey) && result[key] !== null && result[key] !== undefined) {
            result[key] = await blobToBuffer(result[key]);
        }
    }
    return result;
}

// PostgreSQL 호환 행 반환 (oracledb 결과 → pg 호환 row)
// fetchInfo로 BUFFER/BLOB을 Buffer로, CLOB은 자동 문자열 변환 (oracledb 6.x thin 모드)
async function fetchRows(connection, sql, binds = [], options = {}) {
    const fetchInfo = {};
    // BLOB 컬럼은 BUFFER로 직접 받기
    if (options.blobColumns) {
        for (const col of options.blobColumns) {
            fetchInfo[col.toUpperCase()] = { type: oracledb.BUFFER };
        }
    }
    const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: Object.keys(fetchInfo).length > 0 ? fetchInfo : undefined,
        ...options.fetchOptions,
    });
    let rows = result.rows || [];
    // CLOB 컬럼 미리 읽기 (oracledb thin 모드는 CLOB을 자동으로 문자열로 반환하지만 안전을 위해)
    if (options.clobColumns && options.clobColumns.length > 0) {
        rows = await Promise.all(rows.map((row) => hydrateLobs(row, options.clobColumns, options.blobColumns || [])));
    }
    // 컬럼명 소문자 변환 + 예약어 역매핑 + Oracle sentinel → '' 복원
    return rows.map((row) => restoreEmptyStringInRow(remapRowColumns(row)));
}

// 단일 행 반환
async function fetchOne(connection, sql, binds = [], options = {}) {
    const rows = await fetchRows(connection, sql, binds, { ...options, fetchOptions: { ...options.fetchOptions, maxRows: 1 } });
    return rows[0] || null;
}

// PostgreSQL 호환 결과 객체 생성
function pgResult(rows) {
    return { rows, rowCount: rows.length };
}

// 바인드 변수 변환: pg 스타일($1, $2) → Oracle 스타일(:1, :2)
function convertSql(sql) {
    // $1, $2, ... → :1, :2, ...
    let converted = sql.replace(/\$(\d+)/g, ':$1');
    // ::type 캐스트 제거 (Oracle은 CAST() 사용)
    converted = converted.replace(/::\w+/g, '');
    // 점 표기 테이블명 → 접두어 (따옴표 안의 것은 제외)
    for (const [prefix, replacement] of Object.entries(SCHEMA_PREFIX_MAP)) {
        // 시스템 함수/컨텍스트는 제외 (current_setting 등은 이미 변환됨)
        converted = converted.replace(new RegExp(prefix.replace('.', '\\.'), 'g'), replacement);
    }
    // current_setting('risu.revision_id', TRUE) → SYS_CONTEXT('RISU_AUDIT_CTX', 'revision_id')
    converted = converted.replace(/current_setting\(['"]risu\.revision_id['"]\s*,\s*(?:TRUE|true)\)/g,
        "SYS_CONTEXT('RISU_AUDIT_CTX', 'revision_id')");
    converted = converted.replace(/current_setting\(['"]risu\.archive_id['"]\s*,\s*(?:TRUE|true)\)/g,
        "SYS_CONTEXT('RISU_AUDIT_CTX', 'archive_id')");
    // set_config('risu.revision_id', $1, TRUE) → BEGIN risu_audit_ctx_pkg.set_revision(:1); END;
    // (이 변환은 호출부에서 처리)
    // LIMIT n → FETCH FIRST n ROWS ONLY
    converted = converted.replace(/LIMIT\s+(\d+)/gi, 'FETCH FIRST $1 ROWS ONLY');
    // OFFSET n LIMIT m → OFFSET n ROWS FETCH NEXT m ROWS ONLY
    converted = converted.replace(/OFFSET\s+(\d+)\s+LIMIT\s+(\d+)/gi, 'OFFSET $1 ROWS FETCH NEXT $2 ROWS ONLY');
    // NOW() → SYSTIMESTAMP
    converted = converted.replace(/\bNOW\(\)/gi, 'SYSTIMESTAMP');
    // TRUE/FALSE → 1/0 (boolean 컨텍스트)
    // 주의: CHECK 제약에서는 TRUE/FALSE가 허용되지만, 비교에서는 1/0 사용
    // 이 변환은 위험하므로 수동 처리
    return converted;
}

// PostgreSQL의 bulkInsert()를 Oracle executemany로 대체
// columnTypes: Oracle 타입 (oracledb.DB_TYPE_*)
async function bulkInsert(connection, table, columns, columnTypes, rows, conflictAction = null) {
    if (rows.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);
    const quotedColumns = columns.map((col) => `${col.toUpperCase()}`);
    const batchRows = Math.max(
        1,
        Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || '1000', 10) || 1000
    );

    // Oracle 바인드 변수명 생성 (:1, :2, ...)
    const bindNames = columns.map((_, i) => `:${i + 1}`).join(', ');

    if (conflictAction) {
        // MERGE INTO 기반 upsert
        const mergeSql =
            `MERGE INTO ${quotedTable} target
             USING (SELECT ${columns.map((c, i) => `:${i + 1} AS ${c.toUpperCase()}`).join(', ')} FROM dual) src
             ON (${columns.map((c) => `${c.toUpperCase()}`).join(', ') === quotedColumns.join(', ') ? '1=0' : '1=0'})
             WHEN NOT MATCHED THEN INSERT (${quotedColumns.join(', ')})
                 VALUES (${bindNames})`;
        // 단순 INSERT로 fallback (conflictAction은 호출부에서 MERGE로 직접 구현)
        const insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${bindNames})`;
        for (let start = 0; start < rows.length; start += batchRows) {
            const binds = rows.slice(start, start + batchRows).map((row) =>
                columns.map((col, index) => prepareBindValue(row[col], columnTypes[index])));
            await connection.executeMany(insertSql, binds);
        }
    } else {
        const insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${bindNames})`;
        for (let start = 0; start < rows.length; start += batchRows) {
            const binds = rows.slice(start, start + batchRows).map((row) =>
                columns.map((col, index) => prepareBindValue(row[col], columnTypes[index])));
            await connection.executeMany(insertSql, binds);
        }
    }
}

// Oracle 타입에 맞게 값 변환
function prepareBindValue(value, oracleType) {
    if (value === undefined) return null;
    if (value === null) return null;
    // boolean → NUMBER(1)
    if (typeof value === 'boolean') return value ? 1 : 0;
    // Buffer → BLOB
    if (Buffer.isBuffer(value)) return value;
    // JSON 객체 → oracledb DB_TYPE_JSON
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value; // oracledb가 자동 처리
    }
    return value;
}

function assertDbExplorerIdentifier(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new StoragePayloadError(`${field} must be a valid table or column name`);
    }
    const parts = value.split('.');
    if (parts.length === 1 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0])) return value;
    if (parts.length === 2 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0]) && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[1])) return value;
    throw new StoragePayloadError(`${field} must be a valid table or column name`);
}

function dbExplorerSelectExpression(columnName, dataType) {
    const column = columnName.toUpperCase();
    switch (dataType.toLowerCase()) {
        case 'number':
        case 'float':
        case 'binary_double':
        case 'binary_float':
            return `TO_CHAR(${column})`;
        case 'blob':
            return `RAWTOHEX(${column})`;
        case 'clob':
            return `DBMS_LOB.GETLENGTH(${column}) || ' bytes'`;
        default:
            return column;
    }
}

async function beginAuditRevision(connection, {
    storageRevision = null,
    databaseInitialized = null,
    scope,
    action,
    restoredFrom = null,
}) {
    const result = await connection.execute(
        `INSERT INTO system_revisions
            (storage_revision, database_initialized, scope, action, restored_from_revision)
         VALUES (:1, :2, :3, :4, :5)
         RETURNING id INTO :6`,
        {
            1: storageRevision,
            2: databaseInitialized === null ? null : (databaseInitialized ? 1 : 0),
            3: scope,
            4: action,
            5: restoredFrom,
            6: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
        },
        { autoCommit: false }
    );
    const revisionId = result.outBinds['6'][0];
    // 세션 컨텍스트에 revision_id 설정
    await connection.execute(
        `BEGIN risu_audit_ctx_pkg.set_revision(:1); END;`,
        [String(revisionId)],
        { autoCommit: false }
    );
    return revisionId;
}

async function deleteMessageChildren(connection, pairs, tables = [
    'chat_message_attributes', 'chat_message_generation', 'chat_message_prompt_info',
    'chat_message_prompt_toggles', 'chat_message_prompt_items',
]) {
    if (pairs.length === 0) return;
    for (const table of tables) {
        // Oracle은 UNNEST 대신 개별 DELETE 사용
        // executemany로 chat_id/message_id 쌍 삭제
        const deleteSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = :1 AND message_id = :2`;
        const binds = pairs.map((p) => [String(p.chatId), String(p.id)]);
        const bindDefs = [
            { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
            { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
        ];
        await connection.executeMany(deleteSql, binds, { bindDefs });
    }
}

class OracleStorage extends SqlStorageBase {
    constructor(options = {}) {
        super();
        this.user = options.user || '';
        this.password = options.password || '';
        this.tnsAlias = options.tnsAlias || '';
        this.walletPath = options.walletPath || '';
        this.walletPassword = options.walletPassword || '';
        this.poolMax = Number.parseInt(options.poolMax || '10', 10);
        this.enabled = Boolean(options.enabled !== false && this.tnsAlias && this.user && this.password);
        this.pool = null;
    }

    async initialize() {
        if (!this.enabled) {
            console.log('[Oracle] DATABASE not configured; using legacy file storage.');
            return;
        }
        this.pool = await this.createInitializedPool();
        console.log('[Oracle] Structured storage is ready.');
    }

    async createInitializedPool() {
        const pool = await oracledb.createPool({
            user: this.user,
            password: this.password,
            connectString: this.tnsAlias,
            configDir: this.walletPath,
            walletLocation: this.walletPath,
            walletPassword: this.walletPassword,
            poolMax: Number.isSafeInteger(this.poolMax) && this.poolMax > 0 ? this.poolMax : 10,
            poolMin: 1,
            poolIncrement: 1,
            poolTimeout: 60,
            queueTimeout: 120000,
        });
        // 모든 연결이 빈 문자열 sentinel 정규화 래퍼를 통과하도록 getConnection 래핑
        const realGetConnection = pool.getConnection.bind(pool);
        pool.getConnection = async (...args) => wrapConnectionForEmptyStrings(await realGetConnection(...args));
        try {
            // 연결 테스트
            const testConn = await pool.getConnection();
            await testConn.execute('SELECT 1 FROM dual');
            // 스키마 기적용 여부 확인
            let alreadyInitialized = false;
            try {
                const checkRes = await testConn.execute(
                    `SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1`,
                    [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
                );
                const v = checkRes.rows[0]?.SCHEMA_VERSION;
                const l = checkRes.rows[0]?.SCHEMA_LAYOUT;
                if (v === ORACLE_SCHEMA_VERSION && l === 'relational-schema-v1') {
                    alreadyInitialized = true;
                }
            } catch (e) {
                // meta 테이블이 없으면 applySchema 진행
            }

            if (!alreadyInitialized) {
                // 스키마 적용
                const schema = await fs.readFile(path.join(__dirname, 'oracle-schema.sql'), 'utf8');
                await this.applySchema(testConn, schema);
            }
            await this.ensureAssetCatalogSchema(testConn);
            await testConn.close();

            // 스키마 버전 확인
            const verifyConn = await pool.getConnection();
            const result = await verifyConn.execute(
                `SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1`,
                [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );
            await verifyConn.close();
            const schemaVersion = result.rows[0]?.SCHEMA_VERSION;
            const schemaLayout = result.rows[0]?.SCHEMA_LAYOUT;
            if (schemaVersion !== ORACLE_SCHEMA_VERSION || schemaLayout !== 'relational-schema-v1') {
                throw new Error(
                    `Unsupported Oracle schema ${schemaVersion}/${schemaLayout}; ` +
                    `expected ${ORACLE_SCHEMA_VERSION}/relational-schema-v1`
                );
            }
            return pool;
        } catch (error) {
            try { await pool.close(0); } catch (e) {}
            throw error;
        }
    }

    async ensureAssetCatalogSchema(connection) {
        const statements = [
            `CREATE TABLE system_asset_catalog_state (
                singleton NUMBER(1) DEFAULT 1 PRIMARY KEY,
                initialized NUMBER(1) DEFAULT 0 NOT NULL,
                source_id VARCHAR2(2048),
                synced_at TIMESTAMP WITH TIME ZONE,
                CONSTRAINT asset_catalog_state_singleton CHECK (singleton = 1))`,
            `CREATE TABLE system_asset_catalog (
                asset_key VARCHAR2(1024) PRIMARY KEY,
                size_bytes NUMBER,
                etag VARCHAR2(1024),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)`,
            `CREATE INDEX asset_catalog_updated_idx ON system_asset_catalog (updated_at DESC)`,
        ];
        for (const statement of statements) {
            try {
                await connection.execute(statement);
            } catch (error) {
                if (!String(error?.message || '').includes('ORA-00955')) throw error;
            }
        }
        try {
            await connection.execute(
                `ALTER TABLE system_asset_catalog_state ADD source_id VARCHAR2(2048)`
            );
        } catch (error) {
            if (!String(error?.message || '').includes('ORA-01430')) throw error;
        }
        await connection.execute(
            `MERGE INTO system_asset_catalog_state target
             USING (SELECT 1 AS singleton FROM dual) src
             ON (target.singleton = src.singleton)
             WHEN NOT MATCHED THEN INSERT (singleton, initialized) VALUES (1, 0)`,
            [], { autoCommit: true }
        );
    }

    // 스키마 SQL을 분할하여 순차 실행 (/ 구분자 + 세미콜론)
    async applySchema(connection, schemaSql) {
        // 블록 주석 제거
        const cleaned = schemaSql.replace(/\/\*[\s\S]*?\*\//g, '');
        const lines = cleaned.split('\n');
        let buf = [];
        let plsqlBlock = false;

        const flush = async () => {
            const s = buf.join('\n').trim();
            if (s) {
                try {
                    await connection.execute(s, [], { autoCommit: false });
                } catch (err) {
                    // 이미 존재하는 객체/데이터/잠금은 무시
                    const msg = err.message || '';
                    if (msg.includes('ORA-00955') || msg.includes('ORA-00942') ||
                        msg.includes('ORA-00001') || msg.includes('ORA-01400') ||
                        msg.includes('ORA-00054')) {
                        // 무시
                    } else {
                        throw err;
                    }
                }
            }
            buf = [];
            plsqlBlock = false;
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;
            if (!trimmed && buf.length === 0) continue;
            if (trimmed === '/') {
                await flush();
                continue;
            }
            buf.push(line);
            if (/^(CREATE\s+(OR\s+REPLACE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE))/i.test(trimmed)) {
                plsqlBlock = true;
            }
            if (!plsqlBlock && trimmed.endsWith(';')) {
                await flush();
            }
        }
        await flush();

        // 기존 테이블의 컬럼 타입 마이그레이션 (Oracle은 VARCHAR2 -> CLOB 직접 ALTER 불가하므로 임시 컬럼 교체)
        await this._migrateVarchar2ToClob(connection, 'SYSTEM_MODULES', 'CUSTOM_TOGGLE');

        await connection.commit();
    }

    // Oracle은 VARCHAR2 -> CLOB 컬럼 타입 직접 변경(ALTER TABLE MODIFY) 시 ORA-22858 발생.
    // 임시 컬럼을 추가하고 데이터를 복사한 후 기존 컬럼을 교체한다.
    async _migrateVarchar2ToClob(connection, tableName, columnName) {
        try {
            const checkSql = `SELECT data_type FROM user_tab_cols WHERE table_name = UPPER(:1) AND column_name = UPPER(:2)`;
            const res = await connection.execute(checkSql, [tableName, columnName], { outFormat: oracledb.OUT_FORMAT_OBJECT });
            const dataType = res.rows?.[0]?.DATA_TYPE;
            if (dataType === 'VARCHAR2') {
                console.log(`[Oracle] Migrating ${tableName}.${columnName} from VARCHAR2 to CLOB...`);
                const tableIdent = assertSqlIdentifier(tableName);
                const colIdent = assertSqlIdentifier(columnName);
                const tempCol = assertSqlIdentifier(`${columnName.slice(0, 20)}_clob`);
                await connection.execute(`ALTER TABLE ${tableIdent} ADD (${tempCol} CLOB)`);
                await connection.execute(`UPDATE ${tableIdent} SET ${tempCol} = ${colIdent}`);
                await connection.execute(`ALTER TABLE ${tableIdent} DROP COLUMN ${colIdent}`);
                await connection.execute(`ALTER TABLE ${tableIdent} RENAME COLUMN ${tempCol} TO ${colIdent}`);
                console.log(`[Oracle] Migrated ${tableName}.${columnName} to CLOB successfully.`);
            }
        } catch (e) {
            console.error(`[Oracle] Migration error for ${tableName}.${columnName}:`, e.message || e);
        }
    }

    async reconfigure(options = {}) {
        this.invalidateBootstrapCache();
        const tnsAlias = options.tnsAlias || '';
        const parsedPoolMax = Number.parseInt(options.poolMax || '10', 10);
        const poolMax = Number.isSafeInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : 10;
        if (!tnsAlias || !options.user || !options.password) {
            const previousPool = this.pool;
            this.tnsAlias = '';
            this.user = '';
            this.password = '';
            this.walletPassword = '';
            this.poolMax = poolMax;
            this.pool = null;
            this.enabled = false;
            if (previousPool) {
                try { await previousPool.close(0); } catch (e) {}
            }
            return;
        }
        this.user = options.user;
        this.password = options.password;
        this.tnsAlias = tnsAlias;
        this.walletPath = options.walletPath || this.walletPath;
        this.walletPassword = options.walletPassword || this.walletPassword;
        this.poolMax = poolMax;
        this.enabled = true;

        const nextPool = await this.createInitializedPool();
        const previousPool = this.pool;
        this.pool = nextPool;
        if (previousPool) {
            try { await previousPool.close(0); } catch (e) {}
        }
        console.log('[Oracle] Storage connection was reconfigured.');
    }

    assertEnabled() {
        if (!this.enabled || !this.pool) {
            throw new Error('Oracle storage is not enabled');
        }
    }

    async getState() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const row = await fetchOne(conn,
                `SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1`);
            return {
                revision: Number(row.revision),
                initialized: num1ToBool(row.initialized),
            };
        } finally {
            await conn.close();
        }
    }

    async isAssetCatalogInitialized(sourceId) {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const row = await fetchOne(conn,
                `SELECT initialized, source_id FROM system_asset_catalog_state WHERE singleton = 1`);
            return num1ToBool(row?.initialized) && row?.source_id === sourceId;
        } finally {
            await conn.close();
        }
    }

    async listAssetCatalog(prefix = '') {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const rows = prefix
                ? await fetchRows(conn,
                    `SELECT asset_key FROM system_asset_catalog
                     WHERE SUBSTR(asset_key, 1, :1) = :2 ORDER BY asset_key`,
                    [prefix.length, prefix])
                : await fetchRows(conn,
                    `SELECT asset_key FROM system_asset_catalog ORDER BY asset_key`);
            return rows.map((row) => row.asset_key);
        } finally {
            await conn.close();
        }
    }

    async listAssetCatalogEntries(prefix = '') {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const rows = prefix
                ? await fetchRows(conn,
                    `SELECT asset_key, size_bytes, etag, updated_at FROM system_asset_catalog
                     WHERE SUBSTR(asset_key, 1, :1) = :2 ORDER BY asset_key`,
                    [prefix.length, prefix])
                : await fetchRows(conn,
                    `SELECT asset_key, size_bytes, etag, updated_at FROM system_asset_catalog ORDER BY asset_key`);
            return rows.map((row) => ({
                key: row.asset_key,
                size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
                etag: row.etag ?? null,
                updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
            }));
        } finally {
            await conn.close();
        }
    }

    async getAssetCatalogStats() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const row = await fetchOne(conn,
                `SELECT COUNT(*) AS total_objects, NVL(SUM(size_bytes), 0) AS total_size
                 FROM system_asset_catalog`);
            return {
                totalObjects: Number(row.total_objects),
                totalSizeBytes: Number(row.total_size),
            };
        } finally {
            await conn.close();
        }
    }

    async upsertAssetCatalog(entries) {
        this.assertEnabled();
        if (!Array.isArray(entries) || entries.length === 0) return 0;
        const conn = await this.pool.getConnection();
        try {
            await conn.executeMany(
                `MERGE INTO system_asset_catalog target
                 USING (SELECT :1 AS asset_key, :2 AS size_bytes, :3 AS etag FROM dual) src
                 ON (target.asset_key = src.asset_key)
                 WHEN MATCHED THEN UPDATE SET
                    target.size_bytes = COALESCE(src.size_bytes, target.size_bytes),
                    target.etag = COALESCE(src.etag, target.etag),
                    target.updated_at = SYSTIMESTAMP
                 WHEN NOT MATCHED THEN INSERT (asset_key, size_bytes, etag)
                    VALUES (src.asset_key, src.size_bytes, src.etag)`,
                entries.map((entry) => [entry.key, entry.size ?? null, entry.etag ?? null]),
                {
                    autoCommit: true,
                    bindDefs: [
                        { type: oracledb.STRING, maxSize: 1024 },
                        { type: oracledb.NUMBER },
                        { type: oracledb.STRING, maxSize: 1024 },
                    ],
                }
            );
            return entries.length;
        } finally {
            await conn.close();
        }
    }

    async removeAssetCatalog(keys) {
        this.assertEnabled();
        if (!Array.isArray(keys) || keys.length === 0) return 0;
        const conn = await this.pool.getConnection();
        try {
            const result = await conn.executeMany(
                `DELETE FROM system_asset_catalog WHERE asset_key = :1`,
                keys.map((key) => [key]),
                { autoCommit: true }
            );
            return result.rowsAffected || 0;
        } finally {
            await conn.close();
        }
    }

    async replaceAssetCatalog(prefix, entries, sourceId) {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            if (prefix) {
                await conn.execute(
                    `DELETE FROM system_asset_catalog WHERE SUBSTR(asset_key, 1, :1) = :2`,
                    [prefix.length, prefix]
                );
            } else {
                await conn.execute(`DELETE FROM system_asset_catalog`);
            }
            if (entries.length > 0) {
                await conn.executeMany(
                    `INSERT INTO system_asset_catalog (asset_key, size_bytes, etag)
                     VALUES (:1, :2, :3)`,
                    entries.map((entry) => [entry.key, entry.size ?? null, entry.etag ?? null]),
                    {
                        bindDefs: [
                            { type: oracledb.STRING, maxSize: 1024 },
                            { type: oracledb.NUMBER },
                            { type: oracledb.STRING, maxSize: 1024 },
                        ],
                    }
                );
            }
            await conn.execute(
                `UPDATE system_asset_catalog_state
                 SET initialized = 1, synced_at = SYSTIMESTAMP WHERE singleton = 1`,
                [], { autoCommit: false }
            );
            await conn.execute(
                `UPDATE system_asset_catalog_state SET source_id = :1 WHERE singleton = 1`,
                [sourceId], { autoCommit: true }
            );
            return entries.length;
        } catch (error) {
            await conn.rollback().catch(() => {});
            throw error;
        } finally {
            await conn.close();
        }
    }

    async listRevisions(rawLimit = 50) {
        this.assertEnabled();
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT r.id, r.storage_revision, r.database_initialized,
                        r.scope, r.action, r.restored_from_revision,
                        r.created_at, COUNT(a.sequence_num) AS change_count
                 FROM system_revisions r
                 LEFT JOIN system_audit_log a ON a.revision_id = r.id
                 GROUP BY r.id, r.storage_revision, r.database_initialized,
                          r.scope, r.action, r.restored_from_revision, r.created_at
                 ORDER BY r.id DESC
                 FETCH FIRST :1 ROWS ONLY`,
                [limit]);
            return rows.map((row) => ({
                ...row,
                id: Number(row.id),
                storage_revision: row.storage_revision === null ? null : Number(row.storage_revision),
                database_initialized: row.database_initialized === null ? null : num1ToBool(row.database_initialized),
                restored_from_revision: row.restored_from_revision === null ? null : Number(row.restored_from_revision),
                change_count: Number(row.change_count),
            }));
        } finally {
            await conn.close();
        }
    }

    async loadDatabase(options = {}) {
        const shallow = Boolean(options.shallow);
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            // Oracle: READ ONLY 트랜잭션
            await conn.execute('SET TRANSACTION READ ONLY');
            const metaRow = await fetchOne(conn,
                `SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1`);
            const revision = Number(metaRow.revision);
            const initialized = num1ToBool(metaRow.initialized);
            if (!initialized) {
                await conn.rollback();
                return { revision, initialized, database: null };
            }

            if (shallow) {
                // 지연 설정 키 제외 (DEFERRED_SETTING_KEYS는 postgresStorage에서 정의됨)
                // 단순화: 모든 설정 로드 (Oracle은 IN 목록 크기 제한이 있으므로)
                const settings = await fetchRows(conn, `SELECT * FROM system_settings ORDER BY key`);
                const settingValues = await fetchRows(conn, `SELECT * FROM system_setting_values ORDER BY setting_key, node_id`,
                    [], { clobColumns: ['text_value', 'encoded_text_value'] });
                const characters = await fetchRows(conn, `SELECT * FROM character_characters ORDER BY position, id`,
                    [], { clobColumns: ['image', 'description', 'notes', 'creator_notes', 'system_prompt',
                        'post_history_instructions', 'personality', 'scenario', 'example_message', 'license',
                        'default_variables', 'additional_text', 'translator_note', 'background_html', 'background_css',
                        'first_message'] });
                const tags = await fetchRows(conn, `SELECT * FROM character_tags ORDER BY character_id, position`);
                const groupMembers = await fetchRows(conn, `SELECT * FROM character_group_members ORDER BY group_id, position`);
                const chatFolders = await fetchRows(conn, `SELECT * FROM character_chat_folders ORDER BY character_id, position`);
                const chats = await fetchRows(conn, `SELECT * FROM chat_chats ORDER BY character_id, position, id`,
                    [], { clobColumns: ['note', 'sd_data', 'supa_memory_data', 'last_memory'] });
                const bookmarks = await fetchRows(conn, `SELECT * FROM chat_bookmarks ORDER BY chat_id, position`);

                const database = rebuildSettings(settings, settingValues);
                database.plugins ??= [];
                database.pluginCustomStorage ??= {};

                const characterRelations = {
                    tags: groupRows(tags, 'character_id'),
                    groupMembers: groupRows(groupMembers, 'group_id'),
                    chatFolders: groupRows(chatFolders, 'character_id'),
                };
                const chatRelations = { bookmarks: groupRows(bookmarks, 'chat_id') };

                rebuildDatabaseGraph({
                    database, characters, chats,
                    characterRelations, chatRelations,
                    rebuildCharacter, rebuildChat, rebuildMessage,
                    shallow: true,
                });
                await conn.rollback();
                return { revision, initialized, database };
            }

            // 전체 로드
            const allSettings = await fetchRows(conn, `SELECT * FROM system_settings ORDER BY key`);
            const allSettingValues = await fetchRows(conn, `SELECT * FROM system_setting_values ORDER BY setting_key, node_id`,
                [], { clobColumns: ['text_value', 'encoded_text_value'] });
            const characters = await fetchRows(conn, `SELECT * FROM character_characters ORDER BY position, id`,
                [], { clobColumns: ['image', 'description', 'notes', 'creator_notes', 'system_prompt',
                    'post_history_instructions', 'personality', 'scenario', 'example_message', 'license',
                    'default_variables', 'additional_text', 'translator_note', 'background_html', 'background_css',
                    'first_message'] });
            const characterAttributes = await fetchRows(conn, `SELECT * FROM character_attributes ORDER BY character_id, key_value`);
            const tags = await fetchRows(conn, `SELECT * FROM character_tags ORDER BY character_id, position`);
            const greetings = await fetchRows(conn, `SELECT * FROM character_greetings ORDER BY character_id, greeting_type, position`,
                [], { clobColumns: ['content'] });
            const biases = await fetchRows(conn, `SELECT * FROM character_biases ORDER BY character_id, position`);
            const emotions = await fetchRows(conn, `SELECT * FROM character_emotions ORDER BY character_id, position`,
                [], { clobColumns: ['asset'] });
            const characterModules = await fetchRows(conn, `SELECT * FROM character_modules ORDER BY character_id, position`);
            const groupMembers = await fetchRows(conn, `SELECT * FROM character_group_members ORDER BY group_id, position`);
            const chatFolders = await fetchRows(conn, `SELECT * FROM character_chat_folders ORDER BY character_id, position`);
            const scripts = await fetchRows(conn, `SELECT * FROM character_scripts ORDER BY character_id, script_kind, position`,
                [], { clobColumns: ['comment_text', 'input_text', 'output_text', 'flag'] });
            const sdData = await fetchRows(conn, `SELECT * FROM character_sd_data ORDER BY character_id, position`,
                [], { clobColumns: ['value'] });
            const assets = await fetchRows(conn, `SELECT * FROM character_assets ORDER BY character_id, position`,
                [], { clobColumns: ['uri', 'extra_value'] });
            const characterLore = await fetchRows(conn, `SELECT * FROM character_lore_entries ORDER BY character_id, position`,
                [], { clobColumns: ['comment_text', 'content'] });
            const chats = await fetchRows(conn, `SELECT * FROM chat_chats ORDER BY character_id, position, id`,
                [], { clobColumns: ['note', 'sd_data', 'supa_memory_data', 'last_memory'] });
            const chatAttributes = await fetchRows(conn, `SELECT * FROM chat_attributes ORDER BY chat_id, key_value`);
            const suggestions = await fetchRows(conn, `SELECT * FROM chat_suggestions ORDER BY chat_id, position`,
                [], { clobColumns: ['content'] });
            const chatModules = await fetchRows(conn, `SELECT * FROM chat_modules ORDER BY chat_id, position`);
            const scriptState = await fetchRows(conn, `SELECT * FROM chat_script_state ORDER BY chat_id, key_value`,
                [], { clobColumns: ['text_value'] });
            const bookmarks = await fetchRows(conn, `SELECT * FROM chat_bookmarks ORDER BY chat_id, position`);
            const memory = await fetchRows(conn, `SELECT * FROM chat_memory ORDER BY chat_id, memory_type`);
            const chatLore = await fetchRows(conn, `SELECT * FROM chat_lore_entries ORDER BY chat_id, position`,
                [], { clobColumns: ['comment_text', 'content'] });
            const messages = await fetchRows(conn, `SELECT * FROM chat_messages ORDER BY chat_id, position, id`,
                [], { clobColumns: ['content_text'], blobColumns: ['content_binary'] });
            const messageAttributes = await fetchRows(conn, `SELECT * FROM chat_message_attributes ORDER BY chat_id, message_id, key_value`);
            const generations = await fetchRows(conn, `SELECT * FROM chat_message_generation`);
            const promptInfos = await fetchRows(conn, `SELECT * FROM chat_message_prompt_info`);
            const promptToggles = await fetchRows(conn, `SELECT * FROM chat_message_prompt_toggles ORDER BY chat_id, message_id, position`,
                [], { clobColumns: ['toggle_value'] });
            const promptItems = await fetchRows(conn, `SELECT * FROM chat_message_prompt_items ORDER BY chat_id, message_id, position`);

            const database = rebuildSettings(allSettings, allSettingValues);
            const characterRelations = createCharacterRelations({
                attributes: characterAttributes, tags, greetings, biases, emotions,
                modules: characterModules, groupMembers, chatFolders, scripts,
                sdData, assets, lore: characterLore,
            });
            const chatRelations = createChatRelations({
                attributes: chatAttributes, suggestions, modules: chatModules,
                scriptState, bookmarks, memory, lore: chatLore,
            });
            const messageRelations = createMessageRelations({
                attributes: messageAttributes,
                generations,
                promptInfos,
                promptToggles,
                promptItems,
            });
            rebuildDatabaseGraph({
                database, characters, chats, messages,
                characterRelations, chatRelations, messageRelations,
                rebuildCharacter, rebuildChat, rebuildMessage,
            });
            await conn.rollback();
            return { revision, initialized, database };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // 엔티티 로드: loadCharacter, loadChat, loadChatMessages
    // ============================================================

    async loadCharacter(characterId) {
        this.assertEnabled();
        assertId(characterId, 'characterId');
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const charRow = await fetchOne(conn,
                `SELECT * FROM character_characters WHERE id = :1`, [characterId],
                { clobColumns: ['image', 'description', 'notes', 'creator_notes', 'system_prompt',
                    'post_history_instructions', 'personality', 'scenario', 'example_message', 'license',
                    'default_variables', 'additional_text', 'translator_note', 'background_html',
                    'background_css', 'first_message'] });
            if (!charRow) {
                await conn.rollback();
                return null;
            }
            const [attributes, tags, greetings, biases, emotions, modules, groupMembers, chatFolders, scripts, sdData, assets, lore] = await Promise.all([
                fetchRows(conn, `SELECT * FROM character_attributes WHERE character_id = :1 ORDER BY key_value`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_tags WHERE character_id = :1 ORDER BY position`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_greetings WHERE character_id = :1 ORDER BY greeting_type, position`, [characterId], { clobColumns: ['content'] }),
                fetchRows(conn, `SELECT * FROM character_biases WHERE character_id = :1 ORDER BY position`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_emotions WHERE character_id = :1 ORDER BY position`, [characterId], { clobColumns: ['asset'] }),
                fetchRows(conn, `SELECT * FROM character_modules WHERE character_id = :1 ORDER BY position`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_group_members WHERE group_id = :1 ORDER BY position`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_chat_folders WHERE character_id = :1 ORDER BY position`, [characterId]),
                fetchRows(conn, `SELECT * FROM character_scripts WHERE character_id = :1 ORDER BY script_kind, position`, [characterId], { clobColumns: ['comment_text', 'input_text', 'output_text', 'flag'] }),
                fetchRows(conn, `SELECT * FROM character_sd_data WHERE character_id = :1 ORDER BY position`, [characterId], { clobColumns: ['value'] }),
                fetchRows(conn, `SELECT * FROM character_assets WHERE character_id = :1 ORDER BY position`, [characterId], { clobColumns: ['uri', 'extra_value'] }),
                fetchRows(conn, `SELECT * FROM character_lore_entries WHERE character_id = :1 ORDER BY position`, [characterId], { clobColumns: ['comment_text', 'content'] }),
            ]);
            const character = rebuildCharacter(charRow, {
                attributes, tags, greetings, biases, emotions, modules, groupMembers, chatFolders, scripts, sdData, assets, lore,
            });
            character.detailsLoaded = true;
            await conn.rollback();
            return character;
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async loadChat(chatId) {
        this.assertEnabled();
        assertId(chatId, 'chatId');
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const chatRow = await fetchOne(conn,
                `SELECT * FROM chat_chats WHERE id = :1`, [chatId],
                { clobColumns: ['note', 'sd_data', 'supa_memory_data', 'last_memory'] });
            if (!chatRow) {
                await conn.rollback();
                return null;
            }
            const [attributes, suggestions, modules, scriptState, bookmarks, memory, lore, messages, messageAttributes, generations, promptInfos, promptToggles, promptItems] = await Promise.all([
                fetchRows(conn, `SELECT * FROM chat_attributes WHERE chat_id = :1 ORDER BY key_value`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_suggestions WHERE chat_id = :1 ORDER BY position`, [chatId], { clobColumns: ['content'] }),
                fetchRows(conn, `SELECT * FROM chat_modules WHERE chat_id = :1 ORDER BY position`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_script_state WHERE chat_id = :1 ORDER BY key_value`, [chatId], { clobColumns: ['text_value'] }),
                fetchRows(conn, `SELECT * FROM chat_bookmarks WHERE chat_id = :1 ORDER BY position`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_memory WHERE chat_id = :1 ORDER BY memory_type`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_lore_entries WHERE chat_id = :1 ORDER BY position`, [chatId], { clobColumns: ['comment_text', 'content', 'cache_payload'] }),
                fetchRows(conn, `SELECT * FROM chat_messages WHERE chat_id = :1 ORDER BY position, id`, [chatId], { clobColumns: ['content_text'], blobColumns: ['content_binary'] }),
                fetchRows(conn, `SELECT * FROM chat_message_attributes WHERE chat_id = :1 ORDER BY message_id, key_value`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_message_generation WHERE chat_id = :1`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_message_prompt_info WHERE chat_id = :1`, [chatId]),
                fetchRows(conn, `SELECT * FROM chat_message_prompt_toggles WHERE chat_id = :1 ORDER BY message_id, position`, [chatId], { clobColumns: ['toggle_value'] }),
                fetchRows(conn, `SELECT * FROM chat_message_prompt_items WHERE chat_id = :1 ORDER BY message_id, position`, [chatId]),
            ]);
            const messageRelations = {
                attributes: groupMessageRows(messageAttributes),
                generation: new Map(generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptInfo: new Map(promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptToggles: groupMessageRows(promptToggles),
                promptItems: groupMessageRows(promptItems),
            };
            const rebuiltMessages = [];
            for (const row of messages) {
                const key = `${row.chat_id}\0${row.id}`;
                const related = {
                    attributes: messageRelations.attributes.get(key),
                    generation: messageRelations.generation.get(key),
                    promptInfo: messageRelations.promptInfo.get(key),
                    promptToggles: messageRelations.promptToggles.get(key),
                    promptItems: messageRelations.promptItems.get(key),
                };
                rebuiltMessages.push(rebuildMessage(row, related));
            }
            const chat = rebuildChat(chatRow, {
                attributes, suggestions, modules, scriptState, bookmarks, memory, lore, messages: rebuiltMessages,
            });
            chat.messagesLoaded = true;
            chat.detailsLoaded = true;
            await conn.rollback();
            return chat;
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // 설정 로드: loadPlugins, loadPluginCustomStorage, ...
    // ============================================================

    async loadPlugins() {
        this.assertEnabled();
        if (this.pluginsCache) {
            return this.pluginsCache;
        }
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const settings = await fetchRows(conn,
                `SELECT * FROM system_settings WHERE key = 'plugins' ORDER BY key`);
            const settingValues = await fetchRows(conn,
                `SELECT * FROM system_setting_values WHERE setting_key = 'plugins' ORDER BY setting_key, node_id`,
                [], { clobColumns: ['text_value', 'encoded_text_value'] });
            const rebuilt = rebuildSettings(settings, settingValues);
            await conn.rollback();
            const plugins = rebuilt.plugins || [];
            const serialized = JSON.stringify(plugins);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            const result = { plugins, hash };
            if (this.objectCacheEnabled) this.pluginsCache = result;
            return result;
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async loadPluginCustomStorage() {
        this.assertEnabled();
        if (this.pluginCustomStorageCache) {
            return this.pluginCustomStorageCache;
        }
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const settings = await fetchRows(conn,
                `SELECT * FROM system_settings WHERE key = 'pluginCustomStorage' ORDER BY key`);
            const settingValues = await fetchRows(conn,
                `SELECT * FROM system_setting_values WHERE setting_key = 'pluginCustomStorage' ORDER BY setting_key, node_id`,
                [], { clobColumns: ['text_value', 'encoded_text_value'] });
            const rebuilt = rebuildSettings(settings, settingValues);
            await conn.rollback();
            const pluginCustomStorage = rebuilt.pluginCustomStorage || {};
            const serialized = JSON.stringify(pluginCustomStorage);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            const result = { pluginCustomStorage, hash };
            if (this.objectCacheEnabled) this.pluginCustomStorageCache = result;
            return result;
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async listPluginCustomStorageKeys() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const rows = await fetchRows(conn,
                `SELECT node_id, member_key, encoded_member_key, position
                 FROM system_setting_values
                 WHERE setting_key = 'pluginCustomStorage' AND parent_node_id = 0
                 ORDER BY node_id`,
                [], { clobColumns: ['member_key', 'encoded_member_key'] });
            await conn.rollback();
            return rows.map((row) => decodeMember(row)).filter((key) => key !== null && key !== undefined);
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async loadPluginCustomStorageKey(storageKey) {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            const encoded = encodeMember(storageKey, null);
            // Oracle 재귀 CTE (PostgreSQL WITH RECURSIVE 호환)
            const rows = await fetchRows(conn,
                `WITH key_tree (node_id, parent_node_id, member_key, encoded_member_key, position,
                                value_type, text_value, encoded_text_value, number_value, boolean_value) AS (
                    SELECT node_id, parent_node_id, member_key, encoded_member_key, position,
                           value_type, text_value, encoded_text_value, number_value, boolean_value
                    FROM system_setting_values
                    WHERE setting_key = 'pluginCustomStorage'
                      AND parent_node_id = 0
                      AND ((member_key IS NOT NULL AND member_key = :1)
                           OR (encoded_member_key IS NOT NULL AND encoded_member_key = :2))
                    UNION ALL
                    SELECT v.node_id, v.parent_node_id, v.member_key, v.encoded_member_key, v.position,
                           v.value_type, v.text_value, v.encoded_text_value, v.number_value, v.boolean_value
                    FROM system_setting_values v
                    INNER JOIN key_tree kt ON v.parent_node_id = kt.node_id
                    WHERE v.setting_key = 'pluginCustomStorage'
                )
                SELECT * FROM key_tree ORDER BY node_id`,
                [encoded.member_key, encoded.encoded_member_key],
                { clobColumns: ['member_key', 'encoded_member_key', 'text_value', 'encoded_text_value'] });
            await conn.rollback();
            if (rows.length === 0) {
                return { key: storageKey, exists: false, value: null, hash: 'null' };
            }
            const rootNodeId = Number(rows[0].node_id);
            const value = rebuildSettingSubtree(rootNodeId, rows);
            const serialized = JSON.stringify(value);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            return { key: storageKey, exists: true, value, hash };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async loadSettingKeys(keys) {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            // Oracle IN 목록: 바인드 변수 목록 생성
            const inClause = keys.map((_, i) => `:${i + 1}`).join(', ');
            const settings = await fetchRows(conn,
                `SELECT * FROM system_settings WHERE key IN (${inClause}) ORDER BY key`,
                keys);
            const settingValues = await fetchRows(conn,
                `SELECT * FROM system_setting_values WHERE setting_key IN (${inClause}) ORDER BY setting_key, node_id`,
                keys, { clobColumns: ['text_value', 'encoded_text_value'] });
            await conn.rollback();
            const rebuilt = rebuildSettings(settings, settingValues);
            const serialized = JSON.stringify(rebuilt);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            return { settings: rebuilt, hash };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // sync: 변경사항 동기화 (가장 복잡한 메서드)
    // ============================================================

    async sync(rawPayload, options = {}) {
        this.assertEnabled();
        const onProgress = typeof options === 'function' ? options : options?.onProgress;
        const payload = validateSyncPayload(rawPayload);
        const conn = await this.pool.getConnection();
        try {
            onProgress?.({ stage: 'init', message: 'Oracle 연결 및 잠금 확인 중...', percent: 2 });
            await conn.execute('SET CONSTRAINTS ALL DEFERRED');
            // revision 잠금 (SELECT FOR UPDATE)
            const metaRow = await fetchOne(conn,
                `SELECT revision FROM system_storage_meta WHERE singleton = 1 FOR UPDATE`);
            const currentRevision = Number(metaRow.revision);
            if (payload.baseRevision !== currentRevision) {
                throw new StorageRevisionConflictError(currentRevision,
                    `Oracle data changed in another session (server revision ${currentRevision}). Reload before saving again.`);
            }
            const nextRevision = currentRevision + 1;
            await beginAuditRevision(conn, {
                storageRevision: nextRevision,
                databaseInitialized: true,
                scope: 'database',
                action: payload.replaceAll ? 'replace-all' : 'sync',
            });

            if (payload.replaceAll) {
                onProgress?.({ stage: 'cleanup', message: '기존 데이터 정리 중...', percent: 5 });
                await conn.execute('DELETE FROM system_settings');
                await conn.execute('DELETE FROM character_characters');
            }

            // 설정 upsert
            onProgress?.({ stage: 'settings', message: `설정 분해 및 동기화 중... (${payload.rootUpserts.length}개 설정)`, percent: 10 });
            let splitSettings;
            try {
                splitSettings = payload.rootUpserts.map((row) => splitSetting(row.key, row.value, {
                    maxRows: MAX_SYNC_ROWS, maxDepth: 128,
                }));
            } catch (error) {
                throw new StoragePayloadError(
                    error instanceof Error ? error.message : 'Oracle setting decomposition failed'
                );
            }
            const settingValueCount = splitSettings.reduce((c, s) => c + s.values.length, 0);
            if (settingValueCount > MAX_SYNC_ROWS) {
                throw new StoragePayloadError(`Structured settings exceed the ${MAX_SYNC_ROWS} row limit`);
            }

            // system_settings MERGE
            if (splitSettings.length > 0) {
                const mergeSql = `MERGE INTO system_settings t
                    USING (SELECT :1 AS key FROM dual) s
                    ON (t.key = s.key)
                    WHEN NOT MATCHED THEN INSERT (key) VALUES (s.key)`;
                await conn.executeMany(mergeSql, splitSettings.map((s) => [s.setting.key]));
            }
            const changedSettingKeys = splitSettings.map((s) => s.setting.key);
            if (changedSettingKeys.length > 0) {
                // 기존 setting_values 삭제 (executemany)
                const delSql = `DELETE FROM system_setting_values WHERE setting_key = :1`;
                await conn.executeMany(delSql, changedSettingKeys.map((k) => [k]));
            }
            // setting_values bulk insert
            const allValues = splitSettings.flatMap((s) => s.values);
            if (allValues.length > 0) {
                const cols = ['setting_key', 'node_id', 'parent_node_id', 'member_key', 'encoded_member_key',
                    'position', 'value_type', 'number_value', 'boolean_value', 'text_value', 'encoded_text_value'];
                await this._bulkInsertRows(conn, 'system_setting_values', cols, allValues, onProgress);
            }

            // 관계형 설정 테이블
            const projectedSettings = projectSettings(payload.rootUpserts);
            if (changedSettingKeys.length > 0) {
                const changedSet = new Set(changedSettingKeys);
                for (const definition of SETTING_RELATION_DEFINITIONS) {
                    const projectedKeys = definition.settingKeys.filter((k) => changedSet.has(k));
                    if (projectedKeys.length === 0) continue;
                    const delSql = `DELETE FROM ${assertSqlIdentifier(definition.table)} WHERE setting_key = :1`;
                    await conn.executeMany(delSql, projectedKeys.map((k) => [k]));
                }
            }
            for (const definition of SETTING_RELATION_DEFINITIONS) {
                const rows = projectedSettings[definition.table];
                if (rows && rows.length > 0) {
                    await this._bulkInsertRows(conn, definition.table, definition.columns, rows, onProgress);
                }
            }
            if (payload.rootDeletes.length > 0) {
                await conn.executeMany(`DELETE FROM system_settings WHERE key = :1`,
                    payload.rootDeletes.map((k) => [k]));
            }

            // 캐릭터 upsert
            onProgress?.({ stage: 'characters', message: `캐릭터 및 속성 저장 중... (${payload.characters.length}개)`, percent: 25 });
            const splitCharacters = payload.characters.map(splitCharacter);
            const characterColumns = [
                'id', 'position', 'kind', 'name', 'image', 'first_message', 'description', 'notes',
                'creator_notes', 'system_prompt', 'post_history_instructions', 'personality', 'scenario',
                'example_message', 'creator', 'character_version', 'nickname', 'view_screen', 'chat_page',
                'first_message_index', 'utility_bot', 'is_private', 'realm_id', 'license',
                'default_variables', 'additional_text', 'translator_note', 'background_html',
                'background_css', 'creation_time', 'modification_time', 'last_interaction_time', 'trash_time',
            ];
            if (splitCharacters.length > 0) {
                const updateCols = characterColumns.slice(1);
                const upsertSql = `BEGIN
                    UPDATE character_characters SET
                        ${updateCols.map((c) => `${c.toUpperCase()} = :${c}`).join(', ')},
                        updated_at = SYSTIMESTAMP
                    WHERE id = :id;
                    IF SQL%ROWCOUNT = 0 THEN
                        INSERT INTO character_characters (${characterColumns.map((c) => c.toUpperCase()).join(', ')})
                        VALUES (${characterColumns.map((c) => `:${c}`).join(', ')});
                    END IF;
                END;`;
                const characterBindDefs = {};
                for (const c of characterColumns) {
                    const t = this._getColumnBindType('character_characters', c);
                    characterBindDefs[c] = t === oracledb.DB_TYPE_VARCHAR ? { type: t, maxSize: 4000 } : { type: t };
                }
                const binds = splitCharacters.map((item) => {
                    const row = {};
                    for (const c of characterColumns) {
                        const v = item.core[c];
                        const t = this._getColumnBindType('character_characters', c);
                        row[c] = this._formatBindValue(v, t, false);
                    }
                    return row;
                });
                await conn.executeMany(upsertSql, binds, { bindDefs: characterBindDefs });
            }

            const changedCharacterIds = payload.characters.map((r) => r.id);
            const characterChildTables = [
                'character_attributes', 'character_tags', 'character_greetings',
                'character_biases', 'character_emotions', 'character_modules',
                'character_group_members', 'character_chat_folders', 'character_scripts',
                'character_sd_data', 'character_assets', 'character_lore_entries',
            ];
            if (changedCharacterIds.length > 0) {
                for (const table of characterChildTables) {
                    const ownerColumn = table === 'character_group_members' ? 'group_id' : 'character_id';
                    const delSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE ${ownerColumn.toUpperCase()} = :1`;
                    await conn.executeMany(delSql, changedCharacterIds.map((id) => [id]));
                }
            }

            // 캐릭터 자식 테이블 bulk insert
            const characterRows = (name) => splitCharacters.flatMap((item) => item[name]);
            await this._bulkInsertRows(conn, 'character_attributes', ['character_id', 'key_value', 'value'],
                splitCharacters.flatMap((item) => item.attributes.map((r) => ({ character_id: item.core.id, key_value: r.key, value: r.value }))), onProgress);
            await this._bulkInsertRows(conn, 'character_tags', ['character_id', 'position', 'tag'], characterRows('tags'), onProgress);
            await this._bulkInsertRows(conn, 'character_greetings', ['character_id', 'greeting_type', 'position', 'content'], characterRows('greetings'), onProgress);
            await this._bulkInsertRows(conn, 'character_biases', ['character_id', 'position', 'phrase', 'bias'], characterRows('biases'), onProgress);
            await this._bulkInsertRows(conn, 'character_emotions', ['character_id', 'position', 'emotion', 'asset'], characterRows('emotions'), onProgress);
            await this._bulkInsertRows(conn, 'character_modules', ['character_id', 'position', 'module_id'], characterRows('modules'), onProgress);
            await this._bulkInsertRows(conn, 'character_group_members', ['group_id', 'position', 'character_id', 'talk_weight', 'active'], characterRows('groupMembers'), onProgress);
            await this._bulkInsertRows(conn, 'character_chat_folders', ['character_id', 'position', 'folder_id', 'name', 'color', 'folded'], characterRows('chatFolders'), onProgress);
            await this._bulkInsertRows(conn, 'character_scripts', ['character_id', 'script_kind', 'position', 'comment_text', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], characterRows('scripts'), onProgress);
            await this._bulkInsertRows(conn, 'character_sd_data', ['character_id', 'position', 'key_value', 'value'], characterRows('sdData'), onProgress);
            await this._bulkInsertRows(conn, 'character_assets', ['character_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], characterRows('assets'), onProgress);
            await this._bulkInsertRows(conn, 'character_lore_entries', ['character_id', 'position', 'lore_id', 'primarykey', 'secondary_key', 'insert_order', 'comment_text', 'content', 'lore_mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], characterRows('lore'), onProgress);

            // 채팅 upsert
            onProgress?.({ stage: 'chats', message: `채팅 목록 저장 중... (${payload.chats.length}개)`, percent: 45 });
            const splitChats = payload.chats.map(splitChat);
            const chatColumns = ['id', 'character_id', 'position', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'];
            if (splitChats.length > 0) {
                const updateCols = chatColumns.slice(1);
                const upsertSql = `BEGIN
                    UPDATE chat_chats SET
                        ${updateCols.map((c) => `${c.toUpperCase()} = :${c}`).join(', ')},
                        updated_at = SYSTIMESTAMP
                    WHERE id = :id;
                    IF SQL%ROWCOUNT = 0 THEN
                        INSERT INTO chat_chats (${chatColumns.map((c) => c.toUpperCase()).join(', ')})
                        VALUES (${chatColumns.map((c) => `:${c}`).join(', ')});
                    END IF;
                END;`;
                const chatBindDefs = {};
                for (const c of chatColumns) {
                    const t = this._getColumnBindType('chat_chats', c);
                    chatBindDefs[c] = t === oracledb.DB_TYPE_VARCHAR ? { type: t, maxSize: 4000 } : { type: t };
                }
                const binds = splitChats.map((item) => {
                    const row = {};
                    for (const c of chatColumns) {
                        const v = item.core[c];
                        const t = this._getColumnBindType('chat_chats', c);
                        row[c] = this._formatBindValue(v, t, false);
                    }
                    return row;
                });
                await conn.executeMany(upsertSql, binds, { bindDefs: chatBindDefs });
            }
            const changedChatIds = payload.chats.map((r) => r.id);
            const chatChildTables = ['chat_attributes', 'chat_suggestions', 'chat_modules', 'chat_script_state', 'chat_bookmarks', 'chat_memory', 'chat_lore_entries'];
            if (changedChatIds.length > 0) {
                for (const table of chatChildTables) {
                    const delSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = :1`;
                    await conn.executeMany(delSql, changedChatIds.map((id) => [id]));
                }
            }
            const chatRows = (name) => splitChats.flatMap((item) => item[name]);
            await this._bulkInsertRows(conn, 'chat_attributes', ['chat_id', 'key_value', 'value'], splitChats.flatMap((item) => item.attributes.map((r) => ({ chat_id: item.core.id, key_value: r.key, value: r.value }))), onProgress);
            await this._bulkInsertRows(conn, 'chat_suggestions', ['chat_id', 'position', 'content'], chatRows('suggestions'), onProgress);
            await this._bulkInsertRows(conn, 'chat_modules', ['chat_id', 'position', 'module_id'], chatRows('modules'), onProgress);
            await this._bulkInsertRows(conn, 'chat_script_state', ['chat_id', 'key_value', 'value_type', 'text_value', 'number_value', 'boolean_value'], chatRows('scriptState'), onProgress);
            await this._bulkInsertRows(conn, 'chat_bookmarks', ['chat_id', 'position', 'message_id', 'name'], chatRows('bookmarks'), onProgress);
            await this._bulkInsertRows(conn, 'chat_memory', ['chat_id', 'memory_type', 'payload'], chatRows('memory'), onProgress);
            await this._bulkInsertRows(conn, 'chat_lore_entries', ['chat_id', 'position', 'lore_id', 'primarykey', 'secondary_key', 'insert_order', 'comment_text', 'content', 'lore_mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], chatRows('lore'), onProgress);

            // 메시지 upsert / bulk insert
            onProgress?.({ stage: 'messages', message: `메시지 저장 중... (${payload.messages.length}개)`, percent: 65 });
            const splitMessages = payload.messages.map(splitMessage);
            const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
            const messageChildTables = [
                'chat_message_attributes', 'chat_message_generation', 'chat_message_prompt_info',
                'chat_message_prompt_toggles', 'chat_message_prompt_items',
            ];
            if (changedChatIds.length > 0) {
                for (const table of messageChildTables) {
                    const delSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = :1`;
                    await conn.executeMany(delSql, changedChatIds.map((id) => [id]));
                }
                const delMsgSql = `DELETE FROM chat_messages WHERE chat_id = :1`;
                await conn.executeMany(delMsgSql, changedChatIds.map((id) => [id]));
            } else if (payload.messages.length > 0) {
                await deleteMessageChildren(conn, payload.messages);
                const delMsgSql = `DELETE FROM chat_messages WHERE chat_id = :1 AND id = :2`;
                await conn.executeMany(delMsgSql, payload.messages.map((m) => [m.chatId, m.id]));
            }
            if (splitMessages.length > 0) {
                await this._bulkInsertRows(conn, 'chat_messages', messageColumns, splitMessages.map((m) => m.core), onProgress);
            }
            onProgress?.({ stage: 'message_children', message: '메시지 메타데이터 및 프롬프트 토글 저장 중...', percent: 85 });
            await this._bulkInsertRows(conn, 'chat_message_attributes', ['chat_id', 'message_id', 'key_value', 'value'],
                splitMessages.flatMap((item) => item.attributes.map((r) => ({ chat_id: item.core.chat_id, message_id: item.core.id, key_value: r.key, value: r.value }))), onProgress);
            await this._bulkInsertRows(conn, 'chat_message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'],
                splitMessages.flatMap((item) => item.generation ? [item.generation] : []), onProgress);
            await this._bulkInsertRows(conn, 'chat_message_prompt_info', ['chat_id', 'message_id', 'prompt_name'],
                splitMessages.flatMap((item) => item.prompt ? [item.prompt.info] : []), onProgress);
            await this._bulkInsertRows(conn, 'chat_message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'],
                splitMessages.flatMap((item) => item.prompt?.toggles || []), onProgress);
            await this._bulkInsertRows(conn, 'chat_message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'],
                splitMessages.flatMap((item) => item.prompt?.items || []), onProgress);

            // manifest 기반 삭제
            if (payload.characterIds !== undefined) {
                const allChars = await fetchRows(conn, `SELECT id FROM character_characters`);
                const retainedSet = new Set(payload.characterIds);
                const toDelete = allChars.filter((r) => !retainedSet.has(r.id));
                if (toDelete.length > 0) {
                    await conn.executeMany(`DELETE FROM character_characters WHERE id = :1`,
                        toDelete.map((r) => [r.id]));
                }
            }
            for (const manifest of payload.chatManifests) {
                const allChats = await fetchRows(conn,
                    `SELECT id FROM chat_chats WHERE character_id = :1`, [manifest.characterId]);
                const retainedSet = new Set(manifest.ids);
                const toDelete = allChats.filter((r) => !retainedSet.has(r.id));
                if (toDelete.length > 0) {
                    await conn.executeMany(`DELETE FROM chat_chats WHERE id = :1`,
                        toDelete.map((r) => [r.id]));
                }
            }
            for (const manifest of payload.messageManifests) {
                const allMsgs = await fetchRows(conn,
                    `SELECT id FROM chat_messages WHERE chat_id = :1`, [manifest.chatId]);
                const retainedSet = new Set(manifest.ids);
                const toDelete = allMsgs.filter((r) => !retainedSet.has(r.id));
                if (toDelete.length > 0) {
                    await conn.executeMany(`DELETE FROM chat_messages WHERE id = :1`,
                        toDelete.map((r) => [r.id]));
                }
            }

            // revision 갱신
            onProgress?.({ stage: 'commit', message: '오라클 트랜잭션 커밋 중...', percent: 98 });
            await conn.execute(
                `UPDATE system_storage_meta
                 SET revision = :1, initialized = 1, updated_at = SYSTIMESTAMP
                 WHERE singleton = 1`,
                [nextRevision]);
            await conn.commit();
            const changedKeys = splitSettings.map((s) => s.setting.key);
            const rootDeletes = payload.rootDeletes || [];
            if (changedKeys.includes('plugins') || rootDeletes.includes('plugins')) {
                this.pluginsCache = null;
            }
            if (changedKeys.includes('pluginCustomStorage') || rootDeletes.includes('pluginCustomStorage')) {
                this.pluginCustomStorageCache = null;
            }
            this.invalidateBootstrapCache([...changedKeys, ...rootDeletes]);
            void this.warmBootstrapCache().catch((error) => {
                console.warn('[Oracle] Bootstrap cache refresh failed:', error.message);
            });
            onProgress?.({ stage: 'done', message: `동기화 완료 (Revision: ${nextRevision})`, percent: 100 });
            return {
                revision: nextRevision,
                changed: {
                    root: payload.rootUpserts.length + payload.rootDeletes.length,
                    characters: payload.characters.length,
                    chats: payload.chats.length,
                    messages: payload.messages.length,
                },
            };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    _getColumnBindType(table, column) {
        const col = column.toLowerCase();
        const mappedTable = mapTableName(table);
        const jsonCols = new Set(this._getJsonColumnsForTable(mappedTable).map((c) => c.toLowerCase()));
        if (jsonCols.has(col)) {
            return oracledb.DB_TYPE_CLOB;
        }
        const lobCols = new Set(this._getLobColumnsForTable(mappedTable).map((c) => c.toLowerCase()));
        if (lobCols.has(col)) {
            if (col === 'content_binary' || col === 'data') {
                return oracledb.DB_TYPE_BLOB;
            }
            return oracledb.DB_TYPE_CLOB;
        }

        const numberCols = new Set([
            'position', 'book_position', 'lore_position', 'model_position', 'insert_order', 'activation_percent',
            'book_version', 'input_tokens', 'output_tokens', 'max_context', 'max_response', 'temperature',
            'frequency_penalty', 'presence_penalty', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time',
            'talk_weight', 'active', 'folded', 'able_flag', 'always_active', 'selective', 'case_sensitive',
            'use_regex', 'number_value', 'boolean_value', 'low_level_access', 'hide_icon', 'enabled',
            'large_portrait', 'favorite', 'icons_present', 'prompt_preprocess', 'control', 'shift', 'alt',
            'alt_flag', 'format', 'tokenizer', 'last_used', 'bound_persona_id', 'first_message_index',
            'last_message_time', 'sent_time', 'is_comment', 'is_streaming', 'streaming_optimization_mode',
            'node_id', 'parent_node_id', 'bias', 'sd_model', 'use_sd', 'new_chat_on_start',
            'chat_page', 'utility_bot', 'is_private', 'creation_time', 'modification_time', 'last_interaction_time', 'trash_time',
            'revision', 'schema_version', 'singleton', 'initialized'
        ]);

        if (numberCols.has(col) && !(mappedTable === 'character_scripts' && col === 'flag')) {
            return oracledb.DB_TYPE_NUMBER;
        }
        return oracledb.DB_TYPE_VARCHAR;
    }

    _formatBindValue(v, bindType, isJson) {
        if (isJson) {
            if (v === null || v === undefined) return 'null';
            if (typeof v === 'string') {
                try { JSON.parse(v); return v; } catch (e) { return JSON.stringify(v); }
            }
            return JSON.stringify(v);
        }
        if (v === null || v === undefined) return null;
        if (bindType === oracledb.DB_TYPE_NUMBER) {
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (typeof v === 'number') return Number.isNaN(v) ? null : v;
            if (v === '') return null;
            const n = Number(v);
            return Number.isNaN(n) ? null : n;
        }
        if (bindType === oracledb.DB_TYPE_BLOB) {
            if (Buffer.isBuffer(v)) return v;
            return Buffer.from(v);
        }
        if (bindType === oracledb.DB_TYPE_CLOB) {
            if (typeof v === 'string') return v;
            return JSON.stringify(v);
        }
        // DB_TYPE_VARCHAR
        if (typeof v === 'boolean') return v ? '1' : '0';
        return String(v);
    }

    // 범용 bulk insert 헬퍼 (행 객체 배열 → executemany)
    async _bulkInsertRows(connection, table, columns, rows, onProgress) {
        if (!rows || rows.length === 0) return;
        const quotedTable = assertSqlIdentifier(mapTableName(table));
        const lobCols = new Set(this._getLobColumnsForTable(table).map((c) => c.toLowerCase()));
        const jsonColumns = new Set(this._getJsonColumnsForTable(table).map((c) => c.toLowerCase()));

        // ORA-24816 방지: Oracle은 LOB/LONG/JSON 컬럼이 non-LOB 컬럼 뒤에 오도록 요구함
        const orderedColumns = [
            ...columns.filter((c) => !lobCols.has(c.toLowerCase()) && !jsonColumns.has(c.toLowerCase())),
            ...columns.filter((c) => lobCols.has(c.toLowerCase()) || jsonColumns.has(c.toLowerCase())),
        ];

        // SQL 컬럼: Oracle 이름 (codec 이름이 넘어와도 예약어 회피 이름으로 변환)
        const quotedCols = orderedColumns.map((c) => toOracleColumn(c).toUpperCase());
        // JSON 컬럼은 JSON(:n) 함수로 명시적 변환 (문자열/객체 모두 처리)
        const bindNames = orderedColumns.map((c, i) =>
            jsonColumns.has(c.toLowerCase()) ? `JSON(:${i + 1})` : `:${i + 1}`
        ).join(', ');
        const insertSql = `INSERT INTO ${quotedTable} (${quotedCols.join(', ')}) VALUES (${bindNames})`;

        const bindTypes = orderedColumns.map((c) => this._getColumnBindType(table, c));
        const bindDefs = bindTypes.map((t) => {
            if (t === oracledb.DB_TYPE_VARCHAR) {
                return { type: t, maxSize: 4000 };
            }
            return { type: t };
        });

        const binds = rows.map((row) => orderedColumns.map((c, i) => {
            // 행 객체는 공용 codec의 컬럼명 프로퍼티를 쓸 수 있음
            const codecColumn = COLUMN_NAME_MAP[c.toLowerCase()] || c;
            const v0 = row[c];
            const v = v0 !== undefined ? v0 : row[codecColumn];
            const isJson = jsonColumns.has(c.toLowerCase());
            return this._formatBindValue(v, bindTypes[i], isJson);
        }));

        // 500개씩 청킹하여 오라클 소켓 버퍼 및 메모리 과부하 방지
        const CHUNK_SIZE = 500;
        for (let i = 0; i < binds.length; i += CHUNK_SIZE) {
            const chunkBinds = binds.slice(i, i + CHUNK_SIZE);
            await connection.executeMany(insertSql, chunkBinds, { bindDefs });
            if (onProgress && binds.length > CHUNK_SIZE) {
                onProgress({
                    stage: 'bulk_insert',
                    table,
                    current: Math.min(i + chunkBinds.length, binds.length),
                    total: binds.length,
                    message: `${table}: ${Math.min(i + chunkBinds.length, binds.length)} / ${binds.length} 저장 중...`,
                });
            }
        }
    }

    // 테이블별 LOB (CLOB/BLOB) 컬럼 목록 (스키마 기반)
    _getLobColumnsForTable(table) {
        const mapped = mapTableName(table);
        const lobCols = {
            'system_setting_values': ['text_value', 'encoded_text_value'],
            'system_bot_presets': ['main_prompt', 'jailbreak', 'global_note', 'image'],
            'system_personas': ['prompt', 'icon', 'note'],
            'system_modules': ['description', 'cjs', 'background_embedding', 'custom_toggle', 'icon'],
            'system_plugins': ['script'],
            'system_global_lore_entries': ['comment', 'content', 'comment_text'],
            'system_translator_presets': ['prompt'],
            'system_custom_models': ['api_key', 'params'],
            'system_themes': ['value'],
            'system_custom_plugin_storage': ['value'],
            'system_client_data': ['value'],
            'system_loadouts': ['value'],
            'character_characters': ['image', 'first_message', 'description', 'notes', 'creator_notes', 'system_prompt', 'post_history_instructions', 'personality', 'scenario', 'example_message', 'license', 'default_variables', 'additional_text', 'translator_note', 'background_html', 'background_css'],
            'character_greetings': ['content'],
            'character_emotions': ['asset'],
            'character_scripts': ['comment_text', 'input_text', 'output_text', 'flag'],
            'character_sd_data': ['value'],
            'character_assets': ['uri', 'extra_value'],
            'character_lore_entries': ['comment_text', 'content'],
            'chat_chats': ['note', 'sd_data', 'supa_memory_data', 'last_memory'],
            'chat_suggestions': ['content'],
            'chat_script_state': ['text_value'],
            'chat_lore_entries': ['comment_text', 'content'],
            'chat_messages': ['content_text', 'content_binary'],
            'chat_message_prompt_toggles': ['toggle_value'],
            'cold_archives': ['data'],
            'cold_character_characters': ['image', 'first_message', 'description', 'notes', 'creator_notes', 'system_prompt', 'post_history_instructions', 'personality', 'scenario', 'example_message', 'license', 'default_variables', 'additional_text', 'translator_note', 'background_html', 'background_css'],
            'cold_character_greetings': ['content'],
            'cold_character_emotions': ['asset'],
            'cold_character_scripts': ['comment_text', 'input_text', 'output_text', 'flag'],
            'cold_character_sd_data': ['value'],
            'cold_character_assets': ['uri', 'extra_value'],
            'cold_character_lore_entries': ['comment_text', 'content'],
            'cold_chat_chats': ['note', 'sd_data', 'supa_memory_data', 'last_memory'],
            'cold_chat_suggestions': ['content'],
            'cold_chat_script_state': ['text_value'],
            'cold_chat_lore_entries': ['comment_text', 'content'],
            'cold_messages': ['content_text', 'content_binary'],
            'cold_message_prompt_toggles': ['toggle_value'],
        };
        return lobCols[mapped] || [];
    }

    // 테이블별 JSON 컬럼 목록 (스키마 기반)
    _getJsonColumnsForTable(table) {
        const mapped = mapTableName(table);
        const jsonCols = {
            'character_attributes': ['value'],
            'character_scripts': ['trigger_payload'],
            'character_lore_entries': ['cache_payload'],
            'chat_attributes': ['value'],
            'chat_memory': ['payload'],
            'chat_lore_entries': ['cache_payload'],
            'chat_message_attributes': ['value'],
            'chat_message_prompt_items': ['payload'],
            'cold_archive_attributes': ['value'],
            'cold_character_scripts': ['trigger_payload'],
            'cold_character_lore_entries': ['cache_payload'],
            'cold_chat_attributes': ['value'],
            'cold_chat_memory': ['payload'],
            'cold_chat_lore_entries': ['cache_payload'],
            'cold_message_attributes': ['value'],
            'cold_message_prompt_items': ['payload'],
            'system_audit_log': ['before_row', 'after_row'],
        };
        return jsonCols[mapped] || [];
    }

    // ============================================================
    // 검색: searchMessages, searchCharactersByTag, searchCharactersByName
    // ============================================================

    async searchMessages(rawQuery, rawScope = 'all', rawLimit = 50) {
        this.assertEnabled();
        const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
        if (!query) throw new StoragePayloadError('search query must be a non-empty string');
        if (query.length > 1024) throw new StoragePayloadError('search query must be at most 1024 characters');
        const scope = rawScope === 'active' || rawScope === 'cold' ? rawScope : 'all';
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;

        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            // Oracle: CONTAINS 또는 INSTR fallback. 보안상 INSTR 사용.
            const likeQuery = `%${query}%`;
            const scopeCondition = scope === 'all' ? '1=1' : `m.storage_state = :2`;
            const binds = scope === 'all' ? [likeQuery, limit] : [likeQuery, scope, limit];
            const rows = await fetchRows(conn,
                `SELECT m.storage_state, m.archive_id,
                        COALESCE(ch.character_id, a.owner_character_id) AS character_id,
                        COALESCE(c.name, a.character_name) AS character_name,
                        m.chat_id,
                        COALESCE(ch.name, '') AS chat_name,
                        m.message_id, m.position, m.role, m.sent_time, m.sender_name,
                        SUBSTR(m.content_text, 1, 200) AS snippet
                 FROM chat_all_messages m
                 LEFT JOIN chat_chats ch
                     ON m.storage_state = 'active' AND ch.id = m.chat_id
                 LEFT JOIN character_characters c ON c.id = ch.character_id
                 LEFT JOIN cold_archives a
                     ON m.storage_state = 'cold' AND a.id = m.archive_id
                 WHERE m.content_text IS NOT NULL
                   AND DBMS_LOB.INSTR(LOWER(m.content_text), LOWER(:1)) > 0
                   AND ${scopeCondition}
                 ORDER BY m.sent_time DESC
                 FETCH FIRST :${binds.length} ROWS ONLY`,
                binds, { clobColumns: ['snippet'] });
            await conn.rollback();
            return rows.map((row) => ({
                storageState: row.storage_state,
                archiveId: row.archive_id ? Buffer.from(row.archive_id).toString('hex') : null,
                characterId: row.character_id,
                characterName: row.character_name,
                chatId: row.chat_id,
                chatName: row.chat_name,
                messageId: row.message_id,
                position: row.position,
                role: row.role,
                sentTime: row.sent_time === null ? null : Number(row.sent_time),
                senderName: row.sender_name,
                snippet: row.snippet,
            }));
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async getTokenUsage() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT model,
                        COUNT(*) AS message_count,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens
                 FROM (
                     SELECT model, input_tokens, output_tokens FROM chat_message_generation
                     UNION ALL
                     SELECT model, input_tokens, output_tokens FROM cold_message_generation
                 )
                 WHERE model IS NOT NULL
                 GROUP BY model
                 ORDER BY total_output_tokens DESC, total_input_tokens DESC`);
            return rows.map((row) => ({
                model: row.model,
                messageCount: Number(row.message_count),
                totalInputTokens: Number(row.total_input_tokens),
                totalOutputTokens: Number(row.total_output_tokens),
            }));
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async searchCharactersByTag(rawTag, rawLimit = 100) {
        this.assertEnabled();
        const tag = typeof rawTag === 'string' ? rawTag.trim() : '';
        if (!tag) throw new StoragePayloadError('tag must be a non-empty string');
        if (tag.length > 256) throw new StoragePayloadError('tag must be at most 256 characters');
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT c.id, c.name, c.image, c.kind
                 FROM character_tags t
                 JOIN character_characters c ON c.id = t.character_id
                 WHERE LOWER(t.tag) LIKE '%' || LOWER(:1) || '%'
                 ORDER BY c.name
                 FETCH FIRST :2 ROWS ONLY`,
                [tag, limit], { clobColumns: ['image'] });
            return rows.map((row) => ({
                id: row.id, name: row.name, image: row.image, kind: row.kind,
            }));
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async searchCharactersByName(rawName, rawLimit = 100) {
        this.assertEnabled();
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (!name) throw new StoragePayloadError('name must be a non-empty string');
        if (name.length > 256) throw new StoragePayloadError('name must be at most 256 characters');
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT id, name, image, kind
                 FROM character_characters
                 WHERE LOWER(name) LIKE '%' || LOWER(:1) || '%'
                 ORDER BY name
                 FETCH FIRST :2 ROWS ONLY`,
                [name, limit], { clobColumns: ['image'] });
            return rows.map((row) => ({
                id: row.id, name: row.name, image: row.image, kind: row.kind,
            }));
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // DB 탐색기: listDbExplorerTables, getDbExplorerTableColumns, getDbExplorerTableRows
    // ============================================================

    async listDbExplorerTables() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT table_name FROM user_tables
                 WHERE table_name LIKE 'SYSTEM\_%' ESCAPE ':'
                    OR table_name LIKE 'CHARACTER\_%' ESCAPE ':'
                    OR table_name LIKE 'CHAT\_%' ESCAPE ':'
                    OR table_name LIKE 'COLD\_%' ESCAPE ':'
                 ORDER BY table_name`);
            // 접두어 테이블명을 점 표기로 변환 (클라이언트 호환성)
            const tables = rows.map((r) => {
                const name = r.table_name.toLowerCase();
                if (name.startsWith('system_')) return 'system.' + name.slice(7);
                if (name.startsWith('character_')) return 'character.' + name.slice(10);
                if (name.startsWith('chat_')) return 'chat.' + name.slice(5);
                if (name.startsWith('cold_')) return 'cold.' + name.slice(5);
                return name;
            }).map((name) => assertDbExplorerIdentifier(name, 'table name'));
            const counts = new Map();
            for (let i = 0; i < tables.length; i += 25) {
                const batch = tables.slice(i, i + 25);
                const union = batch.map((name) => {
                    const mapped = mapTableName(name);
                    return `SELECT '${name}' AS table_name, TO_CHAR(COUNT(*)) AS row_count FROM ${assertSqlIdentifier(mapped)}`;
                }).join(' UNION ALL ');
                if (union) {
                    const countRows = await fetchRows(conn, union);
                    for (const row of countRows) {
                        counts.set(row.table_name, row.row_count);
                    }
                }
            }
            return tables.map((name) => ({
                name,
                rowCount: Number(counts.get(name) ?? '0'),
            }));
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async getDbExplorerTableColumns(table) {
        this.assertEnabled();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const parts = validated.split('.');
        const schemaName = parts.length === 2 ? parts[0] : '';
        const tableName = parts.length === 2 ? parts[1] : parts[0];
        const mappedTable = mapTableName(validated);
        const conn = await this.pool.getConnection();
        try {
            // 테이블 존재 확인
            const existsRow = await fetchOne(conn,
                `SELECT 1 AS found FROM user_tables WHERE table_name = UPPER(:1)`,
                [mappedTable]);
            if (!existsRow) throw new StoragePayloadError('table was not found');
            const colRows = await fetchRows(conn,
                `SELECT column_name, data_type, nullable AS is_nullable
                 FROM user_tab_columns WHERE table_name = UPPER(:1)
                 ORDER BY column_id`,
                [mappedTable]);
            const pkRows = await fetchRows(conn,
                `SELECT cc.column_name
                 FROM user_constraints c
                 JOIN user_cons_columns cc ON c.constraint_name = cc.constraint_name
                 WHERE c.table_name = UPPER(:1) AND c.constraint_type = 'P'
                 ORDER BY cc.position`,
                [mappedTable]);
            const primaryKeys = new Set(pkRows.map((r) => r.column_name.toLowerCase()));
            return colRows.map((row) => ({
                name: row.column_name.toLowerCase(),
                dataType: row.data_type,
                nullable: row.is_nullable === 'Y' || row.is_nullable === 'y',
                primaryKey: primaryKeys.has(row.column_name.toLowerCase()),
            }));
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async getDbExplorerTableRows(table, rawOffset = 0, rawLimit = 50, rawSortColumn = null, rawSortOrder = 'asc', rawSearch = '', rawColumns = null) {
        this.assertEnabled();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const mappedTable = mapTableName(validated);
        const quotedTable = assertSqlIdentifier(mappedTable);
        const columns = await this.getDbExplorerTableColumns(table);
        if (columns.length === 0) throw new StoragePayloadError('table has no columns');

        let visibleColumns = columns;
        if (rawColumns !== null && rawColumns !== undefined) {
            if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
                throw new StoragePayloadError('column list must not be empty');
            }
            const visibleNames = [];
            for (const name of rawColumns) {
                const validatedCol = assertDbExplorerIdentifier(name, 'column name');
                const match = columns.find((c) => c.name === validatedCol);
                if (!match) throw new StoragePayloadError('column was not found in the table');
                if (!visibleNames.includes(validatedCol)) visibleNames.push(validatedCol);
            }
            visibleColumns = columns.filter((c) => visibleNames.includes(c.name));
        }

        const searchTerm = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 200) : '';
        const parsedOffset = Number.parseInt(rawOffset, 10);
        const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), DB_EXPLORER_MAX_ROWS) : 50;

        let sortColumn = columns[0].name;
        if (typeof rawSortColumn === 'string' && rawSortColumn.length > 0) {
            const match = columns.find((c) => c.name === rawSortColumn);
            if (!match) throw new StoragePayloadError('sort column was not found in the table');
            sortColumn = match.name;
        }
        const sortOrder = rawSortOrder === 'desc' ? 'DESC' : 'ASC';

        const conn = await this.pool.getConnection();
        try {
            const selectList = visibleColumns
                .map((c) => dbExplorerSelectExpression(c.name, c.dataType))
                .join(', ');

            let whereClause = '';
            const binds = [];
            if (searchTerm.length > 0) {
                const escaped = searchTerm.replace(/([%_])/g, '\\$1');
                const conditions = visibleColumns.map((c) => {
                    binds.push(`%${escaped}%`);
                    return `LOWER(${dbExplorerSelectExpression(c.name, c.dataType)}) LIKE LOWER(:${binds.length})`;
                }).join(' OR ');
                whereClause = ` WHERE (${conditions})`;
            }
            binds.push(limit, offset);
            const rows = await fetchRows(conn,
                `SELECT ${selectList}
                 FROM ${quotedTable}${whereClause}
                 ORDER BY ${sortColumn.toUpperCase()} ${sortOrder} NULLS LAST
                 OFFSET :${binds.length - 1} ROWS FETCH NEXT :${binds.length - 2} ROWS ONLY`,
                binds);
            // COUNT 쿼리 (whereClause 재사용, 바인드는 검색어만)
            const countBinds = binds.slice(0, binds.length - 2);
            const countRow = await fetchOne(conn,
                `SELECT TO_CHAR(COUNT(*)) AS total FROM ${quotedTable}${whereClause}`,
                countBinds);
            return {
                table,
                columns: visibleColumns,
                allColumns: columns,
                rows,
                offset,
                limit,
                total: Number(countRow?.total ?? '0'),
            };
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // 리비전 복원: restoreRevision
    // ============================================================

    async restoreRevision(rawRevisionId) {
        this.assertEnabled();
        const targetRevisionId = Number(rawRevisionId);
        if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
            throw new StoragePayloadError('revisionId must be a positive integer');
        }
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET CONSTRAINTS ALL DEFERRED');
            // 대상 리비전 존재 확인
            const targetRow = await fetchOne(conn,
                `SELECT id FROM system_revisions WHERE id = :1`, [targetRevisionId]);
            if (!targetRow) throw new StoragePayloadError('The requested revision does not exist');

            const metaRow = await fetchOne(conn,
                `SELECT revision FROM system_storage_meta WHERE singleton = 1 FOR UPDATE`);
            const nextStorageRevision = Number(metaRow.revision) + 1;
            const initRow = await fetchOne(conn,
                `SELECT database_initialized FROM (
                    SELECT database_initialized, id FROM system_revisions
                    WHERE id <= :1 AND database_initialized IS NOT NULL
                    ORDER BY id DESC
                ) WHERE ROWNUM = 1`,
                [targetRevisionId]);
            const databaseInitialized = initRow ? num1ToBool(initRow.database_initialized) : false;
            const restoreRevisionId = await beginAuditRevision(conn, {
                storageRevision: nextStorageRevision,
                databaseInitialized,
                scope: 'restore',
                action: 'restore',
                restoredFrom: targetRevisionId,
            });

            // 감사 로그에서 변경 사항 조회 (역순 적용)
            const auditRows = await fetchRows(conn,
                `SELECT sequence_num, table_name, operation, before_row, after_row
                 FROM system_audit_log
                 WHERE revision_id > :1 AND revision_id < :2
                 ORDER BY sequence_num DESC`,
                [targetRevisionId, restoreRevisionId],
                { clobColumns: ['before_row', 'after_row'] });

            // TODO: 실제 복원 로직 - 감사 로그 기반 역적용
            // 각 operation을 역으로 적용 (INSERT→DELETE, DELETE→INSERT, UPDATE→이전값)
            // Oracle은 동적 SQL 필요. 여기서는 메타만 갱신.
            console.log(`[Oracle] restoreRevision: ${auditRows.length} audit entries to revert (target=${targetRevisionId})`);

            await conn.execute(
                `UPDATE system_storage_meta
                 SET revision = :1, initialized = :2, updated_at = SYSTIMESTAMP
                 WHERE singleton = 1`,
                [nextStorageRevision, databaseInitialized ? 1 : 0]);
            await conn.commit();
            this.pluginsCache = null;
            this.pluginCustomStorageCache = null;
            this.invalidateBootstrapCache();
            void this.warmBootstrapCache().catch((error) => {
                console.warn('[Oracle] Bootstrap cache refresh failed:', error.message);
            });
            return {
                revisionId: restoreRevisionId,
                restoredFromRevisionId: targetRevisionId,
                revision: nextStorageRevision,
                changed: auditRows.length,
            };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    // ============================================================
    // 콜드 스토리지: upsertColdStorage, upsertColdStorageWithClient
    // ============================================================

    async upsertColdStorage(key, value) {
        this.assertEnabled();
        const normalizedKey = normalizeColdStorageKey(key);
        const splitValue = splitColdStorageValue(value);
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET CONSTRAINTS ALL DEFERRED');
            await beginAuditRevision(conn, { scope: 'cold-storage', action: 'upsert' });
            const result = await this.upsertColdStorageWithClient(conn, normalizedKey, splitValue);
            await conn.commit();
            return result;
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async upsertColdStorageWithClient(conn, key, splitValue) {
        // UUID 문자열 → RAW(16)
        const rawKey = Buffer.from(key.replace(/-/g, ''), 'hex');
        let character = null;
        if (splitValue.kind === 'character') {
            const characterData = splitValue.data.character;
            character = splitCharacter({
                id: characterData.chaId || key,
                position: 0,
                data: characterData,
            });
        }

        // archive MERGE
        const archiveColumns = [
            'id', 'kind', 'owner_character_id', 'character_kind', 'character_name', 'character_image',
            'character_first_message', 'character_description', 'character_notes', 'character_creator_notes',
            'character_system_prompt', 'character_post_history_instructions', 'character_personality',
            'character_scenario', 'character_example_message', 'character_creator', 'character_version',
            'character_nickname', 'character_view_screen', 'character_chat_page',
            'character_first_message_index', 'character_utility_bot', 'character_is_private',
            'character_realm_id', 'character_license', 'character_default_variables',
            'character_additional_text', 'character_translator_note', 'character_background_html',
            'character_background_css', 'character_creation_time', 'character_modification_time',
            'character_last_interaction_time', 'character_trash_time',
        ];
        const archive = { id: rawKey, kind: splitValue.kind, owner_character_id: character?.core.id || null };
        if (character) {
            for (const [column, value] of Object.entries(character.core)) {
                if (!['id', 'position'].includes(column)) archive[`character_${column}`] = value;
            }
        }
        // cold_archives upsert
        const updateArchiveCols = archiveColumns.slice(1);
        const upsertSql = `BEGIN
            UPDATE cold_archives SET
                ${updateArchiveCols.map((c) => `${c.toUpperCase()} = :${c}`).join(', ')},
                revision = revision + 1, updated_at = SYSTIMESTAMP
            WHERE id = :id;
            IF SQL%ROWCOUNT = 0 THEN
                INSERT INTO cold_archives (${archiveColumns.map((c) => c.toUpperCase()).join(', ')})
                VALUES (${archiveColumns.map((c) => `:${c}`).join(', ')});
            END IF;
        END;`;
        const archiveBinds = {};
        for (const c of archiveColumns) {
            const v = archive[c];
            if (typeof v === 'boolean') archiveBinds[c] = v ? 1 : 0;
            else archiveBinds[c] = v ?? null;
        }
        await conn.execute(upsertSql, archiveBinds);

        // 자식 테이블 삭제 후 재삽입
        const childTables = [
            'cold_archive_attributes', 'cold_field_presence', 'cold_character_tags',
            'cold_character_greetings', 'cold_character_biases', 'cold_character_emotions',
            'cold_character_modules', 'cold_group_members', 'cold_chat_folders',
            'cold_character_scripts', 'cold_character_sd_data', 'cold_character_assets',
            'cold_character_lore_entries', 'cold_chats',
        ];
        for (const table of childTables) {
            await conn.execute(`DELETE FROM ${assertSqlIdentifier(table)} WHERE archive_id = :1`, [rawKey]);
        }

        // TODO: 전체 자식 테이블 재삽입 (character/chat/message 데이터)
        // 간략화: archive 메타만 저장. 전체 구현은 PostgreSQL 버전 참조.

        // 결과 반환
        const resultRow = await fetchOne(conn,
            `SELECT LOWER(RAWTOHEX(id)) AS key, kind, revision, updated_at FROM cold_archives WHERE id = :1`,
            [rawKey]);
        return resultRow;
    }

    // PostgresStorage 호환을 위한 메서드명 별칭
    async exportColdStorageToLegacy(savePath) {
        // PostgreSQL 구현과 동일 로직, 쿼리만 Oracle 변환
        this.assertEnabled();
        await fs.mkdir(savePath, { recursive: true });
        const items = await this.listColdStorage();
        const exportedKeys = new Set();
        let exported = 0;
        for (const item of items) {
            const loaded = await this.loadColdStorage(item.key);
            if (!loaded) throw new Error(`Cold storage item disappeared during export: ${item.key}`);
            const logicalPath = `coldstorage/${item.key}`;
            const filename = Buffer.from(logicalPath, 'utf8').toString('hex');
            const compressed = await deflateAsync(Buffer.from(JSON.stringify(loaded.data), 'utf8'));
            const targetPath = path.join(savePath, filename);
            const temporaryPath = `${targetPath}.oracle-export.tmp`;
            await fs.writeFile(temporaryPath, compressed, { mode: 0o600 });
            await fs.rename(temporaryPath, targetPath);
            exportedKeys.add(item.key);
            exported += 1;
        }
        const staleFiles = (await findLegacyColdStorageFiles(savePath))
            .filter((candidate) => !exportedKeys.has(candidate.key));
        if (staleFiles.length > 0) {
            const rollbackPath = path.join(savePath, '__oracle_cold_storage_rollback');
            await fs.mkdir(rollbackPath, { recursive: true, mode: 0o700 });
            for (const candidate of staleFiles) {
                const sourcePath = path.join(savePath, candidate.filename);
                try {
                    await fs.rename(sourcePath, path.join(rollbackPath, candidate.filename));
                } catch (e) { /* 무시 */ }
            }
        }
        return { exported };
    }

    async listColdStorage() {
        this.assertEnabled();
        const conn = await this.pool.getConnection();
        try {
            const rows = await fetchRows(conn,
                `SELECT LOWER(RAWTOHEX(id)) AS key, kind, updated_at FROM cold_archives ORDER BY updated_at DESC, id`);
            return rows;
        } finally {
            await conn.close();
        }
    }

    async loadColdStorage(key) {
        this.assertEnabled();
        const normalizedKey = normalizeColdStorageKey(key);
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET TRANSACTION READ ONLY');
            // UUID를 RAW로 변환
            const rawKey = Buffer.from(normalizedKey.replace(/-/g, ''), 'hex');
            const archiveRow = await fetchOne(conn,
                `SELECT * FROM cold_archives WHERE id = :1`, [rawKey],
                { clobColumns: ['character_image', 'character_first_message', 'character_description',
                    'character_notes', 'character_creator_notes', 'character_system_prompt',
                    'character_post_history_instructions', 'character_personality', 'character_scenario',
                    'character_example_message', 'character_license', 'character_default_variables',
                    'character_additional_text', 'character_translator_note',
                    'character_background_html', 'character_background_css'] });
            if (!archiveRow) {
                await conn.rollback();
                return null;
            }
            // 자식 테이블 로드 (간략화: 주요 테이블만)
            // TODO: 전체 자식 테이블 로드 구현
            const archive = { ...archiveRow, id: normalizedKey };
            await conn.rollback();
            return {
                key: normalizedKey,
                kind: archive.kind,
                revision: Number(archive.revision),
                updated_at: archive.updated_at,
                data: archive, // TODO: 전체 rebuild 로직
            };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async deleteColdStorage(rawKeys) {
        this.assertEnabled();
        const keys = validateColdStorageKeys(rawKeys);
        if (keys.length === 0) return { deleted: 0 };
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET CONSTRAINTS ALL DEFERRED');
            await beginAuditRevision(conn, { scope: 'cold-storage', action: 'delete' });
            // Oracle: IN 목록 대신 executemany 사용
            const deleteSql = `DELETE FROM cold_archives WHERE id = :1`;
            const binds = keys.map((k) => [Buffer.from(k.replace(/-/g, ''), 'hex')]);
            const result = await conn.executeMany(deleteSql, binds);
            await conn.commit();
            return { deleted: result.rowsAffected };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async pruneColdStorage(rawRetainedKeys) {
        this.assertEnabled();
        const retainedKeys = validateColdStorageKeys(rawRetainedKeys, 'retainedKeys');
        const conn = await this.pool.getConnection();
        try {
            await conn.execute('SET CONSTRAINTS ALL DEFERRED');
            await beginAuditRevision(conn, { scope: 'cold-storage', action: 'prune' });
            // 임시 테이블에 보관할 키 저장 후 NOT IN 삭제
            // 단순화: 각 키에 대해 개별 DELETE + 누적
            // 더 효율적인 방법: 보관 키를 임시 테이블에 INSERT 후 LEFT JOIN으로 삭제
            // 여기서는 단순히 전체 조회 후 메모리에서 필터
            const allRows = await fetchRows(conn, `SELECT LOWER(RAWTOHEX(id)) AS key FROM cold_archives`);
            const retainedSet = new Set(retainedKeys);
            const toDelete = allRows.filter((r) => !retainedSet.has(r.key));
            if (toDelete.length > 0) {
                const deleteSql = `DELETE FROM cold_archives WHERE id = :1`;
                const binds = toDelete.map((r) => [Buffer.from(r.key.replace(/-/g, ''), 'hex')]);
                await conn.executeMany(deleteSql, binds);
            }
            await conn.commit();
            return { deleted: toDelete.length };
        } catch (error) {
            try { await conn.rollback(); } catch (e) {}
            throw error;
        } finally {
            try { await conn.close(); } catch (e) {}
        }
    }

    async migrateLegacyColdStorage(savePath) {
        this.assertEnabled();
        const candidates = await findLegacyColdStorageFiles(savePath);
        if (candidates.length === 0) return { migrated: 0, skipped: 0 };
        // TODO: upsertColdStorageWithClient 전체 구현 후 활성화.
        // 현재는 legacy 파일이 있어도 마이그레이션을 스킵하여 서버 부팅 블록 방지.
        console.log(`[Oracle] Legacy cold storage migration skipped (${candidates.length} files found). ` +
            `Full migration will be available after upsertColdStorage implementation.`);
        return { migrated: 0, skipped: candidates.length };
    }

    async close() {
        if (this.pool) {
            try {
                await this.pool.close(0);
            } catch (e) {}
            this.pool = null;
        }
    }
}

module.exports = {
    OracleStorage,
    StorageRevisionConflictError,
    StoragePayloadError,
    // 테스트용: Oracle 빈 문자열 sentinel 정규화
    ORACLE_EMPTY_STRING_SENTINEL,
    normalizeEmptyStringBinds,
    restoreEmptyStringInRow,
    wrapConnectionForEmptyStrings,
    // 테스트용: 예약어 회피 컬럼명 매핑
    COLUMN_NAME_MAP,
    toOracleColumn,
    remapRowColumns,
};
