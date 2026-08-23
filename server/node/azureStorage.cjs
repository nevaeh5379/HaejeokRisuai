// Azure SQL Database / Microsoft SQL Server Storage Driver for RisuAI
// PostgresStorage / OracleStorage 인터페이스와 100% 호환.
// postgresRelationalCodec.cjs / postgresJsonCodec.cjs / postgresSettingsCodec.cjs 재사용.

'use strict';

const sql = require('mssql');
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
    splitCharacter,
    splitChat,
    splitMessage,
    splitLore,
} = require('./postgresRelationalCodec.cjs');
const {
    rebuildSettings,
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

function mapSettingValueToColumns(value) {
    if (typeof value === 'boolean') {
        return { text_val: null, num_val: null, bool_val: value ? 1 : 0 };
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

function mapColumnsToSettingValue(row) {
    if (row.bool_val !== null && row.bool_val !== undefined) return Boolean(row.bool_val);
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

const AZURE_SCHEMA_VERSION = 4;
const RELATIONAL_SCHEMA_LAYOUT = 'relational-schema-v3';
const MAX_SYNC_ROWS = 250000;

const AUDITED_TABLES = [
    'system.settings', 'system.setting_values', 'system.bot_presets',
    'system.personas', 'system.modules', 'system.plugins',
    'system.global_lorebooks', 'system.global_lore_entries', 'system.global_lore_cache_items',
    'system.translator_presets', 'system.hotkeys', 'system.custom_models',
    'system.custom_model_flags', 'system.loadouts', 'system.loadout_character_refs',
    'system.loadout_module_refs', 'system.loadout_variables', 'system.loadout_icons',
    'system.custom_sidebar_items', 'system.ordered_text_settings',
    'system.ordered_number_settings', 'system.string_map_settings',
    'system.bias_entries', 'system.additional_parameters', 'system.fallback_models',
    'system.openrouter_provider_rules', 'system.plugin_custom_storage', 'system.client_storage',
    'character.characters', 'character.attributes', 'character.tags',
    'character.greetings', 'character.biases', 'character.emotions',
    'character.modules', 'character.group_members', 'character.chat_folders',
    'character.scripts', 'character.sd_data', 'character.assets',
    'character.lore_entries', 'character.lore_cache_items',
    'chat.chats', 'chat.attributes', 'chat.suggestions', 'chat.modules',
    'chat.script_state', 'chat.bookmarks', 'chat.memory',
    'chat.lore_entries', 'chat.lore_cache_items', 'chat.messages',
    'chat.message_attributes', 'chat.message_generation',
    'chat.message_prompt_info', 'chat.message_prompt_toggles', 'chat.message_prompt_items',
    'cold.archives', 'cold.archive_attributes', 'cold.field_presence',
    'cold.character_tags', 'cold.character_greetings', 'cold.character_biases',
    'cold.character_emotions', 'cold.character_modules', 'cold.group_members',
    'cold.chat_folders', 'cold.character_scripts', 'cold.character_sd_data',
    'cold.character_assets', 'cold.character_lore_entries', 'cold.character_lore_cache_items',
    'cold.chats', 'cold.chat_attributes', 'cold.chat_suggestions', 'cold.chat_modules',
    'cold.chat_script_state', 'cold.chat_bookmarks', 'cold.chat_memory',
    'cold.chat_lore_entries', 'cold.chat_lore_cache_items', 'cold.messages',
    'cold.message_attributes', 'cold.message_generation',
    'cold.message_prompt_info', 'cold.message_prompt_toggles', 'cold.message_prompt_items',
];

const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);


function assertSqlIdentifier(value) {
    if (typeof value !== 'string') {
        throw new Error(`Unsafe SQL identifier: ${value}`);
    }
    const parts = value.split('.');
    if (parts.length === 1 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0])) {
        return `[${parts[0]}]`;
    }
    if (parts.length === 2 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0]) && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[1])) {
        return `[${parts[0]}].[${parts[1]}]`;
    }
    throw new Error(`Unsafe SQL identifier: ${value}`);
}

function assertDbExplorerIdentifier(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new StoragePayloadError(`${field} must be a non-empty string of at most 128 characters`);
    }
    const parts = value.split('.');
    if (parts.length === 1 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0])) {
        return value;
    }
    if (parts.length === 2 && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[0]) && DB_EXPLORER_IDENTIFIER_PATTERN.test(parts[1])) {
        return value;
    }
    throw new StoragePayloadError(`${field} contains invalid characters`);
}

function groupColdMessageRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.archive_id}\0${row.chat_position}\0${row.message_position}`;
        const items = grouped.get(key) || [];
        items.push(row);
        grouped.set(key, items);
    }
    return grouped;
}

/**
 * Bulk insert helper using SQL Server OPENJSON
 */
async function bulkInsert(reqOrTx, table, columns, columnTypes, rows, mergeKeyColumns = null) {
    if (!rows || rows.length === 0) return;
    const quotedTable = assertSqlIdentifier(table);

    // Map column types to OPENJSON data types
    const openJsonColDefs = [];
    const selectColExprs = [];

    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const type = (columnTypes[i] || 'nvarchar(max)').toLowerCase();
        if (type.startsWith('varbinary')) {
            openJsonColDefs.push(`[${col}] NVARCHAR(MAX) '$.${col}'`);
            selectColExprs.push(`CASE WHEN [${col}] IS NOT NULL THEN CONVERT(VARBINARY(MAX), [${col}], 2) ELSE NULL END AS [${col}]`);
        } else if (type === 'bit' || type === 'boolean') {
            openJsonColDefs.push(`[${col}] BIT '$.${col}'`);
            selectColExprs.push(`[${col}]`);
        } else if (type === 'int' || type === 'integer') {
            openJsonColDefs.push(`[${col}] INT '$.${col}'`);
            selectColExprs.push(`[${col}]`);
        } else if (type === 'bigint') {
            openJsonColDefs.push(`[${col}] BIGINT '$.${col}'`);
            selectColExprs.push(`[${col}]`);
        } else if (type === 'float' || type === 'double precision') {
            openJsonColDefs.push(`[${col}] FLOAT '$.${col}'`);
            selectColExprs.push(`[${col}]`);
        } else {
            openJsonColDefs.push(`[${col}] NVARCHAR(MAX) '$.${col}'`);
            selectColExprs.push(`[${col}]`);
        }
    }

    const CHUNK_SIZE = Math.max(
        1,
        Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || '1000', 10) || 1000
    );
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const preparedChunk = chunk.map((row) => {
            const obj = {};
            for (let c = 0; c < columns.length; c++) {
                const col = columns[c];
                const type = (columnTypes[c] || '').toLowerCase();
                let val = row[col];
                if (val === undefined || val === null) {
                    obj[col] = null;
                } else if (Buffer.isBuffer(val)) {
                    obj[col] = val.toString('hex');
                } else if (typeof val === 'boolean') {
                    obj[col] = val ? 1 : 0;
                } else if (typeof val === 'object') {
                    obj[col] = JSON.stringify(val);
                } else {
                    obj[col] = val;
                }
            }
            return obj;
        });

        const req = reqOrTx.request ? reqOrTx.request() : new sql.Request(reqOrTx);
        req.input('bulkPayload', sql.NVarChar(sql.MAX), JSON.stringify(preparedChunk));

        if (mergeKeyColumns && Array.isArray(mergeKeyColumns) && mergeKeyColumns.length > 0) {
            const matchConditions = mergeKeyColumns.map((k) => `target.[${k}] = source.[${k}]`).join(' AND ');
            const nonKeyCols = columns.filter((c) => !mergeKeyColumns.includes(c));
            let updateClause = '';
            if (nonKeyCols.length > 0) {
                updateClause = `WHEN MATCHED THEN UPDATE SET ${nonKeyCols.map((c) => `[${c}] = source.[${c}]`).join(', ')}`;
            } else {
                updateClause = `WHEN MATCHED THEN UPDATE SET target.[${mergeKeyColumns[0]}] = source.[${mergeKeyColumns[0]}]`;
            }

            const mergeSql = `
                MERGE INTO ${quotedTable} AS target
                USING (
                    SELECT ${selectColExprs.join(', ')}
                    FROM OPENJSON(@bulkPayload)
                    WITH (
                        ${openJsonColDefs.join(',\n                        ')}
                    )
                ) AS source
                ON ${matchConditions}
                ${updateClause}
                WHEN NOT MATCHED THEN
                    INSERT (${columns.map((c) => `[${c}]`).join(', ')})
                    VALUES (${columns.map((c) => `source.[${c}]`).join(', ')});
            `;
            await req.query(mergeSql);
        } else {
            const insertSql = `
                INSERT INTO ${quotedTable} (${columns.map((c) => `[${c}]`).join(', ')})
                SELECT ${selectColExprs.join(', ')}
                FROM OPENJSON(@bulkPayload)
                WITH (
                    ${openJsonColDefs.join(',\n                    ')}
                );
            `;
            await req.query(insertSql);
        }
    }
}

class AzureStorage extends SqlStorageBase {
    constructor(options = {}) {
        super();
        this.options = { ...options };
        this.server = options.server || process.env.AZURE_HOST || '';
        this.database = options.database || process.env.AZURE_DATABASE || '';
        this.user = options.user || process.env.AZURE_USERNAME || '';
        this.password = options.password || process.env.AZURE_PASSWORD || '';
        this.port = parseInt(options.port || process.env.AZURE_PORT || '1433', 10);
        this.poolMax = parseInt(options.poolMax || process.env.AZURE_POOL_MAX || '10', 10);
        this.enabled = options.enabled !== false;
        this.schemaPath = options.schemaPath || path.join(__dirname, 'azure-schema.sql');
        this.pool = null;
        this.poolPromise = null;
    }

    async getPool() {
        if (!this.enabled) {
            throw new Error('Azure SQL storage is disabled');
        }
        if (this.pool && this.pool.connected) {
            return this.pool;
        }
        if (this.poolPromise) {
            return this.poolPromise;
        }
        this.poolPromise = (async () => {
            const config = {
                server: this.server,
                port: this.port,
                database: this.database,
                user: this.user,
                password: this.password,
                connectionTimeout: 60000,
                requestTimeout: 120000,
                options: {
                    encrypt: true,
                    trustServerCertificate: true,
                    enableArithAbort: true,
                },
                pool: {
                    max: this.poolMax,
                    min: 0,
                    idleTimeoutMillis: 30000,
                },
            };
            const p = new sql.ConnectionPool(config);
            p.on('error', (err) => {
                console.error('[AzureStorage] Pool error:', err);
            });
            await p.connect();
            this.pool = p;
            return p;
        })();
        try {
            return await this.poolPromise;
        } finally {
            this.poolPromise = null;
        }
    }

    assertEnabled() {
        if (!this.enabled) {
            throw new Error('Azure SQL storage is not enabled');
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }

    async withTransaction(callback) {
        const pool = await this.getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            const result = await callback(transaction);
            await transaction.commit();
            return result;
        } catch (err) {
            try {
                await transaction.rollback();
            } catch (rollbackErr) {
                // Ignore rollback error if already aborted
            }
            throw err;
        }
    }

    async initialize() {
        const pool = await this.getPool();
        const existing = await pool.request().query(
            "SELECT OBJECT_ID(N'[system].[storage_meta]', N'U') AS table_id"
        );
        if (existing.recordset[0]?.table_id) {
            const current = (await pool.request().query(
                'SELECT schema_version, schema_layout FROM [system].[storage_meta] WHERE singleton = 1'
            )).recordset[0];
            if (current && (Number(current.schema_version) !== AZURE_SCHEMA_VERSION || current.schema_layout !== RELATIONAL_SCHEMA_LAYOUT)) {
                throw new Error(
                    `Unsupported Azure SQL schema ${current.schema_version}/${current.schema_layout}; ` +
                    `expected ${AZURE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}. ` +
                    'Reset the configured development database explicitly before retrying.'
                );
            }
        }
        const schemaSql = await fs.readFile(this.schemaPath, 'utf8');
        const req = pool.request();
        await req.batch(schemaSql);

        // Ensure storage_meta exists
        const metaRes = await pool.request().query('SELECT * FROM [system].[storage_meta] WHERE singleton = 1');
        if (metaRes.recordset.length === 0) {
            await pool.request().query(`
                INSERT INTO [system].[storage_meta] (singleton, schema_version, schema_layout, revision, initialized)
                VALUES (1, ${AZURE_SCHEMA_VERSION}, '${RELATIONAL_SCHEMA_LAYOUT}', 0, 0)
            `);
        }
        const meta = (await pool.request().query(
            'SELECT schema_version, schema_layout FROM [system].[storage_meta] WHERE singleton = 1'
        )).recordset[0];
        if (Number(meta?.schema_version) !== AZURE_SCHEMA_VERSION || meta?.schema_layout !== RELATIONAL_SCHEMA_LAYOUT) {
            throw new Error(
                `Unsupported Azure SQL schema ${meta?.schema_version}/${meta?.schema_layout}; ` +
                `expected ${AZURE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}. ` +
                'Reset the configured development database explicitly before retrying.'
            );
        }
    }

    async getState() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT revision, initialized, schema_version, schema_layout FROM [system].[storage_meta] WHERE singleton = 1');
        const row = res.recordset[0] || { revision: 0, initialized: false, schema_version: AZURE_SCHEMA_VERSION, schema_layout: RELATIONAL_SCHEMA_LAYOUT };
        return {
            revision: parseInt(row.revision, 10) || 0,
            initialized: Boolean(row.initialized),
            schemaVersion: row.schema_version,
            schemaLayout: row.schema_layout,
        };
    }

    async isAssetCatalogInitialized(sourceId) {
        const pool = await this.getPool();
        const result = await pool.request().query(
            'SELECT initialized, source_id FROM [system].[asset_catalog_state] WHERE singleton = 1'
        );
        return Boolean(result.recordset[0]?.initialized) && result.recordset[0]?.source_id === sourceId;
    }

    async listAssetCatalog(prefix = '') {
        const pool = await this.getPool();
        const request = pool.request();
        let query = 'SELECT asset_key FROM [system].[asset_catalog]';
        if (prefix) {
            request.input('prefix_length', sql.Int, prefix.length);
            request.input('prefix', sql.NVarChar(900), prefix);
            query += ' WHERE LEFT(asset_key, @prefix_length) = @prefix';
        }
        query += ' ORDER BY asset_key';
        const result = await request.query(query);
        return result.recordset.map((row) => row.asset_key);
    }

    async listAssetCatalogEntries(prefix = '') {
        const pool = await this.getPool();
        const request = pool.request();
        let query = 'SELECT asset_key, size_bytes, etag, updated_at FROM [system].[asset_catalog]';
        if (prefix) {
            request.input('prefix_length', sql.Int, prefix.length);
            request.input('prefix', sql.NVarChar(900), prefix);
            query += ' WHERE LEFT(asset_key, @prefix_length) = @prefix';
        }
        query += ' ORDER BY asset_key';
        const result = await request.query(query);
        return result.recordset.map((row) => ({
            key: row.asset_key,
            size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
            etag: row.etag ?? null,
            updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
        }));
    }

    async getAssetCatalogStats() {
        const pool = await this.getPool();
        const result = await pool.request().query(
            `SELECT COUNT(*) AS total_objects, ISNULL(SUM(size_bytes), 0) AS total_size
             FROM [system].[asset_catalog]`
        );
        const row = result.recordset[0] || {};
        return {
            totalObjects: Number(row.total_objects) || 0,
            totalSizeBytes: Number(row.total_size) || 0,
        };
    }

    async upsertAssetCatalog(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return 0;
        const pool = await this.getPool();
        const batchSize = 400;
        for (let offset = 0; offset < entries.length; offset += batchSize) {
            const chunk = entries.slice(offset, offset + batchSize);
            const request = pool.request();
            const values = chunk.map((entry, index) => {
                request.input(`key_${index}`, sql.NVarChar(900), entry.key);
                request.input(`size_${index}`, sql.BigInt, entry.size ?? null);
                request.input(`etag_${index}`, sql.NVarChar(900), entry.etag ?? null);
                return `(@key_${index}, @size_${index}, @etag_${index})`;
            });
            await request.query(`MERGE [system].[asset_catalog] AS target
                USING (VALUES ${values.join(',')}) AS source (asset_key, size_bytes, etag)
                ON target.asset_key = source.asset_key
                WHEN MATCHED THEN UPDATE SET
                    size_bytes = COALESCE(source.size_bytes, target.size_bytes),
                    etag = COALESCE(source.etag, target.etag),
                    updated_at = SYSDATETIMEOFFSET()
                WHEN NOT MATCHED THEN INSERT (asset_key, size_bytes, etag)
                    VALUES (source.asset_key, source.size_bytes, source.etag);`);
        }
        return entries.length;
    }

    async removeAssetCatalog(keys) {
        if (!Array.isArray(keys) || keys.length === 0) return 0;
        const pool = await this.getPool();
        let removed = 0;
        const batchSize = 500;
        for (let offset = 0; offset < keys.length; offset += batchSize) {
            const chunk = keys.slice(offset, offset + batchSize);
            const request = pool.request();
            const placeholders = chunk.map((key, index) => {
                request.input(`key_${index}`, sql.NVarChar(900), key);
                return `@key_${index}`;
            });
            const result = await request.query(
                `DELETE FROM [system].[asset_catalog] WHERE asset_key IN (${placeholders.join(',')})`
            );
            removed += result.rowsAffected?.[0] || 0;
        }
        return removed;
    }

    async replaceAssetCatalog(prefix, entries, sourceId) {
        return await this.withTransaction(async (transaction) => {
            if (prefix) {
                await transaction.request()
                    .input('prefix_length', sql.Int, prefix.length)
                    .input('prefix', sql.NVarChar(900), prefix)
                    .query('DELETE FROM [system].[asset_catalog] WHERE LEFT(asset_key, @prefix_length) = @prefix');
            } else {
                await transaction.request().query('DELETE FROM [system].[asset_catalog]');
            }

            const batchSize = 500;
            for (let offset = 0; offset < entries.length; offset += batchSize) {
                const chunk = entries.slice(offset, offset + batchSize);
                const request = transaction.request();
                const values = chunk.map((entry, index) => {
                    request.input(`key_${index}`, sql.NVarChar(900), entry.key);
                    request.input(`size_${index}`, sql.BigInt, entry.size ?? null);
                    request.input(`etag_${index}`, sql.NVarChar(900), entry.etag ?? null);
                    return `(@key_${index}, @size_${index}, @etag_${index})`;
                });
                await request.query(
                    `INSERT INTO [system].[asset_catalog] (asset_key, size_bytes, etag) VALUES ${values.join(',')}`
                );
            }
            await transaction.request()
                .input('source_id', sql.NVarChar(900), sourceId)
                .query(
                `UPDATE [system].[asset_catalog_state]
                 SET initialized = 1, source_id = @source_id, synced_at = SYSDATETIMEOFFSET()
                 WHERE singleton = 1`
            );
            return entries.length;
        });
    }

    async getStatus() {
        const pool = await this.getPool();
        const state = await this.getState();
        const countsRes = await pool.request().query(`
            SELECT 
                (SELECT COUNT(*) FROM [system].[settings]) AS settings_count,
                (SELECT COUNT(*) FROM [character].[characters]) AS characters_count,
                (SELECT COUNT(*) FROM [chat].[chats]) AS chats_count,
                (SELECT COUNT(*) FROM [chat].[messages]) AS messages_count,
                (SELECT COUNT(*) FROM [cold].[archives]) AS cold_archives_count,
                (SELECT COUNT(*) FROM [system].[revisions]) AS revisions_count
        `);
        const counts = countsRes.recordset[0] || {};
        return {
            ...state,
            counts: {
                settings: parseInt(counts.settings_count, 10) || 0,
                characters: parseInt(counts.characters_count, 10) || 0,
                chats: parseInt(counts.chats_count, 10) || 0,
                messages: parseInt(counts.messages_count, 10) || 0,
                coldArchives: parseInt(counts.cold_archives_count, 10) || 0,
                revisions: parseInt(counts.revisions_count, 10) || 0,
            },
        };
    }

    async loadDatabase({ shallow = false, onlyKeys = null } = {}) {
        const pool = await this.getPool();
        const state = await this.getState();

        if (!state.initialized) {
            return { revision: state.revision, initialized: false, database: null };
        }

        const deferredKeysLiteral = DEFERRED_SETTING_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');

        // 1. Settings
        let settingsQuery = 'SELECT [key], [text_val], [num_val], [bool_val] FROM [system].[settings] ORDER BY [key]';
        if (Array.isArray(onlyKeys) && onlyKeys.length > 0) {
            const keysList = onlyKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
            settingsQuery = `SELECT [key], [text_val], [num_val], [bool_val] FROM [system].[settings] WHERE [key] IN (${keysList}) ORDER BY [key]`;
        } else if (shallow) {
            settingsQuery = `SELECT [key], [text_val], [num_val], [bool_val] FROM [system].[settings] WHERE [key] NOT IN (${deferredKeysLiteral}) ORDER BY [key]`;
        }
        const settingsRes = await pool.request().query(settingsQuery);
        const settings = settingsRes.recordset;
        const settingKeys = new Set(settings.map((row) => row.key));
        const settingValuesRes = await pool.request().query(
            'SELECT * FROM [system].[setting_values] ORDER BY setting_key, node_id'
        );
        const database = rebuildSettings(settings,
            settingValuesRes.recordset.filter((row) => settingKeys.has(row.setting_key)));
        for (const row of settings) if (!Object.prototype.hasOwnProperty.call(database, row.key)) {
            database[row.key] = mapColumnsToSettingValue(row);
        }
        if (shallow) {
            database.plugins ??= [];
            // Plugin storage is loaded by key after startup.
            database.pluginCustomStorage = {};
        } else {
            const pluginRows = (await pool.request().query(
                'SELECT [key], [value] FROM [system].[plugin_custom_storage] ORDER BY [key]'
            )).recordset;
            database.pluginCustomStorage = Object.fromEntries(pluginRows.map((row) => [row.key, JSON.parse(row.value)]));
        }

        // 2. Characters & 3. Chats
        let characterRelations;
        let chatRelations;
        let charsRes;
        let chatsRes;

        if (shallow) {
            const [
                cRes, charTagsRes, charGroupMembersRes, charFoldersRes,
                chRes, chatBookmarksRes
            ] = await Promise.all([
                pool.request().query('SELECT * FROM [character].[characters] ORDER BY position, id'),
                pool.request().query('SELECT * FROM [character].[tags] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[group_members] ORDER BY group_id, position'),
                pool.request().query('SELECT * FROM [character].[chat_folders] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [chat].[chats] ORDER BY character_id, position, id'),
                pool.request().query('SELECT * FROM [chat].[bookmarks] ORDER BY chat_id, position'),
            ]);

            charsRes = cRes;
            chatsRes = chRes;

            characterRelations = {
                attributes: new Map(),
                tags: groupRows(charTagsRes.recordset, 'character_id'),
                greetings: new Map(),
                biases: new Map(),
                emotions: new Map(),
                modules: new Map(),
                groupMembers: groupRows(charGroupMembersRes.recordset, 'group_id'),
                chatFolders: groupRows(charFoldersRes.recordset, 'character_id'),
                scripts: new Map(),
                sdData: new Map(),
                assets: new Map(),
                lore: new Map(),
            };

            chatRelations = {
                attributes: new Map(),
                suggestions: new Map(),
                modules: new Map(),
                scriptState: new Map(),
                bookmarks: groupRows(chatBookmarksRes.recordset, 'chat_id'),
                memory: new Map(),
                lore: new Map(),
            };
        } else {
            const [
                cRes, charAttrsRes, charTagsRes, charGreetingsRes, charBiasesRes,
                charEmotionsRes, charModulesRes, charGroupMembersRes, charFoldersRes,
                charScriptsRes, charSdDataRes, charAssetsRes, charLoreEntriesRes,
                chRes, chatAttrsRes, chatSuggestionsRes, chatModulesRes,
                chatScriptStateRes, chatBookmarksRes, chatMemoryRes,
                chatLoreEntriesRes,
            ] = await Promise.all([
                pool.request().query('SELECT * FROM [character].[characters] ORDER BY position, id'),
                pool.request().query('SELECT * FROM [character].[attributes] ORDER BY character_id, [key]'),
                pool.request().query('SELECT * FROM [character].[tags] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[greetings] ORDER BY character_id, greeting_type, position'),
                pool.request().query('SELECT * FROM [character].[biases] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[emotions] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[modules] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[group_members] ORDER BY group_id, position'),
                pool.request().query('SELECT * FROM [character].[chat_folders] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[scripts] ORDER BY character_id, script_kind, position'),
                pool.request().query('SELECT * FROM [character].[sd_data] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[assets] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [character].[lore_entries] ORDER BY character_id, position'),
                pool.request().query('SELECT * FROM [chat].[chats] ORDER BY character_id, position, id'),
                pool.request().query('SELECT * FROM [chat].[attributes] ORDER BY chat_id, [key]'),
                pool.request().query('SELECT * FROM [chat].[suggestions] ORDER BY chat_id, position'),
                pool.request().query('SELECT * FROM [chat].[modules] ORDER BY chat_id, position'),
                pool.request().query('SELECT * FROM [chat].[script_state] ORDER BY chat_id, [key]'),
                pool.request().query('SELECT * FROM [chat].[bookmarks] ORDER BY chat_id, position'),
                pool.request().query('SELECT * FROM [chat].[memory] ORDER BY chat_id, memory_type'),
                pool.request().query('SELECT * FROM [chat].[lore_entries] ORDER BY chat_id, position'),
            ]);

            charsRes = cRes;
            chatsRes = chRes;

            characterRelations = createCharacterRelations({
                attributes: charAttrsRes.recordset,
                tags: charTagsRes.recordset,
                greetings: charGreetingsRes.recordset,
                biases: charBiasesRes.recordset,
                emotions: charEmotionsRes.recordset,
                modules: charModulesRes.recordset,
                groupMembers: charGroupMembersRes.recordset,
                chatFolders: charFoldersRes.recordset,
                scripts: charScriptsRes.recordset,
                sdData: charSdDataRes.recordset,
                assets: charAssetsRes.recordset,
                lore: charLoreEntriesRes.recordset,
            });
            chatRelations = createChatRelations({
                attributes: chatAttrsRes.recordset,
                suggestions: chatSuggestionsRes.recordset,
                modules: chatModulesRes.recordset,
                scriptState: chatScriptStateRes.recordset,
                bookmarks: chatBookmarksRes.recordset,
                memory: chatMemoryRes.recordset,
                lore: chatLoreEntriesRes.recordset,
            });
        }

        // 4. Messages (if not shallow)
        let messages = [];
        let messageRelations = null;

        if (!shallow) {
            const [
                msgsRes, msgAttrsRes, msgGenRes, msgPromptInfoRes,
                msgPromptTogglesRes, msgPromptItemsRes,
            ] = await Promise.all([
                pool.request().query('SELECT * FROM [chat].[messages] ORDER BY chat_id, position, id'),
                pool.request().query('SELECT * FROM [chat].[message_attributes] ORDER BY chat_id, message_id, [key]'),
                pool.request().query('SELECT * FROM [chat].[message_generation]'),
                pool.request().query('SELECT * FROM [chat].[message_prompt_info]'),
                pool.request().query('SELECT * FROM [chat].[message_prompt_toggles] ORDER BY chat_id, message_id, position'),
                pool.request().query('SELECT * FROM [chat].[message_prompt_items] ORDER BY chat_id, message_id, position'),
            ]);

            messages = msgsRes.recordset;
            messageRelations = createMessageRelations({
                attributes: msgAttrsRes.recordset,
                generations: msgGenRes.recordset,
                promptInfos: msgPromptInfoRes.recordset,
                promptToggles: msgPromptTogglesRes.recordset,
                promptItems: msgPromptItemsRes.recordset,
            });
        }

        rebuildDatabaseGraph({
            database,
            characters: charsRes.recordset,
            chats: chatsRes.recordset,
            messages,
            characterRelations,
            chatRelations,
            messageRelations,
            rebuildCharacter,
            rebuildChat,
            rebuildMessage,
            shallow,
        });

        return {
            database,
            revision: state.revision,
            initialized: state.initialized,
        };
    }

    async loadCharacter(characterId) {
        const pool = await this.getPool();
        const [
            charRes, attrsRes, tagsRes, greetingsRes, biasesRes,
            emotionsRes, modulesRes, groupMembersRes, foldersRes,
            scriptsRes, sdDataRes, assetsRes, loreRes,
        ] = await Promise.all([
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[characters] WHERE id = @id'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[attributes] WHERE character_id = @id ORDER BY [key]'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[tags] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[greetings] WHERE character_id = @id ORDER BY greeting_type, position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[biases] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[emotions] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[modules] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[group_members] WHERE group_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[chat_folders] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[scripts] WHERE character_id = @id ORDER BY script_kind, position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[sd_data] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[assets] WHERE character_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), characterId).query('SELECT * FROM [character].[lore_entries] WHERE character_id = @id ORDER BY position'),
        ]);

        if (charRes.recordset.length === 0) return null;

        const characterRelations = {
            attributes: attrsRes.recordset,
            tags: tagsRes.recordset,
            greetings: greetingsRes.recordset,
            biases: biasesRes.recordset,
            emotions: emotionsRes.recordset,
            modules: modulesRes.recordset,
            groupMembers: groupMembersRes.recordset,
            chatFolders: foldersRes.recordset,
            scripts: scriptsRes.recordset,
            sdData: sdDataRes.recordset,
            assets: assetsRes.recordset,
            lore: loreRes.recordset,
            chats: [],
        };

        const character = rebuildCharacter(charRes.recordset[0], characterRelations, { shallow: false });
        character.detailsLoaded = true;
        return character;
    }

    async loadChat(chatId) {
        const pool = await this.getPool();
        const [
            chatRes, attrsRes, suggestionsRes, modulesRes,
            scriptStateRes, bookmarksRes, memoryRes, loreRes,
            msgsRes, msgAttrsRes, msgGenRes, msgPromptInfoRes,
            msgPromptTogglesRes, msgPromptItemsRes,
        ] = await Promise.all([
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[chats] WHERE id = @id'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[attributes] WHERE chat_id = @id ORDER BY [key]'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[suggestions] WHERE chat_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[modules] WHERE chat_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[script_state] WHERE chat_id = @id ORDER BY [key]'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[bookmarks] WHERE chat_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[memory] WHERE chat_id = @id ORDER BY memory_type'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[lore_entries] WHERE chat_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[messages] WHERE chat_id = @id ORDER BY position, id'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[message_attributes] WHERE chat_id = @id ORDER BY chat_id, message_id, [key]'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[message_generation] WHERE chat_id = @id'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[message_prompt_info] WHERE chat_id = @id'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[message_prompt_toggles] WHERE chat_id = @id ORDER BY chat_id, message_id, position'),
            pool.request().input('id', sql.NVarChar(450), chatId).query('SELECT * FROM [chat].[message_prompt_items] WHERE chat_id = @id ORDER BY chat_id, message_id, position'),
        ]);

        if (chatRes.recordset.length === 0) return null;

        const messageRelations = {
            attributes: groupMessageRows(msgAttrsRes.recordset),
            generation: new Map(msgGenRes.recordset.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
            promptInfo: new Map(msgPromptInfoRes.recordset.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
            promptToggles: groupMessageRows(msgPromptTogglesRes.recordset),
            promptItems: groupMessageRows(msgPromptItemsRes.recordset),
        };

        const messages = msgsRes.recordset.map((row) => {
            const key = `${row.chat_id}\0${row.id}`;
            const related = {
                attributes: messageRelations.attributes.get(key) || [],
                generation: messageRelations.generation.get(key) || null,
                promptInfo: messageRelations.promptInfo.get(key) || null,
                promptToggles: messageRelations.promptToggles.get(key) || [],
                promptItems: messageRelations.promptItems.get(key) || [],
            };
            return rebuildMessage(row, related);
        });

        const chatRelations = {
            attributes: attrsRes.recordset,
            suggestions: suggestionsRes.recordset,
            modules: modulesRes.recordset,
            scriptState: scriptStateRes.recordset,
            bookmarks: bookmarksRes.recordset,
            memory: memoryRes.recordset,
            lore: loreRes.recordset,
            messages,
        };

        const chat = rebuildChat(chatRes.recordset[0], chatRelations, { shallow: false });
        chat.messagesLoaded = true;
        chat.detailsLoaded = true;
        return chat;
    }

    async loadPlugins() {
        if (this.pluginsCache) {
            return this.pluginsCache;
        }
        const { settings, hash } = await this.loadSettingKeys(['plugins']);
        const result = {
            plugins: settings.plugins || [],
            hash,
        };
        if (this.objectCacheEnabled) this.pluginsCache = result;
        return result;
    }

    async loadPluginCustomStorage() {
        if (this.pluginCustomStorageCache) {
            return this.pluginCustomStorageCache;
        }
        const pool = await this.getPool();
        const rows = (await pool.request().query('SELECT [key], [value] FROM [system].[plugin_custom_storage] ORDER BY [key]')).recordset;
        const pluginCustomStorage = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
        const hash = crypto.createHash('sha256').update(JSON.stringify(pluginCustomStorage)).digest('hex');
        const result = {
            pluginCustomStorage,
            hash,
        };
        if (this.objectCacheEnabled) this.pluginCustomStorageCache = result;
        return result;
    }

    async listPluginCustomStorageKeys() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT [key] FROM [system].[plugin_custom_storage] ORDER BY [key]');
        return res.recordset.map((row) => row.key);
    }

    async loadPluginCustomStorageKey(storageKey) {
        const pool = await this.getPool();
        const request = pool.request();
        request.input('key', sql.NVarChar(450), storageKey);
        const rows = (await request.query('SELECT [value] FROM [system].[plugin_custom_storage] WHERE [key] = @key')).recordset;
        const value = rows.length ? JSON.parse(rows[0].value) : null;
        const serialized = JSON.stringify(value);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex');
        return {
            key: storageKey,
            exists: rows.length > 0,
            value,
            hash,
        };
    }

    async loadSettingKeys(keys) {
        const pool = await this.getPool();
        if (!Array.isArray(keys) || keys.length === 0) {
            return { settings: {}, hash: crypto.createHash('sha256').update('{}').digest('hex') };
        }
        const keysList = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
        const [settingsRes, valuesRes] = await Promise.all([
            pool.request().query(`SELECT [key] FROM [system].[settings] WHERE [key] IN (${keysList}) ORDER BY [key]`),
            pool.request().query(`SELECT * FROM [system].[setting_values] WHERE setting_key IN (${keysList}) ORDER BY setting_key, node_id`),
        ]);
        const rebuilt = rebuildSettings(settingsRes.recordset, valuesRes.recordset);
        if (keys.includes('pluginCustomStorage')) {
            const pluginRows = (await pool.request().query(
                'SELECT [key], [value] FROM [system].[plugin_custom_storage] ORDER BY [key]'
            )).recordset;
            rebuilt.pluginCustomStorage = Object.fromEntries(pluginRows.map((row) => [row.key, JSON.parse(row.value)]));
        }
        const serialized = JSON.stringify(rebuilt);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex');
        return {
            settings: rebuilt,
            hash,
        };
    }

    async listBotPresets() {
        const started = process.hrtime.bigint();
        const pool = await this.getPool();
        const rows = (await pool.request().query(`SELECT preset_id, position, name, image, api_type, ai_model, content_hash
            FROM [system].[bot_presets] ORDER BY position`)).recordset;
        const presets = rows.map((row) => ({ id: row.preset_id, position: Number(row.position), name: row.name || '',
            image: row.image || '', apiType: row.api_type || '', aiModel: row.ai_model || '', hash: row.content_hash }));
        return { presets, hash: crypto.createHash('sha256').update(JSON.stringify(presets)).digest('hex'),
            queryMs: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    async loadBotPreset(id) {
        const started = process.hrtime.bigint();
        const pool = await this.getPool();
        const request = pool.request(); request.input('id', sql.NVarChar(450), id);
        const rows = (await request.query('SELECT data, content_hash FROM [system].[bot_presets] WHERE preset_id = @id')).recordset;
        if (!rows.length) return null;
        return { preset: { ...JSON.parse(rows[0].data), id }, hash: rows[0].content_hash,
            queryMs: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    async reconfigure(options = {}) {
        this.invalidateBootstrapCache();
        if (this.pool) {
            try { await this.pool.close(); } catch (e) {}
            this.pool = null;
        }
        this.server = options.server || this.server;
        this.database = options.database || this.database;
        this.user = options.user || this.user;
        this.password = options.password || this.password;
        this.port = options.port || this.port;
        this.poolMax = options.poolMax || this.poolMax;
        this.enabled = options.enabled !== false;
    }

    async getDatabaseSnapshot() {
        const { database } = await this.loadDatabase({ shallow: false });
        return database;
    }

    async sync(rawPayload, options = {}) {
        const payload = validateSyncPayload(rawPayload);
        const { onProgress } = options;

        return await this.withTransaction(async (tx) => {
            // 1. Check revision with lock
            const metaRes = await tx.request().query('SELECT revision, initialized FROM [system].[storage_meta] WITH (UPDLOCK, HOLDLOCK) WHERE singleton = 1');
            const meta = metaRes.recordset[0] || { revision: 0, initialized: false };
            const currentRevision = parseInt(meta.revision, 10) || 0;

            if (payload.baseRevision !== currentRevision) {
                throw new StorageRevisionConflictError(currentRevision);
            }

            const nextRevision = currentRevision + 1;

            // 2. Create revision row
            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'database');
            revReq.input('action', sql.NVarChar(64), payload.action || (payload.replaceAll ? 'replace-all' : 'sync'));
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action);
            `);
            const revisionId = revRes.recordset[0].id;

            // Set session context for audit trigger
            const ctxReq = tx.request();
            ctxReq.input('rev_id', sql.NVarChar(128), String(revisionId));
            await ctxReq.query(`EXEC sp_set_session_context @key = N'risu_revision_id', @value = @rev_id;`);

            if (onProgress) onProgress({ stage: 'start', message: 'Starting transaction' });

            // 3. Process Settings
            if (payload.replaceAll) {
                await tx.request().query('DELETE FROM [system].[settings];');
                await tx.request().query('DELETE FROM [system].[plugin_custom_storage];');
                await tx.request().query('DELETE FROM [system].[bot_presets];');
            }

            if (payload.presets) {
                const existing = (await tx.request().query('SELECT preset_id, position FROM [system].[bot_presets] ORDER BY position')).recordset;
                const currentActiveId = (await tx.request().query("SELECT text_val FROM [system].[settings] WHERE [key]='activeBotPresetId'")).recordset[0]?.text_val;
                const originalIds = existing.map((row) => row.preset_id);
                const ids = new Set(existing.map((row) => row.preset_id));
                for (const id of payload.presets.deletes) ids.delete(id);
                for (const entry of payload.presets.upserts) ids.add(entry.id);
                if (!ids.size) throw new StoragePayloadError('At least one bot preset must remain');
                if (payload.presets.order && (payload.presets.order.length !== ids.size || new Set(payload.presets.order).size !== ids.size || payload.presets.order.some((id) => !ids.has(id)))) throw new StoragePayloadError('Preset order must contain every preset ID exactly once');
                if (payload.presets.activeId !== undefined && !ids.has(payload.presets.activeId)) throw new StoragePayloadError('Active bot preset does not exist');
                for (const id of payload.presets.deletes) { const r = tx.request(); r.input('id', sql.NVarChar(450), id); await r.query('DELETE FROM [system].[bot_presets] WHERE preset_id=@id'); }
                let nextPosition = existing.reduce((max, row) => Math.max(max, Number(row.position)), -1) + 1;
                const positions = new Map(existing.map((row) => [row.preset_id, Number(row.position)]));
                for (const entry of payload.presets.upserts) {
                    const data = { ...entry.data }; delete data.id; const serialized = JSON.stringify(data);
                    const r = tx.request(); r.input('id', sql.NVarChar(450), entry.id); r.input('position', sql.Int, entry.position ?? positions.get(entry.id) ?? nextPosition++);
                    r.input('name', sql.NVarChar(sql.MAX), data.name || ''); r.input('image', sql.NVarChar(sql.MAX), data.image || '');
                    r.input('api_type', sql.NVarChar(256), data.apiType || ''); r.input('ai_model', sql.NVarChar(512), data.aiModel || '');
                    r.input('data', sql.NVarChar(sql.MAX), serialized); r.input('hash', sql.NVarChar(128), crypto.createHash('sha256').update(serialized).digest('hex'));
                    await r.query(`MERGE [system].[bot_presets] AS t USING (SELECT @id preset_id) AS s ON t.preset_id=s.preset_id
                        WHEN MATCHED THEN UPDATE SET position=@position,name=@name,image=@image,api_type=@api_type,ai_model=@ai_model,data=@data,content_hash=@hash,updated_at=SYSDATETIMEOFFSET()
                        WHEN NOT MATCHED THEN INSERT (preset_id,position,name,image,api_type,ai_model,data,content_hash) VALUES (@id,@position,@name,@image,@api_type,@ai_model,@data,@hash);`);
                }
                if (payload.presets.order) {
                    await tx.request().query('UPDATE [system].[bot_presets] SET position=position+1000000000');
                    for (const [position, id] of payload.presets.order.entries()) { const r=tx.request(); r.input('id',sql.NVarChar(450),id); r.input('position',sql.Int,position); await r.query('UPDATE [system].[bot_presets] SET position=@position WHERE preset_id=@id'); }
                }
                let activeId = payload.presets.activeId;
                if (activeId === undefined) {
                    if (!currentActiveId || !ids.has(currentActiveId)) {
                        const deletedIndex = originalIds.indexOf(currentActiveId);
                        activeId = originalIds.slice(deletedIndex + 1).find((id) => ids.has(id)) || originalIds.slice(0, Math.max(0, deletedIndex)).reverse().find((id) => ids.has(id)) || (payload.presets.order || Array.from(ids))[0];
                    }
                }
                if (activeId !== undefined) payload.rootUpserts.push({ key: 'activeBotPresetId', value: activeId });
            }

            const rootSettingUpserts = (payload.rootUpserts || []).filter((row) => row.key !== 'pluginCustomStorage');
            if (rootSettingUpserts.length > 0) {
                const settingRows = rootSettingUpserts.map((row) => {
                    const mapped = mapSettingValueToColumns(row.value);
                    return { key: row.key, ...mapped };
                });
                await bulkInsert(
                    tx,
                    'system.settings',
                    ['key', 'text_val', 'num_val', 'bool_val'],
                    ['nvarchar(450)', 'nvarchar(max)', 'float', 'bit'],
                    settingRows,
                    ['key']
                );
                const changedKeysList = rootSettingUpserts.map((row) => `'${row.key.replace(/'/g, "''")}'`).join(', ');
                await tx.request().query(`DELETE FROM [system].[setting_values] WHERE setting_key IN (${changedKeysList});`);
                const settingValueRows = rootSettingUpserts.flatMap((row) => splitSetting(row.key, row.value).values);
                await bulkInsert(tx, 'system.setting_values',
                    ['setting_key', 'node_id', 'parent_node_id', 'member_key', 'encoded_member_key', 'position', 'value_type', 'text_value', 'encoded_text_value', 'number_value', 'boolean_value'],
                    ['nvarchar(450)', 'int', 'int', 'nvarchar(max)', 'nvarchar(max)', 'int', 'nvarchar(32)', 'nvarchar(max)', 'nvarchar(max)', 'float', 'bit'],
                    settingValueRows);
            }

            const changedSettingKeys = rootSettingUpserts.map((item) => item.key);

            const projectedSettings = projectSettings(rootSettingUpserts);
            if (changedSettingKeys.length > 0) {
                const keysList = changedSettingKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
                for (const definition of SETTING_RELATION_DEFINITIONS) {
                    await tx.request().query(
                        `DELETE FROM ${assertSqlIdentifier(definition.table)} WHERE [setting_key] IN (${keysList});`
                    );
                }
            }
            for (const definition of SETTING_RELATION_DEFINITIONS) {
                const rows = projectedSettings[definition.table];
                if (rows && rows.length > 0) {
                    await bulkInsert(
                        tx,
                        definition.table,
                        definition.columns,
                        definition.types,
                        rows
                    );
                }
            }
            if (payload.rootDeletes && payload.rootDeletes.length > 0) {
                const delKeys = payload.rootDeletes.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
                await tx.request().query(`DELETE FROM [system].[settings] WHERE [key] IN (${delKeys});`);
            }
            if (payload.pluginStorageClear) {
                await tx.request().query('DELETE FROM [system].[plugin_custom_storage];');
            }
            if (payload.pluginStorageDeletes?.length) {
                const request = tx.request();
                request.input('keys', sql.NVarChar(sql.MAX), JSON.stringify(payload.pluginStorageDeletes));
                await request.query(`DELETE target FROM [system].[plugin_custom_storage] target
                    INNER JOIN OPENJSON(@keys) values_json ON target.[key] = values_json.[value];`);
            }
            for (const item of payload.pluginStorageUpserts || []) {
                const request = tx.request();
                request.input('key', sql.NVarChar(450), item.key);
                request.input('value', sql.NVarChar(sql.MAX), JSON.stringify(item.value));
                await request.query(`MERGE [system].[plugin_custom_storage] AS target
                    USING (SELECT @key AS [key], @value AS [value]) AS source ON target.[key] = source.[key]
                    WHEN MATCHED THEN UPDATE SET [value] = source.[value], updated_at = SYSDATETIMEOFFSET()
                    WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (source.[key], source.[value]);`);
            }

            // 4. Characters, Chats, Messages
            if (payload.replaceAll) {
                await tx.request().query('DELETE FROM [character].[characters];');
            } else if (payload.characterIds && payload.characterIds.length > 0) {
                // characterIds is the full manifest of characters that should exist.
                // Delete characters NOT in the manifest (i.e. removed on the client).
                // ON DELETE CASCADE on chat.chats.character_id and chat.messages.chat_id
                // propagates the removal to chats and messages.
                const charIdsList = payload.characterIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
                await tx.request().query(`DELETE FROM [character].[characters] WHERE id NOT IN (${charIdsList});`);
            }

            // Prune chats/messages removed on the client using the manifests.
            // payload.chatManifests / payload.messageManifests carry the full list of
            // ids that should remain for each parent; anything else must be deleted.
            if (!payload.replaceAll) {
                for (const manifest of payload.chatManifests) {
                    const chatIdsList = manifest.ids.length > 0
                        ? manifest.ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')
                        : null;
                    const chatReq = tx.request();
                    chatReq.input('chat_manifest_character_id', sql.NVarChar(450), manifest.characterId);
                    if (chatIdsList) {
                        await chatReq.query(
                            `DELETE FROM [chat].[chats] WHERE character_id = @chat_manifest_character_id AND id NOT IN (${chatIdsList});`
                        );
                    } else {
                        await chatReq.query(
                            `DELETE FROM [chat].[chats] WHERE character_id = @chat_manifest_character_id;`
                        );
                    }
                }
                for (const manifest of payload.messageManifests) {
                    const msgIdsList = manifest.ids.length > 0
                        ? manifest.ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')
                        : null;
                    const msgReq = tx.request();
                    msgReq.input('msg_manifest_chat_id', sql.NVarChar(450), manifest.chatId);
                    if (msgIdsList) {
                        await msgReq.query(
                            `DELETE FROM [chat].[messages] WHERE chat_id = @msg_manifest_chat_id AND id NOT IN (${msgIdsList});`
                        );
                    } else {
                        await msgReq.query(
                            `DELETE FROM [chat].[messages] WHERE chat_id = @msg_manifest_chat_id;`
                        );
                    }
                }
                if (payload.messageDeletes) {
                    for (const del of payload.messageDeletes) {
                        if (del.ids.length > 0) {
                            const delIdsList = del.ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
                            const delReq = tx.request();
                            delReq.input('msg_del_chat_id', sql.NVarChar(450), del.chatId);
                            await delReq.query(
                                `DELETE FROM [chat].[messages] WHERE chat_id = @msg_del_chat_id AND id IN (${delIdsList});`
                            );
                        }
                    }
                }
            }

            if (payload.characters && payload.characters.length > 0) {
                if (onProgress) onProgress({ stage: 'characters', message: `Inserting ${payload.characters.length} characters` });

                const fullPayloadChars = [];
                const shallowPayloadChars = [];

                for (const charRow of payload.characters) {
                    const data = charRow.data || {};
                    const isShallow = !payload.replaceAll && (data.detailsLoaded === false || (data.firstMessage === undefined && data.desc === undefined && data.description === undefined));
                    if (isShallow) {
                        shallowPayloadChars.push(charRow);
                    } else {
                        fullPayloadChars.push(charRow);
                    }
                }

                // 1. Process full characters (with all details and child tables)
                if (fullPayloadChars.length > 0) {
                    const splitFull = fullPayloadChars.map(splitCharacter);
                    const charScalarCols = [
                        'id', 'position', 'kind', 'name', 'image', 'first_message', 'description',
                        'notes', 'creator_notes', 'system_prompt', 'post_history_instructions',
                        'personality', 'scenario', 'example_message', 'creator', 'character_version',
                        'nickname', 'view_screen', 'chat_page', 'first_message_index', 'utility_bot',
                        'is_private', 'realm_id', 'license', 'default_variables', 'additional_text',
                        'translator_note', 'background_html', 'background_css', 'creation_time',
                        'modification_time', 'last_interaction_time', 'trash_time',
                    ];
                    const charScalarTypes = [
                        'nvarchar(450)', 'int', 'nvarchar(32)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(max)', 'nvarchar(max)', 'int', 'int', 'bit',
                        'bit', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'bigint',
                        'bigint', 'bigint', 'bigint',
                    ];

                    await bulkInsert(tx, 'character.characters', charScalarCols, charScalarTypes, splitFull.map((c) => c.core), ['id']);

                    const changedCharacterIds = fullPayloadChars.map((row) => row.id);
                    const characterChildTables = [
                        'character.attributes', 'character.tags', 'character.greetings',
                        'character.biases', 'character.emotions', 'character.modules',
                        'character.group_members', 'character.chat_folders', 'character.scripts',
                        'character.sd_data', 'character.assets', 'character.lore_entries',
                    ];
                    if (changedCharacterIds.length > 0) {
                        const charDelReq = tx.request();
                        charDelReq.input('charIdsPayload', sql.NVarChar(sql.MAX), JSON.stringify(changedCharacterIds.map((id) => ({ id }))));
                        for (const table of characterChildTables) {
                            const ownerColumn = table === 'character.group_members' ? 'group_id' : 'character_id';
                            await charDelReq.query(`
                                DELETE target
                                FROM ${assertSqlIdentifier(table)} target
                                INNER JOIN OPENJSON(@charIdsPayload) WITH (id NVARCHAR(450) '$.id') src ON target.[${ownerColumn}] = src.id;
                            `);
                        }
                    }

                    const charAttrRows = splitFull.flatMap((c) => (c.attributes || []).map((attr) => ({
                        character_id: c.core.id, key: attr.key, value: JSON.stringify(attr.value),
                    })));
                    await bulkInsert(tx, 'character.attributes', ['character_id', 'key', 'value'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)'], charAttrRows);

                    const charTagRows = splitFull.flatMap((c) => c.tags || []);
                    await bulkInsert(tx, 'character.tags', ['character_id', 'position', 'tag'], ['nvarchar(450)', 'int', 'nvarchar(450)'], charTagRows);

                    const charGreetingRows = splitFull.flatMap((c) => c.greetings || []);
                    await bulkInsert(tx, 'character.greetings', ['character_id', 'greeting_type', 'position', 'content'], ['nvarchar(450)', 'nvarchar(32)', 'int', 'nvarchar(max)'], charGreetingRows);

                    const charBiasRows = splitFull.flatMap((c) => c.biases || []);
                    await bulkInsert(tx, 'character.biases', ['character_id', 'position', 'phrase', 'bias'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'float'], charBiasRows);

                    const charEmotionRows = splitFull.flatMap((c) => c.emotions || []);
                    await bulkInsert(tx, 'character.emotions', ['character_id', 'position', 'emotion', 'asset'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(max)'], charEmotionRows);

                    const charModuleRows = splitFull.flatMap((c) => c.modules || []);
                    await bulkInsert(tx, 'character.modules', ['character_id', 'position', 'module_id'], ['nvarchar(450)', 'int', 'nvarchar(450)'], charModuleRows);

                    const charGroupMemberRows = splitFull.flatMap((c) => c.groupMembers || []);
                    await bulkInsert(tx, 'character.group_members', ['group_id', 'position', 'character_id', 'talk_weight', 'active'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'float', 'bit'], charGroupMemberRows);

                    const charFolderRows = splitFull.flatMap((c) => c.chatFolders || []);
                    await bulkInsert(tx, 'character.chat_folders', ['character_id', 'position', 'folder_id', 'name', 'color', 'folded'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(max)', 'nvarchar(64)', 'bit'], charFolderRows);

                    const charScriptRows = splitFull.flatMap((c) => (c.scripts || []).map((s) => ({
                        ...s,
                        trigger_payload: s.trigger_payload ? JSON.stringify(s.trigger_payload) : null,
                    })));
                    await bulkInsert(tx, 'character.scripts', ['character_id', 'script_kind', 'position', 'comment', 'input_text', 'output_text', 'script_type', 'flag', 'able_flag', 'trigger_payload'], ['nvarchar(450)', 'nvarchar(32)', 'int', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(128)', 'nvarchar(450)', 'bit', 'nvarchar(max)'], charScriptRows);

                    const charSdDataRows = splitFull.flatMap((c) => c.sdData || []);
                    await bulkInsert(tx, 'character.sd_data', ['character_id', 'position', 'key', 'value'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(max)'], charSdDataRows);

                    const charAssetRows = splitFull.flatMap((c) => c.assets || []);
                    await bulkInsert(tx, 'character.assets', ['character_id', 'position', 'asset_source', 'asset_type', 'uri', 'name', 'extension', 'extra_value'], ['nvarchar(450)', 'int', 'nvarchar(32)', 'nvarchar(128)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(64)', 'nvarchar(max)'], charAssetRows);

                    const charLoreRows = splitFull.flatMap((c) => (c.lore || []).map((l) => ({
                        ...l,
                        cache_payload: l.cache_payload !== null && l.cache_payload !== undefined ? JSON.stringify(l.cache_payload) : null,
                    })));
                    await bulkInsert(tx, 'character.lore_entries', ['character_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)', 'int', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(64)', 'bit', 'bit', 'bit', 'float', 'bit', 'int', 'nvarchar(450)', 'nvarchar(max)'], charLoreRows);
                }

                // 2. Process shallow characters (only update position and shallow scalars, preserve existing details)
                if (shallowPayloadChars.length > 0) {
                    const splitShallow = shallowPayloadChars.map(splitCharacter);
                    const shallowCols = [
                        'id', 'position', 'kind', 'name', 'image', 'nickname', 'view_screen', 'chat_page',
                        'first_message_index', 'utility_bot', 'is_private', 'realm_id', 'license',
                        'creation_time', 'modification_time', 'last_interaction_time', 'trash_time',
                    ];
                    const shallowTypes = [
                        'nvarchar(450)', 'int', 'nvarchar(32)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'int', 'int', 'bit', 'bit', 'nvarchar(max)', 'nvarchar(max)',
                        'bigint', 'bigint', 'bigint', 'bigint',
                    ];
                    await bulkInsert(tx, 'character.characters', shallowCols, shallowTypes, splitShallow.map((c) => c.core), ['id']);
                }
            }

            // 5. Chats
            if (payload.chats && payload.chats.length > 0) {
                if (onProgress) onProgress({ stage: 'chats', message: `Inserting ${payload.chats.length} chats` });

                const fullPayloadChats = [];
                const shallowPayloadChats = [];

                for (const chatRow of payload.chats) {
                    const data = chatRow.data || {};
                    const isShallow = !payload.replaceAll && (data.detailsLoaded === false || (!data.localLore && !data.suggestMessages && !data.modules && !data.scriptstate && !data.hypaV2Data && !data.hypaV3Data && !data.attributes));
                    if (isShallow) {
                        shallowPayloadChats.push(chatRow);
                    } else {
                        fullPayloadChats.push(chatRow);
                    }
                }

                if (fullPayloadChats.length > 0) {
                    const splitFull = fullPayloadChats.map(splitChat);
                    const chatScalarCols = [
                        'id', 'character_id', 'position', 'name', 'note', 'sd_data',
                        'supa_memory_data', 'last_memory', 'is_streaming', 'streaming_optimization_mode',
                        'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time',
                    ];
                    const chatScalarTypes = [
                        'nvarchar(450)', 'nvarchar(450)', 'int', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(max)', 'nvarchar(max)', 'bit', 'nvarchar(128)',
                        'nvarchar(450)', 'int', 'nvarchar(450)', 'bigint',
                    ];

                    await bulkInsert(tx, 'chat.chats', chatScalarCols, chatScalarTypes, splitFull.map((c) => c.core), ['id']);

                    const changedChatIds = fullPayloadChats.map((row) => row.id);
                    const chatChildTables = [
                        'chat.attributes', 'chat.suggestions', 'chat.modules', 'chat.script_state',
                        'chat.bookmarks', 'chat.memory', 'chat.lore_entries'
                    ];
                    if (changedChatIds.length > 0) {
                        const chatDelReq = tx.request();
                        chatDelReq.input('chatIdsPayload', sql.NVarChar(sql.MAX), JSON.stringify(changedChatIds.map((id) => ({ id }))));
                        for (const table of chatChildTables) {
                            await chatDelReq.query(`
                                DELETE target
                                FROM ${assertSqlIdentifier(table)} target
                                INNER JOIN OPENJSON(@chatIdsPayload) WITH (id NVARCHAR(450) '$.id') src ON target.[chat_id] = src.id;
                            `);
                        }
                    }

                    const chatAttrRows = splitFull.flatMap((c) => (c.attributes || []).map((attr) => ({
                        chat_id: c.core.id, key: attr.key, value: JSON.stringify(attr.value),
                    })));
                    await bulkInsert(tx, 'chat.attributes', ['chat_id', 'key', 'value'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)'], chatAttrRows);

                    const chatSuggestionRows = splitFull.flatMap((c) => c.suggestions || []);
                    await bulkInsert(tx, 'chat.suggestions', ['chat_id', 'position', 'content'], ['nvarchar(450)', 'int', 'nvarchar(max)'], chatSuggestionRows);

                    const chatModuleRows = splitFull.flatMap((c) => c.modules || []);
                    await bulkInsert(tx, 'chat.modules', ['chat_id', 'position', 'module_id'], ['nvarchar(450)', 'int', 'nvarchar(450)'], chatModuleRows);

                    const chatScriptStateRows = splitFull.flatMap((c) => c.scriptState || []);
                    await bulkInsert(tx, 'chat.script_state', ['chat_id', 'key', 'value_type', 'text_value', 'number_value', 'boolean_value'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(32)', 'nvarchar(max)', 'float', 'bit'], chatScriptStateRows);

                    const chatBookmarkRows = splitFull.flatMap((c) => c.bookmarks || []);
                    await bulkInsert(tx, 'chat.bookmarks', ['chat_id', 'position', 'message_id', 'name'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(max)'], chatBookmarkRows);

                    const chatMemoryRows = splitFull.flatMap((c) => (c.memory || []).map((m) => ({
                        ...m, payload: JSON.stringify(m.payload),
                    })));
                    await bulkInsert(tx, 'chat.memory', ['chat_id', 'memory_type', 'payload'], ['nvarchar(450)', 'nvarchar(128)', 'nvarchar(max)'], chatMemoryRows);

                    const chatLoreRows = splitFull.flatMap((c) => (c.lore || []).map((l) => ({
                        ...l,
                        cache_payload: l.cache_payload !== null && l.cache_payload !== undefined ? JSON.stringify(l.cache_payload) : null,
                    })));
                    await bulkInsert(tx, 'chat.lore_entries', ['chat_id', 'position', 'lore_id', 'primary_key', 'secondary_key', 'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective', 'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder', 'cache_payload'], ['nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)', 'int', 'nvarchar(max)', 'nvarchar(max)', 'nvarchar(64)', 'bit', 'bit', 'bit', 'float', 'bit', 'int', 'nvarchar(450)', 'nvarchar(max)'], chatLoreRows);
                }

                if (shallowPayloadChats.length > 0) {
                    const splitShallow = shallowPayloadChats.map(splitChat);
                    const shallowCols = [
                        'id', 'character_id', 'position', 'name', 'note',
                        'bound_persona_id', 'first_message_index', 'folder_id', 'last_message_time',
                    ];
                    const shallowTypes = [
                        'nvarchar(450)', 'nvarchar(450)', 'int', 'nvarchar(max)', 'nvarchar(max)',
                        'nvarchar(450)', 'int', 'nvarchar(450)', 'bigint',
                    ];
                    await bulkInsert(tx, 'chat.chats', shallowCols, shallowTypes, splitShallow.map((c) => c.core), ['id']);
                }
            }

            // 6. Messages
            if (payload.messages && payload.messages.length > 0) {
                if (onProgress) onProgress({ stage: 'messages', message: `Inserting ${payload.messages.length} messages` });

                const splitMessages = payload.messages.map(splitMessage);

                const msgScalarCols = [
                    'chat_id', 'id', 'position', 'role', 'content_text', 'content_binary',
                    'saying_character_id', 'sent_time', 'sender_name', 'other_user',
                    'disabled_scope', 'is_comment',
                ];
                const msgScalarTypes = [
                    'nvarchar(450)', 'nvarchar(450)', 'int', 'nvarchar(32)', 'nvarchar(max)', 'varbinary(max)',
                    'nvarchar(max)', 'bigint', 'nvarchar(max)', 'bit',
                    'nvarchar(32)', 'bit',
                ];

                await bulkInsert(tx, 'chat.messages', msgScalarCols, msgScalarTypes, splitMessages.map((m) => m.core), ['chat_id', 'id']);

                const msgOwnerPairs = splitMessages.map((m) => ({ chat_id: m.core.chat_id, message_id: m.core.id }));
                const msgChildTables = [
                    'chat.message_attributes', 'chat.message_generation',
                    'chat.message_prompt_info', 'chat.message_prompt_toggles', 'chat.message_prompt_items'
                ];
                const msgDelReq = tx.request();
                msgDelReq.input('pairsPayload', sql.NVarChar(sql.MAX), JSON.stringify(msgOwnerPairs));
                for (const table of msgChildTables) {
                    await msgDelReq.query(`
                        DELETE target
                        FROM ${assertSqlIdentifier(table)} target
                        INNER JOIN OPENJSON(@pairsPayload) WITH (
                            chat_id NVARCHAR(450) '$.chat_id',
                            message_id NVARCHAR(450) '$.message_id'
                        ) src ON target.chat_id = src.chat_id AND target.message_id = src.message_id;
                    `);
                }

                const msgAttrRows = splitMessages.flatMap((m) => (m.attributes || []).map((attr) => ({
                    chat_id: m.core.chat_id, message_id: m.core.id, key: attr.key, value: JSON.stringify(attr.value),
                })));
                await bulkInsert(tx, 'chat.message_attributes', ['chat_id', 'message_id', 'key', 'value'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)'], msgAttrRows);

                const msgGenRows = splitMessages.flatMap((m) => m.generation ? [{ ...m.generation, chat_id: m.core.chat_id, message_id: m.core.id }] : []);
                await bulkInsert(tx, 'chat.message_generation', ['chat_id', 'message_id', 'model', 'generation_id', 'input_tokens', 'output_tokens', 'max_context', 'stage1_time', 'stage2_time', 'stage3_time', 'stage4_time'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(512)', 'nvarchar(450)', 'int', 'int', 'int', 'float', 'float', 'float', 'float'], msgGenRows);

                const msgPromptInfoRows = splitMessages.flatMap((m) => m.prompt?.info ? [{ prompt_name: m.prompt.info.prompt_name, chat_id: m.core.chat_id, message_id: m.core.id }] : []);
                await bulkInsert(tx, 'chat.message_prompt_info', ['chat_id', 'message_id', 'prompt_name'], ['nvarchar(450)', 'nvarchar(450)', 'nvarchar(max)'], msgPromptInfoRows);

                const msgPromptToggleRows = splitMessages.flatMap((m) => (m.prompt?.toggles || []).map((row) => ({
                    ...row, chat_id: m.core.chat_id, message_id: m.core.id,
                })));
                await bulkInsert(tx, 'chat.message_prompt_toggles', ['chat_id', 'message_id', 'position', 'toggle_key', 'toggle_value'], ['nvarchar(450)', 'nvarchar(450)', 'int', 'nvarchar(450)', 'nvarchar(max)'], msgPromptToggleRows);

                const msgPromptItemRows = splitMessages.flatMap((m) => (m.prompt?.items || []).map((row) => ({
                    chat_id: m.core.chat_id, message_id: m.core.id, position: row.position, payload: JSON.stringify(row.payload),
                })));
                await bulkInsert(tx, 'chat.message_prompt_items', ['chat_id', 'message_id', 'position', 'payload'], ['nvarchar(450)', 'nvarchar(450)', 'int', 'nvarchar(max)'], msgPromptItemRows);
            }

            // 7. Update storage meta revision
            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query(`
                UPDATE [system].[storage_meta]
                SET revision = @next_rev, initialized = 1, updated_at = SYSDATETIMEOFFSET()
                WHERE singleton = 1;
            `);

            if (onProgress) onProgress({ stage: 'finish', message: 'Sync complete' });

            return {
                revision: nextRevision,
                revisionId: String(revisionId),
            };
        });

        const changedSettingKeys = payload.rootUpserts?.map((row) => row.key) || [];
        const rootDeletes = payload.rootDeletes || [];
        if (changedSettingKeys.includes('plugins') || rootDeletes.includes('plugins')) {
            this.pluginsCache = null;
        }
        if (changedSettingKeys.includes('pluginCustomStorage') || rootDeletes.includes('pluginCustomStorage')) {
            this.pluginCustomStorageCache = null;
        }
        this.invalidateBootstrapCache([...changedSettingKeys, ...rootDeletes]);

        return syncResult;
    }

    async commitDatabaseSync(payload, options = {}) {
        return this.sync(payload, options);
    }

    // ============================================================
    // Cold Storage API
    // ============================================================

    async getColdStorageKeys() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT id FROM [cold].[archives] ORDER BY updated_at DESC');
        return res.recordset.map((r) => r.id.toLowerCase());
    }

    async getColdStorageItem(key) {
        const normalizedKey = normalizeColdStorageKey(key);
        const pool = await this.getPool();

        const req = pool.request();
        req.input('id', sql.NVarChar(64), normalizedKey);
        const archiveRes = await req.query('SELECT * FROM [cold].[archives] WHERE id = @id');
        if (archiveRes.recordset.length === 0) {
            return null;
        }
        const archiveRow = archiveRes.recordset[0];
        const kind = archiveRow.kind;

        // Attributes
        const attrReq = pool.request();
        attrReq.input('id', sql.NVarChar(64), normalizedKey);
        const attrRes = await attrReq.query('SELECT * FROM [cold].[archive_attributes] WHERE archive_id = @id');
        const attributes = attrRes.recordset;

        if (kind === 'legacy') {
            const rawAttr = attributes.find((a) => a.key === 'raw');
            if (rawAttr) {
                return JSON.parse(rawAttr.value);
            }
            return [];
        }

        // Presence
        const presReq = pool.request();
        presReq.input('id', sql.NVarChar(64), normalizedKey);
        const presRes = await presReq.query('SELECT * FROM [cold].[field_presence] WHERE archive_id = @id');
        const presence = presRes.recordset;

        // Tags, Greetings, Biases, Emotions, Modules, Group Members, Folders, Scripts, SD, Assets, Lore
        const [
            tagsRes, greetingsRes, biasesRes, emotionsRes, modulesRes,
            groupMembersRes, foldersRes, scriptsRes, sdRes, assetsRes,
            loreRes, loreCacheRes,
        ] = await Promise.all([
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_tags] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_greetings] WHERE archive_id = @id ORDER BY greeting_type, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_biases] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_emotions] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_modules] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[group_members] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_folders] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_scripts] WHERE archive_id = @id ORDER BY script_kind, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_sd_data] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_assets] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_lore_entries] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_lore_cache_items] WHERE archive_id = @id ORDER BY lore_position, position'),
        ]);

        // Cold Chats & Messages
        const [
            chatsRes, chatAttrsRes, chatSuggestionsRes, chatModulesRes,
            chatScriptStateRes, chatBookmarksRes, chatMemoryRes,
            chatLoreRes, chatLoreCacheRes,
            msgsRes, msgAttrsRes, msgGenRes, msgPromptInfoRes,
            msgPromptTogglesRes, msgPromptItemsRes,
        ] = await Promise.all([
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chats] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_attributes] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_suggestions] WHERE archive_id = @id ORDER BY chat_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_modules] WHERE archive_id = @id ORDER BY chat_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_script_state] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_bookmarks] WHERE archive_id = @id ORDER BY chat_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_memory] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_lore_entries] WHERE archive_id = @id ORDER BY chat_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_lore_cache_items] WHERE archive_id = @id ORDER BY chat_position, lore_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[messages] WHERE archive_id = @id ORDER BY chat_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[message_attributes] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[message_generation] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[message_prompt_info] WHERE archive_id = @id'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[message_prompt_toggles] WHERE archive_id = @id ORDER BY chat_position, message_position, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[message_prompt_items] WHERE archive_id = @id ORDER BY chat_position, message_position, position'),
        ]);

        const chatAttrsGroup = groupRows(chatAttrsRes.recordset, 'chat_position');
        const chatSuggestionsGroup = groupRows(chatSuggestionsRes.recordset, 'chat_position');
        const chatModulesGroup = groupRows(chatModulesRes.recordset, 'chat_position');
        const chatScriptStateGroup = groupRows(chatScriptStateRes.recordset, 'chat_position');
        const chatBookmarksGroup = groupRows(chatBookmarksRes.recordset, 'chat_position');
        const chatMemoryGroup = groupRows(chatMemoryRes.recordset, 'chat_position');
        const chatLoreGroup = groupRows(chatLoreRes.recordset, 'chat_position');
        const chatLoreCacheGroup = groupRows(chatLoreCacheRes.recordset, 'chat_position');

        const msgsByChatPos = groupRows(msgsRes.recordset, 'chat_position');
        const msgAttrsGroup = groupColdMessageRows(msgAttrsRes.recordset);
        const msgGenGroup = groupColdMessageRows(msgGenRes.recordset);
        const msgPromptInfoGroup = groupColdMessageRows(msgPromptInfoRes.recordset);
        const msgPromptTogglesGroup = groupColdMessageRows(msgPromptTogglesRes.recordset);
        const msgPromptItemsGroup = groupColdMessageRows(msgPromptItemsRes.recordset);

        const chats = [];
        for (const chatRow of chatsRes.recordset) {
            const chatPos = chatRow.position;
            const msgRows = msgsByChatPos.get(chatPos) || [];
            const reconstructedMsgs = msgRows.map((msgRow) => {
                const msgKey = `${normalizedKey}\0${chatPos}\0${msgRow.position}`;
                return rebuildMessage(
                    msgRow,
                    msgAttrsGroup.get(msgKey) || [],
                    (msgGenGroup.get(msgKey) || [])[0] || null,
                    (msgPromptInfoGroup.get(msgKey) || [])[0] || null,
                    msgPromptTogglesGroup.get(msgKey) || [],
                    msgPromptItemsGroup.get(msgKey) || []
                );
            });

            const reconstructedChat = rebuildChat(
                chatRow,
                chatAttrsGroup.get(chatPos) || [],
                chatSuggestionsGroup.get(chatPos) || [],
                chatModulesGroup.get(chatPos) || [],
                chatScriptStateGroup.get(chatPos) || [],
                chatBookmarksGroup.get(chatPos) || [],
                chatMemoryGroup.get(chatPos) || [],
                chatLoreGroup.get(chatPos) || [],
                chatLoreCacheGroup.get(chatPos) || [],
                reconstructedMsgs
            );
            if (chatRow.original_chat_id) {
                reconstructedChat.id = chatRow.original_chat_id;
            }
            chats.push(reconstructedChat);
        }

        if (kind === 'character') {
            const character = rebuildCharacter(
                {
                    id: archiveRow.owner_character_id || normalizedKey,
                    kind: archiveRow.character_kind,
                    name: archiveRow.character_name,
                    image: archiveRow.character_image,
                    first_message: archiveRow.character_first_message,
                    description: archiveRow.character_description,
                    notes: archiveRow.character_notes,
                    creator_notes: archiveRow.character_creator_notes,
                    system_prompt: archiveRow.character_system_prompt,
                    post_history_instructions: archiveRow.character_post_history_instructions,
                    personality: archiveRow.character_personality,
                    scenario: archiveRow.character_scenario,
                    example_message: archiveRow.character_example_message,
                    creator: archiveRow.character_creator,
                    character_version: archiveRow.character_version,
                    nickname: archiveRow.character_nickname,
                    view_screen: archiveRow.character_view_screen,
                    chat_page: archiveRow.character_chat_page,
                    first_message_index: archiveRow.character_first_message_index,
                    utility_bot: archiveRow.character_utility_bot,
                character_translator_note: archiveRow.character_translator_note,
                    background_html: archiveRow.character_background_html,
                    background_css: archiveRow.character_background_css,
                    creation_time: archiveRow.character_creation_time,
                    modification_time: archiveRow.character_modification_time,
                    last_interaction_time: archiveRow.character_last_interaction_time,
                    trash_time: archiveRow.character_trash_time,
                },
                attributes,
                tagsRes.recordset,
                greetingsRes.recordset,
                biasesRes.recordset,
                emotionsRes.recordset,
                modulesRes.recordset,
                groupMembersRes.recordset,
                foldersRes.recordset,
                scriptsRes.recordset,
                sdRes.recordset,
                assetsRes.recordset,
                loreRes.recordset,
                loreCacheRes.recordset,
                chats
            );
            return { character };
        }

        // kind === 'chat'
        const chat = chats[0] || {};
        return { ...chat, message: chat.message || [] };
    }

    // ============================================================
    // Cold Storage
    // ============================================================

    async listColdStorageKeys() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT id FROM [cold].[archives] ORDER BY updated_at DESC, id');
        return res.recordset.map((r) => r.id);
    }

    async listColdStorage() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT id AS [key], kind, revision, updated_at FROM [cold].[archives] ORDER BY updated_at DESC, id');
        return res.recordset;
    }

    async listColdStorageOverview() {
        const pool = await this.getPool();
        const res = await pool.request().query(`
            SELECT a.id AS [key], a.kind, a.revision, a.character_name AS name, a.updated_at,
                   (SELECT COUNT(*) FROM [cold].[chats] c WHERE c.archive_id = a.id) AS chat_count,
                   (SELECT COUNT(*) FROM [cold].[messages] m WHERE m.archive_id = a.id) AS message_count
            FROM [cold].[archives] a
            ORDER BY a.updated_at DESC, a.id
        `);
        return res.recordset.map((r) => ({
            key: r.key,
            kind: r.kind,
            revision: parseInt(r.revision, 10) || 0,
            name: r.name,
            updatedAt: r.updated_at,
            chatCount: parseInt(r.chat_count, 10) || 0,
            messageCount: parseInt(r.message_count, 10) || 0,
        }));
    }

    async inspectColdStorage(key) {
        const loaded = await this.loadColdStorage(key);
        if (!loaded) return null;
        return {
            key: loaded.key,
            kind: loaded.kind,
            revision: loaded.revision,
            updatedAt: loaded.updated_at,
            summary: loaded.kind === 'character' ? {
                name: loaded.data.character?.name || '',
                chats: loaded.data.character?.chats?.length || 0,
            } : loaded.kind === 'chat' ? {
                name: loaded.data.name || '',
                messages: loaded.data.message?.length || 0,
            } : { length: Array.isArray(loaded.data) ? loaded.data.length : 0 },
        };
    }

    async loadColdStorage(key) {
        const normalizedKey = normalizeColdStorageKey(key);
        const pool = await this.getPool();

        const archiveRes = await pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[archives] WHERE id = @id');
        if (archiveRes.recordset.length === 0) return null;
        const archiveRow = archiveRes.recordset[0];

        if (archiveRow.kind === 'legacy') {
            const attrRes = await pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT [key], value FROM [cold].[archive_attributes] WHERE archive_id = @id');
            let legacyData = [];
            for (const r of attrRes.recordset) {
                if (r.key === 'legacy' || r.key === 'raw') {
                    try { legacyData = JSON.parse(r.value); } catch (e) { legacyData = []; }
                }
            }
            return {
                key: normalizedKey,
                kind: 'legacy',
                revision: parseInt(archiveRow.revision, 10) || 0,
                updated_at: archiveRow.updated_at,
                data: legacyData,
            };
        }

        const [
            attrsRes, tagsRes, greetingsRes, biasesRes, emotionsRes,
            modulesRes, groupMembersRes, foldersRes, scriptsRes,
            sdRes, assetsRes, loreRes, chatsRes, msgsRes,
        ] = await Promise.all([
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT [key], value FROM [cold].[archive_attributes] WHERE archive_id = @id ORDER BY [key]'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_tags] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_greetings] WHERE archive_id = @id ORDER BY greeting_type, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_biases] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_emotions] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_modules] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[group_members] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chat_folders] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_scripts] WHERE archive_id = @id ORDER BY script_kind, position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_sd_data] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_assets] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[character_lore_entries] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[chats] WHERE archive_id = @id ORDER BY position'),
            pool.request().input('id', sql.NVarChar(64), normalizedKey).query('SELECT * FROM [cold].[messages] WHERE archive_id = @id ORDER BY chat_position, position'),
        ]);

        const msgsByChatPos = new Map();
        for (const m of msgsRes.recordset) {
            const arr = msgsByChatPos.get(m.chat_position) || [];
            arr.push({
                chatId: m.original_message_id,
                role: m.role,
                data: m.content_text,
                saying: m.saying_character_id,
                time: m.sent_time ? Number(m.sent_time) : undefined,
                name: m.sender_name,
                otherUser: m.other_user,
                disabled: m.disabled_scope === 'true' ? true : m.disabled_scope === 'false' ? false : m.disabled_scope,
                isComment: m.is_comment,
            });
            msgsByChatPos.set(m.chat_position, arr);
        }

        const chats = chatsRes.recordset.map((c) => ({
            id: c.original_chat_id,
            name: c.name,
            note: c.note,
            message: msgsByChatPos.get(c.position) || [],
        }));

        if (archiveRow.kind === 'character') {
            const characterRelations = {
                attributes: attrsRes.recordset,
                tags: tagsRes.recordset,
                greetings: greetingsRes.recordset,
                biases: biasesRes.recordset,
                emotions: emotionsRes.recordset,
                modules: modulesRes.recordset,
                groupMembers: groupMembersRes.recordset,
                chatFolders: foldersRes.recordset,
                scripts: scriptsRes.recordset,
                sdData: sdRes.recordset,
                assets: assetsRes.recordset,
                lore: loreRes.recordset,
                chats,
            };
            const characterCore = {
                id: archiveRow.owner_character_id || normalizedKey,
                position: 0,
                kind: archiveRow.character_kind,
                name: archiveRow.character_name,
                image: archiveRow.character_image,
                first_message: archiveRow.character_first_message,
                description: archiveRow.character_description,
                notes: archiveRow.character_notes,
                creator_notes: archiveRow.character_creator_notes,
                system_prompt: archiveRow.character_system_prompt,
                post_history_instructions: archiveRow.character_post_history_instructions,
                personality: archiveRow.character_personality,
                scenario: archiveRow.character_scenario,
                example_message: archiveRow.character_example_message,
                creator: archiveRow.character_creator,
                character_version: archiveRow.character_version,
                nickname: archiveRow.character_nickname,
                view_screen: archiveRow.character_view_screen,
                chat_page: archiveRow.character_chat_page,
                first_message_index: archiveRow.character_first_message_index,
                utility_bot: archiveRow.character_utility_bot,
                is_private: archiveRow.character_is_private,
                realm_id: archiveRow.character_realm_id,
                license: archiveRow.character_license,
                default_variables: archiveRow.character_default_variables,
                additional_text: archiveRow.character_additional_text,
                translator_note: archiveRow.character_translator_note,
                background_html: archiveRow.character_background_html,
                background_css: archiveRow.character_background_css,
                creation_time: archiveRow.character_creation_time,
                modification_time: archiveRow.character_modification_time,
                last_interaction_time: archiveRow.character_last_interaction_time,
                trash_time: archiveRow.character_trash_time,
            };
            const character = rebuildCharacter(characterCore, characterRelations, { shallow: false });
            return {
                key: normalizedKey,
                kind: 'character',
                revision: parseInt(archiveRow.revision, 10) || 0,
                updated_at: archiveRow.updated_at,
                data: { character },
            };
        }

        const chat = chats[0] || {};
        return {
            key: normalizedKey,
            kind: 'chat',
            revision: parseInt(archiveRow.revision, 10) || 0,
            updated_at: archiveRow.updated_at,
            data: { ...chat, message: chat.message || [] },
        };
    }

    async upsertColdStorage(key, value) {
        const normalizedKey = normalizeColdStorageKey(key);
        const split = splitColdStorageValue(value);

        return await this.withTransaction(async (tx) => {
            const metaRes = await tx.request().query('SELECT revision FROM [system].[storage_meta] WHERE singleton = 1');
            const currentRevision = parseInt(metaRes.recordset[0]?.revision, 10) || 0;
            const nextRevision = currentRevision + 1;

            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'cold-storage');
            revReq.input('action', sql.NVarChar(64), 'upsert');
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action);
            `);
            const revisionId = revRes.recordset[0].id;

            const ctxReq = tx.request();
            ctxReq.input('rev_id', sql.NVarChar(128), String(revisionId));
            await ctxReq.query(`EXEC sp_set_session_context @key = N'risu_revision_id', @value = @rev_id;`);

            const result = await this.upsertColdStorageWithClient(tx, normalizedKey, split);

            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query('UPDATE [system].[storage_meta] SET revision = @next_rev, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1');

            return result;
        });
    }

    async upsertColdStorageWithClient(tx, key, splitValue) {
        let character = null;
        if (splitValue.kind === 'character') {
            const characterData = splitValue.data.character;
            character = splitCharacter({
                id: characterData.chaId || key,
                position: 0,
                data: characterData,
            });
        }

        // Delete existing child tables
        const childTables = [
            'cold.archive_attributes', 'cold.field_presence', 'cold.character_tags',
            'cold.character_greetings', 'cold.character_biases', 'cold.character_emotions',
            'cold.character_modules', 'cold.group_members', 'cold.chat_folders',
            'cold.character_scripts', 'cold.character_sd_data', 'cold.character_assets',
            'cold.character_lore_entries', 'cold.chats', 'cold.messages',
        ];
        for (const table of childTables) {
            const delReq = tx.request();
            delReq.input('id', sql.NVarChar(64), key);
            await delReq.query(`DELETE FROM ${assertSqlIdentifier(table)} WHERE archive_id = @id;`);
        }

        // Upsert archive
        const archReq = tx.request();
        archReq.input('id', sql.NVarChar(64), key);
        archReq.input('kind', sql.NVarChar(32), splitValue.kind);
        archReq.input('owner_id', sql.NVarChar(450), character?.core?.id || null);
        archReq.input('char_kind', sql.NVarChar(32), character?.core?.kind || null);
        archReq.input('char_name', sql.NVarChar(sql.MAX), character?.core?.name || null);
        archReq.input('char_image', sql.NVarChar(sql.MAX), character?.core?.image || null);
        archReq.input('char_first_msg', sql.NVarChar(sql.MAX), character?.core?.first_message || null);
        archReq.input('char_desc', sql.NVarChar(sql.MAX), character?.core?.description || null);
        archReq.input('char_notes', sql.NVarChar(sql.MAX), character?.core?.notes || null);
        archReq.input('char_cnotes', sql.NVarChar(sql.MAX), character?.core?.creator_notes || null);
        archReq.input('char_sprompt', sql.NVarChar(sql.MAX), character?.core?.system_prompt || null);
        archReq.input('char_post_inst', sql.NVarChar(sql.MAX), character?.core?.post_history_instructions || null);
        archReq.input('char_pers', sql.NVarChar(sql.MAX), character?.core?.personality || null);
        archReq.input('char_scen', sql.NVarChar(sql.MAX), character?.core?.scenario || null);
        archReq.input('char_ex_msg', sql.NVarChar(sql.MAX), character?.core?.example_message || null);
        archReq.input('char_creator', sql.NVarChar(sql.MAX), character?.core?.creator || null);
        archReq.input('char_ver', sql.NVarChar(sql.MAX), character?.core?.character_version || null);
        archReq.input('char_nick', sql.NVarChar(sql.MAX), character?.core?.nickname || null);
        archReq.input('char_vscreen', sql.NVarChar(sql.MAX), character?.core?.view_screen || null);
        archReq.input('char_cpage', sql.Int, character?.core?.chat_page || 0);
        archReq.input('char_fm_idx', sql.Int, character?.core?.first_message_index || 0);
        archReq.input('char_ubot', sql.Bit, character?.core?.utility_bot || 0);
        archReq.input('char_priv', sql.Bit, character?.core?.is_private || 0);
        archReq.input('char_realm_id', sql.NVarChar(sql.MAX), character?.core?.realm_id || null);
        archReq.input('char_lic', sql.NVarChar(sql.MAX), character?.core?.license || null);
        archReq.input('char_dvars', sql.NVarChar(sql.MAX), character?.core?.default_variables || null);
        archReq.input('char_atext', sql.NVarChar(sql.MAX), character?.core?.additional_text || null);
        archReq.input('char_tnote', sql.NVarChar(sql.MAX), character?.core?.translator_note || null);
        archReq.input('char_bghtml', sql.NVarChar(sql.MAX), character?.core?.background_html || null);
        archReq.input('char_bgcss', sql.NVarChar(sql.MAX), character?.core?.background_css || null);
        archReq.input('char_ctime', sql.BigInt, character?.core?.creation_time || null);
        archReq.input('char_mtime', sql.BigInt, character?.core?.modification_time || null);
        archReq.input('char_ltime', sql.BigInt, character?.core?.last_interaction_time || null);
        archReq.input('char_ttime', sql.BigInt, character?.core?.trash_time || null);

        await archReq.query(`
            MERGE INTO [cold].[archives] AS target
            USING (SELECT @id AS id) AS source
            ON target.id = source.id
            WHEN MATCHED THEN
                UPDATE SET kind = @kind, owner_character_id = @owner_id,
                           character_kind = @char_kind, character_name = @char_name, character_image = @char_image,
                           character_first_message = @char_first_msg, character_description = @char_desc,
                           character_notes = @char_notes, character_creator_notes = @char_cnotes,
                           character_system_prompt = @char_sprompt, character_post_history_instructions = @char_post_inst,
                           character_personality = @char_pers, character_scenario = @char_scen,
                           character_example_message = @char_ex_msg, character_creator = @char_creator,
                           character_version = @char_ver, character_nickname = @char_nick,
                           character_view_screen = @char_vscreen, character_chat_page = @char_cpage,
                           character_first_message_index = @char_fm_idx, character_utility_bot = @char_ubot,
                           character_is_private = @char_priv, character_realm_id = @char_realm_id,
                           character_license = @char_lic, character_default_variables = @char_dvars,
                           character_additional_text = @char_atext, character_translator_note = @char_tnote,
                           character_background_html = @char_bghtml, character_background_css = @char_bgcss,
                           character_creation_time = @char_ctime, character_modification_time = @char_mtime,
                           character_last_interaction_time = @char_ltime, character_trash_time = @char_ttime,
                           revision = target.revision + 1, updated_at = SYSDATETIMEOFFSET()
            WHEN NOT MATCHED THEN
                INSERT (id, kind, owner_character_id, character_kind, character_name, character_image,
                        character_first_message, character_description, character_notes, character_creator_notes,
                        character_system_prompt, character_post_history_instructions, character_personality,
                        character_scenario, character_example_message, character_creator, character_version,
                        character_nickname, character_view_screen, character_chat_page, character_first_message_index,
                        character_utility_bot, character_is_private, character_realm_id, character_license,
                        character_default_variables, character_additional_text, character_translator_note,
                        character_background_html, character_background_css, character_creation_time,
                        character_modification_time, character_last_interaction_time, character_trash_time)
                VALUES (@id, @kind, @owner_id, @char_kind, @char_name, @char_image,
                        @char_first_msg, @char_desc, @char_notes, @char_cnotes,
                        @char_sprompt, @char_post_inst, @char_pers, @char_scen,
                        @char_ex_msg, @char_creator, @char_ver, @char_nick,
                        @char_vscreen, @char_cpage, @char_fm_idx, @char_ubot,
                        @char_priv, @char_realm_id, @char_lic, @char_dvars,
                        @char_atext, @char_tnote, @char_bghtml, @char_bgcss,
                        @char_ctime, @char_mtime, @char_ltime, @char_ttime);
        `);

        if (splitValue.kind === 'legacy') {
            const attrReq = tx.request();
            attrReq.input('id', sql.NVarChar(64), key);
            attrReq.input('k', sql.NVarChar(450), 'legacy');
            attrReq.input('v', sql.NVarChar(sql.MAX), JSON.stringify(splitValue.data));
            await attrReq.query('INSERT INTO [cold].[archive_attributes] (archive_id, [key], value) VALUES (@id, @k, @v);');
        }

        const res = await tx.request().input('id', sql.NVarChar(64), key).query('SELECT id AS [key], kind, revision, updated_at FROM [cold].[archives] WHERE id = @id');
        return res.recordset[0];
    }

    async deleteColdStorage(rawKeys) {
        const keys = validateColdStorageKeys(rawKeys);
        if (keys.length === 0) return { deleted: 0 };

        return await this.withTransaction(async (tx) => {
            const metaRes = await tx.request().query('SELECT revision FROM [system].[storage_meta] WHERE singleton = 1');
            const currentRevision = parseInt(metaRes.recordset[0]?.revision, 10) || 0;
            const nextRevision = currentRevision + 1;

            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'cold-storage');
            revReq.input('action', sql.NVarChar(64), 'delete');
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action);
            `);
            const revisionId = revRes.recordset[0].id;

            const ctxReq = tx.request();
            ctxReq.input('rev_id', sql.NVarChar(128), String(revisionId));
            await ctxReq.query(`EXEC sp_set_session_context @key = N'risu_revision_id', @value = @rev_id;`);

            const keysList = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
            const delRes = await tx.request().query(`DELETE FROM [cold].[archives] WHERE id IN (${keysList});`);

            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query('UPDATE [system].[storage_meta] SET revision = @next_rev, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1');

            return { deleted: delRes.rowsAffected[0] || 0 };
        });
    }

    async pruneColdStorage(rawRetainedKeys) {
        const retainedKeys = validateColdStorageKeys(rawRetainedKeys, 'retainedKeys');

        return await this.withTransaction(async (tx) => {
            const metaRes = await tx.request().query('SELECT revision FROM [system].[storage_meta] WHERE singleton = 1');
            const currentRevision = parseInt(metaRes.recordset[0]?.revision, 10) || 0;
            const nextRevision = currentRevision + 1;

            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'cold-storage');
            revReq.input('action', sql.NVarChar(64), 'prune');
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action);
            `);
            const revisionId = revRes.recordset[0].id;

            const ctxReq = tx.request();
            ctxReq.input('rev_id', sql.NVarChar(128), String(revisionId));
            await ctxReq.query(`EXEC sp_set_session_context @key = N'risu_revision_id', @value = @rev_id;`);

            let delQuery = 'DELETE FROM [cold].[archives]';
            if (retainedKeys.length > 0) {
                const keysList = retainedKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
                delQuery += ` WHERE id NOT IN (${keysList})`;
            }
            const delRes = await tx.request().query(delQuery);

            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query('UPDATE [system].[storage_meta] SET revision = @next_rev, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1');

            return { deleted: delRes.rowsAffected[0] || 0 };
        });
    }

    async migrateLegacyColdStorage(savePath) {
        this.assertEnabled();
        const candidates = await findLegacyColdStorageFiles(savePath);
        if (candidates.length === 0) return { migrated: 0, skipped: 0 };

        const pool = await this.getPool();
        const keysList = candidates.map((c) => `'${c.key.replace(/'/g, "''")}'`).join(', ');
        const importedRes = await pool.request().query(`SELECT id FROM [cold].[legacy_imports] WHERE id IN (${keysList})`);
        const imported = new Set(importedRes.recordset.map((r) => r.id.toLowerCase()));
        const pending = candidates.filter((c) => !imported.has(c.key.toLowerCase()));

        if (pending.length === 0) return { migrated: 0, skipped: 0 };

        return await this.withTransaction(async (tx) => {
            const metaRes = await tx.request().query('SELECT revision FROM [system].[storage_meta] WHERE singleton = 1');
            const currentRevision = parseInt(metaRes.recordset[0]?.revision, 10) || 0;
            const nextRevision = currentRevision + 1;

            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'cold-storage');
            revReq.input('action', sql.NVarChar(64), 'legacy-import');
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action);
            `);
            const revisionId = revRes.recordset[0].id;

            const ctxReq = tx.request();
            ctxReq.input('rev_id', sql.NVarChar(128), String(revisionId));
            await ctxReq.query(`EXEC sp_set_session_context @key = N'risu_revision_id', @value = @rev_id;`);

            let migrated = 0;
            let skipped = 0;

            for (const candidate of pending) {
                try {
                    const compressed = await fs.readFile(path.join(savePath, candidate.filename));
                    const decompressed = await unzipAsync(compressed);
                    const decoded = JSON.parse(decompressed.toString('utf8'));
                    const splitValue = splitColdStorageValue(decoded);

                    const existingRes = await tx.request().input('id', sql.NVarChar(64), candidate.key).query('SELECT 1 FROM [cold].[archives] WHERE id = @id');
                    if (existingRes.recordset.length === 0) {
                        await this.upsertColdStorageWithClient(tx, candidate.key, splitValue);
                    }

                    await tx.request().input('id', sql.NVarChar(64), candidate.key).query(`
                        IF NOT EXISTS (SELECT 1 FROM [cold].[legacy_imports] WHERE id = @id)
                            INSERT INTO [cold].[legacy_imports] (id) VALUES (@id);
                    `);
                    migrated += 1;
                } catch (error) {
                    skipped += 1;
                    console.error(`[Azure SQL] Could not migrate legacy cold storage ${candidate.key}:`, error.message);
                }
            }

            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query('UPDATE [system].[storage_meta] SET revision = @next_rev, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1');

            return { migrated, skipped };
        });
    }

    async exportColdStorageToLegacy(savePath) {
        this.assertEnabled();
        await fs.mkdir(savePath, { recursive: true });
        const items = await this.listColdStorage();
        const exportedKeys = new Set();
        let exported = 0;

        for (const item of items) {
            const loaded = await this.loadColdStorage(item.key);
            if (!loaded) continue;

            const logicalPath = `coldstorage/${item.key}`;
            const filename = Buffer.from(logicalPath, 'utf8').toString('hex');
            const compressed = await deflateAsync(Buffer.from(JSON.stringify(loaded.data), 'utf8'));
            const targetPath = path.join(savePath, filename);
            const temporaryPath = `${targetPath}.azure-export.tmp`;
            await fs.writeFile(temporaryPath, compressed);
            await fs.rename(temporaryPath, targetPath);
            exportedKeys.add(item.key);
            exported += 1;
        }

        return { exported };
    }

    // ============================================================
    // Revisions & Audit Log
    // ============================================================

    async listRevisions(rawLimit = null) {
        const pool = await this.getPool();
        let topClause = '';
        if (rawLimit !== null && rawLimit !== undefined && rawLimit !== '' && rawLimit !== 'all' && rawLimit !== 0 && rawLimit !== '0') {
            const parsedLimit = Number.parseInt(rawLimit, 10);
            if (Number.isSafeInteger(parsedLimit) && parsedLimit > 0) {
                topClause = `TOP (${parsedLimit})`;
            }
        }

        const res = await pool.request().query(`
            SELECT ${topClause} r.id, r.storage_revision, r.database_initialized, r.scope, r.action,
                   r.restored_from_revision, r.created_at,
                   (SELECT COUNT(*) FROM [system].[audit_log] a WHERE a.revision_id = r.id) AS change_count
            FROM [system].[revisions] r
            ORDER BY r.id DESC
        `);

        return res.recordset.map((r) => ({
            id: Number(r.id),
            storage_revision: r.storage_revision === null ? null : Number(r.storage_revision),
            database_initialized: Boolean(r.database_initialized),
            scope: r.scope,
            action: r.action,
            restored_from_revision: r.restored_from_revision === null ? null : Number(r.restored_from_revision),
            created_at: r.created_at,
            change_count: Number(r.change_count) || 0,
        }));
    }

    async getRevisions() {
        return await this.listRevisions();
    }

    async getRevisionDetails(id) {
        const pool = await this.getPool();
        const revReq = pool.request();
        revReq.input('id', sql.BigInt, id);
        const revRes = await revReq.query('SELECT * FROM [system].[revisions] WHERE id = @id');
        if (revRes.recordset.length === 0) return null;

        const auditReq = pool.request();
        auditReq.input('rev_id', sql.BigInt, id);
        const auditRes = await auditReq.query('SELECT * FROM [system].[audit_log] WHERE revision_id = @rev_id ORDER BY sequence');

        const row = revRes.recordset[0];
        const tableMap = new Map();
        const auditLogs = auditRes.recordset.map((a) => {
            const table = a.table_name;
            const op = a.operation;
            if (!tableMap.has(table)) {
                tableMap.set(table, { tableName: table, insertCount: 0, updateCount: 0, deleteCount: 0, totalCount: 0 });
            }
            const stat = tableMap.get(table);
            stat.totalCount += 1;
            if (op === 'INSERT') stat.insertCount += 1;
            else if (op === 'UPDATE') stat.updateCount += 1;
            else if (op === 'DELETE') stat.deleteCount += 1;

            return {
                sequence: Number(a.sequence),
                tableName: a.table_name,
                operation: a.operation,
                beforeRow: a.before_row ? (typeof a.before_row === 'string' ? JSON.parse(a.before_row) : a.before_row) : null,
                afterRow: a.after_row ? (typeof a.after_row === 'string' ? JSON.parse(a.after_row) : a.after_row) : null,
                recordedAt: a.recorded_at,
            };
        });

        return {
            id: Number(row.id),
            storage_revision: row.storage_revision === null ? null : Number(row.storage_revision),
            database_initialized: Boolean(row.database_initialized),
            scope: row.scope,
            action: row.action,
            restored_from_revision: row.restored_from_revision === null ? null : Number(row.restored_from_revision),
            created_at: row.created_at,
            change_count: auditLogs.length,
            tableSummaries: Array.from(tableMap.values()),
            auditLogs,
        };
    }

    async getRevision(id) {
        return await this.getRevisionDetails(id);
    }

    async getRevisionDiff(baseId, targetId) {
        const pool = await this.getPool();
        const minId = Math.min(Number(baseId), Number(targetId));
        const maxId = Math.max(Number(baseId), Number(targetId));

        const req = pool.request();
        req.input('min_id', sql.BigInt, minId);
        req.input('max_id', sql.BigInt, maxId);
        const auditRes = await req.query(
            'SELECT * FROM [system].[audit_log] WHERE revision_id > @min_id AND revision_id <= @max_id ORDER BY sequence'
        );

        const tableMap = new Map();
        for (const a of auditRes.recordset) {
            const table = a.table_name;
            const op = a.operation;
            if (!tableMap.has(table)) {
                tableMap.set(table, { tableName: table, insertCount: 0, updateCount: 0, deleteCount: 0, totalCount: 0, entries: [] });
            }
            const stat = tableMap.get(table);
            stat.totalCount += 1;
            if (op === 'INSERT') stat.insertCount += 1;
            else if (op === 'UPDATE') stat.updateCount += 1;
            else if (op === 'DELETE') stat.deleteCount += 1;
            stat.entries.push({
                sequence: Number(a.sequence),
                revisionId: Number(a.revision_id),
                tableName: a.table_name,
                operation: a.operation,
                beforeRow: a.before_row ? (typeof a.before_row === 'string' ? JSON.parse(a.before_row) : a.before_row) : null,
                afterRow: a.after_row ? (typeof a.after_row === 'string' ? JSON.parse(a.after_row) : a.after_row) : null,
                recordedAt: a.recorded_at,
            });
        }

        return {
            baseRevisionId: Number(baseId),
            targetRevisionId: Number(targetId),
            totalChanges: auditRes.recordset.length,
            tables: Array.from(tableMap.values()),
        };
    }

    async previewRestore(rawRevisionId) {
        const targetRevisionId = Number(rawRevisionId);
        const pool = await this.getPool();
        const targetReq = pool.request();
        targetReq.input('id', sql.BigInt, targetRevisionId);
        const targetRes = await targetReq.query('SELECT id FROM [system].[revisions] WHERE id = @id');
        if (targetRes.recordset.length === 0) {
            throw new Error('The requested revision does not exist');
        }

        const latestRes = await pool.request().query('SELECT TOP 1 id FROM [system].[revisions] ORDER BY id DESC');
        const currentRevisionId = latestRes.recordset[0]?.id ? Number(latestRes.recordset[0].id) : targetRevisionId;

        const auditReq = pool.request();
        auditReq.input('target_id', sql.BigInt, targetRevisionId);
        const auditRes = await auditReq.query('SELECT * FROM [system].[audit_log] WHERE revision_id > @target_id ORDER BY sequence DESC');

        const tableMap = new Map();
        let restoreInsertCount = 0;
        let restoreDeleteCount = 0;
        let restoreUpdateCount = 0;

        for (const event of auditRes.recordset) {
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
            totalOperations: auditRes.recordset.length,
            restoreInsertCount,
            restoreDeleteCount,
            restoreUpdateCount,
            affectedTables: Array.from(tableMap.values()),
        };
    }

    async restoreRevision(targetRevisionId) {
        return await this.withTransaction(async (tx) => {
            const metaRes = await tx.request().query('SELECT revision FROM [system].[storage_meta] WHERE singleton = 1');
            const currentRevision = parseInt(metaRes.recordset[0]?.revision, 10) || 0;
            const nextRevision = currentRevision + 1;

            const revReq = tx.request();
            revReq.input('storage_rev', sql.BigInt, nextRevision);
            revReq.input('db_init', sql.Bit, 1);
            revReq.input('scope', sql.NVarChar(32), 'restore');
            revReq.input('action', sql.NVarChar(64), `restore_to_${targetRevisionId}`);
            revReq.input('restored_from', sql.BigInt, targetRevisionId);
            const revRes = await revReq.query(`
                INSERT INTO [system].[revisions] (storage_revision, database_initialized, scope, action, restored_from_revision)
                OUTPUT INSERTED.id
                VALUES (@storage_rev, @db_init, @scope, @action, @restored_from);
            `);
            const revisionId = revRes.recordset[0].id;

            const updateMetaReq = tx.request();
            updateMetaReq.input('next_rev', sql.BigInt, nextRevision);
            await updateMetaReq.query('UPDATE [system].[storage_meta] SET revision = @next_rev, updated_at = SYSDATETIMEOFFSET() WHERE singleton = 1');

            return { revision: nextRevision, revisionId };
        });
        this.pluginsCache = null;
        this.pluginCustomStorageCache = null;
        this.invalidateBootstrapCache();
        return result;
    }

    // ============================================================
    // DB Explorer
    // ============================================================

    async getTableNames() {
        const pool = await this.getPool();
        const res = await pool.request().query(`
            SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS full_name
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA IN ('system', 'character', 'chat', 'cold')
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        `);
        return res.recordset.map((r) => r.full_name);
    }

    async getTableSchema(fullTableName) {
        const [schema, table] = fullTableName.split('.');
        const pool = await this.getPool();
        const req = pool.request();
        req.input('schema', sql.NVarChar(128), schema);
        req.input('table', sql.NVarChar(128), table);
        const res = await req.query(`
            SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            ORDER BY ORDINAL_POSITION
        `);
        return res.recordset;
    }

    async getTableRows(fullTableName, { limit = 50, offset = 0 } = {}) {
        const pool = await this.getPool();
        const [schema, table] = fullTableName.split('.');
        const safeTable = `[${schema}].[${table}]`;

        const countRes = await pool.request().query(`SELECT COUNT(*) AS total FROM ${safeTable}`);
        const total = countRes.recordset[0]?.total || 0;

        const res = await pool.request().query(`
            SELECT * FROM ${safeTable}
            ORDER BY (SELECT NULL)
            OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
            total,
            rows: res.recordset,
        };
    }

    async getTokenUsage() {
        this.assertEnabled();
        const pool = await this.getPool();
        const res = await pool.request().query(`
            SELECT model,
                   COUNT(*) AS message_count,
                   COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS total_output_tokens
            FROM (
                SELECT model, input_tokens, output_tokens FROM [chat].[message_generation]
                UNION ALL
                SELECT model, input_tokens, output_tokens FROM [cold].[message_generation]
            ) AS generation
            WHERE model IS NOT NULL
            GROUP BY model
            ORDER BY total_output_tokens DESC, total_input_tokens DESC
        `);
        return res.recordset.map((row) => ({
            model: row.model,
            messageCount: parseInt(row.message_count, 10) || 0,
            totalInputTokens: parseInt(row.total_input_tokens, 10) || 0,
            totalOutputTokens: parseInt(row.total_output_tokens, 10) || 0,
        }));
    }

    async getBotChatStats() {
        this.assertEnabled();
        const pool = await this.getPool();
        const res = await pool.request().query(`
            WITH session_counts AS (
                SELECT
                    ch.character_id,
                    ch.id AS chat_id,
                    COUNT(m.id) AS session_msgs,
                    MAX(m.sent_time) AS max_sent_time,
                    MAX(ch.last_message_time) AS last_msg_time
                FROM [chat].[chats] ch
                LEFT JOIN [chat].[messages] m ON m.chat_id = ch.id
                GROUP BY ch.character_id, ch.id
            ),
            char_msg_stats AS (
                SELECT
                    ch.character_id,
                    COUNT(m.id) AS total_messages,
                    COUNT(CASE WHEN m.role = 'user' THEN 1 END) AS user_messages,
                    COUNT(CASE WHEN m.role = 'char' THEN 1 END) AS bot_messages,
                    AVG(CASE WHEN m.role = 'char' AND m.content_text IS NOT NULL THEN CAST(LEN(m.content_text) AS FLOAT) END) AS avg_bot_len,
                    AVG(CASE WHEN m.role = 'user' AND m.content_text IS NOT NULL THEN CAST(LEN(m.content_text) AS FLOAT) END) AS avg_user_len
                FROM [chat].[chats] ch
                JOIN [chat].[messages] m ON m.chat_id = ch.id
                GROUP BY ch.character_id
            )
            SELECT
                c.id,
                c.name,
                c.image,
                c.kind,
                COUNT(sc.chat_id) AS total_sessions,
                COALESCE(cms.total_messages, 0) AS total_messages,
                COALESCE(cms.user_messages, 0) AS user_messages,
                COALESCE(cms.bot_messages, 0) AS bot_messages,
                COALESCE(MAX(sc.session_msgs), 0) AS longest_session_messages,
                COALESCE(MAX(sc.max_sent_time), MAX(sc.last_msg_time), c.last_interaction_time) AS last_active_date,
                ROUND(COALESCE(cms.avg_bot_len, 0), 0) AS avg_bot_message_len,
                ROUND(COALESCE(cms.avg_user_len, 0), 0) AS avg_user_message_len
            FROM [character].[characters] c
            LEFT JOIN session_counts sc ON sc.character_id = c.id
            LEFT JOIN char_msg_stats cms ON cms.character_id = c.id
            GROUP BY c.id, c.name, c.image, c.kind, c.position, c.last_interaction_time, cms.total_messages, cms.user_messages, cms.bot_messages, cms.avg_bot_len, cms.avg_user_len
            ORDER BY c.position ASC
        `);
        return res.recordset.map((row) => {
            const totalSessions = parseInt(row.total_sessions, 10) || 0;
            const totalMessages = parseInt(row.total_messages, 10) || 0;
            return {
                id: row.id,
                name: row.name || (row.kind === 'group' ? 'Group' : 'Character'),
                avatarKey: row.image || undefined,
                image: row.image || undefined,
                isGroup: row.kind === 'group',
                totalSessions,
                totalMessages,
                userMessages: parseInt(row.user_messages, 10) || 0,
                botMessages: parseInt(row.bot_messages, 10) || 0,
                longestSessionMessages: parseInt(row.longest_session_messages, 10) || 0,
                lastActiveDate: row.last_active_date != null ? parseInt(row.last_active_date, 10) : null,
                avgBotMessageLen: Math.round(Number(row.avg_bot_message_len) || 0),
                avgUserMessageLen: Math.round(Number(row.avg_user_message_len) || 0),
                avgMessagesPerSession: Number(totalSessions > 0 ? (totalMessages / totalSessions).toFixed(1) : 0),
            };
        });
    }

    async listDbExplorerTables() {
        this.assertEnabled();
        const pool = await this.getPool();
        const res = await pool.request().query(`
            SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS table_name
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA IN ('system', 'character', 'chat', 'cold') AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        `);
        const tables = res.recordset.map((row) => assertDbExplorerIdentifier(row.table_name, 'table name'));
        const counts = new Map();
        for (let i = 0; i < tables.length; i += 25) {
            const unionParts = tables.slice(i, i + 25).map(
                (name) => `SELECT '${name.replace(/'/g, "''")}' AS table_name, CAST(COUNT(*) AS NVARCHAR(20)) AS row_count FROM ${assertSqlIdentifier(name)}`
            ).join(' UNION ALL ');
            const countRes = await pool.request().query(unionParts);
            for (const row of countRes.recordset) {
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
        const pool = await this.getPool();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const parts = validated.split('.');
        const schemaName = parts.length === 2 ? parts[0] : 'dbo';
        const tableName = parts.length === 2 ? parts[1] : parts[0];

        const existsRes = await pool.request()
            .input('schema', sql.NVarChar(128), schemaName)
            .input('table', sql.NVarChar(128), tableName)
            .query(`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = @table`);
        if (existsRes.recordset.length === 0) {
            throw new StoragePayloadError('table was not found');
        }

        const colRes = await pool.request()
            .input('schema', sql.NVarChar(128), schemaName)
            .input('table', sql.NVarChar(128), tableName)
            .query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
                    ORDER BY ORDINAL_POSITION`);

        // Primary key via sys indexes
        const pkRes = await pool.request()
            .input('schema', sql.NVarChar(128), schemaName)
            .input('table', sql.NVarChar(128), tableName)
            .query(`SELECT COL_NAME(ic.object_id, ic.column_id) AS column_name
                    FROM sys.indexes AS i
                    JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.tables AS t ON t.object_id = i.object_id
                    JOIN sys.schemas AS s ON s.schema_id = t.schema_id
                    WHERE s.name = @schema AND t.name = @table AND i.is_primary_key = 1`);
        const primaryKeys = new Set(pkRes.recordset.map((row) => row.column_name));

        return colRes.recordset.map((row) => ({
            name: assertDbExplorerIdentifier(row.COLUMN_NAME, 'column name'),
            dataType: row.DATA_TYPE,
            nullable: row.IS_NULLABLE === 'YES',
            primaryKey: primaryKeys.has(row.COLUMN_NAME),
        }));
    }

    async getDbExplorerTableRows(table, rawOffset = 0, rawLimit = 50, rawSortColumn = null, rawSortOrder = 'asc', rawSearch = '', rawColumns = null) {
        this.assertEnabled();
        const pool = await this.getPool();
        const validated = assertDbExplorerIdentifier(table, 'table name');
        const quotedTable = assertSqlIdentifier(validated);
        const columns = await this.getDbExplorerTableColumns(table);
        if (columns.length === 0) {
            throw new StoragePayloadError('table has no columns');
        }

        let visibleColumns = columns;
        if (rawColumns !== null && rawColumns !== undefined) {
            if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
                throw new StoragePayloadError('column list must not be empty');
            }
            const visibleNames = [];
            for (const name of rawColumns) {
                const validatedCol = assertDbExplorerIdentifier(name, 'column name');
                const match = columns.find((column) => column.name === validatedCol);
                if (!match) {
                    throw new StoragePayloadError('column was not found in the table');
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

        const sortColumn = rawSortColumn ? assertDbExplorerIdentifier(rawSortColumn, 'sort column') : null;
        const sortOrder = rawSortOrder === 'desc' ? 'DESC' : 'ASC';

        const columnList = visibleColumns.map((col) => assertSqlIdentifier(col.name)).join(', ');

        // Total count
        const countRes = await pool.request().query(`SELECT COUNT(*) AS total FROM ${quotedTable}`);
        const total = parseInt(countRes.recordset[0]?.total, 10) || 0;

        // Build WHERE for search
        let whereClause = '';
        const request = pool.request();
        if (searchTerm) {
            const likeParts = visibleColumns.map((col, idx) => {
                request.input(`search_${idx}`, sql.NVarChar(4000), `%${searchTerm}%`);
                return `${assertSqlIdentifier(col.name)} LIKE @search_${idx}`;
            });
            whereClause = ' WHERE ' + likeParts.join(' OR ');
        }

        // ORDER BY
        let orderBy = '';
        if (sortColumn) {
            orderBy = ` ORDER BY ${assertSqlIdentifier(sortColumn)} ${sortOrder}`;
        } else {
            // Use first column as default sort for deterministic paging
            orderBy = ` ORDER BY ${assertSqlIdentifier(visibleColumns[0].name)} ASC`;
        }

        // SQL Server uses OFFSET/FETCH for paging (2012+)
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);
        const rowsRes = await request.query(
            `SELECT ${columnList} FROM ${quotedTable}${whereClause}${orderBy} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
        );

        const rows = rowsRes.recordset.map((row) => {
            const obj = {};
            for (const col of visibleColumns) {
                obj[col.name] = row[col.name];
            }
            return obj;
        });

        return {
            columns: visibleColumns.map((col) => ({ name: col.name, dataType: col.dataType })),
            rows,
            total,
            offset,
            limit,
        };
    }

    static async testConnection(config = {}) {
        const testPool = new sql.ConnectionPool({
            server: config.server || process.env.AZURE_HOST,
            port: parseInt(config.port || '1433', 10),
            database: config.database || process.env.AZURE_DATABASE,
            user: config.user || process.env.AZURE_USERNAME,
            password: config.password || process.env.AZURE_PASSWORD,
            connectionTimeout: 30000,
            requestTimeout: 30000,
            options: {
                encrypt: true,
                trustServerCertificate: true,
            },
        });
        try {
            await testPool.connect();
            const res = await testPool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db_name');
            return {
                success: true,
                version: res.recordset[0]?.version,
                database: res.recordset[0]?.db_name,
            };
        } finally {
            try {
                await testPool.close();
            } catch (e) {}
        }
    }
}

module.exports = {
    AzureStorage,
    AZURE_SCHEMA_VERSION,
    AUDITED_TABLES,
    bulkInsert,
    assertSqlIdentifier,
    normalizeColdStorageKey,
};
