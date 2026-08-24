const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const { promisify } = require('util');
const { deflate, unzip } = require('zlib');
const {
    describePostgresTarget,
    readStorageStartupSettings,
    runStartupStage,
} = require('./startupDiagnostics.cjs');
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
    projectSettings,
    SETTING_RELATION_DEFINITIONS,
} = require('./postgresSettingRelations.cjs');
const {
    rebuildSettings,
    splitSetting,
} = require('./postgresSettingsCodec.cjs');
const {
    DEFERRED_SETTING_KEYS,
    SqlStorageBase,
    createSqlStorageHelpers,
    groupRows,
    groupMessageRows,
    createCharacterRelations,
    createChatRelations,
    createMessageRelations,
    rebuildDatabaseGraph,
} = require('./sqlStorageCommon.cjs');

const POSTGRES_SCHEMA_VERSION = 4;
const RELATIONAL_SCHEMA_LAYOUT = 'relational-schema-v3';
const MAX_SYNC_ROWS = 250000;
const BULK_INSERT_BATCH_ROWS = Math.max(
    1,
    Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || '1000', 10) || 1000
);
const AUDITED_TABLES = [
    'system.settings', 'system.setting_values', 'system.plugin_custom_storage', 'character.characters',
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
const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);


const DEFERRED_KEYS_SQL_LITERAL = DEFERRED_SETTING_KEYS.map((k) => `'${k}'`).join(', ');

function mapSettingValueToColumns(value) {
    if (typeof value === 'boolean') {
        return { text_val: null, num_val: null, bool_val: value };
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { text_val: null, num_val: value, bool_val: null };
    }
    if (typeof value === 'string') {
        return { text_val: value, num_val: null, bool_val: null };
    }
    if (value === null || value === undefined) {
        return { text_val: null, num_val: null, bool_val: null };
    }
    return { text_val: null, num_val: null, bool_val: null };
}

async function replaceSettingValueRows(client, upserts) {
    if (upserts.length === 0) return;
    const keys = upserts.map((item) => item.key);
    await client.query('DELETE FROM system.setting_values WHERE setting_key = ANY($1::text[])', [keys]);
    const rows = upserts.flatMap((item) => splitSetting(item.key, item.value).values);
    await bulkInsert(client, 'system.setting_values',
        ['setting_key', 'node_id', 'parent_node_id', 'member_key', 'encoded_member_key', 'position', 'value_type', 'text_value', 'encoded_text_value', 'number_value', 'boolean_value'],
        ['text', 'integer', 'integer', 'text', 'text', 'integer', 'text', 'text', 'text', 'double precision', 'boolean'], rows);
}

function rebuildSettingRows(settings, valueRows) {
    const rebuilt = rebuildSettings(settings, valueRows);
    for (const row of settings) {
        if (!Object.prototype.hasOwnProperty.call(rebuilt, row.key)) {
            rebuilt[row.key] = mapColumnsToSettingValue(row);
        }
    }
    return rebuilt;
}

function mapColumnsToSettingValue(row) {
    if (row.bool_val !== null && row.bool_val !== undefined) return row.bool_val;
    if (row.num_val !== null && row.num_val !== undefined) return Number(row.num_val);
    if (row.text_val !== null && row.text_val !== undefined) {
        if (row.text_val.startsWith('{') || row.text_val.startsWith('[') || row.text_val === 'null') {
            try {
                return JSON.parse(row.text_val);
            } catch {
                return row.text_val;
            }
        }
        return row.text_val;
    }
    return null;
}

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
    PayloadError: PostgresPayloadError,
    maxIdLength: 1024,
});

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
    const unnest = columns.map((_, index) => `$${index + 1}::${columnTypes[index]}[]`).join(', ');
    const query = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')})
         SELECT * FROM UNNEST(${unnest}) AS item(${quotedColumns.join(', ')})
         ${suffix}`;

    // Keep only one column-major parameter batch alive during large restores.
    for (let start = 0; start < rows.length; start += BULK_INSERT_BATCH_ROWS) {
        const end = Math.min(rows.length, start + BULK_INSERT_BATCH_ROWS);
        const parameters = columns.map((column, columnIndex) => {
            const values = new Array(end - start);
            for (let rowIndex = start; rowIndex < end; rowIndex++) {
                const value = rows[rowIndex][column];
                values[rowIndex - start] = columnTypes[columnIndex] === 'jsonb'
                    ? (value === undefined ? null : JSON.stringify(value))
                    : (value ?? null);
            }
            return values;
        });
        await client.query(query, parameters);
    }
}

async function beginAuditRevision(client, {
    storageRevision = null,
    databaseInitialized = null,
    scope,
    action,
    restoredFrom = null,
}) {
    const result = await client.query(
        `WITH inserted AS (
            INSERT INTO system.revisions
                (storage_revision, database_initialized, scope, action, restored_from_revision)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
         )
         SELECT id, set_config('risu.revision_id', id::text, TRUE)
         FROM inserted`,
        [storageRevision, databaseInitialized, scope, action, restoredFrom]
    );
    const revisionId = Number(result.rows[0].id);
    return revisionId;
}

function buildUpsertClause(table, pkColumns, valueColumns, updateTimestamp = false) {
    if (valueColumns.length === 0) {
        return `ON CONFLICT (${pkColumns.map((c) => `"${c}"`).join(', ')}) DO NOTHING`;
    }
    const quotedTable = assertSqlIdentifier(table);
    const sets = valueColumns.map((c) => `"${c}" = EXCLUDED."${c}"`);
    if (updateTimestamp) {
        sets.push('"updated_at" = NOW()');
    }
    const leftCols = valueColumns.map((c) => `${quotedTable}."${c}"`).join(', ');
    const rightCols = valueColumns.map((c) => `EXCLUDED."${c}"`).join(', ');
    return `ON CONFLICT (${pkColumns.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET
        ${sets.join(', ')}
        WHERE (${leftCols}) IS DISTINCT FROM (${rightCols})`;
}

async function prunePositionalChildren(client, table, ownerColumn, lengthsByOwner, subKindColumn = null) {
    if (lengthsByOwner.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);
    const ownerCol = `"${ownerColumn}"`;

    if (subKindColumn) {
        const subKindCol = `"${subKindColumn}"`;
        const owners = lengthsByOwner.map((item) => item.ownerId);
        const subKinds = lengthsByOwner.map((item) => item.subKind);
        const lengths = lengthsByOwner.map((item) => item.length);
        await client.query(
            `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(owner_id, sub_kind, target_len)
             WHERE target.${ownerCol} = spec.owner_id
               AND target.${subKindCol} = spec.sub_kind
               AND target."position" >= spec.target_len`,
            [owners, subKinds, lengths]
        );
    } else {
        const owners = lengthsByOwner.map((item) => item.ownerId);
        const lengths = lengthsByOwner.map((item) => item.length);
        await client.query(
            `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::integer[]) AS spec(owner_id, target_len)
             WHERE target.${ownerCol} = spec.owner_id
               AND target."position" >= spec.target_len`,
            [owners, lengths]
        );
    }
}

async function pruneKeyedChildren(client, table, ownerColumn, keyColumn, keysByOwner) {
    if (keysByOwner.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);
    const ownerCol = `"${ownerColumn}"`;
    const keyCol = `"${keyColumn}"`;

    for (const { ownerId, keys } of keysByOwner) {
        if (!keys || keys.length === 0) {
            await client.query(`DELETE FROM ${quotedTable} WHERE ${ownerCol} = $1`, [ownerId]);
        } else {
            await client.query(`DELETE FROM ${quotedTable} WHERE ${ownerCol} = $1 AND NOT (${keyCol} = ANY($2::text[]))`, [ownerId, keys]);
        }
    }
}

class PostgresStorage extends SqlStorageBase {
    constructor(options = {}) {
        super();
        this.connectionString = options.connectionString || '';
        this.poolMax = Number.parseInt(options.poolMax || '10', 10);
        this.enabled = Boolean(this.connectionString);
        this.startupSettings = readStorageStartupSettings();
        this.pool = null;
        this.schemaRecoveryPromise = null;
        this.postgresSchemaSql = null;
    }

    async initialize() {
        if (!this.enabled) {
            console.log('[PostgreSQL] DATABASE_URL is not configured; using legacy file storage.');
            return;
        }

        console.log(
            `[PostgreSQL startup] Target: ${describePostgresTarget(this.connectionString)}; ` +
            `pool max: ${this.poolMax}; connect timeout: ${this.startupSettings.connectTimeoutMs}ms.`
        );
        this.pool = await this.createInitializedPool(this.connectionString, this.poolMax);
        console.log('[PostgreSQL] Structured storage is ready.');
    }

    runStartupStep(operation, task) {
        return runStartupStage({
            scope: 'PostgreSQL startup',
            operation,
            heartbeatMs: this.startupSettings.heartbeatMs,
        }, task);
    }

    async loadPostgresSchemaSql() {
        if (!this.postgresSchemaSql) {
            this.postgresSchemaSql = await fs.readFile(path.join(__dirname, 'postgres-schema.sql'), 'utf8');
        }
        return this.postgresSchemaSql;
    }

    async verifyPostgresSchema(query) {
        const result = await query(
            'SELECT schema_version, schema_layout FROM system.storage_meta WHERE singleton = TRUE'
        );
        const schemaVersion = Number(result.rows[0]?.schema_version);
        const schemaLayout = result.rows[0]?.schema_layout;
        if (schemaVersion !== POSTGRES_SCHEMA_VERSION || schemaLayout !== RELATIONAL_SCHEMA_LAYOUT) {
            throw new Error(
                `Unsupported PostgreSQL schema ${schemaVersion}/${schemaLayout}; ` +
                `expected ${POSTGRES_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}. ` +
                'Reset the configured development database explicitly before retrying.'
            );
        }
    }

    async recoverMissingPostgresSchema(query) {
        if (this.schemaRecoveryPromise) {
            return this.schemaRecoveryPromise;
        }
        const recovery = (async () => {
            const existingMeta = await query("SELECT to_regclass('system.storage_meta') AS table_name");
            if (!existingMeta.rows[0]?.table_name) {
                console.warn('[PostgreSQL] Storage schema disappeared; reinitializing it on the current database.');
                await query(await this.loadPostgresSchemaSql());
                this.invalidateBootstrapCache();
            }
            await this.verifyPostgresSchema(query);
        })();
        this.schemaRecoveryPromise = recovery;
        try {
            return await recovery;
        } finally {
            if (this.schemaRecoveryPromise === recovery) {
                this.schemaRecoveryPromise = null;
            }
        }
    }

    async ensureConnectedClientSchema(query) {
        const existingMeta = await query("SELECT to_regclass('system.storage_meta') AS table_name");
        if (!existingMeta.rows[0]?.table_name) {
            await this.recoverMissingPostgresSchema(query);
            return;
        }
        await this.verifyPostgresSchema(query);
    }

    installPoolSchemaRecovery(pool) {
        pool.on('error', (error) => {
            console.warn('[PostgreSQL] Idle pool connection failed; a later request will reconnect:', error.message || error);
        });
        pool.on('connect', (client) => {
            const originalQuery = client.query.bind(client);
            const schemaReady = this.ensureConnectedClientSchema(originalQuery);
            schemaReady.catch(() => {});
            client.query = (...args) => {
                const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
                if (callback) {
                    schemaReady
                        .then(() => originalQuery(...args, callback))
                        .catch((error) => callback(error));
                    return;
                }
                return schemaReady.then(() => originalQuery(...args));
            };
        });
    }

    async createInitializedPool(connectionString, poolMax) {
        const pool = new Pool({
            connectionString,
            max: Number.isSafeInteger(poolMax) && poolMax > 0 ? poolMax : 10,
            application_name: 'risuai-node',
            connectionTimeoutMillis: this.startupSettings.connectTimeoutMs,
        });
        try {
            await this.runStartupStep('1/6 connect and ping database', () => pool.query('SELECT 1'));
            const existingMeta = await this.runStartupStep(
                '2/6 inspect storage schema metadata',
                () => pool.query("SELECT to_regclass('system.storage_meta') AS table_name")
            );
            if (existingMeta.rows[0]?.table_name) {
                await this.runStartupStep(
                    '3/6 validate existing storage schema version',
                    () => this.verifyPostgresSchema(pool.query.bind(pool))
                );
            } else {
                console.log('[PostgreSQL startup] 3/6 no existing storage schema found; a new schema will be created.');
            }
            const schemaSql = await this.runStartupStep(
                '4/6 load bundled storage schema',
                () => this.loadPostgresSchemaSql()
            );
            await this.runStartupStep('5/6 apply storage schema', () => pool.query(schemaSql));
            await this.runStartupStep(
                '6/6 verify applied storage schema',
                () => this.verifyPostgresSchema(pool.query.bind(pool))
            );
            this.installPoolSchemaRecovery(pool);
            return pool;
        } catch (error) {
            await pool.end().catch(() => {});
            throw error;
        }
    }

    async reconfigure(options = {}) {
        this.invalidateBootstrapCache();
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

    async isAssetCatalogInitialized(sourceId) {
        this.assertEnabled();
        const result = await this.pool.query(
            'SELECT initialized, source_id FROM system.asset_catalog_state WHERE singleton = TRUE'
        );
        return Boolean(result.rows[0]?.initialized) && result.rows[0]?.source_id === sourceId;
    }

    async listAssetCatalog(prefix = '') {
        this.assertEnabled();
        const result = prefix
            ? await this.pool.query(
                'SELECT asset_key FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2 ORDER BY asset_key',
                [prefix.length, prefix]
            )
            : await this.pool.query('SELECT asset_key FROM system.asset_catalog ORDER BY asset_key');
        return result.rows.map((row) => row.asset_key);
    }

    async listAssetCatalogEntries(prefix = '') {
        this.assertEnabled();
        const result = prefix
            ? await this.pool.query(
                'SELECT asset_key, size_bytes, etag, updated_at FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2 ORDER BY asset_key',
                [prefix.length, prefix]
            )
            : await this.pool.query('SELECT asset_key, size_bytes, etag, updated_at FROM system.asset_catalog ORDER BY asset_key');
        return result.rows.map((row) => ({
            key: row.asset_key,
            size: row.size_bytes === null ? null : Number(row.size_bytes),
            etag: row.etag ?? null,
            updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
        }));
    }

    async getAssetCatalogStats() {
        this.assertEnabled();
        const result = await this.pool.query(
            'SELECT COUNT(*)::bigint AS total_objects, COALESCE(SUM(size_bytes), 0)::bigint AS total_size FROM system.asset_catalog'
        );
        return {
            totalObjects: Number(result.rows[0].total_objects),
            totalSizeBytes: Number(result.rows[0].total_size),
        };
    }

    async upsertAssetCatalog(entries) {
        this.assertEnabled();
        if (!Array.isArray(entries) || entries.length === 0) return 0;
        const keys = entries.map((entry) => entry.key);
        const sizes = entries.map((entry) => entry.size ?? null);
        const etags = entries.map((entry) => entry.etag ?? null);
        await this.pool.query(
            `INSERT INTO system.asset_catalog (asset_key, size_bytes, etag)
             SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::text[])
             ON CONFLICT (asset_key) DO UPDATE SET
                size_bytes = COALESCE(EXCLUDED.size_bytes, system.asset_catalog.size_bytes),
                etag = COALESCE(EXCLUDED.etag, system.asset_catalog.etag),
                updated_at = NOW()`,
            [keys, sizes, etags]
        );
        return entries.length;
    }

    async removeAssetCatalog(keys) {
        this.assertEnabled();
        if (!Array.isArray(keys) || keys.length === 0) return 0;
        const result = await this.pool.query(
            'DELETE FROM system.asset_catalog WHERE asset_key = ANY($1::text[])',
            [keys]
        );
        return result.rowCount;
    }

    async replaceAssetCatalog(prefix, entries, sourceId) {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (prefix) {
                await client.query(
                    'DELETE FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2',
                    [prefix.length, prefix]
                );
            } else {
                await client.query('DELETE FROM system.asset_catalog');
            }
            if (entries.length > 0) {
                const keys = entries.map((entry) => entry.key);
                const sizes = entries.map((entry) => entry.size ?? null);
                const etags = entries.map((entry) => entry.etag ?? null);
                await client.query(
                    `INSERT INTO system.asset_catalog (asset_key, size_bytes, etag)
                     SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::text[])`,
                    [keys, sizes, etags]
                );
            }
            await client.query(
                `UPDATE system.asset_catalog_state
                 SET initialized = TRUE, source_id = $1, synced_at = NOW()
                 WHERE singleton = TRUE`
                , [sourceId]
            );
            await client.query('COMMIT');
            return entries.length;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async listRevisions(rawLimit = null) {
        this.assertEnabled();
        let sql = `SELECT revision.id, revision.storage_revision, revision.database_initialized,
                    revision.scope, revision.action, revision.restored_from_revision,
                    revision.created_at, COUNT(audit.sequence)::integer AS change_count
             FROM system.revisions AS revision
             LEFT JOIN system.audit_log AS audit ON audit.revision_id = revision.id
             GROUP BY revision.id
             ORDER BY revision.id DESC`;
        const params = [];
        if (rawLimit !== null && rawLimit !== undefined && rawLimit !== '' && rawLimit !== 'all' && rawLimit !== 0 && rawLimit !== '0') {
            const parsedLimit = Number.parseInt(rawLimit, 10);
            if (Number.isSafeInteger(parsedLimit) && parsedLimit > 0) {
                sql += ' LIMIT $1';
                params.push(parsedLimit);
            }
        }
        const result = await this.pool.query(sql, params);
        return result.rows.map((row) => ({
            ...row,
            id: Number(row.id),
            storage_revision: row.storage_revision === null ? null : Number(row.storage_revision),
            restored_from_revision: row.restored_from_revision === null
                ? null : Number(row.restored_from_revision),
        }));
    }

    async getRevisionDetails(rawRevisionId) {
        this.assertEnabled();
        const revisionId = Number(rawRevisionId);
        if (!Number.isSafeInteger(revisionId) || revisionId <= 0) {
            throw new PostgresPayloadError('revisionId must be a positive integer');
        }
        const revResult = await this.pool.query(
            `SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at
             FROM system.revisions
             WHERE id = $1`,
            [revisionId]
        );
        if (revResult.rowCount === 0) {
            return null;
        }
        const revision = revResult.rows[0];

        const auditResult = await this.pool.query(
            `SELECT sequence, table_name, operation, before_row, after_row, recorded_at
             FROM system.audit_log
             WHERE revision_id = $1
             ORDER BY sequence ASC`,
            [revisionId]
        );

        const tableMap = new Map();
        const auditLogs = auditResult.rows.map((row) => {
            const table = row.table_name;
            const op = row.operation;
            if (!tableMap.has(table)) {
                tableMap.set(table, { tableName: table, insertCount: 0, updateCount: 0, deleteCount: 0, totalCount: 0 });
            }
            const stat = tableMap.get(table);
            stat.totalCount += 1;
            if (op === 'INSERT') stat.insertCount += 1;
            else if (op === 'UPDATE') stat.updateCount += 1;
            else if (op === 'DELETE') stat.deleteCount += 1;

            return {
                sequence: Number(row.sequence),
                tableName: row.table_name,
                operation: row.operation,
                beforeRow: row.before_row,
                afterRow: row.after_row,
                recordedAt: row.recorded_at,
            };
        });

        const tableSummaries = Array.from(tableMap.values());

        return {
            id: Number(revision.id),
            storage_revision: revision.storage_revision === null ? null : Number(revision.storage_revision),
            database_initialized: revision.database_initialized,
            scope: revision.scope,
            action: revision.action,
            restored_from_revision: revision.restored_from_revision === null ? null : Number(revision.restored_from_revision),
            created_at: revision.created_at,
            change_count: auditLogs.length,
            tableSummaries,
            auditLogs,
        };
    }

    async getRevisionDiff(rawBaseId, rawTargetId) {
        this.assertEnabled();
        const baseId = Number(rawBaseId);
        const targetId = Number(rawTargetId);
        if (!Number.isSafeInteger(baseId) || !Number.isSafeInteger(targetId) || baseId <= 0 || targetId <= 0) {
            throw new PostgresPayloadError('baseRevisionId and targetRevisionId must be positive integers');
        }
        const minId = Math.min(baseId, targetId);
        const maxId = Math.max(baseId, targetId);

        const auditResult = await this.pool.query(
            `SELECT sequence, revision_id, table_name, operation, before_row, after_row, recorded_at
             FROM system.audit_log
             WHERE revision_id > $1 AND revision_id <= $2
             ORDER BY sequence ASC`,
            [minId, maxId]
        );

        const tableMap = new Map();
        for (const row of auditResult.rows) {
            const table = row.table_name;
            const op = row.operation;
            if (!tableMap.has(table)) {
                tableMap.set(table, { tableName: table, insertCount: 0, updateCount: 0, deleteCount: 0, totalCount: 0, entries: [] });
            }
            const stat = tableMap.get(table);
            stat.totalCount += 1;
            if (op === 'INSERT') stat.insertCount += 1;
            else if (op === 'UPDATE') stat.updateCount += 1;
            else if (op === 'DELETE') stat.deleteCount += 1;
            stat.entries.push({
                sequence: Number(row.sequence),
                revisionId: Number(row.revision_id),
                tableName: row.table_name,
                operation: row.operation,
                beforeRow: row.before_row,
                afterRow: row.after_row,
                recordedAt: row.recorded_at,
            });
        }

        return {
            baseRevisionId: baseId,
            targetRevisionId: targetId,
            totalChanges: auditResult.rowCount,
            tables: Array.from(tableMap.values()),
        };
    }

    async previewRestore(rawRevisionId) {
        this.assertEnabled();
        const targetRevisionId = Number(rawRevisionId);
        if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
            throw new PostgresPayloadError('revisionId must be a positive integer');
        }
        const target = await this.pool.query(
            'SELECT id, scope, action, created_at FROM system.revisions WHERE id = $1', [targetRevisionId]
        );
        if (target.rowCount === 0) {
            throw new PostgresPayloadError('The requested revision does not exist');
        }
        const latest = await this.pool.query(
            'SELECT id FROM system.revisions ORDER BY id DESC LIMIT 1'
        );
        const currentRevisionId = latest.rows[0]?.id ? Number(latest.rows[0].id) : targetRevisionId;

        const auditResult = await this.pool.query(
            `SELECT sequence, table_name, operation, before_row, after_row
             FROM system.audit_log
             WHERE revision_id > $1
             ORDER BY sequence DESC`,
            [targetRevisionId]
        );

        const tableMap = new Map();
        let restoreInsertCount = 0;
        let restoreDeleteCount = 0;
        let restoreUpdateCount = 0;

        for (const event of auditResult.rows) {
            const table = event.table_name;
            if (!tableMap.has(table)) {
                tableMap.set(table, { tableName: table, revertedInserts: 0, revertedUpdates: 0, revertedDeletes: 0, totalChanges: 0 });
            }
            const stat = tableMap.get(table);
            stat.totalChanges += 1;
            if (event.operation === 'INSERT') {
                stat.revertedInserts += 1;
                restoreDeleteCount += 1;
            } else if (event.operation === 'DELETE') {
                stat.revertedDeletes += 1;
                restoreInsertCount += 1;
            } else if (event.operation === 'UPDATE') {
                stat.revertedUpdates += 1;
                restoreUpdateCount += 1;
            }
        }

        return {
            targetRevisionId,
            currentRevisionId,
            revisionsToRevert: Math.max(0, currentRevisionId - targetRevisionId),
            totalOperations: auditResult.rowCount,
            restoreInsertCount,
            restoreDeleteCount,
            restoreUpdateCount,
            affectedTables: Array.from(tableMap.values()),
        };
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
            this.pluginsCache = null;
            this.pluginCustomStorageCache = null;
            this.invalidateBootstrapCache();
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
                    `SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key NOT IN (${DEFERRED_KEYS_SQL_LITERAL}) ORDER BY key`,
                    `SELECT * FROM system.setting_values WHERE setting_key NOT IN (${DEFERRED_KEYS_SQL_LITERAL}) ORDER BY setting_key, node_id`,
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

                const database = rebuildSettingRows(settings, settingValues);
                database.plugins ??= [];
                // Plugin storage is loaded by key after startup. Keeping it out
                // of the shallow shell prevents large, static plugin caches from
                // being parsed and transferred twice during bootstrap.
                database.pluginCustomStorage = {};

                const characterRelations = {
                    tags: groupRows(tags, 'character_id'),
                    groupMembers: groupRows(groupMembers, 'group_id'),
                    chatFolders: groupRows(chatFolders, 'character_id'),
                };
                const chatRelations = {
                    bookmarks: groupRows(bookmarks, 'chat_id'),
                };

                rebuildDatabaseGraph({
                    database, characters, chats,
                    characterRelations, chatRelations,
                    rebuildCharacter, rebuildChat, rebuildMessage,
                    shallow: true,
                });
                await client.query('COMMIT');
                return { revision, initialized, database };
            }

            const loadQueries = [
                'SELECT key, text_val, num_val, bool_val FROM system.settings ORDER BY key',
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

            const database = rebuildSettingRows(settings, settingValues);
            database.pluginCustomStorage = Object.fromEntries((await client.query(
                'SELECT key, value FROM system.plugin_custom_storage ORDER BY key')).rows.map((row) => [row.key, row.value]));

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

    async loadChatMessages(chatId, options = {}) {
        this.assertEnabled();
        assertId(chatId, 'chatId');
        const client = await this.pool.connect();
        const includeMetadata = options.mode !== 'generation';
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const queries = [
                'SELECT * FROM chat.messages WHERE chat_id = $1 ORDER BY position, id',
                'SELECT * FROM chat.message_attributes WHERE chat_id = $1 ORDER BY chat_id, message_id, key',
            ];
            if (includeMetadata) {
                queries.push(
                    'SELECT * FROM chat.message_generation WHERE chat_id = $1',
                    'SELECT * FROM chat.message_prompt_info WHERE chat_id = $1',
                    'SELECT * FROM chat.message_prompt_toggles WHERE chat_id = $1 ORDER BY chat_id, message_id, position',
                    'SELECT * FROM chat.message_prompt_items WHERE chat_id = $1 ORDER BY chat_id, message_id, position',
                );
            }
            const results = await Promise.all(queries.map((query) => client.query(query, [chatId])));
            const messagesRes = results[0];
            const attributesRes = results[1];
            const generations = results[2]?.rows ?? [];
            const promptInfos = results[3]?.rows ?? [];
            const promptToggles = results[4]?.rows ?? [];
            const promptItems = results[5]?.rows ?? [];
            const relations = {
                attributes: groupMessageRows(attributesRes.rows),
                generation: new Map(generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptInfo: new Map(promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptToggles: groupMessageRows(promptToggles),
                promptItems: groupMessageRows(promptItems),
            };
            const messages = messagesRes.rows.map((row) => {
                const key = `${row.chat_id}\0${row.id}`;
                return rebuildMessage(row, {
                    attributes: relations.attributes.get(key),
                    generation: relations.generation.get(key),
                    promptInfo: relations.promptInfo.get(key),
                    promptToggles: relations.promptToggles.get(key),
                    promptItems: relations.promptItems.get(key),
                });
            });
            await client.query('COMMIT');
            return messages;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadPlugins() {
        this.assertEnabled();
        if (this.pluginsCache) {
            return this.pluginsCache;
        }
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

            const result = {
                plugins,
                hash,
            };
            if (this.objectCacheEnabled) this.pluginsCache = result;
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async loadPluginCustomStorage() {
        this.assertEnabled();
        if (this.pluginCustomStorageCache) {
            return this.pluginCustomStorageCache;
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const rows = (await client.query('SELECT key, value FROM system.plugin_custom_storage ORDER BY key')).rows;
            await client.query('COMMIT');
            const pluginCustomStorage = Object.fromEntries(rows.map((row) => [row.key, row.value]));
            const serialized = JSON.stringify(pluginCustomStorage);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');

            const result = {
                pluginCustomStorage,
                hash,
            };
            if (this.objectCacheEnabled) this.pluginCustomStorageCache = result;
            return result;
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
            const result = await client.query('SELECT key FROM system.plugin_custom_storage ORDER BY key');
            await client.query('COMMIT');
            return result.rows.map((row) => row.key);
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
            const result = await client.query(
                'SELECT value FROM system.plugin_custom_storage WHERE key = $1', [storageKey]);
            await client.query('COMMIT');

            if (result.rows.length === 0) {
                return {
                    key: storageKey,
                    exists: false,
                    value: null,
                    hash: 'null',
                };
            }

            const value = result.rows[0].value;
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

    async loadSettingKeys(keys) {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const settingsResult = await client.query(
                'SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key = ANY($1::text[]) ORDER BY key',
                [keys]
            );
            const valuesResult = await client.query(
                'SELECT * FROM system.setting_values WHERE setting_key = ANY($1::text[]) ORDER BY setting_key, node_id',
                [keys]
            );
            await client.query('COMMIT');
            const rebuilt = rebuildSettingRows(settingsResult.rows, valuesResult.rows);
            if (keys.includes('pluginCustomStorage')) {
                const pluginRows = (await client.query(
                    'SELECT key, value FROM system.plugin_custom_storage ORDER BY key')).rows;
                rebuilt.pluginCustomStorage = Object.fromEntries(pluginRows.map((row) => [row.key, row.value]));
            }
            const serialized = JSON.stringify(rebuilt);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            return {
                settings: rebuilt,
                hash,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async listBotPresets() {
        this.assertEnabled();
        const started = process.hrtime.bigint();
        const result = await this.pool.query(
            `SELECT preset_id, position, name, image, api_type, ai_model, content_hash
             FROM system.bot_presets ORDER BY position`
        );
        const presets = result.rows.map((row) => ({
            id: row.preset_id, position: Number(row.position), name: row.name || '', image: row.image || '',
            apiType: row.api_type || '', aiModel: row.ai_model || '', hash: row.content_hash,
        }));
        const hash = crypto.createHash('sha256').update(JSON.stringify(presets)).digest('hex');
        return { presets, hash, queryMs: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    async loadBotPreset(id) {
        this.assertEnabled();
        const started = process.hrtime.bigint();
        const result = await this.pool.query(
            'SELECT data, content_hash FROM system.bot_presets WHERE preset_id = $1', [id]);
        if (result.rowCount === 0) return null;
        const data = result.rows[0].data;
        return {
            preset: { ...(typeof data === 'string' ? JSON.parse(data) : data), id },
            hash: result.rows[0].content_hash,
            queryMs: Number(process.hrtime.bigint() - started) / 1e6,
        };
    }

    async executeRevision(action, scope = 'database', callback) {
        this.assertEnabled();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const metaResult = await client.query(
                'SELECT revision FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE'
            );
            const currentRevision = Number(metaResult.rows[0].revision);
            const nextRevision = currentRevision + 1;
            const revisionId = await beginAuditRevision(client, {
                storageRevision: nextRevision,
                databaseInitialized: true,
                scope,
                action,
            });

            const result = await callback(client, revisionId);

            await client.query(
                `UPDATE system.storage_meta
                 SET revision = $1, initialized = TRUE, updated_at = NOW()
                 WHERE singleton = TRUE`,
                [nextRevision]
            );
            await client.query('COMMIT');
            return { success: true, revision: nextRevision, revisionId, ...result };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async updateSetting(key, value) {
        return await this.executeRevision(`setting:update (${key})`, 'database', async (client) => {
            const mapped = mapSettingValueToColumns(value);
            await client.query(
                `INSERT INTO system.settings (key, text_val, num_val, bool_val, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (key) DO UPDATE SET
                    text_val = EXCLUDED.text_val,
                    num_val = EXCLUDED.num_val,
                    bool_val = EXCLUDED.bool_val,
                    updated_at = NOW()`,
                [key, mapped.text_val, mapped.num_val, mapped.bool_val]
            );
            await replaceSettingValueRows(client, [{ key, value }]);
            const projected = projectSettings([{ key, value }]);
            for (const definition of SETTING_RELATION_DEFINITIONS) {
                if (definition.settingKeys.includes(key)) {
                    await client.query(
                        `DELETE FROM ${assertSqlIdentifier(definition.table)} WHERE setting_key = $1`,
                        [key]
                    );
                    await bulkInsert(
                        client,
                        definition.table,
                        definition.columns,
                        definition.types,
                        projected[definition.table]
                    );
                }
            }
            this.invalidateBootstrapCache([key]);
            return { key };
        });
    }

    async deleteSetting(key) {
        return await this.executeRevision(`setting:delete (${key})`, 'database', async (client) => {
            await client.query('DELETE FROM system.settings WHERE key = $1', [key]);
            this.invalidateBootstrapCache([key]);
            return { key };
        });
    }

    async saveBotPreset(preset, position = 0) {
        return await this.executeRevision(`preset:save (${preset.name || position})`, 'database', async (client) => {
            const id = preset.id || crypto.randomUUID();
            const data = { ...preset }; delete data.id;
            const serialized = JSON.stringify(data);
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            await client.query(`INSERT INTO system.bot_presets
                (preset_id,position,name,image,api_type,ai_model,data,content_hash)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
                ON CONFLICT (preset_id) DO UPDATE SET name=EXCLUDED.name,image=EXCLUDED.image,
                api_type=EXCLUDED.api_type,ai_model=EXCLUDED.ai_model,data=EXCLUDED.data,
                content_hash=EXCLUDED.content_hash,updated_at=NOW()`,
            [id, Number(position) || 0, data.name || '', data.image || '', data.apiType || '', data.aiModel || '', serialized, hash]);
            return { id, position };
        });
    }

    async saveModule(moduleData) {
        return await this.executeRevision(`module:save (${moduleData.name || moduleData.id})`, 'database', async (client) => {
            const id = moduleData.id;
            const columns = [
                'setting_key', 'position', 'module_id', 'name', 'description', 'cjs',
                'low_level_access', 'hide_icon', 'background_embedding', 'namespace',
                'custom_toggle', 'mcp_url', 'icon',
            ];
            const posResult = await client.query(
                `SELECT position FROM system.modules WHERE module_id = $1 LIMIT 1`,
                [id]
            );
            const maxPosResult = await client.query(
                `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM system.modules`
            );
            const position = posResult.rowCount > 0 ? posResult.rows[0].position : maxPosResult.rows[0].next_pos;
            const row = {
                setting_key: 'modules',
                position,
                module_id: id,
                name: moduleData.name ?? null,
                description: moduleData.description ?? null,
                cjs: moduleData.cjs ?? null,
                low_level_access: Boolean(moduleData.lowLevelAccess),
                hide_icon: Boolean(moduleData.hideIcon),
                background_embedding: moduleData.backgroundEmbedding ?? null,
                namespace: moduleData.namespace ?? null,
                custom_toggle: moduleData.customModuleToggle ?? null,
                mcp_url: moduleData.mcp?.url ?? null,
                icon: moduleData.icon ?? null,
            };
            await bulkInsert(
                client,
                'system.modules',
                columns,
                [
                    'text', 'integer', 'text', 'text', 'text', 'text', 'boolean', 'boolean', 'text',
                    'text', 'text', 'text', 'text',
                ],
                [row],
                `ON CONFLICT (setting_key, position) DO UPDATE SET ${columns.slice(2).map((c) =>
                    `"${c}" = EXCLUDED."${c}"`).join(', ')}`
            );
            return { id };
        });
    }

    async deleteModule(moduleId) {
        return await this.executeRevision(`module:delete (${moduleId})`, 'database', async (client) => {
            await client.query('DELETE FROM system.modules WHERE module_id = $1', [moduleId]);
            return { id: moduleId };
        });
    }

    async saveMessage(chatId, message) {
        return await this.executeRevision('message:save', 'database', async (client) => {
            const split = splitMessage({ id: message.chatId || message.id, chatId, position: message.position ?? 0, data: message });
            const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
            await bulkInsert(client, 'chat.messages', messageColumns,
                ['text', 'text', 'integer', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'],
                [split.core],
                buildUpsertClause('chat.messages', ['chat_id', 'id'], messageColumns.slice(2), true));
            if (split.attributes.length > 0) {
                await bulkInsert(client, 'chat.message_attributes', ['chat_id', 'message_id', 'key', 'value'], ['text', 'text', 'text', 'jsonb'],
                    split.attributes.map((r) => ({ ...r, chat_id: chatId, message_id: split.core.id })),
                    buildUpsertClause('chat.message_attributes', ['chat_id', 'message_id', 'key'], ['value']));
            }
            await pruneKeyedChildren(client, 'chat.message_attributes', 'chat_id', 'key',
                [{ ownerId: chatId, keys: split.attributes.map((r) => r.key) }]);

            if (split.generation) {
                await bulkInsert(client, 'chat.message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['text', 'text', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'],
                    [split.generation],
                    buildUpsertClause('chat.message_generation', ['chat_id', 'message_id'], ['model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time']));
            } else {
                await client.query('DELETE FROM chat.message_generation WHERE chat_id = $1 AND message_id = $2', [chatId, split.core.id]);
            }

            if (split.prompt?.info) {
                await bulkInsert(client, 'chat.message_prompt_info', ['chat_id', 'message_id', 'prompt_name'], ['text', 'text', 'text'],
                    [split.prompt.info],
                    buildUpsertClause('chat.message_prompt_info', ['chat_id', 'message_id'], ['prompt_name']));
            } else {
                await client.query('DELETE FROM chat.message_prompt_info WHERE chat_id = $1 AND message_id = $2', [chatId, split.core.id]);
            }

            if (split.prompt?.toggles?.length > 0) {
                await bulkInsert(client, 'chat.message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'], ['text', 'text', 'integer', 'text', 'text'],
                    split.prompt.toggles,
                    buildUpsertClause('chat.message_prompt_toggles', ['chat_id', 'message_id', 'position'], ['toggle_key', 'toggle_value']));
            }
            await client.query('DELETE FROM chat.message_prompt_toggles WHERE chat_id = $1 AND message_id = $2 AND position >= $3',
                [chatId, split.core.id, (split.prompt?.toggles || []).length]);

            if (split.prompt?.items?.length > 0) {
                await bulkInsert(client, 'chat.message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'], ['text', 'text', 'integer', 'jsonb'],
                    split.prompt.items,
                    buildUpsertClause('chat.message_prompt_items', ['chat_id', 'message_id', 'position'], ['payload']));
            }
            await client.query('DELETE FROM chat.message_prompt_items WHERE chat_id = $1 AND message_id = $2 AND position >= $3',
                [chatId, split.core.id, (split.prompt?.items || []).length]);

            return { id: split.core.id, chatId };
        });
    }

    async deleteMessage(chatId, messageId) {
        return await this.executeRevision('message:delete', 'database', async (client) => {
            await client.query('DELETE FROM chat.messages WHERE chat_id = $1 AND id = $2', [chatId, messageId]);
            return { chatId, messageId };
        });
    }

    async sync(rawPayload, options = {}) {
        this.assertEnabled();
        const onProgress = typeof options === 'function' ? options : options?.onProgress;
        const payload = validateSyncPayload(rawPayload);
        const client = await this.pool.connect();
        try {
            onProgress?.({ stage: 'start', message: 'Starting transaction' });
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
                action: payload.action || (payload.replaceAll ? 'replace-all' : 'sync'),
            });

            if (payload.replaceAll) {
                await client.query('DELETE FROM system.settings');
                await client.query('DELETE FROM system.plugin_custom_storage');
                await client.query('DELETE FROM system.bot_presets');
                await client.query('DELETE FROM character.characters');
            }

            if (payload.presets) {
                const existingResult = await client.query('SELECT preset_id, position FROM system.bot_presets ORDER BY position');
                const currentActiveResult = await client.query("SELECT text_val FROM system.settings WHERE key = 'activeBotPresetId'");
                const currentActiveId = currentActiveResult.rows[0]?.text_val;
                const originalIds = existingResult.rows.map((row) => row.preset_id);
                const ids = new Set(existingResult.rows.map((row) => row.preset_id));
                for (const id of payload.presets.deletes) ids.delete(id);
                for (const entry of payload.presets.upserts) ids.add(entry.id);
                if (ids.size === 0) throw new PostgresPayloadError('At least one bot preset must remain');
                if (payload.presets.order && (payload.presets.order.length !== ids.size ||
                    new Set(payload.presets.order).size !== ids.size || payload.presets.order.some((id) => !ids.has(id)))) {
                    throw new PostgresPayloadError('Preset order must contain every preset ID exactly once');
                }
                if (payload.presets.activeId !== undefined && !ids.has(payload.presets.activeId)) {
                    throw new PostgresPayloadError('Active bot preset does not exist');
                }
                if (payload.presets.deletes.length) {
                    await client.query('DELETE FROM system.bot_presets WHERE preset_id = ANY($1::text[])', [payload.presets.deletes]);
                }
                let nextPosition = existingResult.rows.reduce((max, row) => Math.max(max, Number(row.position)), -1) + 1;
                const existingPositions = new Map(existingResult.rows.map((row) => [row.preset_id, Number(row.position)]));
                for (const entry of payload.presets.upserts) {
                    const data = { ...entry.data }; delete data.id;
                    const serialized = JSON.stringify(data);
                    const contentHash = crypto.createHash('sha256').update(serialized).digest('hex');
                    const position = entry.position ?? existingPositions.get(entry.id) ?? nextPosition++;
                    await client.query(`INSERT INTO system.bot_presets
                        (preset_id, position, name, image, api_type, ai_model, data, content_hash, updated_at)
                        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())
                        ON CONFLICT (preset_id) DO UPDATE SET position=EXCLUDED.position, name=EXCLUDED.name,
                        image=EXCLUDED.image, api_type=EXCLUDED.api_type, ai_model=EXCLUDED.ai_model,
                        data=EXCLUDED.data, content_hash=EXCLUDED.content_hash, updated_at=NOW()`,
                    [entry.id, position, data.name || '', data.image || '', data.apiType || '', data.aiModel || '', serialized, contentHash]);
                }
                if (payload.presets.order) {
                    await client.query('UPDATE system.bot_presets SET position = position + 1000000000');
                    for (const [position, id] of payload.presets.order.entries()) {
                        await client.query('UPDATE system.bot_presets SET position = $1 WHERE preset_id = $2', [position, id]);
                    }
                }
                let activeId = payload.presets.activeId;
                if (activeId === undefined) {
                    if (!currentActiveId || !ids.has(currentActiveId)) {
                        const deletedIndex = originalIds.indexOf(currentActiveId);
                        activeId = originalIds.slice(deletedIndex + 1).find((id) => ids.has(id)) ||
                            originalIds.slice(0, Math.max(0, deletedIndex)).reverse().find((id) => ids.has(id)) ||
                            (payload.presets.order || Array.from(ids))[0];
                    }
                }
                if (activeId !== undefined) payload.rootUpserts.push({ key: 'activeBotPresetId', value: activeId });
            }

            onProgress?.({ stage: 'settings', message: `Syncing settings (${payload.rootUpserts.length})`, count: payload.rootUpserts.length });
            const rootSettingUpserts = payload.rootUpserts.filter((row) => row.key !== 'pluginCustomStorage');
            if (rootSettingUpserts.length > 0) {
                const settingRows = rootSettingUpserts.map((row) => {
                    const mapped = mapSettingValueToColumns(row.value);
                    return { key: row.key, ...mapped };
                });
                await bulkInsert(
                    client,
                    'system.settings',
                    ['key', 'text_val', 'num_val', 'bool_val'],
                    ['text', 'text', 'double precision', 'boolean'],
                    settingRows,
                    buildUpsertClause('system.settings', ['key'], ['text_val', 'num_val', 'bool_val'], true)
                );
                await replaceSettingValueRows(client, rootSettingUpserts);
            }
            const changedSettingKeys = rootSettingUpserts.map((item) => item.key);
            const projectedSettings = projectSettings(rootSettingUpserts);
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
            if (payload.pluginStorageClear) {
                await client.query('DELETE FROM system.plugin_custom_storage');
            }
            if (payload.pluginStorageDeletes && payload.pluginStorageDeletes.length > 0) {
                await client.query('DELETE FROM system.plugin_custom_storage WHERE key = ANY($1::text[])',
                    [payload.pluginStorageDeletes]);
            }
            if (payload.pluginStorageUpserts && payload.pluginStorageUpserts.length > 0) {
                for (const upsert of payload.pluginStorageUpserts) {
                    await client.query(
                        `INSERT INTO system.plugin_custom_storage (key, value, updated_at)
                         VALUES ($1, $2::jsonb, NOW())
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                        [upsert.key, JSON.stringify(upsert.value)]
                    );
                }
            }
            if (payload.pluginStorageClear || (payload.pluginStorageDeletes && payload.pluginStorageDeletes.length > 0) || (payload.pluginStorageUpserts && payload.pluginStorageUpserts.length > 0)) {
                this.pluginCustomStorageCache = null;
                this.bootstrapCache = null;
                this.bootstrapCacheGeneration++;
            }

            onProgress?.({ stage: 'characters', message: `Syncing characters (${payload.characters.length})`, count: payload.characters.length });
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
                buildUpsertClause('character.characters', ['id'], characterColumns.slice(1), true)
            );

            const characterRows = (name) => splitCharacters.flatMap((item) => item[name]);

            // 1. attributes (PK: character_id, key)
            const charAttrRows = splitCharacters.flatMap((item) => item.attributes.map((row) => ({ ...row, character_id: item.core.id })));
            await bulkInsert(client, 'character.attributes', ['character_id', 'key', 'value'], ['text', 'text', 'jsonb'], charAttrRows,
                buildUpsertClause('character.attributes', ['character_id', 'key'], ['value']));
            await pruneKeyedChildren(client, 'character.attributes', 'character_id', 'key',
                splitCharacters.map((c) => ({ ownerId: c.core.id, keys: (c.attributes || []).map((a) => a.key) })));

            // 2. tags (PK: character_id, position)
            await bulkInsert(client, 'character.tags', ['character_id', 'position', 'tag'], ['text', 'integer', 'text'], characterRows('tags'),
                buildUpsertClause('character.tags', ['character_id', 'position'], ['tag']));
            await prunePositionalChildren(client, 'character.tags', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.tags || []).length })));

            // 3. greetings (PK: character_id, greeting_type, position)
            await bulkInsert(client, 'character.greetings', ['character_id', 'greeting_type', 'position', 'content'], ['text', 'text', 'integer', 'text'], characterRows('greetings'),
                buildUpsertClause('character.greetings', ['character_id', 'greeting_type', 'position'], ['content']));
            await prunePositionalChildren(client, 'character.greetings', 'character_id',
                splitCharacters.flatMap((c) => [
                    { ownerId: c.core.id, subKind: 'alternate', length: (c.greetings || []).filter((g) => g.greeting_type === 'alternate').length },
                    { ownerId: c.core.id, subKind: 'group-only', length: (c.greetings || []).filter((g) => g.greeting_type === 'group-only').length },
                ]), 'greeting_type');

            // 4. biases (PK: character_id, position)
            await bulkInsert(client, 'character.biases', ['character_id', 'position', 'phrase', 'bias'], ['text', 'integer', 'text', 'double precision'], characterRows('biases'),
                buildUpsertClause('character.biases', ['character_id', 'position'], ['phrase', 'bias']));
            await prunePositionalChildren(client, 'character.biases', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.biases || []).length })));

            // 5. emotions (PK: character_id, position)
            await bulkInsert(client, 'character.emotions', ['character_id', 'position', 'emotion', 'asset'], ['text', 'integer', 'text', 'text'], characterRows('emotions'),
                buildUpsertClause('character.emotions', ['character_id', 'position'], ['emotion', 'asset']));
            await prunePositionalChildren(client, 'character.emotions', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.emotions || []).length })));

            // 6. modules (PK: character_id, position)
            await bulkInsert(client, 'character.modules', ['character_id', 'position', 'module_id'], ['text', 'integer', 'text'], characterRows('modules'),
                buildUpsertClause('character.modules', ['character_id', 'position'], ['module_id']));
            await prunePositionalChildren(client, 'character.modules', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.modules || []).length })));

            // 7. group_members (PK: group_id, position)
            await bulkInsert(client, 'character.group_members', ['group_id', 'position', 'character_id', 'talk_weight', 'active'], ['text', 'integer', 'text', 'double precision', 'boolean'], characterRows('groupMembers'),
                buildUpsertClause('character.group_members', ['group_id', 'position'], ['character_id', 'talk_weight', 'active']));
            await prunePositionalChildren(client, 'character.group_members', 'group_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.groupMembers || []).length })));

            // 8. chat_folders (PK: character_id, position)
            await bulkInsert(client, 'character.chat_folders', ['character_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['text', 'integer', 'text', 'text', 'text', 'boolean'], characterRows('chatFolders'),
                buildUpsertClause('character.chat_folders', ['character_id', 'position'], ['folder_id', 'name', 'color', 'folded']));
            await prunePositionalChildren(client, 'character.chat_folders', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.chatFolders || []).length })));

            // 9. scripts (PK: character_id, script_kind, position)
            await bulkInsert(client, 'character.scripts', ['character_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'jsonb'], characterRows('scripts'),
                buildUpsertClause('character.scripts', ['character_id', 'script_kind', 'position'], ['comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload']));
            await prunePositionalChildren(client, 'character.scripts', 'character_id',
                splitCharacters.flatMap((c) => [
                    { ownerId: c.core.id, subKind: 'custom', length: (c.scripts || []).filter((s) => s.script_kind === 'custom').length },
                    { ownerId: c.core.id, subKind: 'trigger', length: (c.scripts || []).filter((s) => s.script_kind === 'trigger').length },
                ]), 'script_kind');

            // 10. sd_data (PK: character_id, position)
            await bulkInsert(client, 'character.sd_data', ['character_id', 'position', 'key', 'value'], ['text', 'integer', 'text', 'text'], characterRows('sdData'),
                buildUpsertClause('character.sd_data', ['character_id', 'position'], ['key', 'value']));
            await prunePositionalChildren(client, 'character.sd_data', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.sdData || []).length })));

            // 11. assets (PK: character_id, position)
            await bulkInsert(client, 'character.assets', ['character_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['text', 'integer', 'text', 'text', 'text', 'text', 'text', 'text'], characterRows('assets'),
                buildUpsertClause('character.assets', ['character_id', 'position'], ['asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value']));
            await prunePositionalChildren(client, 'character.assets', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.assets || []).length })));

            // 12. lore_entries (PK: character_id, position)
            await bulkInsert(client, 'character.lore_entries', ['character_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], characterRows('lore'),
                buildUpsertClause('character.lore_entries', ['character_id', 'position'], ['lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload']));
            await prunePositionalChildren(client, 'character.lore_entries', 'character_id',
                splitCharacters.map((c) => ({ ownerId: c.core.id, length: (c.lore || []).length })));

            if (payload.characterTouches.length > 0) {
                for (const touch of payload.characterTouches) {
                    await client.query(
                        `UPDATE character.characters
                         SET last_interaction_time = $2, updated_at = NOW()
                         WHERE id = $1`,
                        [touch.id, touch.lastInteraction]
                    );
                }
            }

            onProgress?.({ stage: 'chats', message: `Syncing chats (${payload.chats.length})`, count: payload.chats.length });
            const splitChats = payload.chats.map(splitChat);
            const chatColumns = ['id', 'character_id', 'position', 'name', 'note', 'sd_data', 'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode', 'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time'];
            await bulkInsert(client, 'chat.chats', chatColumns,
                ['text', 'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text', 'integer', 'text', 'bigint'],
                splitChats.map((item) => item.core),
                buildUpsertClause('chat.chats', ['id'], chatColumns.slice(1), true));

            const chatRows = (name) => splitChats.flatMap((item) => item[name]);

            // 1. attributes (PK: chat_id, key)
            const chatAttrRows = splitChats.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.id })));
            await bulkInsert(client, 'chat.attributes', ['chat_id', 'key', 'value'], ['text', 'text', 'jsonb'], chatAttrRows,
                buildUpsertClause('chat.attributes', ['chat_id', 'key'], ['value']));
            await pruneKeyedChildren(client, 'chat.attributes', 'chat_id', 'key',
                splitChats.map((c) => ({ ownerId: c.core.id, keys: (c.attributes || []).map((a) => a.key) })));

            // 2. suggestions (PK: chat_id, position)
            await bulkInsert(client, 'chat.suggestions', ['chat_id', 'position', 'content'], ['text', 'integer', 'text'], chatRows('suggestions'),
                buildUpsertClause('chat.suggestions', ['chat_id', 'position'], ['content']));
            await prunePositionalChildren(client, 'chat.suggestions', 'chat_id',
                splitChats.map((c) => ({ ownerId: c.core.id, length: (c.suggestions || []).length })));

            // 3. modules (PK: chat_id, position)
            await bulkInsert(client, 'chat.modules', ['chat_id', 'position', 'module_id'], ['text', 'integer', 'text'], chatRows('modules'),
                buildUpsertClause('chat.modules', ['chat_id', 'position'], ['module_id']));
            await prunePositionalChildren(client, 'chat.modules', 'chat_id',
                splitChats.map((c) => ({ ownerId: c.core.id, length: (c.modules || []).length })));

            // 4. script_state (PK: chat_id, key)
            await bulkInsert(client, 'chat.script_state', ['chat_id', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['text', 'text', 'text', 'text', 'double precision', 'boolean'], chatRows('scriptState'),
                buildUpsertClause('chat.script_state', ['chat_id', 'key'], ['value_type', 'text_value', 'number_value', 'boolean_value']));
            await pruneKeyedChildren(client, 'chat.script_state', 'chat_id', 'key',
                splitChats.map((c) => ({ ownerId: c.core.id, keys: (c.scriptState || []).map((s) => s.key) })));

            // 5. bookmarks (PK: chat_id, position)
            await bulkInsert(client, 'chat.bookmarks', ['chat_id', 'position', 'message_id', 'name'], ['text', 'integer', 'text', 'text'], chatRows('bookmarks'),
                buildUpsertClause('chat.bookmarks', ['chat_id', 'position'], ['message_id', 'name']));
            await prunePositionalChildren(client, 'chat.bookmarks', 'chat_id',
                splitChats.map((c) => ({ ownerId: c.core.id, length: (c.bookmarks || []).length })));

            // 6. memory (PK: chat_id, memory_type)
            await bulkInsert(client, 'chat.memory', ['chat_id', 'memory_type', 'payload'], ['text', 'text', 'jsonb'], chatRows('memory'),
                buildUpsertClause('chat.memory', ['chat_id', 'memory_type'], ['payload']));
            await pruneKeyedChildren(client, 'chat.memory', 'chat_id', 'memory_type',
                splitChats.map((c) => ({ ownerId: c.core.id, keys: (c.memory || []).map((m) => m.memory_type) })));

            // 7. lore_entries (PK: chat_id, position)
            await bulkInsert(client, 'chat.lore_entries', ['chat_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['text', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text', 'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer', 'text', 'jsonb'], chatRows('lore'),
                buildUpsertClause('chat.lore_entries', ['chat_id', 'position'], ['lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload']));
            await prunePositionalChildren(client, 'chat.lore_entries', 'chat_id',
                splitChats.map((c) => ({ ownerId: c.core.id, length: (c.lore || []).length })));

            onProgress?.({ stage: 'messages', message: `Syncing messages (${payload.messages.length})`, count: payload.messages.length });
            const splitMessages = payload.messages.map(splitMessage);
            const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
            await bulkInsert(client, 'chat.messages', messageColumns,
                ['text', 'text', 'integer', 'text', 'text', 'bytea', 'text', 'bigint', 'text', 'boolean', 'text', 'boolean'],
                splitMessages.map((item) => item.core),
                buildUpsertClause('chat.messages', ['chat_id', 'id'], messageColumns.slice(2), true));

            // 1. message_attributes
            const msgAttrRows = splitMessages.flatMap((item) => item.attributes.map((row) => ({ ...row, chat_id: item.core.chat_id, message_id: item.core.id })));
            await bulkInsert(client, 'chat.message_attributes', ['chat_id', 'message_id', 'key', 'value'], ['text', 'text', 'text', 'jsonb'], msgAttrRows,
                buildUpsertClause('chat.message_attributes', ['chat_id', 'message_id', 'key'], ['value']));
            for (const item of splitMessages) {
                const keys = (item.attributes || []).map((a) => a.key);
                if (keys.length === 0) {
                    await client.query('DELETE FROM chat.message_attributes WHERE chat_id = $1 AND message_id = $2', [item.core.chat_id, item.core.id]);
                } else {
                    await client.query('DELETE FROM chat.message_attributes WHERE chat_id = $1 AND message_id = $2 AND NOT (key = ANY($3::text[]))', [item.core.chat_id, item.core.id, keys]);
                }
            }

            // 2. message_generation
            const genRows = splitMessages.flatMap((item) => item.generation ? [item.generation] : []);
            await bulkInsert(client, 'chat.message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['text', 'text', 'text', 'text', 'integer', 'integer', 'integer', 'double precision', 'double precision', 'double precision', 'double precision'], genRows,
                buildUpsertClause('chat.message_generation', ['chat_id', 'message_id'], ['model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time']));
            const msgsWithoutGen = splitMessages.filter((m) => !m.generation);
            if (msgsWithoutGen.length > 0) {
                await client.query(
                    `DELETE FROM chat.message_generation AS target
                     USING UNNEST($1::text[], $2::text[]) AS spec(chat_id, message_id)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id`,
                    [msgsWithoutGen.map((m) => m.core.chat_id), msgsWithoutGen.map((m) => m.core.id)]
                );
            }

            // 3. message_prompt_info
            const promptInfoRows = splitMessages.flatMap((item) => item.prompt ? [item.prompt.info] : []);
            await bulkInsert(client, 'chat.message_prompt_info', ['chat_id', 'message_id', 'prompt_name'], ['text', 'text', 'text'], promptInfoRows,
                buildUpsertClause('chat.message_prompt_info', ['chat_id', 'message_id'], ['prompt_name']));
            const msgsWithoutPrompt = splitMessages.filter((m) => !m.prompt?.info);
            if (msgsWithoutPrompt.length > 0) {
                await client.query(
                    `DELETE FROM chat.message_prompt_info AS target
                     USING UNNEST($1::text[], $2::text[]) AS spec(chat_id, message_id)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id`,
                    [msgsWithoutPrompt.map((m) => m.core.chat_id), msgsWithoutPrompt.map((m) => m.core.id)]
                );
            }

            // 4. message_prompt_toggles
            const toggleRows = splitMessages.flatMap((item) => item.prompt?.toggles || []);
            await bulkInsert(client, 'chat.message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'], ['text', 'text', 'integer', 'text', 'text'], toggleRows,
                buildUpsertClause('chat.message_prompt_toggles', ['chat_id', 'message_id', 'position'], ['toggle_key', 'toggle_value']));
            if (splitMessages.length > 0) {
                await client.query(
                    `DELETE FROM chat.message_prompt_toggles AS target
                     USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(chat_id, message_id, target_len)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id AND target.position >= spec.target_len`,
                    [
                        splitMessages.map((m) => m.core.chat_id),
                        splitMessages.map((m) => m.core.id),
                        splitMessages.map((m) => (m.prompt?.toggles || []).length),
                    ]
                );
            }

            // 5. message_prompt_items
            const promptItemRows = splitMessages.flatMap((item) => item.prompt?.items || []);
            await bulkInsert(client, 'chat.message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'], ['text', 'text', 'integer', 'jsonb'], promptItemRows,
                buildUpsertClause('chat.message_prompt_items', ['chat_id', 'message_id', 'position'], ['payload']));
            if (splitMessages.length > 0) {
                await client.query(
                    `DELETE FROM chat.message_prompt_items AS target
                     USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(chat_id, message_id, target_len)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id AND target.position >= spec.target_len`,
                    [
                        splitMessages.map((m) => m.core.chat_id),
                        splitMessages.map((m) => m.core.id),
                        splitMessages.map((m) => (m.prompt?.items || []).length),
                    ]
                );
            }

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
            if (payload.messageDeletes) {
                for (const del of payload.messageDeletes) {
                    if (del.ids.length > 0) {
                        await client.query(
                            `DELETE FROM chat.messages
                             WHERE chat_id = $1 AND id = ANY($2::text[])`,
                            [del.chatId, del.ids]
                        );
                    }
                }
            }

            onProgress?.({ stage: 'finalizing', message: 'Updating metadata and committing' });
            await client.query(
                `UPDATE system.storage_meta
                 SET revision = $1, initialized = TRUE, updated_at = NOW()
                 WHERE singleton = TRUE`,
                [nextRevision]
            );
            await client.query('COMMIT');
            if (changedSettingKeys.includes('plugins') || payload.rootDeletes.includes('plugins')) {
                this.pluginsCache = null;
            }
            if (changedSettingKeys.includes('pluginCustomStorage') || payload.rootDeletes.includes('pluginCustomStorage')) {
                this.pluginCustomStorageCache = null;
            }
            this.invalidateBootstrapCache([...changedSettingKeys, ...payload.rootDeletes]);
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

    async getBotChatStats() {
        this.assertEnabled();
        const result = await this.pool.query(
            `WITH session_counts AS (
                SELECT
                    ch.character_id,
                    ch.id AS chat_id,
                    COUNT(m.id)::integer AS session_msgs,
                    MAX(m.sent_time)::bigint AS max_sent_time,
                    MAX(ch.last_message_time)::bigint AS last_msg_time
                FROM chat.chats ch
                LEFT JOIN chat.messages m ON m.chat_id = ch.id
                GROUP BY ch.character_id, ch.id
            ),
            char_msg_stats AS (
                SELECT
                    ch.character_id,
                    COUNT(m.id)::integer AS total_messages,
                    COUNT(CASE WHEN m.role = 'user' THEN 1 END)::integer AS user_messages,
                    COUNT(CASE WHEN m.role = 'char' THEN 1 END)::integer AS bot_messages,
                    AVG(CASE WHEN m.role = 'char' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END)::double precision AS avg_bot_len,
                    AVG(CASE WHEN m.role = 'user' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END)::double precision AS avg_user_len
                FROM chat.chats ch
                JOIN chat.messages m ON m.chat_id = ch.id
                GROUP BY ch.character_id
            )
            SELECT
                c.id,
                c.name,
                c.image,
                c.kind,
                COUNT(sc.chat_id)::integer AS total_sessions,
                COALESCE(cms.total_messages, 0)::integer AS total_messages,
                COALESCE(cms.user_messages, 0)::integer AS user_messages,
                COALESCE(cms.bot_messages, 0)::integer AS bot_messages,
                COALESCE(MAX(sc.session_msgs), 0)::integer AS longest_session_messages,
                COALESCE(MAX(sc.max_sent_time), MAX(sc.last_msg_time), c.last_interaction_time)::bigint AS last_active_date,
                ROUND(COALESCE(cms.avg_bot_len, 0))::integer AS avg_bot_message_len,
                ROUND(COALESCE(cms.avg_user_len, 0))::integer AS avg_user_message_len
            FROM character.characters c
            LEFT JOIN session_counts sc ON sc.character_id = c.id
            LEFT JOIN char_msg_stats cms ON cms.character_id = c.id
            GROUP BY c.id, c.name, c.image, c.kind, c.position, c.last_interaction_time, cms.total_messages, cms.user_messages, cms.bot_messages, cms.avg_bot_len, cms.avg_user_len
            ORDER BY c.position ASC`
        );
        return result.rows.map((row) => {
            const totalSessions = Number(row.total_sessions || 0);
            const totalMessages = Number(row.total_messages || 0);
            return {
                id: row.id,
                name: row.name || (row.kind === 'group' ? 'Group' : 'Character'),
                avatarKey: row.image || undefined,
                image: row.image || undefined,
                isGroup: row.kind === 'group',
                totalSessions,
                totalMessages,
                userMessages: Number(row.user_messages || 0),
                botMessages: Number(row.bot_messages || 0),
                longestSessionMessages: Number(row.longest_session_messages || 0),
                lastActiveDate: row.last_active_date != null ? Number(row.last_active_date) : null,
                avgBotMessageLen: Number(row.avg_bot_message_len || 0),
                avgUserMessageLen: Number(row.avg_user_message_len || 0),
                avgMessagesPerSession: Number(totalSessions > 0 ? (totalMessages / totalSessions).toFixed(1) : 0),
            };
        });
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
    DEFERRED_SETTING_KEYS,
    PostgresPayloadError,
    PostgresRevisionConflictError,
    PostgresStorage,
    buildUpsertClause,
    decodePostgresJsonValue,
    encodePostgresJsonValue,
    normalizeColdStorageKey,
    validateColdStorageKeys,
    validateColdStorageValue,
    validateSyncPayload,
};
