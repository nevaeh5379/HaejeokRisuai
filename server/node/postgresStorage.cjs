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
    rebuildSettings,
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
    'risu_settings', 'risu_setting_values', 'risu_characters',
    ...SETTING_RELATION_DEFINITIONS.map((definition) => definition.table),
    'risu_character_attributes', 'risu_character_tags',
    'risu_character_greetings', 'risu_character_biases', 'risu_character_emotions',
    'risu_character_modules', 'risu_group_members', 'risu_chat_folders',
    'risu_character_scripts', 'risu_character_sd_data', 'risu_character_assets',
    'risu_character_lore_entries', 'risu_chats', 'risu_chat_attributes',
    'risu_chat_suggestions', 'risu_chat_modules', 'risu_chat_script_state',
    'risu_chat_bookmarks', 'risu_chat_memory', 'risu_chat_lore_entries', 'risu_messages',
    'risu_message_attributes', 'risu_message_generation', 'risu_message_prompt_info',
    'risu_message_prompt_toggles', 'risu_message_prompt_items', 'risu_cold_archives',
    'risu_cold_archive_attributes', 'risu_cold_field_presence', 'risu_cold_character_tags',
    'risu_cold_character_greetings', 'risu_cold_character_biases',
    'risu_cold_character_emotions', 'risu_cold_character_modules', 'risu_cold_group_members',
    'risu_cold_chat_folders', 'risu_cold_character_scripts', 'risu_cold_character_sd_data',
    'risu_cold_character_assets', 'risu_cold_character_lore_entries', 'risu_cold_chats',
    'risu_cold_chat_attributes', 'risu_cold_chat_suggestions', 'risu_cold_chat_modules',
    'risu_cold_chat_script_state', 'risu_cold_chat_bookmarks', 'risu_cold_chat_memory',
    'risu_cold_chat_lore_entries', 'risu_cold_messages', 'risu_cold_message_attributes',
    'risu_cold_message_generation', 'risu_cold_message_prompt_info',
    'risu_cold_message_prompt_toggles', 'risu_cold_message_prompt_items',
];
const COLD_STORAGE_PATH_PATTERN = /^coldstorage\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COLD_STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
        throw new PostgresPayloadError('Request body must be an object');
    }
    if (!Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0) {
        throw new PostgresPayloadError('baseRevision must be a non-negative integer');
    }

    const rootUpserts = asArray(payload.root?.upserts, 'root.upserts');
    const rootDeletes = asArray(payload.root?.deletes, 'root.deletes');
    const characters = asArray(payload.characters, 'characters');
    const chats = asArray(payload.chats, 'chats');
    const messages = asArray(payload.messages, 'messages');
    const chatManifests = asArray(payload.chatManifests, 'chatManifests');
    const messageManifests = asArray(payload.messageManifests, 'messageManifests');

    const characterIds = payload.characterIds === undefined
        ? undefined
        : asArray(payload.characterIds, 'characterIds');
    const manifestIdCount = chatManifests.reduce(
        (count, manifest) => count + (Array.isArray(manifest?.ids) ? manifest.ids.length : 0),
        0
    ) + messageManifests.reduce(
        (count, manifest) => count + (Array.isArray(manifest?.ids) ? manifest.ids.length : 0),
        0
    );
    const rowCount = rootUpserts.length + rootDeletes.length + characters.length + chats.length +
        messages.length + chatManifests.length + messageManifests.length + manifestIdCount +
        (characterIds?.length || 0);
    if (rowCount > MAX_SYNC_ROWS) {
        throw new PostgresPayloadError(`Sync payload exceeds the ${MAX_SYNC_ROWS} row limit`);
    }

    for (const row of rootUpserts) {
        assertId(row?.key, 'root.upserts[].key');
        if (!Object.prototype.hasOwnProperty.call(row, 'value')) {
            throw new PostgresPayloadError('root.upserts[].value is required');
        }
    }
    for (const key of rootDeletes) {
        assertId(key, 'root.deletes[]');
    }
    for (const row of characters) {
        assertId(row?.id, 'characters[].id');
        assertPosition(row?.position, 'characters[].position');
        assertData(row, 'characters[].data');
    }
    for (const row of chats) {
        assertId(row?.id, 'chats[].id');
        assertId(row?.characterId, 'chats[].characterId');
        assertPosition(row?.position, 'chats[].position');
        assertData(row, 'chats[].data');
    }
    for (const row of messages) {
        assertId(row?.id, 'messages[].id');
        assertId(row?.chatId, 'messages[].chatId');
        assertPosition(row?.position, 'messages[].position');
        assertData(row, 'messages[].data');
    }
    for (const manifest of chatManifests) {
        assertId(manifest?.characterId, 'chatManifests[].characterId');
        for (const id of asArray(manifest?.ids, 'chatManifests[].ids')) {
            assertId(id, 'chatManifests[].ids[]');
        }
    }
    for (const manifest of messageManifests) {
        assertId(manifest?.chatId, 'messageManifests[].chatId');
        for (const id of asArray(manifest?.ids, 'messageManifests[].ids')) {
            assertId(id, 'messageManifests[].ids[]');
        }
    }
    if (characterIds !== undefined) {
        for (const id of characterIds) {
            assertId(id, 'characterIds[]');
        }
    }

    return {
        replaceAll: payload.replaceAll === true,
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
    if (!/^[a-z][a-z0-9_]*$/.test(value)) {
        throw new Error(`Unsafe SQL identifier: ${value}`);
    }
    return `"${value}"`;
}

async function bulkInsert(client, table, columns, columnTypes, rows, suffix = '') {
    if (rows.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);
    const quotedColumns = columns.map(assertSqlIdentifier);
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
        `INSERT INTO risu_revisions
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
    'risu_message_attributes',
    'risu_message_generation',
    'risu_message_prompt_info',
    'risu_message_prompt_toggles',
    'risu_message_prompt_items',
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
                'SELECT schema_version, schema_layout FROM risu_storage_meta WHERE singleton = TRUE'
            );
            const schemaVersion = result.rows[0]?.schema_version;
            const schemaLayout = result.rows[0]?.schema_layout;
            if (schemaVersion !== POSTGRES_SCHEMA_VERSION || schemaLayout !== 'relational-v1') {
                throw new Error(
                    `Unsupported PostgreSQL schema ${schemaVersion}/${schemaLayout}; ` +
                    `expected ${POSTGRES_SCHEMA_VERSION}/relational-v1`
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
            'SELECT revision, initialized FROM risu_storage_meta WHERE singleton = TRUE'
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
             FROM risu_revisions AS revision
             LEFT JOIN risu_audit_log AS audit ON audit.revision_id = revision.id
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
            `SELECT class.relname AS table_name,
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
             WHERE namespace.nspname = current_schema()
               AND class.relname = ANY($1::text[])
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
             ORDER BY class.relname, attribute.attnum`,
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
                'SELECT id FROM risu_revisions WHERE id = $1 FOR SHARE', [targetRevisionId]
            );
            if (target.rowCount === 0) throw new PostgresPayloadError('The requested revision does not exist');
            const metaResult = await client.query(
                'SELECT revision FROM risu_storage_meta WHERE singleton = TRUE FOR UPDATE'
            );
            const nextStorageRevision = Number(metaResult.rows[0].revision) + 1;
            const initializedResult = await client.query(
                `SELECT database_initialized
                 FROM risu_revisions
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
                 FROM risu_audit_log
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
                        `${assertSqlIdentifier(column)} = $${index + 1}`).join(' AND ');
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
                        `${assertSqlIdentifier(column)} = EXCLUDED.${assertSqlIdentifier(column)}`).join(', ')}`;
                await client.query(
                    `INSERT INTO ${quotedTable} (${columns.map(assertSqlIdentifier).join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT (${table.primary.map(assertSqlIdentifier).join(', ')}) ${conflictAction}`,
                    values
                );
            }
            await client.query(
                `UPDATE risu_storage_meta
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
                'SELECT * FROM risu_cold_archives WHERE id = $1::uuid', [normalizedKey]
            );
            const archive = archiveResult.rows[0];
            if (!archive) {
                await client.query('COMMIT');
                return null;
            }
            const tableNames = [
                'risu_cold_archive_attributes', 'risu_cold_field_presence', 'risu_cold_character_tags',
                'risu_cold_character_greetings', 'risu_cold_character_biases',
                'risu_cold_character_emotions', 'risu_cold_character_modules',
                'risu_cold_group_members', 'risu_cold_chat_folders',
                'risu_cold_character_scripts', 'risu_cold_character_sd_data',
                'risu_cold_character_assets', 'risu_cold_character_lore_entries',
                'risu_cold_chats', 'risu_cold_chat_attributes', 'risu_cold_chat_suggestions',
                'risu_cold_chat_modules', 'risu_cold_chat_script_state',
                'risu_cold_chat_bookmarks', 'risu_cold_chat_memory', 'risu_cold_chat_lore_entries',
                'risu_cold_messages', 'risu_cold_message_attributes',
                'risu_cold_message_generation', 'risu_cold_message_prompt_info',
                'risu_cold_message_prompt_toggles', 'risu_cold_message_prompt_items',
            ];
            await client.query(`SELECT set_config('risu.archive_id', $1, TRUE)`, [normalizedKey]);
            const loaded = await client.query(tableNames.map((table) =>
                `SELECT * FROM ${assertSqlIdentifier(table)}
                 WHERE archive_id = current_setting('risu.archive_id')::uuid ORDER BY 1, 2, 3`
            ).join(';\n'));
            const rows = Object.fromEntries(tableNames.map((table, index) => [table, loaded[index].rows]));
            let data;
            if (archive.kind === 'legacy') {
                const legacy = rows.risu_cold_archive_attributes.find((item) => item.key === 'legacy');
                data = legacy ? decodePostgresJsonValue(legacy.value) : [];
            } else {
                const presence = (entityType, chatPosition, entityPosition) => new Set(
                    rows.risu_cold_field_presence
                        .filter((item) => item.entity_type === entityType &&
                            item.chat_position === chatPosition && item.entity_position === entityPosition)
                        .map((item) => item.field_name)
                );
                const retainPresentFields = (value, fields) => {
                    if (fields.size === 0) return value;
                    for (const field of Object.keys(value)) if (!fields.has(field)) delete value[field];
                    return value;
                };
                const chatAttributes = groupRows(rows.risu_cold_chat_attributes, 'chat_position');
                const chatSuggestions = groupRows(rows.risu_cold_chat_suggestions, 'chat_position');
                const chatModules = groupRows(rows.risu_cold_chat_modules, 'chat_position');
                const chatScriptState = groupRows(rows.risu_cold_chat_script_state, 'chat_position');
                const chatBookmarks = groupRows(rows.risu_cold_chat_bookmarks, 'chat_position');
                const chatMemory = groupRows(rows.risu_cold_chat_memory, 'chat_position');
                const chatLore = groupRows(rows.risu_cold_chat_lore_entries, 'chat_position');
                const messagesByPosition = groupRows(rows.risu_cold_messages, 'chat_position');
                const messageKey = (chatPosition, messagePosition) => `${chatPosition}\0${messagePosition}`;
                const groupColdMessages = (items) => new Map(items.reduce((entries, item) => {
                    const key = messageKey(item.chat_position, item.message_position);
                    const value = entries.find(([candidate]) => candidate === key);
                    if (value) value[1].push(item); else entries.push([key, [item]]);
                    return entries;
                }, []));
                const messageAttributes = groupColdMessages(rows.risu_cold_message_attributes);
                const messageGenerations = new Map(rows.risu_cold_message_generation.map((item) => [messageKey(item.chat_position, item.message_position), item]));
                const messagePromptInfos = new Map(rows.risu_cold_message_prompt_info.map((item) => [messageKey(item.chat_position, item.message_position), item]));
                const messagePromptToggles = groupColdMessages(rows.risu_cold_message_prompt_toggles);
                const messagePromptItems = groupColdMessages(rows.risu_cold_message_prompt_items);
                const rebuiltChats = rows.risu_cold_chats.map((chatRow) => {
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
                        attributes: rows.risu_cold_archive_attributes.filter((item) => item.key !== 'legacy'),
                        tags: rows.risu_cold_character_tags,
                        greetings: rows.risu_cold_character_greetings,
                        biases: rows.risu_cold_character_biases,
                        emotions: rows.risu_cold_character_emotions,
                        modules: rows.risu_cold_character_modules,
                        groupMembers: rows.risu_cold_group_members,
                        chatFolders: rows.risu_cold_chat_folders,
                        scripts: rows.risu_cold_character_scripts,
                        sdData: rows.risu_cold_character_sd_data,
                        assets: rows.risu_cold_character_assets,
                        lore: rows.risu_cold_character_lore_entries,
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
             FROM risu_cold_archives
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
        const result = await bulkInsert(
            client, 'risu_cold_archives', archiveColumns,
            ['uuid', 'text', ...Array(17).fill('text'), 'integer', 'integer', 'boolean', 'boolean',
                ...Array(7).fill('text'), 'bigint', 'bigint', 'bigint', 'bigint'],
            [archive],
            `ON CONFLICT (id) DO UPDATE SET ${archiveColumns.slice(1).map((column) =>
                `${assertSqlIdentifier(column)} = EXCLUDED.${assertSqlIdentifier(column)}`).join(', ')},
                revision = risu_cold_archives.revision + 1, updated_at = NOW()
             RETURNING id::text AS key, kind, revision, updated_at`
        );

        const childTables = [
            'risu_cold_archive_attributes', 'risu_cold_field_presence', 'risu_cold_character_tags',
            'risu_cold_character_greetings', 'risu_cold_character_biases',
            'risu_cold_character_emotions', 'risu_cold_character_modules', 'risu_cold_group_members',
            'risu_cold_chat_folders', 'risu_cold_character_scripts', 'risu_cold_character_sd_data',
            'risu_cold_character_assets', 'risu_cold_character_lore_entries', 'risu_cold_chats',
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
        await bulkInsert(client, 'risu_cold_archive_attributes', ['archive_id', 'key', 'value'], ['uuid', 'text', 'jsonb'], archiveAttributes);
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
        await bulkInsert(client, 'risu_cold_field_presence',
            ['archive_id', 'entity_type', 'chat_position', 'entity_position', 'field_name'],
            ['uuid', 'text', 'integer', 'integer', 'text'], presenceRows);
        const mapCharacterRows = (name) => (character?.[name] || []).map((item) => {
            const mapped = { ...item, archive_id: key };
            delete mapped.character_id;
            delete mapped.group_id;
            return mapped;
        });
        await bulkInsert(client, 'risu_cold_character_tags', ['archive_id', 'position', 'tag'], ['uuid', 'integer', 'text'], mapCharacterRows('tags'));
        await bulkInsert(client, 'risu_cold_character_greetings', ['archive_id', 'greeting_type', 'position', 'content'], ['uuid', 'text', 'integer', 'text'], mapCharacterRows('greetings'));
        await bulkInsert(client, 'risu_cold_character_biases', ['archive_id', 'position', 'phrase', 'bias'], ['uuid', 'integer', 'text', 'double precision'], mapCharacterRows('biases'));
        await bulkInsert(client, 'risu_cold_character_emotions', ['archive_id', 'position', 'emotion', 'asset'], ['uuid', 'integer', 'text', 'text'], mapCharacterRows('emotions'));
        await bulkInsert(client, 'risu_cold_character_modules', ['archive_id', 'position', 'module_id'], ['uuid', 'integer', 'text'], mapCharacterRows('modules'));
        await bulkInsert(client, 'risu_cold_group_members', ['archive_id', 'position', 'character_id', 'talk_weight', 'active'], ['uuid', 'integer', 'text', 'double precision', 'boolean'], mapCharacterRows('groupMembers'));
        await bulkInsert(client, 'risu_cold_chat_folders', ['archive_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['uuid', 'integer', 'text', 'text', 'text', 'boolean'], mapCharacterRows('chatFolders'));
        await bulkInsert(client, 'risu_cold_character_scripts', ['archive_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['uuid', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'jsonb'], mapCharacterRows('scripts'));
        await bulkInsert(client, 'risu_cold_character_sd_data', ['archive_id', 'position', 'key', 'value'], ['uuid', 'integer', 'text', 'text'], mapCharacterRows('sdData'));
        await bulkInsert(client, 'risu_cold_character_assets', ['archive_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['uuid', 'integer', 'text', 'text', 'text', 'text', 'text', 'text'], mapCharacterRows('assets'));
        await bulkInsert(client, 'risu_cold_character_lore_entries', ['archive_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['uuid', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], mapCharacterRows('lore'));

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
        await bulkInsert(client, 'risu_cold_chats', ['archive_id', 'position', 'original_chat_id', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'], ['uuid', 'integer', 'text', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'integer', 'text', 'bigint'], coldChats);
        const mapChatRows = (name) => splitChats.flatMap((item) => item[name].map((row) => {
            const mapped = { ...row, archive_id: key, chat_position: item.core.position };
            delete mapped.chat_id;
            return mapped;
        }));
        await bulkInsert(client, 'risu_cold_chat_attributes', ['archive_id', 'chat_position', 'key', 'value'], ['uuid', 'integer', 'text', 'jsonb'], splitChats.flatMap((item) => item.attributes.map((row) => ({ ...row, archive_id: key, chat_position: item.core.position }))));
        await bulkInsert(client, 'risu_cold_chat_suggestions', ['archive_id', 'chat_position', 'position', 'content'], ['uuid', 'integer', 'integer', 'text'], mapChatRows('suggestions'));
        await bulkInsert(client, 'risu_cold_chat_modules', ['archive_id', 'chat_position', 'position', 'module_id'], ['uuid', 'integer', 'integer', 'text'], mapChatRows('modules'));
        await bulkInsert(client, 'risu_cold_chat_script_state', ['archive_id', 'chat_position', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['uuid', 'integer', 'text', 'text', 'text', 'double precision', 'boolean'], mapChatRows('scriptState'));
        await bulkInsert(client, 'risu_cold_chat_bookmarks', ['archive_id', 'chat_position', 'position', 'message_id', 'name'], ['uuid', 'integer', 'integer', 'text', 'text'], mapChatRows('bookmarks'));
        await bulkInsert(client, 'risu_cold_chat_memory', ['archive_id', 'chat_position', 'memory_type', 'payload'], ['uuid', 'integer', 'text', 'jsonb'], mapChatRows('memory'));
        await bulkInsert(client, 'risu_cold_chat_lore_entries', ['archive_id', 'chat_position', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['uuid', 'integer', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], mapChatRows('lore'));

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
        await bulkInsert(client, 'risu_cold_messages', ['archive_id', 'chat_position', 'position', 'original_message_id', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'], ['uuid', 'integer', 'integer', 'text', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'], coldMessages);
        const messageOwner = (item, index) => ({ archive_id: key, chat_position: splitValue.messages[index].chatPosition, message_position: item.core.position });
        await bulkInsert(client, 'risu_cold_message_attributes', ['archive_id', 'chat_position', 'message_position', 'key', 'value'], ['uuid', 'integer', 'integer', 'text', 'jsonb'], splitMessages.flatMap((item, index) => item.attributes.map((row) => ({ ...row, ...messageOwner(item, index) }))));
        await bulkInsert(client, 'risu_cold_message_generation', ['archive_id', 'chat_position', 'message_position', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['uuid', 'integer', 'integer', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'], splitMessages.flatMap((item, index) => item.generation ? [{ ...item.generation, ...messageOwner(item, index) }] : []));
        await bulkInsert(client, 'risu_cold_message_prompt_info', ['archive_id', 'chat_position', 'message_position', 'prompt_name'], ['uuid', 'integer', 'integer', 'text'], splitMessages.flatMap((item, index) => item.prompt ? [{ ...item.prompt.info, ...messageOwner(item, index) }] : []));
        await bulkInsert(client, 'risu_cold_message_prompt_toggles', ['archive_id', 'chat_position', 'message_position', 'position', 'toggle_key', 'toggle_value'], ['uuid', 'integer', 'integer', 'integer', 'text', 'text'], splitMessages.flatMap((item, index) => (item.prompt?.toggles || []).map((row) => ({ ...row, ...messageOwner(item, index) }))));
        await bulkInsert(client, 'risu_cold_message_prompt_items', ['archive_id', 'chat_position', 'message_position', 'position', 'payload'], ['uuid', 'integer', 'integer', 'integer', 'jsonb'], splitMessages.flatMap((item, index) => (item.prompt?.items || []).map((row) => ({ ...row, ...messageOwner(item, index) }))));
        const archiveResult = await client.query(
            'SELECT id::text AS key, kind, revision, updated_at FROM risu_cold_archives WHERE id = $1::uuid',
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
                'DELETE FROM risu_cold_archives WHERE id = ANY($1::uuid[])', [keys]
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
                'DELETE FROM risu_cold_archives WHERE NOT (id = ANY($1::uuid[]))', [retainedKeys]
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
            'SELECT id::text AS key FROM risu_cold_storage_legacy_imports WHERE id = ANY($1::uuid[])',
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
                        'SELECT 1 FROM risu_cold_archives WHERE id = $1::uuid',
                        [candidate.key]
                    );
                    if (existing.rowCount === 0) {
                        await this.upsertColdStorageWithClient(client, candidate.key, splitValue);
                    }
                    await client.query(
                        `INSERT INTO risu_cold_storage_legacy_imports (id)
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

    async loadDatabase() {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const metaResult = await client.query(
                'SELECT revision, initialized FROM risu_storage_meta WHERE singleton = TRUE'
            );
            const revision = Number(metaResult.rows[0].revision);
            const initialized = metaResult.rows[0].initialized;
            if (!initialized) {
                await client.query('COMMIT');
                return { revision, initialized, database: null };
            }

            const loadQueries = [
                'SELECT * FROM risu_settings ORDER BY key',
                'SELECT * FROM risu_setting_values ORDER BY setting_key, node_id',
                'SELECT * FROM risu_characters ORDER BY position, id',
                'SELECT * FROM risu_character_attributes ORDER BY character_id, key',
                'SELECT * FROM risu_character_tags ORDER BY character_id, position',
                'SELECT * FROM risu_character_greetings ORDER BY character_id, greeting_type, position',
                'SELECT * FROM risu_character_biases ORDER BY character_id, position',
                'SELECT * FROM risu_character_emotions ORDER BY character_id, position',
                'SELECT * FROM risu_character_modules ORDER BY character_id, position',
                'SELECT * FROM risu_group_members ORDER BY group_id, position',
                'SELECT * FROM risu_chat_folders ORDER BY character_id, position',
                'SELECT * FROM risu_character_scripts ORDER BY character_id, script_kind, position',
                'SELECT * FROM risu_character_sd_data ORDER BY character_id, position',
                'SELECT * FROM risu_character_assets ORDER BY character_id, position',
                'SELECT * FROM risu_character_lore_entries ORDER BY character_id, position',
                'SELECT * FROM risu_chats ORDER BY character_id, position, id',
                'SELECT * FROM risu_chat_attributes ORDER BY chat_id, key',
                'SELECT * FROM risu_chat_suggestions ORDER BY chat_id, position',
                'SELECT * FROM risu_chat_modules ORDER BY chat_id, position',
                'SELECT * FROM risu_chat_script_state ORDER BY chat_id, key',
                'SELECT * FROM risu_chat_bookmarks ORDER BY chat_id, position',
                'SELECT * FROM risu_chat_memory ORDER BY chat_id, memory_type',
                'SELECT * FROM risu_chat_lore_entries ORDER BY chat_id, position',
                'SELECT * FROM risu_messages ORDER BY chat_id, position, id',
                'SELECT * FROM risu_message_attributes ORDER BY chat_id, message_id, key',
                'SELECT * FROM risu_message_generation',
                'SELECT * FROM risu_message_prompt_info',
                'SELECT * FROM risu_message_prompt_toggles ORDER BY chat_id, message_id, position',
                'SELECT * FROM risu_message_prompt_items ORDER BY chat_id, message_id, position',
            ];
            const results = await client.query(loadQueries.join(';\n'));
            const [settings, settingValues, characters, characterAttributes, tags, greetings, biases, emotions,
                characterModules, groupMembers, chatFolders, scripts, sdData, assets, characterLore,
                chats, chatAttributes, suggestions, chatModules, scriptState, bookmarks, memory,
                chatLore, messages, messageAttributes, generations, promptInfos, promptToggles,
                promptItems] = results.map((result) => result.rows);

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
                const items = chatsByCharacter.get(row.character_id) || [];
                items.push(rebuildChat(row, related));
                chatsByCharacter.set(row.character_id, items);
            }

            database.characters = characters.map((row) => {
                const related = { chats: chatsByCharacter.get(row.id) || [] };
                for (const [name, grouped] of Object.entries(characterRelations)) related[name] = grouped.get(row.id) || [];
                return rebuildCharacter(row, related);
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

    async sync(rawPayload) {
        this.assertEnabled();
        const payload = validateSyncPayload(rawPayload);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const metaResult = await client.query(
                'SELECT revision FROM risu_storage_meta WHERE singleton = TRUE FOR UPDATE'
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
                await client.query('DELETE FROM risu_settings');
                await client.query('DELETE FROM risu_characters');
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
                'risu_settings',
                ['key'],
                ['text'],
                splitSettings.map((item) => item.setting),
                'ON CONFLICT (key) DO UPDATE SET updated_at = NOW()'
            );
            const changedSettingKeys = splitSettings.map((item) => item.setting.key);
            if (changedSettingKeys.length > 0) {
                await client.query(
                    'DELETE FROM risu_setting_values WHERE setting_key = ANY($1::text[])',
                    [changedSettingKeys]
                );
            }
            await bulkInsert(
                client,
                'risu_setting_values',
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
                await client.query('DELETE FROM risu_settings WHERE key = ANY($1::text[])', [payload.rootDeletes]);
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
                client, 'risu_characters', characterColumns,
                ['text', 'integer', 'text', ...Array(15).fill('text'), 'integer', 'integer', 'boolean', 'boolean',
                    'text', 'text', 'text', 'text', 'text', 'text', 'text', 'bigint', 'bigint', 'bigint', 'bigint'],
                splitCharacters.map((item) => item.core),
                `ON CONFLICT (id) DO UPDATE SET ${characterColumns.slice(1).map((column) =>
                    `${assertSqlIdentifier(column)} = EXCLUDED.${assertSqlIdentifier(column)}`).join(', ')}, updated_at = NOW()`
            );
            const changedCharacterIds = payload.characters.map((row) => row.id);
            const characterChildTables = [
                'risu_character_attributes', 'risu_character_tags', 'risu_character_greetings',
                'risu_character_biases', 'risu_character_emotions', 'risu_character_modules',
                'risu_group_members', 'risu_chat_folders', 'risu_character_scripts',
                'risu_character_sd_data', 'risu_character_assets', 'risu_character_lore_entries',
            ];
            if (changedCharacterIds.length > 0) {
                for (const table of characterChildTables) {
                    const ownerColumn = table === 'risu_group_members' ? 'group_id' : 'character_id';
                    await client.query(
                        `DELETE FROM ${assertSqlIdentifier(table)} WHERE ${assertSqlIdentifier(ownerColumn)} = ANY($1::text[])`,
                        [changedCharacterIds]
                    );
                }
            }
            const characterRows = (name) => splitCharacters.flatMap((item) => item[name]);
            await bulkInsert(client, 'risu_character_attributes', ['character_id', 'key', 'value'], ['text', 'text', 'jsonb'],
                splitCharacters.flatMap((item) => item.attributes.map((row) => ({ ...row, character_id: item.core.id }))));
            await bulkInsert(client, 'risu_character_tags', ['character_id', 'position', 'tag'], ['text', 'integer', 'text'], characterRows('tags'));
            await bulkInsert(client, 'risu_character_greetings', ['character_id', 'greeting_type', 'position', 'content'], ['text', 'text', 'integer', 'text'], characterRows('greetings'));
            await bulkInsert(client, 'risu_character_biases', ['character_id', 'position', 'phrase', 'bias'], ['text', 'integer', 'text', 'double precision'], characterRows('biases'));
            await bulkInsert(client, 'risu_character_emotions', ['character_id', 'position', 'emotion', 'asset'], ['text', 'integer', 'text', 'text'], characterRows('emotions'));
            await bulkInsert(client, 'risu_character_modules', ['character_id', 'position', 'module_id'], ['text', 'integer', 'text'], characterRows('modules'));
            await bulkInsert(client, 'risu_group_members', ['group_id', 'position', 'character_id', 'talk_weight', 'active'], ['text', 'integer', 'text', 'double precision', 'boolean'], characterRows('groupMembers'));
            await bulkInsert(client, 'risu_chat_folders', ['character_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['text', 'integer', 'text', 'text', 'text', 'boolean'], characterRows('chatFolders'));
            await bulkInsert(client, 'risu_character_scripts', ['character_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'jsonb'], characterRows('scripts'));
            await bulkInsert(client, 'risu_character_sd_data', ['character_id', 'position', 'key', 'value'], ['text', 'integer', 'text', 'text'], characterRows('sdData'));
            await bulkInsert(client, 'risu_character_assets', ['character_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['text', 'integer', 'text', 'text', 'text', 'text', 'text', 'text'], characterRows('assets'));
            await bulkInsert(client, 'risu_character_lore_entries', ['character_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], characterRows('lore'));

            const splitChats = payload.chats.map(splitChat);
            const chatColumns = ['id', 'character_id', 'position', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'];
            await bulkInsert(client, 'risu_chats', chatColumns,
                ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'integer', 'text', 'bigint'],
                splitChats.map((item) => item.core),
                `ON CONFLICT (id) DO UPDATE SET ${chatColumns.slice(1).map((column) =>
                    `${assertSqlIdentifier(column)} = EXCLUDED.${assertSqlIdentifier(column)}`).join(', ')}, updated_at = NOW()`);
            const changedChatIds = payload.chats.map((row) => row.id);
            const chatChildTables = ['risu_chat_attributes', 'risu_chat_suggestions', 'risu_chat_modules', 'risu_chat_script_state', 'risu_chat_bookmarks', 'risu_chat_memory', 'risu_chat_lore_entries'];
            if (changedChatIds.length > 0) {
                for (const table of chatChildTables) await client.query(`DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = ANY($1::text[])`, [changedChatIds]);
            }
            const chatRows = (name) => splitChats.flatMap((item) => item[name]);
            await bulkInsert(client, 'risu_chat_attributes', ['chat_id', 'key', 'value'], ['text', 'text', 'jsonb'], splitChats.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.id }))));
            await bulkInsert(client, 'risu_chat_suggestions', ['chat_id', 'position', 'content'], ['text', 'integer', 'text'], chatRows('suggestions'));
            await bulkInsert(client, 'risu_chat_modules', ['chat_id', 'position', 'module_id'], ['text', 'integer', 'text'], chatRows('modules'));
            await bulkInsert(client, 'risu_chat_script_state', ['chat_id', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['text', 'text', 'text', 'text', 'double precision', 'boolean'], chatRows('scriptState'));
            await bulkInsert(client, 'risu_chat_bookmarks', ['chat_id', 'position', 'message_id', 'name'], ['text', 'integer', 'text', 'text'], chatRows('bookmarks'));
            await bulkInsert(client, 'risu_chat_memory', ['chat_id', 'memory_type', 'payload'], ['text', 'text', 'jsonb'], chatRows('memory'));
            await bulkInsert(client, 'risu_chat_lore_entries', ['chat_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], chatRows('lore'));

            const splitMessages = payload.messages.map(splitMessage);
            const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
            await bulkInsert(client, 'risu_messages', messageColumns,
                ['text', 'text', 'integer', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'],
                splitMessages.map((item) => item.core),
                `ON CONFLICT (chat_id, id) DO UPDATE SET ${messageColumns.slice(2).map((column) =>
                    `${assertSqlIdentifier(column)} = EXCLUDED.${assertSqlIdentifier(column)}`).join(', ')}, updated_at = NOW()`);
            await deleteMessageChildren(client, payload.messages);
            await bulkInsert(client, 'risu_message_attributes', ['chat_id', 'message_id', 'key', 'value'], ['text', 'text', 'text', 'jsonb'], splitMessages.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.chat_id, message_id: item.core.id }))));
            await bulkInsert(client, 'risu_message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['text', 'text', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'], splitMessages.flatMap((item) => item.generation ? [item.generation] : []));
            await bulkInsert(client, 'risu_message_prompt_info', ['chat_id', 'message_id', 'prompt_name'], ['text', 'text', 'text'], splitMessages.flatMap((item) => item.prompt ? [item.prompt.info] : []));
            await bulkInsert(client, 'risu_message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'], ['text', 'text', 'integer', 'text', 'text'], splitMessages.flatMap((item) => item.prompt?.toggles || []));
            await bulkInsert(client, 'risu_message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'], ['text', 'text', 'integer', 'jsonb'], splitMessages.flatMap((item) => item.prompt?.items || []));

            if (payload.characterIds !== undefined) {
                await client.query(
                    'DELETE FROM risu_characters WHERE NOT (id = ANY($1::text[]))',
                    [payload.characterIds]
                );
            }
            for (const manifest of payload.chatManifests) {
                await client.query(
                    `DELETE FROM risu_chats
                     WHERE character_id = $1 AND NOT (id = ANY($2::text[]))`,
                    [manifest.characterId, manifest.ids]
                );
            }
            for (const manifest of payload.messageManifests) {
                await client.query(
                    `DELETE FROM risu_messages
                     WHERE chat_id = $1 AND NOT (id = ANY($2::text[]))`,
                    [manifest.chatId, manifest.ids]
                );
            }

            await client.query(
                `UPDATE risu_storage_meta
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
             FROM risu_all_messages AS m
             LEFT JOIN risu_chats AS ch
                 ON m.storage_state = 'active' AND ch.id = m.chat_id
             LEFT JOIN risu_characters AS c ON c.id = ch.character_id
             LEFT JOIN risu_cold_archives AS a
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
                 SELECT model, input_tokens, output_tokens FROM risu_message_generation
                 UNION ALL
                 SELECT model, input_tokens, output_tokens FROM risu_cold_message_generation
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
             FROM risu_character_tags AS t
             JOIN risu_characters AS c ON c.id = t.character_id
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
             FROM risu_characters
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
