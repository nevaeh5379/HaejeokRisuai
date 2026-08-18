const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
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
    splitCharacter,
    splitChat,
    splitMessage,
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

const POSTGRES_SCHEMA_VERSION = 2;
const MAX_SYNC_ROWS = 250000;
const MAX_COLD_STORAGE_KEYS = 250000;
const AUDITED_TABLES = [
    'system.settings', 'system.setting_values', 'character.characters',
    ...SETTING_RELATION_DEFINITIONS.map((definition) => definition.table),
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
const COLD_STORAGE_PATH_PATTERN = /^coldstorage\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COLD_STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);

class PostgresRevisionConflictError extends Error {
    constructor(revision) {
        super('PostgreSQL storage revision conflict');
        this.name = 'PostgresRevisionConflictError';
        this.revision = revision;
    }
}

class PostgresPayloadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PostgresPayloadError';
    }
}

function asArray(value, field) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new PostgresPayloadError(`${field} must be an array`);
    }
    return value;
}

function assertId(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
        throw new PostgresPayloadError(`${field} must be a non-empty string of at most 1024 characters`);
    }
}

function assertPosition(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PostgresPayloadError(`${field} must be a non-negative integer`);
    }
}

function assertDbExplorerIdentifier(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new PostgresPayloadError(`${field} must be a valid table or column name`);
    }
    const parts = value.split('.');
    if (parts.length === 1 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0])) {
        return value;
    }
    if (parts.length === 2 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0]) && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[1])) {
        return value;
    }
    throw new PostgresPayloadError(`${field} must be a valid table or column name`);
}

function dbExplorerSelectExpression(columnName, dataType) {
    const column = `"${columnName}"`;
    switch (dataType) {
        case 'bigint':
        case 'numeric':
        case 'decimal':
            return `${column}::text`;
        case 'bytea':
            return `encode(${column}, 'hex')`;
        default:
            return column;
    }
}

function normalizeColdStorageKey(value, field = 'coldStorageKey') {
    if (typeof value !== 'string' || !COLD_STORAGE_KEY_PATTERN.test(value)) {
        throw new PostgresPayloadError(`${field} must be a UUID`);
    }
    return value.toLowerCase();
}

function validateColdStorageValue(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (!value || typeof value !== 'object') {
        throw new PostgresPayloadError(
            'Cold storage data must be an array or an object containing character or message data'
        );
    }
    if ('character' in value) {
        const character = value.character;
        if (!character || typeof character !== 'object' || Array.isArray(character) ||
            (character.chats !== undefined && !Array.isArray(character.chats))) {
            throw new PostgresPayloadError('Cold storage character data is invalid');
        }
        for (const chat of character.chats || []) {
            if (!chat || typeof chat !== 'object' || Array.isArray(chat) ||
                (chat.message !== undefined && !Array.isArray(chat.message))) {
                throw new PostgresPayloadError('Cold storage character chat data is invalid');
            }
            for (const message of chat.message || []) {
                if (!message || typeof message !== 'object' || Array.isArray(message)) {
                    throw new PostgresPayloadError('Cold storage message data is invalid');
                }
            }
        }
        return value;
    }
    if (!('message' in value) || !Array.isArray(value.message)) {
        throw new PostgresPayloadError(
            'Cold storage data must be an array or an object containing character or message data'
        );
    }
    for (const message of value.message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new PostgresPayloadError('Cold storage message data is invalid');
        }
    }
    return value;
}

function splitColdStorageValue(rawValue) {
    const value = validateColdStorageValue(rawValue);
    if (Array.isArray(value)) {
        return { kind: 'legacy', data: value, chats: [], messages: [], characterFields: [] };
    }

    if ('character' in value) {
        const { chats = [], ...characterData } = value.character;
        const normalizedChats = [];
        const normalizedMessages = [];
        for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
            const { message = [], ...chatData } = chats[chatPosition];
            normalizedChats.push({
                position: chatPosition,
                data: chatData,
                fields: Object.keys(chats[chatPosition]),
            });
            for (let messagePosition = 0; messagePosition < message.length; messagePosition++) {
                normalizedMessages.push({
                    chatPosition,
                    position: messagePosition,
                    data: message[messagePosition],
                    fields: Object.keys(message[messagePosition]),
                });
            }
        }
        return {
            kind: 'character',
            data: { ...value, character: characterData },
            chats: normalizedChats,
            messages: normalizedMessages,
            characterFields: Object.keys(value.character),
        };
    }

    const { message, ...chatData } = value;
    return {
        kind: 'chat',
        data: chatData,
        chats: [{ position: 0, data: {}, fields: Object.keys(value) }],
        messages: message.map((item, position) => ({
            chatPosition: 0,
            position,
            data: item,
            fields: Object.keys(item),
        })),
        characterFields: [],
    };
}

function validateColdStorageKeys(value, field = 'keys') {
    const keys = asArray(value, field);
    if (keys.length > MAX_COLD_STORAGE_KEYS) {
        throw new PostgresPayloadError(`${field} exceeds the ${MAX_COLD_STORAGE_KEYS} key limit`);
    }
    return Array.from(new Set(keys.map((key) => normalizeColdStorageKey(key, `${field}[]`))));
}

async function findLegacyColdStorageFiles(savePath) {
    const entries = await fs.readdir(savePath, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isFile() || !/^(?:[0-9a-f]{2})+$/i.test(entry.name)) {
            continue;
        }
        const logicalPath = Buffer.from(entry.name, 'hex').toString('utf8');
        if (Buffer.from(logicalPath, 'utf8').toString('hex') !== entry.name.toLowerCase()) {
            continue;
        }
        const match = logicalPath.match(COLD_STORAGE_PATH_PATTERN);
        if (match) {
            candidates.push({ filename: entry.name, key: match[1].toLowerCase() });
        }
    }
    return candidates;
}

function assertData(row, field) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'data') || row.data === null ||
        typeof row.data !== 'object' || Array.isArray(row.data)) {
        throw new PostgresPayloadError(`${field} must be a JSON object`);
    }
}

function validateSyncPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new PostgresPayloadError('Sync payload must be an object');
    }
    if (!Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0) {
        throw new PostgresPayloadError('baseRevision must be a non-negative integer');
    }

    let rootUpserts = [];
    let rootDeletes = [];
    if (payload.root !== undefined) {
        if (!payload.root || typeof payload.root !== 'object' || Array.isArray(payload.root)) {
            throw new PostgresPayloadError('root must be an object');
        }
        rootUpserts = asArray(payload.root.upserts, 'root.upserts').map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new PostgresPayloadError(`root.upserts[${index}] must be an object`);
            }
            assertId(item.key, `root.upserts[${index}].key`);
            return { key: item.key, value: item.value };
        });
        rootDeletes = asArray(payload.root.deletes, 'root.deletes').map((key, index) => {
            assertId(key, `root.deletes[${index}]`);
            return key;
        });
    }

    const characters = asArray(payload.characters, 'characters').map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new PostgresPayloadError(`characters[${index}] must be an object`);
        }
        assertId(row.id, `characters[${index}].id`);
        assertPosition(row.position, `characters[${index}].position`);
        assertData(row, `characters[${index}].data`);
        return { id: row.id, position: row.position, data: row.data };
    });

    const chats = asArray(payload.chats, 'chats').map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new PostgresPayloadError(`chats[${index}] must be an object`);
        }
        assertId(row.id, `chats[${index}].id`);
        assertId(row.characterId, `chats[${index}].characterId`);
        assertPosition(row.position, `chats[${index}].position`);
        assertData(row, `chats[${index}].data`);
        return { id: row.id, characterId: row.characterId, position: row.position, data: row.data };
    });

    const messages = asArray(payload.messages, 'messages').map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new PostgresPayloadError(`messages[${index}] must be an object`);
        }
        assertId(row.id, `messages[${index}].id`);
        assertId(row.chatId, `messages[${index}].chatId`);
        assertPosition(row.position, `messages[${index}].position`);
        assertData(row, `messages[${index}].data`);
        return { id: row.id, chatId: row.chatId, position: row.position, data: row.data };
    });

    const chatManifests = asArray(payload.chatManifests, 'chatManifests').map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new PostgresPayloadError(`chatManifests[${index}] must be an object`);
        }
        assertId(item.characterId, `chatManifests[${index}].characterId`);
        const ids = asArray(item.ids, `chatManifests[${index}].ids`).map((id, idIndex) => {
            assertId(id, `chatManifests[${index}].ids[${idIndex}]`);
            return id;
        });
        return { characterId: item.characterId, ids };
    });

    const messageManifests = asArray(payload.messageManifests, 'messageManifests').map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new PostgresPayloadError(`messageManifests[${index}] must be an object`);
        }
        assertId(item.chatId, `messageManifests[${index}].chatId`);
        const ids = asArray(item.ids, `messageManifests[${index}].ids`).map((id, idIndex) => {
            assertId(id, `messageManifests[${index}].ids[${idIndex}]`);
            return id;
        });
        return { chatId: item.chatId, ids };
    });

    const characterIds = payload.characterIds === undefined
        ? undefined
        : asArray(payload.characterIds, 'characterIds').map((id, index) => {
            assertId(id, `characterIds[${index}]`);
            return id;
        });

    return {
        replaceAll: Boolean(payload.replaceAll),
        baseRevision: payload.baseRevision,
        rootUpserts,
        rootDeletes,
        characters,
        chats,
        messages,
        chatManifests,
        messageManifests,
        characterIds,
    };
}

function assertSqlIdentifier(value) {
    if (typeof value !== 'string') {
        throw new Error(`Unsafe SQL identifier: ${value}`);
    }
    const parts = value.split('.');
    if (parts.length === 1 && /^[a-z][a-z0-9_]*$/i.test(parts[0])) {
        return `"${parts[0]}"`;
    }
    if (parts.length === 2 && /^[a-z][a-z0-9_]*$/i.test(parts[0]) && /^[a-z][a-z0-9_]*$/i.test(parts[1])) {
        return `"${parts[0]}"."${parts[1]}"`;
    }
    throw new Error(`Unsafe SQL identifier: ${value}`);
}

async function bulkInsert(client, table, columns, columnTypes, rows, suffix = '') {
    if (rows.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);
    const quotedColumns = columns.map((col) => `"${col}"`);
    const parameters = columns.map((column, columnIndex) => rows.map((row) => {
        const value = row[column];
        if (columnTypes[columnIndex] === 'jsonb') {
            return value === undefined ? null : JSON.stringify(value);
        }
        return value ?? null;
    }));
    const unnest = columns.map((_, index) => `$${index + 1}::${columnTypes[index]}[]`).join(', ');
    await client.query(
        `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')})
         SELECT * FROM UNNEST(${unnest}) AS item(${quotedColumns.join(', ')})
         ${suffix}`,
        parameters
    );
}

function groupRows(rows, key) {
    const grouped = new Map();
    for (const row of rows) {
        const id = row[key];
        const items = grouped.get(id) || [];
        items.push(row);
        grouped.set(id, items);
    }
    return grouped;
}

function groupMessageRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.chat_id}\0${row.message_id}`;
        const items = grouped.get(key) || [];
        items.push(row);
        grouped.set(key, items);
    }
    return grouped;
}

async function beginAuditRevision(client, {
    storageRevision = null,
    databaseInitialized = null,
    scope,
    action,
    restoredFrom = null,
}) {
    const result = await client.query(
        `INSERT INTO system.revisions
            (storage_revision, database_initialized, scope, action, restored_from_revision)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [storageRevision, databaseInitialized, scope, action, restoredFrom]
    );
    const revisionId = Number(result.rows[0].id);
    await client.query(`SELECT set_config('risu.revision_id', $1, TRUE)`, [String(revisionId)]);
    return revisionId;
}

async function deleteMessageChildren(client, pairs, tables = [
    'chat.message_attributes',
    'chat.message_generation',
    'chat.message_prompt_info',
    'chat.message_prompt_toggles',
    'chat.message_prompt_items',
]) {
    if (pairs.length === 0) return;
    const chatIds = pairs.map((row) => row.chatId);
    const messageIds = pairs.map((row) => row.id);
    for (const table of tables) {
        await client.query(
            `DELETE FROM ${assertSqlIdentifier(table)} AS child
             USING UNNEST($1::text[], $2::text[]) AS changed(chat_id, message_id)
             WHERE child.chat_id = changed.chat_id AND child.message_id = changed.message_id`,
            [chatIds, messageIds]
        );
    }
}

class PostgresStorage {
    constructor(options = {}) {
        this.connectionString = options.connectionString || '';
        this.poolMax = Number.parseInt(options.poolMax || '10', 10);
        this.enabled = Boolean(this.connectionString);
        this.pool = null;
    }

    async initialize() {
        if (!this.enabled) {
            console.log('[PostgreSQL] DATABASE_URL is not configured; using legacy file storage.');
            return;
        }

        this.pool = await this.createInitializedPool(this.connectionString, this.poolMax);
        console.log('[PostgreSQL] Structured storage is ready.');
    }

    async createInitializedPool(connectionString, poolMax) {
        const pool = new Pool({
            connectionString,
            max: Number.isSafeInteger(poolMax) && poolMax > 0 ? poolMax : 10,
            application_name: 'risuai-node',
        });
        try {
            await pool.query('SELECT 1');
            const schema = await fs.readFile(path.join(__dirname, 'postgres-schema.sql'), 'utf8');
            await pool.query(schema);
            const result = await pool.query(
                'SELECT schema_version, schema_layout FROM system.storage_meta WHERE singleton = TRUE'
            );
            const schemaVersion = result.rows[0]?.schema_version;
            const schemaLayout = result.rows[0]?.schema_layout;
            if (schemaVersion !== POSTGRES_SCHEMA_VERSION || schemaLayout !== 'relational-schema-v1') {
                throw new Error(
                    `Unsupported PostgreSQL schema ${schemaVersion}/${schemaLayout}; ` +
                    `expected ${POSTGRES_SCHEMA_VERSION}/relational-schema-v1`
                );
            }
            return pool;
        } catch (error) {
            await pool.end().catch(() => {});
            throw error;
        }
    }

    async reconfigure(options = {}) {
        const connectionString = options.connectionString || '';
        const parsedPoolMax = Number.parseInt(options.poolMax || '10', 10);
        const poolMax = Number.isSafeInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : 10;
        if (!connectionString) {
            const previousPool = this.pool;
            this.connectionString = '';
            this.poolMax = poolMax;
            this.pool = null;
            this.enabled = false;
            if (previousPool) {
                await previousPool.end();
            }
            return;
        }

        const nextPool = await this.createInitializedPool(connectionString, poolMax);
        const previousPool = this.pool;
        this.connectionString = connectionString;
        this.poolMax = poolMax;
        this.pool = nextPool;
        this.enabled = true;
        if (previousPool) {
            await previousPool.end();
        }
        console.log('[PostgreSQL] Storage connection was reconfigured.');
    }

    assertEnabled() {
        if (!this.enabled || !this.pool) {
            throw new Error('PostgreSQL storage is not enabled');
        }
    }

    async getState() {
        this.assertEnabled();
        const result = await this.pool.query(
            'SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE'
        );
        return {
            revision: Number(result.rows[0].revision),
            initialized: result.rows[0].initialized,
        };
    }

    async listRevisions(rawLimit = 50) {
        this.assertEnabled();
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;
        const result = await this.pool.query(
            `SELECT revision.id, revision.storage_revision, revision.database_initialized,
                    revision.scope, revision.action, revision.restored_from_revision,
                    revision.created_at, COUNT(audit.sequence)::integer AS change_count
             FROM system.revisions AS revision
             LEFT JOIN system.audit_log AS audit ON audit.revision_id = revision.id
             GROUP BY revision.id
             ORDER BY revision.id DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows.map((row) => ({
            ...row,
            id: Number(row.id),
            storage_revision: row.storage_revision === null ? null : Number(row.storage_revision),
            restored_from_revision: row.restored_from_revision === null
                ? null : Number(row.restored_from_revision),
        }));
    }

    async getRestoreMetadata(client) {
        const result = await client.query(
            `SELECT (namespace.nspname || '.' || class.relname) AS table_name,
                    attribute.attname AS column_name,
                    format_type(attribute.atttypid, attribute.atttypmod) AS column_type,
                    attribute.attnum AS ordinal,
                    attribute.attnotnull AS not_null,
                    EXISTS (
                        SELECT 1
                        FROM pg_index AS idx
                        WHERE idx.indrelid = class.oid
                          AND idx.indisprimary
                          AND attribute.attnum = ANY(idx.indkey::smallint[])
                    ) AS is_primary
             FROM pg_class AS class
             JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
             JOIN pg_attribute AS attribute ON attribute.attrelid = class.oid
             WHERE (namespace.nspname || '.' || class.relname) = ANY($1::text[])
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
             ORDER BY namespace.nspname, class.relname, attribute.attnum`,
            [AUDITED_TABLES]
        );
        const metadata = new Map();
        for (const row of result.rows) {
            const table = metadata.get(row.table_name) || { columns: [], primary: [] };
            table.columns.push({
                name: row.column_name,
                type: row.column_type,
                notNull: row.not_null,
            });
            if (row.is_primary) table.primary.push(row.column_name);
            metadata.set(row.table_name, table);
        }
        return metadata;
    }

    async restoreRevision(rawRevisionId) {
        this.assertEnabled();
        const targetRevisionId = Number(rawRevisionId);
        if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
            throw new PostgresPayloadError('revisionId must be a positive integer');
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET CONSTRAINTS ALL DEFERRED');
            const target = await client.query(
                'SELECT id FROM system.revisions WHERE id = $1 FOR SHARE', [targetRevisionId]
            );
            if (target.rowCount === 0) throw new PostgresPayloadError('The requested revision does not exist');
            const metaResult = await client.query(
                'SELECT revision FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE'
            );
            const nextStorageRevision = Number(metaResult.rows[0].revision) + 1;
            const initializedResult = await client.query(
                `SELECT database_initialized
                 FROM system.revisions
                 WHERE id <= $1 AND database_initialized IS NOT NULL
                 ORDER BY id DESC LIMIT 1`,
                [targetRevisionId]
            );
            const databaseInitialized = initializedResult.rows[0]?.database_initialized ?? false;
            const restoreRevisionId = await beginAuditRevision(client, {
                storageRevision: nextStorageRevision,
                databaseInitialized,
                scope: 'restore',
                action: 'restore',
                restoredFrom: targetRevisionId,
            });
            const auditResult = await client.query(
                `SELECT sequence, table_name, operation, before_row, after_row
                 FROM system.audit_log
                 WHERE revision_id > $1 AND revision_id < $2
                 ORDER BY sequence DESC`,
                [targetRevisionId, restoreRevisionId]
            );
            const metadata = await this.getRestoreMetadata(client);
            for (const event of auditResult.rows) {
                const table = metadata.get(event.table_name);
                if (!table || table.primary.length === 0) {
                    throw new Error(`Cannot restore unknown or keyless audit table: ${event.table_name}`);
                }
                const quotedTable = assertSqlIdentifier(event.table_name);
                if (event.operation === 'INSERT') {
                    const source = event.after_row;
                    const where = table.primary.map((column, index) =>
                        `"${column}" = $${index + 1}`).join(' AND ');
                    await client.query(
                        `DELETE FROM ${quotedTable} WHERE ${where}`,
                        table.primary.map((column) => source[column])
                    );
                    continue;
                }
                const source = event.before_row;
                const columns = table.columns.map((column) => column.name);
                const values = table.columns.map((column) => {
                    const value = source[column.name];
                    if (column.type !== 'jsonb') return value;
                    if (value === null && !column.notNull) return null;
                    return JSON.stringify(value);
                });
                const placeholders = table.columns.map((column, index) =>
                    `$${index + 1}::${column.type}`).join(', ');
                const updateColumns = columns.filter((column) => !table.primary.includes(column));
                const conflictAction = updateColumns.length === 0
                    ? 'DO NOTHING'
                    : `DO UPDATE SET ${updateColumns.map((column) =>
                        `"${column}" = EXCLUDED."${column}"`).join(', ')}`;
                await client.query(
                    `INSERT INTO ${quotedTable} (${columns.map((c) => `"${c}"`).join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT (${table.primary.map((c) => `"${c}"`).join(', ')}) ${conflictAction}`,
                    values
                );
            }
            await client.query(
                `UPDATE system.storage_meta
                 SET revision = $1, initialized = $2, updated_at = NOW()
                 WHERE singleton = TRUE`,
                [nextStorageRevision, databaseInitialized]
            );
            await client.query('COMMIT');
            return {
                revisionId: restoreRevisionId,
                restoredFromRevisionId: targetRevisionId,
                revision: nextStorageRevision,
                changed: auditResult.rowCount,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadColdStorage(key) {
        this.assertEnabled();
        const normalizedKey = normalizeColdStorageKey(key);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const archiveResult = await client.query(
                'SELECT * FROM cold.archives WHERE id = $1::uuid', [normalizedKey]
            );
            const archive = archiveResult.rows[0];
            if (!archive) {
                await client.query('COMMIT');
                return null;
            }
            const tableNames = [
                'cold.archive_attributes', 'cold.field_presence', 'cold.character_tags',
                'cold.character_greetings', 'cold.character_biases',
                'cold.character_emotions', 'cold.character_modules',
                'cold.group_members', 'cold.chat_folders',
                'cold.character_scripts', 'cold.character_sd_data',
                'cold.character_assets', 'cold.character_lore_entries',
                'cold.chats', 'cold.chat_attributes', 'cold.chat_suggestions',
                'cold.chat_modules', 'cold.chat_script_state',
                'cold.chat_bookmarks', 'cold.chat_memory', 'cold.chat_lore_entries',
                'cold.messages', 'cold.message_attributes',
                'cold.message_generation', 'cold.message_prompt_info',
                'cold.message_prompt_toggles', 'cold.message_prompt_items',
            ];
            await client.query(`SELECT set_config('risu.archive_id', $1, TRUE)`, [normalizedKey]);
            const loaded = await client.query(tableNames.map((table) =>
                `SELECT * FROM ${assertSqlIdentifier(table)}
                 WHERE archive_id = current_setting('risu.archive_id')::uuid ORDER BY 1, 2, 3`
            ).join(';\n'));
            const rows = Object.fromEntries(tableNames.map((table, index) => [table, loaded[index].rows]));
            let data;
            if (archive.kind === 'legacy') {
                const legacy = rows['cold.archive_attributes'].find((item) => item.key === 'legacy');
                data = legacy ? decodePostgresJsonValue(legacy.value) : [];
            } else {
                const presence = (entityType, chatPosition, entityPosition) => new Set(
                    rows['cold.field_presence']
                        .filter((item) => item.entity_type === entityType &&
                            item.chat_position === chatPosition && item.entity_position === entityPosition)
                        .map((item) => item.field_name)
                );
                const retainPresentFields = (value, fields) => {
                    if (fields.size === 0) return value;
                    for (const field of Object.keys(value)) if (!fields.has(field)) delete value[field];
                    return value;
                };
                const chatAttributes = groupRows(rows['cold.chat_attributes'], 'chat_position');
                const chatSuggestions = groupRows(rows['cold.chat_suggestions'], 'chat_position');
                const chatModules = groupRows(rows['cold.chat_modules'], 'chat_position');
                const chatScriptState = groupRows(rows['cold.chat_script_state'], 'chat_position');
                const chatBookmarks = groupRows(rows['cold.chat_bookmarks'], 'chat_position');
                const chatMemory = groupRows(rows['cold.chat_memory'], 'chat_position');
                const chatLore = groupRows(rows['cold.chat_lore_entries'], 'chat_position');
                const messagesByPosition = groupRows(rows['cold.messages'], 'chat_position');
                const messageKey = (chatPosition, messagePosition) => `${chatPosition}\0${messagePosition}`;
                const groupColdMessages = (items) => new Map(items.reduce((entries, item) => {
                    const key = messageKey(item.chat_position, item.message_position);
                    const value = entries.find(([candidate]) => candidate === key);
                    if (value) value[1].push(item); else entries.push([key, [item]]);
                    return entries;
                }, []));
                const messageAttributes = groupColdMessages(rows['cold.message_attributes']);
                const messageGenerations = new Map(rows['cold.message_generation'].map((item) => [messageKey(item.chat_position, item.message_position), item]));
                const messagePromptInfos = new Map(rows['cold.message_prompt_info'].map((item) => [messageKey(item.chat_position, item.message_position), item]));
                const messagePromptToggles = groupColdMessages(rows['cold.message_prompt_toggles']);
                const messagePromptItems = groupColdMessages(rows['cold.message_prompt_items']);
                const rebuiltChats = rows['cold.chats'].map((chatRow) => {
                    const messages = (messagesByPosition.get(chatRow.position) || []).map((messageRow) => {
                        const relationKey = messageKey(messageRow.chat_position, messageRow.position);
                        return retainPresentFields(rebuildMessage({ ...messageRow, id: messageRow.original_message_id || `cold-message-${messageRow.position}` }, {
                            attributes: messageAttributes.get(relationKey),
                            generation: messageGenerations.get(relationKey),
                            promptInfo: messagePromptInfos.get(relationKey),
                            promptToggles: messagePromptToggles.get(relationKey),
                            promptItems: messagePromptItems.get(relationKey),
                        }), presence('message', messageRow.chat_position, messageRow.position));
                    });
                    return retainPresentFields(rebuildChat({ ...chatRow, id: chatRow.original_chat_id || `cold-chat-${chatRow.position}` }, {
                        attributes: chatAttributes.get(chatRow.position),
                        suggestions: chatSuggestions.get(chatRow.position),
                        modules: chatModules.get(chatRow.position),
                        scriptState: chatScriptState.get(chatRow.position),
                        bookmarks: chatBookmarks.get(chatRow.position),
                        memory: chatMemory.get(chatRow.position),
                        lore: chatLore.get(chatRow.position),
                        messages,
                    }), presence('chat', chatRow.position, -1));
                });
                if (archive.kind === 'chat') {
                    const chat = rebuiltChats[0] || { message: [] };
                    data = chat;
                } else {
                    const characterRow = { id: archive.owner_character_id || normalizedKey };
                    for (const [key, value] of Object.entries(archive)) {
                        if (key.startsWith('character_')) characterRow[key.slice('character_'.length)] = value;
                    }
                    characterRow.kind = archive.character_kind || 'character';
                    data = { character: retainPresentFields(rebuildCharacter(characterRow, {
                        attributes: rows['cold.archive_attributes'].filter((item) => item.key !== 'legacy'),
                        tags: rows['cold.character_tags'],
                        greetings: rows['cold.character_greetings'],
                        biases: rows['cold.character_biases'],
                        emotions: rows['cold.character_emotions'],
                        modules: rows['cold.character_modules'],
                        groupMembers: rows['cold.group_members'],
                        chatFolders: rows['cold.chat_folders'],
                        scripts: rows['cold.character_scripts'],
                        sdData: rows['cold.character_sd_data'],
                        assets: rows['cold.character_assets'],
                        lore: rows['cold.character_lore_entries'],
                        chats: rebuiltChats,
                    }), presence('character', -1, -1)) };
                }
            }
            await client.query('COMMIT');
            return { key: normalizedKey, kind: archive.kind, revision: Number(archive.revision), updated_at: archive.updated_at, data };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async listColdStorage() {
        this.assertEnabled();
        const result = await this.pool.query(
            `SELECT id::text AS key, kind, updated_at
             FROM cold.archives
             ORDER BY updated_at DESC, id`
        );
        return result.rows;
    }

    async upsertColdStorage(key, value) {
        this.assertEnabled();
        const normalizedKey = normalizeColdStorageKey(key);
        const splitValue = splitColdStorageValue(value);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await beginAuditRevision(client, { scope: 'cold-storage', action: 'upsert' });
            const result = await this.upsertColdStorageWithClient(client, normalizedKey, splitValue);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async upsertColdStorageWithClient(client, key, splitValue) {
        let character = null;
        if (splitValue.kind === 'character') {
            const characterData = splitValue.data.character;
            character = splitCharacter({
                id: characterData.chaId || key,
                position: 0,
                data: characterData,
            });
        }
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
        const archive = { id: key, kind: splitValue.kind, owner_character_id: character?.core.id || null };
        if (character) {
            for (const [column, value] of Object.entries(character.core)) {
                if (!['id', 'position'].includes(column)) archive[`character_${column}`] = value;
            }
        }
        await bulkInsert(
            client, 'cold.archives', archiveColumns,
            ['uuid', 'text', ...Array(17).fill('text'), 'integer', 'integer', 'boolean', 'boolean',
                ...Array(7).fill('text'), 'bigint', 'bigint', 'bigint', 'bigint'],
            [archive],
            `ON CONFLICT (id) DO UPDATE SET ${archiveColumns.slice(1).map((column) =>
                `"${column}" = EXCLUDED."${column}"`).join(', ')},
                revision = cold.archives.revision + 1, updated_at = NOW()`
        );

        const childTables = [
            'cold.archive_attributes', 'cold.field_presence', 'cold.character_tags',
            'cold.character_greetings', 'cold.character_biases',
            'cold.character_emotions', 'cold.character_modules', 'cold.group_members',
            'cold.chat_folders', 'cold.character_scripts', 'cold.character_sd_data',
            'cold.character_assets', 'cold.character_lore_entries', 'cold.chats',
        ];
        for (const table of childTables) {
            await client.query(`DELETE FROM ${assertSqlIdentifier(table)} WHERE archive_id = $1::uuid`, [key]);
        }

        let archiveAttributes = [];
        if (splitValue.kind === 'legacy') {
            archiveAttributes = [{ archive_id: key, key: 'legacy', value: encodePostgresJsonValue(splitValue.data) }];
        } else if (character) {
            archiveAttributes = character.attributes.map((item) => ({ ...item, archive_id: key }));
        }
        await bulkInsert(client, 'cold.archive_attributes', ['archive_id', 'key', 'value'], ['uuid', 'text', 'jsonb'], archiveAttributes);
        const presenceRows = [
            ...(splitValue.characterFields || []).map((fieldName) => ({
                archive_id: key, entity_type: 'character', chat_position: -1,
                entity_position: -1, field_name: fieldName,
            })),
            ...splitValue.chats.flatMap((chat) => (chat.fields || []).map((fieldName) => ({
                archive_id: key, entity_type: 'chat', chat_position: chat.position,
                entity_position: -1, field_name: fieldName,
            }))),
            ...splitValue.messages.flatMap((message) => (message.fields || []).map((fieldName) => ({
                archive_id: key, entity_type: 'message', chat_position: message.chatPosition,
                entity_position: message.position, field_name: fieldName,
            }))),
        ];
        await bulkInsert(client, 'cold.field_presence',
            ['archive_id', 'entity_type', 'chat_position', 'entity_position', 'field_name'],
            ['uuid', 'text', 'integer', 'integer', 'text'], presenceRows);
        const mapCharacterRows = (name) => (character?.[name] || []).map((item) => {
            const mapped = { ...item, archive_id: key };
            delete mapped.character_id;
            delete mapped.group_id;
            return mapped;
        });
        await bulkInsert(client, 'cold.character_tags', ['archive_id', 'position', 'tag'], ['uuid', 'integer', 'text'], mapCharacterRows('tags'));
        await bulkInsert(client, 'cold.character_greetings', ['archive_id', 'greeting_type', 'position', 'content'], ['uuid', 'text', 'integer', 'text'], mapCharacterRows('greetings'));
        await bulkInsert(client, 'cold.character_biases', ['archive_id', 'position', 'phrase', 'bias'], ['uuid', 'integer', 'text', 'double precision'], mapCharacterRows('biases'));
        await bulkInsert(client, 'cold.character_emotions', ['archive_id', 'position', 'emotion', 'asset'], ['uuid', 'integer', 'text', 'text'], mapCharacterRows('emotions'));
        await bulkInsert(client, 'cold.character_modules', ['archive_id', 'position', 'module_id'], ['uuid', 'integer', 'text'], mapCharacterRows('modules'));
        await bulkInsert(client, 'cold.group_members', ['archive_id', 'position', 'character_id', 'talk_weight', 'active'], ['uuid', 'integer', 'text', 'double precision', 'boolean'], mapCharacterRows('groupMembers'));
        await bulkInsert(client, 'cold.chat_folders', ['archive_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['uuid', 'integer', 'text', 'text', 'text', 'boolean'], mapCharacterRows('chatFolders'));
        await bulkInsert(client, 'cold.character_scripts', ['archive_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['uuid', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'jsonb'], mapCharacterRows('scripts'));
        await bulkInsert(client, 'cold.character_sd_data', ['archive_id', 'position', 'key', 'value'], ['uuid', 'integer', 'text', 'text'], mapCharacterRows('sdData'));
        await bulkInsert(client, 'cold.character_assets', ['archive_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['uuid', 'integer', 'text', 'text', 'text', 'text', 'text', 'text'], mapCharacterRows('assets'));
        await bulkInsert(client, 'cold.character_lore_entries', ['archive_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['uuid', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], mapCharacterRows('lore'));

        const chatInputs = splitValue.kind === 'chat'
            ? [{ position: 0, data: splitValue.data }]
            : splitValue.chats;
        const splitChats = chatInputs.map((chat) => splitChat({
            id: chat.data.id || `cold-chat-${chat.position}`,
            characterId: character?.core.id || '',
            position: chat.position,
            data: chat.data,
        }));
        const coldChats = splitChats.map((item, index) => ({
            archive_id: key,
            position: item.core.position,
            original_chat_id: chatInputs[index].data.id ?? null,
            name: item.core.name,
            note: item.core.note,
            sd_data: item.core.sd_data,
            supa_memory_data: item.core.supa_memory_data,
            last_memory: item.core.last_memory,
            is_streaming: item.core.is_streaming,
            streaming_optimization_mode: item.core.streaming_optimization_mode,
            bound_persona_id: item.core.bound_persona_id,
            first_message_index: item.core.first_message_index,
            folder_id: item.core.folder_id,
            last_message_time: item.core.last_message_time,
        }));
        await bulkInsert(client, 'cold.chats', ['archive_id', 'position', 'original_chat_id', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'], ['uuid', 'integer', 'text', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'integer', 'text', 'bigint'], coldChats);
        const mapChatRows = (name) => splitChats.flatMap((item) => item[name].map((row) => {
            const mapped = { ...row, archive_id: key, chat_position: item.core.position };
            delete mapped.chat_id;
            return mapped;
        }));
        await bulkInsert(client, 'cold.chat_attributes', ['archive_id', 'chat_position', 'key', 'value'], ['uuid', 'integer', 'text', 'jsonb'], splitChats.flatMap((item) => item.attributes.map((row) => ({ ...row, archive_id: key, chat_position: item.core.position }))));
        await bulkInsert(client, 'cold.chat_suggestions', ['archive_id', 'chat_position', 'position', 'content'], ['uuid', 'integer', 'integer', 'text'], mapChatRows('suggestions'));
        await bulkInsert(client, 'cold.chat_modules', ['archive_id', 'chat_position', 'position', 'module_id'], ['uuid', 'integer', 'integer', 'text'], mapChatRows('modules'));
        await bulkInsert(client, 'cold.chat_script_state', ['archive_id', 'chat_position', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['uuid', 'integer', 'text', 'text', 'text', 'double precision', 'boolean'], mapChatRows('scriptState'));
        await bulkInsert(client, 'cold.chat_bookmarks', ['archive_id', 'chat_position', 'position', 'message_id', 'name'], ['uuid', 'integer', 'integer', 'text', 'text'], mapChatRows('bookmarks'));
        await bulkInsert(client, 'cold.chat_memory', ['archive_id', 'chat_position', 'memory_type', 'payload'], ['uuid', 'integer', 'text', 'jsonb'], mapChatRows('memory'));
        await bulkInsert(client, 'cold.chat_lore_entries', ['archive_id', 'chat_position', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['uuid', 'integer', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], mapChatRows('lore'));

        const splitMessages = splitValue.messages.map((message) => splitMessage({
            id: message.data.chatId || `cold-message-${message.position}`,
            chatId: `cold-chat-${message.chatPosition}`,
            position: message.position,
            data: message.data,
        }));
        const coldMessages = splitMessages.map((item, index) => ({
            archive_id: key,
            chat_position: splitValue.messages[index].chatPosition,
            position: item.core.position,
            original_message_id: splitValue.messages[index].data.chatId ?? null,
            role: item.core.role,
            content_text: item.core.content_text,
            content_binary: item.core.content_binary,
            saying_character_id: item.core.saying_character_id,
            sent_time: item.core.sent_time,
            sender_name: item.core.sender_name,
            other_user: item.core.other_user,
            disabled_scope: item.core.disabled_scope,
            is_comment: item.core.is_comment,
        }));
        await bulkInsert(client, 'cold.messages', ['archive_id', 'chat_position', 'position', 'original_message_id', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'], ['uuid', 'integer', 'integer', 'text', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'], coldMessages);
        const messageOwner = (item, index) => ({ archive_id: key, chat_position: splitValue.messages[index].chatPosition, message_position: item.core.position });
        await bulkInsert(client, 'cold.message_attributes', ['archive_id', 'chat_position', 'message_position', 'key', 'value'], ['uuid', 'integer', 'integer', 'text', 'jsonb'], splitMessages.flatMap((item, index) => item.attributes.map((row) => ({ ...row, ...messageOwner(item, index) }))));
        await bulkInsert(client, 'cold.message_generation', ['archive_id', 'chat_position', 'message_position', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['uuid', 'integer', 'integer', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'], splitMessages.flatMap((item, index) => item.generation ? [{ ...item.generation, ...messageOwner(item, index) }] : []));
        await bulkInsert(client, 'cold.message_prompt_info', ['archive_id', 'chat_position', 'message_position', 'prompt_name'], ['uuid', 'integer', 'integer', 'text'], splitMessages.flatMap((item, index) => item.prompt ? [{ ...item.prompt.info, ...messageOwner(item, index) }] : []));
        await bulkInsert(client, 'cold.message_prompt_toggles', ['archive_id', 'chat_position', 'message_position', 'position', 'toggle_key', 'toggle_value'], ['uuid', 'integer', 'integer', 'integer', 'text', 'text'], splitMessages.flatMap((item, index) => (item.prompt?.toggles || []).map((row) => ({ ...row, ...messageOwner(item, index) }))));
        await bulkInsert(client, 'cold.message_prompt_items', ['archive_id', 'chat_position', 'message_position', 'position', 'payload'], ['uuid', 'integer', 'integer', 'integer', 'jsonb'], splitMessages.flatMap((item, index) => (item.prompt?.items || []).map((row) => ({ ...row, ...messageOwner(item, index) }))));
        const archiveResult = await client.query(
            'SELECT id::text AS key, kind, revision, updated_at FROM cold.archives WHERE id = $1::uuid',
            [key]
        );
        return archiveResult.rows[0];
    }

    async deleteColdStorage(rawKeys) {
        this.assertEnabled();
        const keys = validateColdStorageKeys(rawKeys);
        if (keys.length === 0) {
            return { deleted: 0 };
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await beginAuditRevision(client, { scope: 'cold-storage', action: 'delete' });
            const result = await client.query(
                'DELETE FROM cold.archives WHERE id = ANY($1::uuid[])', [keys]
            );
            await client.query('COMMIT');
            return { deleted: result.rowCount };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async pruneColdStorage(rawRetainedKeys) {
        this.assertEnabled();
        const retainedKeys = validateColdStorageKeys(rawRetainedKeys, 'retainedKeys');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await beginAuditRevision(client, { scope: 'cold-storage', action: 'prune' });
            const result = await client.query(
                'DELETE FROM cold.archives WHERE NOT (id = ANY($1::uuid[]))', [retainedKeys]
            );
            await client.query('COMMIT');
            return { deleted: result.rowCount };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async migrateLegacyColdStorage(savePath) {
        this.assertEnabled();
        const candidates = await findLegacyColdStorageFiles(savePath);
        if (candidates.length === 0) {
            return { migrated: 0, skipped: 0 };
        }

        const importedResult = await this.pool.query(
            'SELECT id::text AS key FROM cold.legacy_imports WHERE id = ANY($1::uuid[])',
            [candidates.map((candidate) => candidate.key)]
        );
        const imported = new Set(importedResult.rows.map((row) => row.key));
        const pending = candidates.filter((candidate) => !imported.has(candidate.key));
        if (pending.length === 0) {
            return { migrated: 0, skipped: 0 };
        }

        const client = await this.pool.connect();
        let migrated = 0;
        let skipped = 0;
        try {
            await client.query('BEGIN');
            await beginAuditRevision(client, { scope: 'cold-storage', action: 'legacy-import' });
            for (const candidate of pending) {
                await client.query('SAVEPOINT cold_storage_item');
                try {
                    const compressed = await fs.readFile(path.join(savePath, candidate.filename));
                    const decoded = JSON.parse((await unzipAsync(compressed)).toString('utf8'));
                    const splitValue = splitColdStorageValue(decoded);
                    const existing = await client.query(
                        'SELECT 1 FROM cold.archives WHERE id = $1::uuid',
                        [candidate.key]
                    );
                    if (existing.rowCount === 0) {
                        await this.upsertColdStorageWithClient(client, candidate.key, splitValue);
                    }
                    await client.query(
                        `INSERT INTO cold.legacy_imports (id)
                         VALUES ($1::uuid)
                         ON CONFLICT (id) DO NOTHING`,
                        [candidate.key]
                    );
                    await client.query('RELEASE SAVEPOINT cold_storage_item');
                    migrated += 1;
                } catch (error) {
                    await client.query('ROLLBACK TO SAVEPOINT cold_storage_item');
                    await client.query('RELEASE SAVEPOINT cold_storage_item');
                    skipped += 1;
                    console.error(
                        `[PostgreSQL] Could not migrate legacy cold storage ${candidate.key}:`,
                        error.message
                    );
                }
            }
            await client.query('COMMIT');
            return { migrated, skipped };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async exportColdStorageToLegacy(savePath) {
        this.assertEnabled();
        await fs.mkdir(savePath, { recursive: true });
        const items = await this.listColdStorage();
        const exportedKeys = new Set();
        let exported = 0;
        for (const item of items) {
            const loaded = await this.loadColdStorage(item.key);
            if (!loaded) {
                throw new Error(`Cold storage item disappeared during export: ${item.key}`);
            }
            const logicalPath = `coldstorage/${item.key}`;
            const filename = Buffer.from(logicalPath, 'utf8').toString('hex');
            const compressed = await deflateAsync(Buffer.from(JSON.stringify(loaded.data), 'utf8'));
            const targetPath = path.join(savePath, filename);
            const temporaryPath = `${targetPath}.postgres-export.tmp`;
            await fs.writeFile(temporaryPath, compressed, { mode: 0o600 });
            await fs.rename(temporaryPath, targetPath);
            exportedKeys.add(item.key);
            exported += 1;
        }

        const staleFiles = (await findLegacyColdStorageFiles(savePath))
            .filter((candidate) => !exportedKeys.has(candidate.key));
        if (staleFiles.length > 0) {
            const rollbackPath = path.join(savePath, '__postgres_cold_storage_rollback');
            await fs.mkdir(rollbackPath, { recursive: true, mode: 0o700 });
            const suffix = `${Date.now()}-${process.pid}`;
            for (let index = 0; index < staleFiles.length; index++) {
                const candidate = staleFiles[index];
                await fs.rename(
                    path.join(savePath, candidate.filename),
                    path.join(rollbackPath, `${candidate.filename}.${suffix}-${index}`)
                );
            }
        }
        return { exported, archived: staleFiles.length };
    }

    async loadDatabase(options = {}) {
        const shallow = Boolean(options.shallow);
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const metaResult = await client.query(
                'SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE'
            );
            const revision = Number(metaResult.rows[0].revision);
            const initialized = metaResult.rows[0].initialized;
            if (!initialized) {
                await client.query('COMMIT');
                return { revision, initialized, database: null };
            }

            if (shallow) {
                const shallowQueries = [
                    "SELECT * FROM system.settings WHERE key NOT IN ('plugins', 'pluginCustomStorage') ORDER BY key",
                    "SELECT * FROM system.setting_values WHERE setting_key NOT IN ('plugins', 'pluginCustomStorage') ORDER BY setting_key, node_id",
                    'SELECT * FROM character.characters ORDER BY position, id',
                    'SELECT * FROM character.tags ORDER BY character_id, position',
                    'SELECT * FROM character.group_members ORDER BY group_id, position',
                    'SELECT * FROM character.chat_folders ORDER BY character_id, position',
                    'SELECT * FROM chat.chats ORDER BY character_id, position, id',
                    'SELECT * FROM chat.bookmarks ORDER BY chat_id, position',
                ];
                const results = await client.query(shallowQueries.join(';\n'));
                const [
                    settings, settingValues, characters, tags, groupMembers, chatFolders, chats, bookmarks
                ] = results.map((result) => result.rows);

                const database = rebuildSettings(settings, settingValues);
                database.plugins ??= [];
                database.pluginCustomStorage ??= {};

                const characterRelations = {
                    tags: groupRows(tags, 'character_id'),
                    groupMembers: groupRows(groupMembers, 'group_id'),
                    chatFolders: groupRows(chatFolders, 'character_id'),
                };
                const chatRelations = {
                    bookmarks: groupRows(bookmarks, 'chat_id'),
                };

                const chatsByCharacter = new Map();
                for (const row of chats) {
                    const related = {
                        bookmarks: chatRelations.bookmarks.get(row.id) || [],
                        messages: [],
                    };
                    const rebuilt = rebuildChat(row, related, { shallow: true });
                    rebuilt.messagesLoaded = false;
                    rebuilt.detailsLoaded = false;
                    const items = chatsByCharacter.get(row.character_id) || [];
                    items.push(rebuilt);
                    chatsByCharacter.set(row.character_id, items);
                }

                database.characters = characters.map((row) => {
                    const related = {
                        tags: characterRelations.tags.get(row.id) || [],
                        groupMembers: characterRelations.groupMembers.get(row.id) || [],
                        chatFolders: characterRelations.chatFolders.get(row.id) || [],
                        chats: chatsByCharacter.get(row.id) || [],
                    };
                    const rebuilt = rebuildCharacter(row, related, { shallow: true });
                    rebuilt.detailsLoaded = false;
                    return rebuilt;
                });

                await client.query('COMMIT');
                return { revision, initialized, database };
            }

            const loadQueries = [
                'SELECT * FROM system.settings ORDER BY key',
                'SELECT * FROM system.setting_values ORDER BY setting_key, node_id',
                'SELECT * FROM character.characters ORDER BY position, id',
                'SELECT * FROM character.attributes ORDER BY character_id, key',
                'SELECT * FROM character.tags ORDER BY character_id, position',
                'SELECT * FROM character.greetings ORDER BY character_id, greeting_type, position',
                'SELECT * FROM character.biases ORDER BY character_id, position',
                'SELECT * FROM character.emotions ORDER BY character_id, position',
                'SELECT * FROM character.modules ORDER BY character_id, position',
                'SELECT * FROM character.group_members ORDER BY group_id, position',
                'SELECT * FROM character.chat_folders ORDER BY character_id, position',
                'SELECT * FROM character.scripts ORDER BY character_id, script_kind, position',
                'SELECT * FROM character.sd_data ORDER BY character_id, position',
                'SELECT * FROM character.assets ORDER BY character_id, position',
                'SELECT * FROM character.lore_entries ORDER BY character_id, position',
                'SELECT * FROM chat.chats ORDER BY character_id, position, id',
                'SELECT * FROM chat.attributes ORDER BY chat_id, key',
                'SELECT * FROM chat.suggestions ORDER BY chat_id, position',
                'SELECT * FROM chat.modules ORDER BY chat_id, position',
                'SELECT * FROM chat.script_state ORDER BY chat_id, key',
                'SELECT * FROM chat.bookmarks ORDER BY chat_id, position',
                'SELECT * FROM chat.memory ORDER BY chat_id, memory_type',
                'SELECT * FROM chat.lore_entries ORDER BY chat_id, position',
                'SELECT * FROM chat.messages ORDER BY chat_id, position, id',
                'SELECT * FROM chat.message_attributes ORDER BY chat_id, message_id, key',
                'SELECT * FROM chat.message_generation',
                'SELECT * FROM chat.message_prompt_info',
                'SELECT * FROM chat.message_prompt_toggles ORDER BY chat_id, message_id, position',
                'SELECT * FROM chat.message_prompt_items ORDER BY chat_id, message_id, position'
            ];

            const results = await client.query(loadQueries.join(';\n'));
            const rows = results.map((result) => result.rows);
            const [
                settings, settingValues, characters, characterAttributes, tags, greetings, biases, emotions,
                characterModules, groupMembers, chatFolders, scripts, sdData, assets, characterLore,
                chats, chatAttributes, suggestions, chatModules, scriptState, bookmarks, memory,
                chatLore, messages, messageAttributes, generations, promptInfos, promptToggles, promptItems
            ] = rows;

            const database = rebuildSettings(settings, settingValues);

            const characterRelations = {
                attributes: groupRows(characterAttributes, 'character_id'),
                tags: groupRows(tags, 'character_id'),
                greetings: groupRows(greetings, 'character_id'),
                biases: groupRows(biases, 'character_id'),
                emotions: groupRows(emotions, 'character_id'),
                modules: groupRows(characterModules, 'character_id'),
                groupMembers: groupRows(groupMembers, 'group_id'),
                chatFolders: groupRows(chatFolders, 'character_id'),
                scripts: groupRows(scripts, 'character_id'),
                sdData: groupRows(sdData, 'character_id'),
                assets: groupRows(assets, 'character_id'),
                lore: groupRows(characterLore, 'character_id'),
            };
            const chatRelations = {
                attributes: groupRows(chatAttributes, 'chat_id'),
                suggestions: groupRows(suggestions, 'chat_id'),
                modules: groupRows(chatModules, 'chat_id'),
                scriptState: groupRows(scriptState, 'chat_id'),
                bookmarks: groupRows(bookmarks, 'chat_id'),
                memory: groupRows(memory, 'chat_id'),
                lore: groupRows(chatLore, 'chat_id'),
            };

            const messageRelations = {
                attributes: groupMessageRows(messageAttributes),
                generation: new Map(generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptInfo: new Map(promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptToggles: groupMessageRows(promptToggles),
                promptItems: groupMessageRows(promptItems),
            };
            const messagesByChat = new Map();
            for (const row of messages) {
                const key = `${row.chat_id}\0${row.id}`;
                const related = {
                    attributes: messageRelations.attributes.get(key),
                    generation: messageRelations.generation.get(key),
                    promptInfo: messageRelations.promptInfo.get(key),
                    promptToggles: messageRelations.promptToggles.get(key),
                    promptItems: messageRelations.promptItems.get(key),
                };
                const items = messagesByChat.get(row.chat_id) || [];
                items.push(rebuildMessage(row, related));
                messagesByChat.set(row.chat_id, items);
            }

            const chatsByCharacter = new Map();
            for (const row of chats) {
                const related = { messages: messagesByChat.get(row.id) || [] };
                for (const [name, grouped] of Object.entries(chatRelations)) related[name] = grouped.get(row.id) || [];
                const rebuilt = rebuildChat(row, related);
                rebuilt.messagesLoaded = true;
                rebuilt.detailsLoaded = true;
                const items = chatsByCharacter.get(row.character_id) || [];
                items.push(rebuilt);
                chatsByCharacter.set(row.character_id, items);
            }

            database.characters = characters.map((row) => {
                const related = { chats: chatsByCharacter.get(row.id) || [] };
                for (const [name, grouped] of Object.entries(characterRelations)) related[name] = grouped.get(row.id) || [];
                const rebuilt = rebuildCharacter(row, related);
                rebuilt.detailsLoaded = true;
                return rebuilt;
            });

            await client.query('COMMIT');
            return { revision, initialized, database };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadCharacter(characterId) {
        this.assertEnabled();
        assertId(characterId, 'characterId');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const queries = [
                'SELECT * FROM character.characters WHERE id = $1',
                'SELECT * FROM character.attributes WHERE character_id = $1 ORDER BY key',
                'SELECT * FROM character.tags WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.greetings WHERE character_id = $1 ORDER BY greeting_type, position',
                'SELECT * FROM character.biases WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.emotions WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.modules WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.group_members WHERE group_id = $1 ORDER BY position',
                'SELECT * FROM character.chat_folders WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.scripts WHERE character_id = $1 ORDER BY script_kind, position',
                'SELECT * FROM character.sd_data WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.assets WHERE character_id = $1 ORDER BY position',
                'SELECT * FROM character.lore_entries WHERE character_id = $1 ORDER BY position',
            ];
            const results = await Promise.all(queries.map((q) => client.query(q, [characterId])));
            const [
                charRes, attributesRes, tagsRes, greetingsRes, biasesRes, emotionsRes,
                modulesRes, groupMembersRes, chatFoldersRes, scriptsRes, sdDataRes,
                assetsRes, loreRes
            ] = results;

            if (charRes.rows.length === 0) {
                await client.query('COMMIT');
                return null;
            }

            const characterRelations = {
                attributes: attributesRes.rows,
                tags: tagsRes.rows,
                greetings: greetingsRes.rows,
                biases: biasesRes.rows,
                emotions: emotionsRes.rows,
                modules: modulesRes.rows,
                groupMembers: groupMembersRes.rows,
                chatFolders: chatFoldersRes.rows,
                scripts: scriptsRes.rows,
                sdData: sdDataRes.rows,
                assets: assetsRes.rows,
                lore: loreRes.rows,
            };

            const character = rebuildCharacter(charRes.rows[0], characterRelations);
            character.detailsLoaded = true;

            await client.query('COMMIT');
            return character;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadChat(chatId) {
        this.assertEnabled();
        assertId(chatId, 'chatId');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const queries = [
                'SELECT * FROM chat.chats WHERE id = $1',
                'SELECT * FROM chat.attributes WHERE chat_id = $1 ORDER BY key',
                'SELECT * FROM chat.suggestions WHERE chat_id = $1 ORDER BY position',
                'SELECT * FROM chat.modules WHERE chat_id = $1 ORDER BY position',
                'SELECT * FROM chat.script_state WHERE chat_id = $1 ORDER BY key',
                'SELECT * FROM chat.bookmarks WHERE chat_id = $1 ORDER BY position',
                'SELECT * FROM chat.memory WHERE chat_id = $1 ORDER BY memory_type',
                'SELECT * FROM chat.lore_entries WHERE chat_id = $1 ORDER BY position',
                'SELECT * FROM chat.messages WHERE chat_id = $1 ORDER BY position, id',
                'SELECT * FROM chat.message_attributes WHERE chat_id = $1 ORDER BY chat_id, message_id, key',
                'SELECT * FROM chat.message_generation WHERE chat_id = $1',
                'SELECT * FROM chat.message_prompt_info WHERE chat_id = $1',
                'SELECT * FROM chat.message_prompt_toggles WHERE chat_id = $1 ORDER BY chat_id, message_id, position',
                'SELECT * FROM chat.message_prompt_items WHERE chat_id = $1 ORDER BY chat_id, message_id, position',
            ];
            const [
                chatRes, attributesRes, suggestionsRes, modulesRes, scriptStateRes,
                bookmarksRes, memoryRes, loreRes, messagesRes, messageAttributesRes,
                generationsRes, promptInfosRes, promptTogglesRes, promptItemsRes
            ] = await Promise.all(queries.map((q) => client.query(q, [chatId])));

            if (chatRes.rows.length === 0) {
                await client.query('COMMIT');
                return null;
            }

            const messageRelations = {
                attributes: groupMessageRows(messageAttributesRes.rows),
                generation: new Map(generationsRes.rows.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptInfo: new Map(promptInfosRes.rows.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptToggles: groupMessageRows(promptTogglesRes.rows),
                promptItems: groupMessageRows(promptItemsRes.rows),
            };

            const messages = [];
            for (const row of messagesRes.rows) {
                const key = `${row.chat_id}\0${row.id}`;
                const related = {
                    attributes: messageRelations.attributes.get(key),
                    generation: messageRelations.generation.get(key),
                    promptInfo: messageRelations.promptInfo.get(key),
                    promptToggles: messageRelations.promptToggles.get(key),
                    promptItems: messageRelations.promptItems.get(key),
                };
                messages.push(rebuildMessage(row, related));
            }

            const chatRelations = {
                attributes: attributesRes.rows,
                suggestions: suggestionsRes.rows,
                modules: modulesRes.rows,
                scriptState: scriptStateRes.rows,
                bookmarks: bookmarksRes.rows,
                memory: memoryRes.rows,
                lore: loreRes.rows,
                messages,
            };

            const chat = rebuildChat(chatRes.rows[0], chatRelations);
            chat.messagesLoaded = true;
            chat.detailsLoaded = true;

            await client.query('COMMIT');
            return chat;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadChatMessages(chatId) {
        const chat = await this.loadChat(chatId);
        return chat ? chat.message : [];
    }

    async loadPlugins() {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const queries = [
                "SELECT * FROM system.settings WHERE key = 'plugins' ORDER BY key",
                "SELECT * FROM system.setting_values WHERE setting_key = 'plugins' ORDER BY setting_key, node_id",
            ];
            const results = await client.query(queries.join(';\n'));
            const [settings, settingValues] = results.map((result) => result.rows);
            const rebuilt = rebuildSettings(settings, settingValues);
            await client.query('COMMIT');

            const plugins = rebuilt.plugins || [];
            const serialized = JSON.stringify(plugins);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');

            return {
                plugins,
                hash,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadPluginCustomStorage() {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const queries = [
                "SELECT * FROM system.settings WHERE key = 'pluginCustomStorage' ORDER BY key",
                "SELECT * FROM system.setting_values WHERE setting_key = 'pluginCustomStorage' ORDER BY setting_key, node_id",
            ];
            const results = await client.query(queries.join(';\n'));
            const [settings, settingValues] = results.map((result) => result.rows);
            const rebuilt = rebuildSettings(settings, settingValues);
            await client.query('COMMIT');

            const pluginCustomStorage = rebuilt.pluginCustomStorage || {};
            const serialized = JSON.stringify(pluginCustomStorage);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');

            return {
                pluginCustomStorage,
                hash,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async listPluginCustomStorageKeys() {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const result = await client.query(
                `SELECT node_id, member_key, encoded_member_key, position
                 FROM system.setting_values
                 WHERE setting_key = 'pluginCustomStorage' AND parent_node_id = 0
                 ORDER BY node_id`
            );
            await client.query('COMMIT');
            const keys = result.rows.map((row) => decodeMember(row)).filter((key) => key !== null && key !== undefined);
            return keys;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadPluginCustomStorageKey(storageKey) {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const encoded = encodeMember(storageKey, null);
            const query = `
                WITH RECURSIVE key_tree AS (
                    SELECT node_id, parent_node_id, member_key, encoded_member_key, position,
                           value_type, text_value, encoded_text_value, number_value, boolean_value
                    FROM system.setting_values
                    WHERE setting_key = 'pluginCustomStorage'
                      AND parent_node_id = 0
                      AND ((member_key IS NOT NULL AND member_key = $1)
                           OR (encoded_member_key IS NOT NULL AND encoded_member_key = $2))
                    UNION ALL
                    SELECT v.node_id, v.parent_node_id, v.member_key, v.encoded_member_key, v.position,
                           v.value_type, v.text_value, v.encoded_text_value, v.number_value, v.boolean_value
                    FROM system.setting_values v
                    INNER JOIN key_tree kt ON v.parent_node_id = kt.node_id
                    WHERE v.setting_key = 'pluginCustomStorage'
                )
                SELECT * FROM key_tree ORDER BY node_id;
            `;
            const result = await client.query(query, [encoded.member_key, encoded.encoded_member_key]);
            await client.query('COMMIT');

            if (result.rows.length === 0) {
                return {
                    key: storageKey,
                    exists: false,
                    value: null,
                    hash: 'null',
                };
            }

            const rootNodeId = Number(result.rows[0].node_id);
            const value = rebuildSettingSubtree(rootNodeId, result.rows);
            const serialized = JSON.stringify(value);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');

            return {
                key: storageKey,
                exists: true,
                value,
                hash,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadPluginsData() {
        const [pluginsResult, storageResult] = await Promise.all([
            this.loadPlugins(),
            this.loadPluginCustomStorage(),
        ]);
        return {
            plugins: pluginsResult.plugins,
            pluginCustomStorage: storageResult.pluginCustomStorage,
            hash: `${pluginsResult.hash}:${storageResult.hash}`,
        };
    }

    async sync(rawPayload) {
        this.assertEnabled();
        const payload = validateSyncPayload(rawPayload);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const metaResult = await client.query(
                'SELECT revision FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE'
            );
            const currentRevision = Number(metaResult.rows[0].revision);
            if (payload.baseRevision !== currentRevision) {
                throw new PostgresRevisionConflictError(currentRevision);
            }

            const nextRevision = currentRevision + 1;
            await beginAuditRevision(client, {
                storageRevision: nextRevision,
                databaseInitialized: true,
                scope: 'database',
                action: payload.replaceAll ? 'replace-all' : 'sync',
            });

            if (payload.replaceAll) {
                await client.query('DELETE FROM system.settings');
                await client.query('DELETE FROM character.characters');
            }

            let splitSettings;
            try {
                splitSettings = payload.rootUpserts.map((row) => splitSetting(row.key, row.value, {
                    maxRows: MAX_SYNC_ROWS,
                    maxDepth: 128,
                }));
            } catch (error) {
                throw new PostgresPayloadError(
                    error instanceof Error ? error.message : 'PostgreSQL setting decomposition failed'
                );
            }
            const settingValueCount = splitSettings.reduce(
                (count, setting) => count + setting.values.length,
                0
            );
            if (settingValueCount > MAX_SYNC_ROWS) {
                throw new PostgresPayloadError(
                    `Structured settings exceed the ${MAX_SYNC_ROWS} row limit`
                );
            }
            await bulkInsert(
                client,
                'system.settings',
                ['key'],
                ['text'],
                splitSettings.map((item) => item.setting),
                'ON CONFLICT (key) DO UPDATE SET updated_at = NOW()'
            );
            const changedSettingKeys = splitSettings.map((item) => item.setting.key);
            if (changedSettingKeys.length > 0) {
                await client.query(
                    'DELETE FROM system.setting_values WHERE setting_key = ANY($1::text[])',
                    [changedSettingKeys]
                );
            }
            await bulkInsert(
                client,
                'system.setting_values',
                [
                    'setting_key', 'node_id', 'parent_node_id', 'member_key', 'encoded_member_key',
                    'position', 'value_type', 'text_value', 'encoded_text_value', 'number_value',
                    'boolean_value',
                ],
                [
                    'text', 'bigint', 'bigint', 'text', 'text', 'integer', 'text', 'text', 'text',
                    'double precision', 'boolean',
                ],
                splitSettings.flatMap((item) => item.values)
            );
            const projectedSettings = projectSettings(payload.rootUpserts);
            if (changedSettingKeys.length > 0) {
                const changedSettingKeySet = new Set(changedSettingKeys);
                for (const definition of SETTING_RELATION_DEFINITIONS) {
                    const projectedKeys = definition.settingKeys.filter((key) =>
                        changedSettingKeySet.has(key));
                    if (projectedKeys.length === 0) continue;
                    await client.query(
                        `DELETE FROM ${assertSqlIdentifier(definition.table)}
                         WHERE setting_key = ANY($1::text[])`,
                        [projectedKeys]
                    );
                }
            }
            for (const definition of SETTING_RELATION_DEFINITIONS) {
                await bulkInsert(
                    client,
                    definition.table,
                    definition.columns,
                    definition.types,
                    projectedSettings[definition.table]
                );
            }
            if (payload.rootDeletes.length > 0) {
                await client.query('DELETE FROM system.settings WHERE key = ANY($1::text[])', [payload.rootDeletes]);
            }

            const splitCharacters = payload.characters.map(splitCharacter);
            const characterColumns = [
                'id', 'position', 'kind', 'name', 'image', 'first_message', 'description', 'notes',
                'creator_notes', 'system_prompt', 'post_history_instructions', 'personality', 'scenario',
                'example_message', 'creator', 'character_version', 'nickname', 'view_screen', 'chat_page',
                'first_message_index', 'utility_bot', 'is_private', 'realm_id', 'license',
                'default_variables', 'additional_text', 'translator_note', 'background_html',
                'background_css', 'creation_time', 'modification_time', 'last_interaction_time', 'trash_time',
            ];
            await bulkInsert(
                client, 'character.characters', characterColumns,
                ['text', 'integer', 'text', ...Array(15).fill('text'), 'integer', 'integer', 'boolean', 'boolean',
                    'text', 'text', 'text', 'text', 'text', 'text', 'text', 'bigint', 'bigint', 'bigint', 'bigint'],
                splitCharacters.map((item) => item.core),
                `ON CONFLICT (id) DO UPDATE SET ${characterColumns.slice(1).map((column) =>
                    `"${column}" = EXCLUDED."${column}"`).join(', ')}, updated_at = NOW()`
            );
            const changedCharacterIds = payload.characters.map((row) => row.id);
            const characterChildTables = [
                'character.attributes', 'character.tags', 'character.greetings',
                'character.biases', 'character.emotions', 'character.modules',
                'character.group_members', 'character.chat_folders', 'character.scripts',
                'character.sd_data', 'character.assets', 'character.lore_entries',
            ];
            if (changedCharacterIds.length > 0) {
                for (const table of characterChildTables) {
                    const ownerColumn = table === 'character.group_members' ? 'group_id' : 'character_id';
                    await client.query(
                        `DELETE FROM ${assertSqlIdentifier(table)} WHERE "${ownerColumn}" = ANY($1::text[])`,
                        [changedCharacterIds]
                    );
                }
            }
            const characterRows = (name) => splitCharacters.flatMap((item) => item[name]);
            await bulkInsert(client, 'character.attributes', ['character_id', 'key', 'value'], ['text', 'text', 'jsonb'],
                splitCharacters.flatMap((item) => item.attributes.map((row) => ({ ...row, character_id: item.core.id }))));
            await bulkInsert(client, 'character.tags', ['character_id', 'position', 'tag'], ['text', 'integer', 'text'], characterRows('tags'));
            await bulkInsert(client, 'character.greetings', ['character_id', 'greeting_type', 'position', 'content'], ['text', 'text', 'integer', 'text'], characterRows('greetings'));
            await bulkInsert(client, 'character.biases', ['character_id', 'position', 'phrase', 'bias'], ['text', 'integer', 'text', 'double precision'], characterRows('biases'));
            await bulkInsert(client, 'character.emotions', ['character_id', 'position', 'emotion', 'asset'], ['text', 'integer', 'text', 'text'], characterRows('emotions'));
            await bulkInsert(client, 'character.modules', ['character_id', 'position', 'module_id'], ['text', 'integer', 'text'], characterRows('modules'));
            await bulkInsert(client, 'character.group_members', ['group_id', 'position', 'character_id', 'talk_weight', 'active'], ['text', 'integer', 'text', 'double precision', 'boolean'], characterRows('groupMembers'));
            await bulkInsert(client, 'character.chat_folders', ['character_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['text', 'integer', 'text', 'text', 'text', 'boolean'], characterRows('chatFolders'));
            await bulkInsert(client, 'character.scripts', ['character_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'jsonb'], characterRows('scripts'));
            await bulkInsert(client, 'character.sd_data', ['character_id', 'position', 'key', 'value'], ['text', 'integer', 'text', 'text'], characterRows('sdData'));
            await bulkInsert(client, 'character.assets', ['character_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['text', 'integer', 'text', 'text', 'text', 'text', 'text', 'text'], characterRows('assets'));
            await bulkInsert(client, 'character.lore_entries', ['character_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], characterRows('lore'));

            const splitChats = payload.chats.map(splitChat);
            const chatColumns = ['id', 'character_id', 'position', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'];
            await bulkInsert(client, 'chat.chats', chatColumns,
                ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'integer', 'text', 'bigint'],
                splitChats.map((item) => item.core),
                `ON CONFLICT (id) DO UPDATE SET ${chatColumns.slice(1).map((column) =>
                    `"${column}" = EXCLUDED."${column}"`).join(', ')}, updated_at = NOW()`);
            const changedChatIds = payload.chats.map((row) => row.id);
            const chatChildTables = ['chat.attributes', 'chat.suggestions', 'chat.modules', 'chat.script_state', 'chat.bookmarks', 'chat.memory', 'chat.lore_entries'];
            if (changedChatIds.length > 0) {
                for (const table of chatChildTables) await client.query(`DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = ANY($1::text[])`, [changedChatIds]);
            }
            const chatRows = (name) => splitChats.flatMap((item) => item[name]);
            await bulkInsert(client, 'chat.attributes', ['chat_id', 'key', 'value'], ['text', 'text', 'jsonb'], splitChats.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.id }))));
            await bulkInsert(client, 'chat.suggestions', ['chat_id', 'position', 'content'], ['text', 'integer', 'text'], chatRows('suggestions'));
            await bulkInsert(client, 'chat.modules', ['chat_id', 'position', 'module_id'], ['text', 'integer', 'text'], chatRows('modules'));
            await bulkInsert(client, 'chat.script_state', ['chat_id', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['text', 'text', 'text', 'text', 'double precision', 'boolean'], chatRows('scriptState'));
            await bulkInsert(client, 'chat.bookmarks', ['chat_id', 'position', 'message_id', 'name'], ['text', 'integer', 'text', 'text'], chatRows('bookmarks'));
            await bulkInsert(client, 'chat.memory', ['chat_id', 'memory_type', 'payload'], ['text', 'text', 'jsonb'], chatRows('memory'));
            await bulkInsert(client, 'chat.lore_entries', ['chat_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], chatRows('lore'));

            const splitMessages = payload.messages.map(splitMessage);
            const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
            await bulkInsert(client, 'chat.messages', messageColumns,
                ['text', 'text', 'integer', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'],
                splitMessages.map((item) => item.core),
                `ON CONFLICT (chat_id, id) DO UPDATE SET ${messageColumns.slice(2).map((column) =>
                    `"${column}" = EXCLUDED."${column}"`).join(', ')}, updated_at = NOW()`);
            await deleteMessageChildren(client, payload.messages);
            await bulkInsert(client, 'chat.message_attributes', ['chat_id', 'message_id', 'key', 'value'], ['text', 'text', 'text', 'jsonb'], splitMessages.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.chat_id, message_id: item.core.id }))));
            await bulkInsert(client, 'chat.message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['text', 'text', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'], splitMessages.flatMap((item) => item.generation ? [item.generation] : []));
            await bulkInsert(client, 'chat.message_prompt_info', ['chat_id', 'message_id', 'prompt_name'], ['text', 'text', 'text'], splitMessages.flatMap((item) => item.prompt ? [item.prompt.info] : []));
            await bulkInsert(client, 'chat.message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'], ['text', 'text', 'integer', 'text', 'text'], splitMessages.flatMap((item) => item.prompt?.toggles || []));
            await bulkInsert(client, 'chat.message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'], ['text', 'text', 'integer', 'jsonb'], splitMessages.flatMap((item) => item.prompt?.items || []));

            if (payload.characterIds !== undefined) {
                await client.query(
                    'DELETE FROM character.characters WHERE NOT (id = ANY($1::text[]))',
                    [payload.characterIds]
                );
            }
            for (const manifest of payload.chatManifests) {
                await client.query(
                    `DELETE FROM chat.chats
                     WHERE character_id = $1 AND NOT (id = ANY($2::text[]))`,
                    [manifest.characterId, manifest.ids]
                );
            }
            for (const manifest of payload.messageManifests) {
                await client.query(
                    `DELETE FROM chat.messages
                     WHERE chat_id = $1 AND NOT (id = ANY($2::text[]))`,
                    [manifest.chatId, manifest.ids]
                );
            }

            await client.query(
                `UPDATE system.storage_meta
                 SET revision = $1, initialized = TRUE, updated_at = NOW()
                 WHERE singleton = TRUE`,
                [nextRevision]
            );
            await client.query('COMMIT');
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
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async searchMessages(rawQuery, rawScope = 'all', rawLimit = 50) {
        this.assertEnabled();
        const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
        if (!query) {
            throw new PostgresPayloadError('search query must be a non-empty string');
        }
        if (query.length > 1024) {
            throw new PostgresPayloadError('search query must be at most 1024 characters');
        }
        const scope = rawScope === 'active' || rawScope === 'cold' ? rawScope : 'all';
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;

        const result = await this.pool.query(
            `SELECT
                 m.storage_state,
                 m.archive_id,
                 COALESCE(ch.character_id, a.owner_character_id) AS character_id,
                 COALESCE(c.name, a.character_name) AS character_name,
                 m.chat_id,
                 COALESCE(ch.name, '') AS chat_name,
                 m.message_id,
                 m.position,
                 m.role,
                 m.sent_time,
                 m.sender_name,
                 ts_headline('simple', m.content_text, websearch_to_tsquery('simple', $1),
                     'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=12') AS snippet
             FROM chat.all_messages AS m
             LEFT JOIN chat.chats AS ch
                 ON m.storage_state = 'active' AND ch.id = m.chat_id
             LEFT JOIN character.characters AS c ON c.id = ch.character_id
             LEFT JOIN cold.archives AS a
                 ON m.storage_state = 'cold' AND a.id = m.archive_id
             WHERE m.content_text IS NOT NULL
               AND to_tsvector('simple', m.content_text) @@ websearch_to_tsquery('simple', $1)
               AND ($2::text = 'all' OR m.storage_state = $2)
             ORDER BY ts_rank(to_tsvector('simple', m.content_text), websearch_to_tsquery('simple', $1)) DESC,
                      m.sent_time DESC
             LIMIT $3`,
            [query, scope, limit]
        );
        return result.rows.map((row) => ({
            storageState: row.storage_state,
            archiveId: row.archive_id,
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
    }

    async getTokenUsage() {
        this.assertEnabled();
        const result = await this.pool.query(
            `SELECT model,
                    COUNT(*)::integer AS message_count,
                    COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
                    COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens
             FROM (
                 SELECT model, input_tokens, output_tokens FROM chat.message_generation
                 UNION ALL
                 SELECT model, input_tokens, output_tokens FROM cold.message_generation
             ) AS generation
             WHERE model IS NOT NULL
             GROUP BY model
             ORDER BY total_output_tokens DESC, total_input_tokens DESC`
        );
        return result.rows.map((row) => ({
            model: row.model,
            messageCount: row.message_count,
            totalInputTokens: Number(row.total_input_tokens),
            totalOutputTokens: Number(row.total_output_tokens),
        }));
    }

    async searchCharactersByTag(rawTag, rawLimit = 100) {
        this.assertEnabled();
        const tag = typeof rawTag === 'string' ? rawTag.trim() : '';
        if (!tag) {
            throw new PostgresPayloadError('tag must be a non-empty string');
        }
        if (tag.length > 256) {
            throw new PostgresPayloadError('tag must be at most 256 characters');
        }
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
        const result = await this.pool.query(
            `SELECT c.id, c.name, c.image, c.kind
             FROM character.tags AS t
             JOIN character.characters AS c ON c.id = t.character_id
             WHERE t.tag ILIKE '%' || $1 || '%'
             ORDER BY c.name
             LIMIT $2`,
            [tag, limit]
        );
        return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            image: row.image,
            kind: row.kind,
        }));
    }

    async searchCharactersByName(rawName, rawLimit = 100) {
        this.assertEnabled();
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (!name) {
            throw new PostgresPayloadError('name must be a non-empty string');
        }
        if (name.length > 256) {
            throw new PostgresPayloadError('name must be at most 256 characters');
        }
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
        const result = await this.pool.query(
            `SELECT id, name, image, kind
             FROM character.characters
             WHERE LOWER(name) LIKE '%' || LOWER($1) || '%'
             ORDER BY name
             LIMIT $2`,
            [name, limit]
        );
        return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            image: row.image,
            kind: row.kind,
        }));
    }

    async listDbExplorerTables() {
        this.assertEnabled();
        const result = await this.pool.query(
            `SELECT (table_schema || '.' || table_name) AS table_name
             FROM information_schema.tables
             WHERE table_schema IN ('system', 'character', 'chat', 'cold') AND table_type = 'BASE TABLE'
             ORDER BY table_schema, table_name`
        );
        const tables = result.rows.map((row) => assertDbExplorerIdentifier(row.table_name, 'table name'));
        const counts = new Map();
        for (let i = 0; i < tables.length; i += 25) {
            const union = tables.slice(i, i + 25).map(
                (name) => `SELECT '${name}' AS table_name, COUNT(*)::text AS row_count FROM ${assertSqlIdentifier(name)}`
            ).join(' UNION ALL ');
            const countResult = await this.pool.query(union);
            for (const row of countResult.rows) {
                counts.set(row.table_name, row.row_count);
            }
        }
        return tables.map((name) => ({
            name,
            rowCount: Number(counts.get(name) ?? '0'),
        }));
    }

    async getDbExplorerTableColumns(table) {
        this.assertEnabled();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const parts = validated.split('.');
        const schemaName = parts.length === 2 ? parts[0] : 'public';
        const tableName = parts.length === 2 ? parts[1] : parts[0];

        const exists = await this.pool.query(
            `SELECT 1
             FROM information_schema.tables
             WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name = $2`,
            [schemaName, tableName]
        );
        if (exists.rows.length === 0) {
            throw new PostgresPayloadError('table was not found');
        }
        const columns = await this.pool.query(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schemaName, tableName]
        );
        const primaryKeyResult = await this.pool.query(
            `SELECT a.attname AS column_name
             FROM pg_index AS i
             JOIN pg_class AS c ON c.oid = i.indrelid
             JOIN pg_namespace AS n ON n.oid = c.relnamespace
             JOIN pg_attribute AS a
                 ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
             WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
            [schemaName, tableName]
        );
        const primaryKeys = new Set(primaryKeyResult.rows.map((row) => row.column_name));
        return columns.rows.map((row) => ({
            name: assertDbExplorerIdentifier(row.column_name, 'column name'),
            dataType: row.data_type,
            nullable: row.is_nullable === 'YES',
            primaryKey: primaryKeys.has(row.column_name),
        }));
    }

    async getDbExplorerTableRows(table, rawOffset = 0, rawLimit = 50, rawSortColumn = null, rawSortOrder = 'asc', rawSearch = '', rawColumns = null) {
        this.assertEnabled();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const quotedTable = assertSqlIdentifier(validated);
        const columns = await this.getDbExplorerTableColumns(table);
        if (columns.length === 0) {
            throw new PostgresPayloadError('table has no columns');
        }

        let visibleColumns = columns;
        if (rawColumns !== null && rawColumns !== undefined) {
            if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
                throw new PostgresPayloadError('column list must not be empty');
            }
            const visibleNames = [];
            for (const name of rawColumns) {
                const validatedCol = assertDbExplorerIdentifier(name, 'column name');
                const match = columns.find((column) => column.name === validatedCol);
                if (!match) {
                    throw new PostgresPayloadError('column was not found in the table');
                }
                if (!visibleNames.includes(validatedCol)) {
                    visibleNames.push(validatedCol);
                }
            }
            visibleColumns = columns.filter((column) => visibleNames.includes(column.name));
        }

        const searchTerm = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 200) : '';
        const parsedOffset = Number.parseInt(rawOffset, 10);
        const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), DB_EXPLORER_MAX_ROWS) : 50;

        let sortColumn = columns[0].name;
        if (typeof rawSortColumn === 'string' && rawSortColumn.length > 0) {
            const match = columns.find((column) => column.name === rawSortColumn);
            if (!match) {
                throw new PostgresPayloadError('sort column was not found in the table');
            }
            sortColumn = match.name;
        }
        const sortOrder = rawSortOrder === 'desc' ? 'DESC' : 'ASC';

        const selectList = visibleColumns
            .map((column) => dbExplorerSelectExpression(column.name, column.dataType))
            .join(', ');

        const searchTerms = [];
        let whereClause = '';
        if (searchTerm.length > 0) {
            const escaped = searchTerm.replace(/([%_\\])/g, '\\$1');
            const conditions = visibleColumns
                .map((column) => `("${column.name}")::text ILIKE $1`)
                .join(' OR ');
            whereClause = ` WHERE (${conditions})`;
            searchTerms.push(`%${escaped}%`);
        }
        const rowParams = [...searchTerms, limit, offset];
        const rows = await this.pool.query(
            `SELECT ${selectList}
             FROM ${quotedTable}${whereClause}
             ORDER BY "${sortColumn}" ${sortOrder} NULLS LAST
             LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
            rowParams
        );
        const count = await this.pool.query(
            `SELECT COUNT(*)::text AS total FROM ${quotedTable}${whereClause}`,
            searchTerms
        );
        return {
            table,
            columns: visibleColumns,
            allColumns: columns,
            rows: rows.rows,
            offset,
            limit,
            total: Number(count.rows[0].total),
        };
    }
}

module.exports = {
    PostgresPayloadError,
    PostgresRevisionConflictError,
    PostgresStorage,
    decodePostgresJsonValue,
    encodePostgresJsonValue,
    normalizeColdStorageKey,
    validateColdStorageKeys,
    validateColdStorageValue,
    validateSyncPayload,
};
