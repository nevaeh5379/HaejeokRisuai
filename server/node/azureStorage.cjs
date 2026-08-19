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

const AZURE_SCHEMA_VERSION = 2;
const MAX_SYNC_ROWS = 250000;
const MAX_COLD_STORAGE_KEYS = 250000;

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

const COLD_STORAGE_PATH_PATTERN = /^coldstorage\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12})$/i;
const COLD_STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12}$/i;
const DB_EXPLORER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);

const DEFERRED_SETTING_KEYS = [
    'plugins', 'pluginCustomStorage', 'personas', 'botPresets', 'loreBook',
    'modules', 'globalscript', 'promptTemplate', 'promptSettings', 'mainPrompt',
    'jailbreak', 'globalNote', 'additionalPrompt', 'supaMemoryPrompt',
    'personaPrompt', 'emotionPrompt', 'emotionPrompt2', 'autoSuggestPrompt',
    'translatorPrompt', 'instructChatTemplate', 'JinjaTemplate', 'customTokenizer',
    'customPromptTemplateToggle', 'customModels', 'translatorPresets', 'loadouts',
    'customBackground',
];

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

function asArray(value, field) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new StoragePayloadError(`${field} must be an array`);
    return value;
}

function assertId(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4000) {
        throw new StoragePayloadError(`${field} must be a non-empty string of at most 4000 characters`);
    }
}

function assertPosition(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new StoragePayloadError(`${field} must be a non-negative integer`);
    }
}

function assertData(row, field) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'data') || row.data === null ||
        typeof row.data !== 'object' || Array.isArray(row.data)) {
        throw new StoragePayloadError(`${field} must be a JSON object`);
    }
}

function normalizeColdStorageKey(value, field = 'coldStorageKey') {
    if (typeof value !== 'string' || !COLD_STORAGE_KEY_PATTERN.test(value)) {
        throw new StoragePayloadError(`${field} must be a UUID`);
    }
    return value.toLowerCase();
}

function validateColdStorageValue(rawValue) {
    if (Array.isArray(rawValue)) return rawValue;
    if (!rawValue || typeof rawValue !== 'object') {
        throw new StoragePayloadError('Cold storage data must be an array or an object containing character or message data');
    }
    if ('character' in rawValue) {
        const character = rawValue.character;
        if (!character || typeof character !== 'object' || Array.isArray(character) ||
            (character.chats !== undefined && !Array.isArray(character.chats))) {
            throw new StoragePayloadError('Cold storage character data is invalid');
        }
        for (const chat of character.chats || []) {
            if (!chat || typeof chat !== 'object' || Array.isArray(chat) ||
                (chat.message !== undefined && !Array.isArray(chat.message))) {
                throw new StoragePayloadError('Cold storage character chat data is invalid');
            }
            for (const message of chat.message || []) {
                if (!message || typeof message !== 'object' || Array.isArray(message)) {
                    throw new StoragePayloadError('Cold storage message data is invalid');
                }
            }
        }
        return rawValue;
    }
    if (!('message' in rawValue) || !Array.isArray(rawValue.message)) {
        throw new StoragePayloadError('Cold storage data must be an array or an object containing character or message data');
    }
    return rawValue;
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
            normalizedChats.push({ position: chatPosition, data: chatData, fields: Object.keys(chats[chatPosition]) });
            for (let messagePosition = 0; messagePosition < message.length; messagePosition++) {
                normalizedMessages.push({
                    chatPosition, position: messagePosition,
                    data: message[messagePosition], fields: Object.keys(message[messagePosition]),
                });
            }
        }
        return {
            kind: 'character',
            data: { ...value, character: characterData },
            chats: normalizedChats, messages: normalizedMessages,
            characterFields: Object.keys(value.character),
        };
    }
    const { message, ...chatData } = value;
    return {
        kind: 'chat',
        data: chatData,
        chats: [{ position: 0, data: {}, fields: Object.keys(value) }],
        messages: message.map((item, position) => ({
            chatPosition: 0, position, data: item, fields: Object.keys(item),
        })),
        characterFields: [],
    };
}

function validateColdStorageKeys(value, field = 'keys') {
    const keys = asArray(value, field);
    if (keys.length > MAX_COLD_STORAGE_KEYS) {
        throw new StoragePayloadError(`${field} exceeds the ${MAX_COLD_STORAGE_KEYS} key limit`);
    }
    return Array.from(new Set(keys.map((key) => normalizeColdStorageKey(key, `${field}[]`))));
}

async function findLegacyColdStorageFiles(savePath) {
    try {
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
    } catch (e) {
        return [];
    }
}

function validateSyncPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new StoragePayloadError('Sync payload must be an object');
    }
    if (!Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0) {
        throw new StoragePayloadError('baseRevision must be a non-negative integer');
    }
    let rootUpserts = [];
    let rootDeletes = [];
    if (payload.root !== undefined) {
        if (!payload.root || typeof payload.root !== 'object' || Array.isArray(payload.root)) {
            throw new StoragePayloadError('root must be an object');
        }
        rootUpserts = asArray(payload.root.upserts, 'root.upserts').map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new StoragePayloadError(`root.upserts[${index}] must be an object`);
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
            throw new StoragePayloadError(`characters[${index}] must be an object`);
        }
        assertId(row.id, `characters[${index}].id`);
        assertPosition(row.position, `characters[${index}].position`);
        assertData(row, `characters[${index}].data`);
        return { id: row.id, position: row.position, data: row.data };
    });
    const chats = asArray(payload.chats, 'chats').map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new StoragePayloadError(`chats[${index}] must be an object`);
        }
        assertId(row.id, `chats[${index}].id`);
        assertId(row.characterId, `chats[${index}].characterId`);
        assertPosition(row.position, `chats[${index}].position`);
        assertData(row, `chats[${index}].data`);
        return { id: row.id, characterId: row.characterId, position: row.position, data: row.data };
    });
    const messages = asArray(payload.messages, 'messages').map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new StoragePayloadError(`messages[${index}] must be an object`);
        }
        assertId(row.id, `messages[${index}].id`);
        assertId(row.chatId, `messages[${index}].chatId`);
        assertPosition(row.position, `messages[${index}].position`);
        assertData(row, `messages[${index}].data`);
        return { id: row.id, chatId: row.chatId, position: row.position, data: row.data };
    });
    const chatManifests = asArray(payload.chatManifests, 'chatManifests').map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new StoragePayloadError(`chatManifests[${index}] must be an object`);
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
            throw new StoragePayloadError(`messageManifests[${index}] must be an object`);
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
        rootUpserts, rootDeletes,
        characters, chats, messages,
        chatManifests, messageManifests, characterIds,
    };
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

    const CHUNK_SIZE = 5000;
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

class AzureStorage {
    constructor(options = {}) {
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
        const schemaSql = await fs.readFile(this.schemaPath, 'utf8');
        const req = pool.request();
        await req.batch(schemaSql);

        // Ensure storage_meta exists
        const metaRes = await pool.request().query('SELECT * FROM [system].[storage_meta] WHERE singleton = 1');
        if (metaRes.recordset.length === 0) {
            await pool.request().query(`
                INSERT INTO [system].[storage_meta] (singleton, schema_version, schema_layout, revision, initialized)
                VALUES (1, ${AZURE_SCHEMA_VERSION}, 'relational-schema-v1', 0, 0)
            `);
        }
    }

    async getState() {
        const pool = await this.getPool();
        const res = await pool.request().query('SELECT revision, initialized, schema_version, schema_layout FROM [system].[storage_meta] WHERE singleton = 1');
        const row = res.recordset[0] || { revision: 0, initialized: false, schema_version: AZURE_SCHEMA_VERSION, schema_layout: 'relational-schema-v1' };
        return {
            revision: parseInt(row.revision, 10) || 0,
            initialized: Boolean(row.initialized),
            schemaVersion: row.schema_version,
            schemaLayout: row.schema_layout,
        };
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

        // 1. Settings & Setting values
        let settingsQuery = 'SELECT [key] FROM [system].[settings] ORDER BY [key]';
        if (Array.isArray(onlyKeys) && onlyKeys.length > 0) {
            const keysList = onlyKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
            settingsQuery = `SELECT [key] FROM [system].[settings] WHERE [key] IN (${keysList}) ORDER BY [key]`;
        } else if (shallow) {
            settingsQuery = `SELECT [key] FROM [system].[settings] WHERE [key] NOT IN (${deferredKeysLiteral}) ORDER BY [key]`;
        }
        const settingsRes = await pool.request().query(settingsQuery);
        const settings = settingsRes.recordset;

        let settingValues = [];
        if (settings.length > 0) {
            let svQuery = `
                SELECT setting_key, node_id, parent_node_id, member_key, encoded_member_key,
                       position, value_type, text_value, encoded_text_value, number_value, boolean_value
                FROM [system].[setting_values]
            `;
            if (Array.isArray(onlyKeys) && onlyKeys.length > 0) {
                const keysList = settings.map((s) => `'${s.key.replace(/'/g, "''")}'`).join(', ');
                svQuery += ` WHERE setting_key IN (${keysList})`;
            } else if (shallow) {
                svQuery += ` WHERE setting_key NOT IN (${deferredKeysLiteral})`;
            }
            svQuery += ' ORDER BY setting_key, node_id';
            const svRes = await pool.request().query(svQuery);
            settingValues = svRes.recordset;
        }

        const database = rebuildSettings(settings, settingValues);
        if (shallow) {
            database.plugins ??= [];
            database.pluginCustomStorage ??= {};
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

            characterRelations = {
                attributes: groupRows(charAttrsRes.recordset, 'character_id'),
                tags: groupRows(charTagsRes.recordset, 'character_id'),
                greetings: groupRows(charGreetingsRes.recordset, 'character_id'),
                biases: groupRows(charBiasesRes.recordset, 'character_id'),
                emotions: groupRows(charEmotionsRes.recordset, 'character_id'),
                modules: groupRows(charModulesRes.recordset, 'character_id'),
                groupMembers: groupRows(charGroupMembersRes.recordset, 'group_id'),
                chatFolders: groupRows(charFoldersRes.recordset, 'character_id'),
                scripts: groupRows(charScriptsRes.recordset, 'character_id'),
                sdData: groupRows(charSdDataRes.recordset, 'character_id'),
                assets: groupRows(charAssetsRes.recordset, 'character_id'),
                lore: groupRows(charLoreEntriesRes.recordset, 'character_id'),
            };

            chatRelations = {
                attributes: groupRows(chatAttrsRes.recordset, 'chat_id'),
                suggestions: groupRows(chatSuggestionsRes.recordset, 'chat_id'),
                modules: groupRows(chatModulesRes.recordset, 'chat_id'),
                scriptState: groupRows(chatScriptStateRes.recordset, 'chat_id'),
                bookmarks: groupRows(chatBookmarksRes.recordset, 'chat_id'),
                memory: groupRows(chatMemoryRes.recordset, 'chat_id'),
                lore: groupRows(chatLoreEntriesRes.recordset, 'chat_id'),
            };
        }

        // 4. Messages (if not shallow)
        const messagesByChat = new Map();

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

            const messageRelations = {
                attributes: groupMessageRows(msgAttrsRes.recordset),
                generation: new Map(msgGenRes.recordset.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptInfo: new Map(msgPromptInfoRes.recordset.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
                promptToggles: groupMessageRows(msgPromptTogglesRes.recordset),
                promptItems: groupMessageRows(msgPromptItemsRes.recordset),
            };

            for (const row of msgsRes.recordset) {
                const key = `${row.chat_id}\0${row.id}`;
                const related = {
                    attributes: messageRelations.attributes.get(key) || [],
                    generation: messageRelations.generation.get(key) || null,
                    promptInfo: messageRelations.promptInfo.get(key) || null,
                    promptToggles: messageRelations.promptToggles.get(key) || [],
                    promptItems: messageRelations.promptItems.get(key) || [],
                };
                const items = messagesByChat.get(row.chat_id) || [];
                items.push(rebuildMessage(row, related));
                messagesByChat.set(row.chat_id, items);
            }
        }

        const chatsByCharacter = new Map();
        for (const row of chatsRes.recordset) {
            const related = { messages: messagesByChat.get(row.id) || [] };
            for (const [name, grouped] of Object.entries(chatRelations)) {
                related[name] = grouped.get(row.id) || [];
            }
            const rebuilt = rebuildChat(row, related, { shallow });
            rebuilt.messagesLoaded = !shallow;
            rebuilt.detailsLoaded = !shallow;
            const items = chatsByCharacter.get(row.character_id) || [];
            items.push(rebuilt);
            chatsByCharacter.set(row.character_id, items);
        }

        database.characters = charsRes.recordset.map((row) => {
            const related = { chats: chatsByCharacter.get(row.id) || [] };
            for (const [name, grouped] of Object.entries(characterRelations)) {
                related[name] = grouped.get(row.id) || [];
            }
            const rebuilt = rebuildCharacter(row, related, { shallow });
            rebuilt.detailsLoaded = !shallow;
            return rebuilt;
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

    async loadChatMessages(chatId) {
        const chat = await this.loadChat(chatId);
        return chat ? chat.message : [];
    }

    async loadPlugins() {
        const { settings, hash } = await this.loadSettingKeys(['plugins']);
        return {
            plugins: settings.plugins || [],
            hash,
        };
    }

    async loadPluginCustomStorage() {
        const { settings, hash } = await this.loadSettingKeys(['pluginCustomStorage']);
        return {
            pluginCustomStorage: settings.pluginCustomStorage || {},
            hash,
        };
    }

    async listPluginCustomStorageKeys() {
        const pool = await this.getPool();
        const res = await pool.request().query(`
            SELECT member_key, encoded_member_key
            FROM [system].[setting_values]
            WHERE setting_key = 'pluginCustomStorage' AND parent_node_id = 0
            ORDER BY node_id
        `);
        return res.recordset.map((row) => row.member_key || row.encoded_member_key).filter(Boolean);
    }

    async loadPluginCustomStorageKey(storageKey) {
        const { settings } = await this.loadSettingKeys(['pluginCustomStorage']);
        const customStorage = settings.pluginCustomStorage || {};
        const value = customStorage[storageKey] !== undefined ? customStorage[storageKey] : null;
        const serialized = JSON.stringify(value);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex');
        return {
            key: storageKey,
            exists: customStorage[storageKey] !== undefined,
            value,
            hash,
        };
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
        const serialized = JSON.stringify(rebuilt);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex');
        return {
            settings: rebuilt,
            hash,
        };
    }

    async loadPersonas() {
        const { settings, hash } = await this.loadSettingKeys(['personas']);
        return { personas: settings.personas || [], hash };
    }

    async loadBotPresets() {
        const { settings, hash } = await this.loadSettingKeys(['botPresets']);
        return { botPresets: settings.botPresets || [], hash };
    }

    async loadLorebooks() {
        const { settings, hash } = await this.loadSettingKeys(['loreBook']);
        return { loreBook: settings.loreBook || [], hash };
    }

    async loadModules() {
        const { settings, hash } = await this.loadSettingKeys(['modules']);
        return { modules: settings.modules || [], hash };
    }

    async loadPrompts() {
        const promptKeys = [
            'mainPrompt', 'jailbreak', 'globalNote', 'additionalPrompt',
            'supaMemoryPrompt', 'personaPrompt', 'emotionPrompt', 'emotionPrompt2',
            'autoSuggestPrompt', 'translatorPrompt', 'instructChatTemplate',
            'JinjaTemplate', 'customTokenizer', 'promptTemplate', 'promptSettings',
            'customPromptTemplateToggle',
        ];
        const { settings, hash } = await this.loadSettingKeys(promptKeys);
        return { prompts: settings, hash };
    }

    async loadScripts() {
        const { settings, hash } = await this.loadSettingKeys(['globalscript']);
        return { globalscript: settings.globalscript || [], hash };
    }

    async loadSettingKey(key) {
        const { settings, hash } = await this.loadSettingKeys([key]);
        return {
            key,
            value: settings[key] !== undefined ? settings[key] : null,
            exists: settings[key] !== undefined,
            hash,
        };
    }

    async reconfigure(options = {}) {
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
            revReq.input('action', sql.NVarChar(64), payload.replaceAll ? 'replace_all' : 'sync');
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
            }

            let splitSettings;
            try {
                splitSettings = payload.rootUpserts.map((row) => splitSetting(row.key, row.value, {
                    maxRows: MAX_SYNC_ROWS,
                    maxDepth: 128,
                }));
            } catch (error) {
                throw new StoragePayloadError(
                    error instanceof Error ? error.message : 'Azure SQL setting decomposition failed'
                );
            }

            const settingValueCount = splitSettings.reduce(
                (count, setting) => count + setting.values.length,
                0
            );
            if (settingValueCount > MAX_SYNC_ROWS) {
                throw new StoragePayloadError(
                    `Structured settings exceed the ${MAX_SYNC_ROWS} row limit`
                );
            }

            await bulkInsert(
                tx,
                'system.settings',
                ['key'],
                ['nvarchar(450)'],
                splitSettings.map((item) => item.setting),
                ['key']
            );

            const changedSettingKeys = splitSettings.map((item) => item.setting.key);
            if (changedSettingKeys.length > 0) {
                const keysList = changedSettingKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
                await tx.request().query(`DELETE FROM [system].[setting_values] WHERE [setting_key] IN (${keysList});`);
            }

            await bulkInsert(
                tx,
                'system.setting_values',
                [
                    'setting_key', 'node_id', 'parent_node_id', 'member_key', 'encoded_member_key',
                    'position', 'value_type', 'text_value', 'encoded_text_value', 'number_value',
                    'boolean_value',
                ],
                [
                    'nvarchar(450)', 'bigint', 'bigint', 'nvarchar(450)', 'nvarchar(450)',
                    'int', 'nvarchar(32)', 'nvarchar(max)', 'nvarchar(max)',
                    'float', 'bit',
                ],
                splitSettings.flatMap((item) => item.values)
            );

            const projectedSettings = projectSettings(payload.rootUpserts);
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

            // 4. Characters, Chats, Messages
            if (payload.replaceAll) {
                await tx.request().query('DELETE FROM [character].[characters];');
            } else if (payload.characterIds && payload.characterIds.length > 0) {
                const charIdsList = payload.characterIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
                await tx.request().query(`DELETE FROM [character].[characters] WHERE id IN (${charIdsList});`);
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

    async listRevisions(rawLimit = 50) {
        const pool = await this.getPool();
        const parsedLimit = Number.parseInt(rawLimit, 10);
        const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;

        const res = await pool.request().query(`
            SELECT TOP (${limit}) r.id, r.storage_revision, r.database_initialized, r.scope, r.action,
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
        return await this.listRevisions(100);
    }

    async getRevision(id) {
        const pool = await this.getPool();
        const revReq = pool.request();
        revReq.input('id', sql.BigInt, id);
        const revRes = await revReq.query('SELECT * FROM [system].[revisions] WHERE id = @id');
        if (revRes.recordset.length === 0) return null;

        const auditReq = pool.request();
        auditReq.input('rev_id', sql.BigInt, id);
        const auditRes = await auditReq.query('SELECT * FROM [system].[audit_log] WHERE revision_id = @rev_id ORDER BY sequence');

        const row = revRes.recordset[0];
        return {
            id: row.id,
            storageRevision: parseInt(row.storage_revision, 10) || 0,
            databaseInitialized: Boolean(row.database_initialized),
            scope: row.scope,
            action: row.action,
            restoredFromRevision: row.restored_from_revision,
            createdAt: row.created_at,
            auditLogs: auditRes.recordset.map((a) => ({
                sequence: a.sequence,
                tableName: a.table_name,
                operation: a.operation,
                beforeRow: a.before_row ? JSON.parse(a.before_row) : null,
                afterRow: a.after_row ? JSON.parse(a.after_row) : null,
                recordedAt: a.recorded_at,
            })),
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
