'use strict';

const fs = require('fs/promises');

const DEFAULT_MAX_COLD_STORAGE_KEYS = 250000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPAT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,12}$/i;

const DEFERRED_SETTING_KEYS = [
    'plugins', 'pluginCustomStorage', 'personas', 'botPresets', 'botPresetsId', 'loreBook',
    'modules', 'globalscript', 'promptTemplate', 'promptSettings', 'mainPrompt',
    'jailbreak', 'globalNote', 'additionalPrompt', 'supaMemoryPrompt',
    'personaPrompt', 'emotionPrompt', 'emotionPrompt2', 'autoSuggestPrompt',
    'translatorPrompt', 'instructChatTemplate', 'JinjaTemplate', 'customTokenizer',
    'customPromptTemplateToggle', 'customModels', 'translatorPresets', 'loadouts',
    'customBackground',
];

const PROMPT_SETTING_KEYS = [
    'mainPrompt', 'jailbreak', 'globalNote', 'additionalPrompt',
    'supaMemoryPrompt', 'personaPrompt', 'emotionPrompt', 'emotionPrompt2',
    'autoSuggestPrompt', 'translatorPrompt', 'instructChatTemplate',
    'JinjaTemplate', 'customTokenizer', 'promptTemplate', 'promptSettings',
    'customPromptTemplateToggle',
];

// These domains are touched during application bootstrap. Loading them in one
// snapshot avoids opening a transaction (and consuming a pool connection) for
// every lazy domain at the same time.
const BOOTSTRAP_SETTING_KEYS = [
    'plugins', 'pluginCustomStorage', 'personas', 'loreBook', 'modules', 'globalscript',
    'customModels', 'translatorPresets', 'loadouts', 'customBackground',
    ...PROMPT_SETTING_KEYS,
];

class SqlStorageBase {
    constructor() {
        this.objectCacheEnabled = process.env.RISUAI_SQL_OBJECT_CACHE === '1';
        this.pluginsCache = null;
        this.pluginCustomStorageCache = null;
        // Bootstrap is on every application's critical path, so keep this
        // compact settings snapshot regardless of the optional general object
        // cache. It is invalidated only by writes to bootstrap setting keys.
        this.bootstrapCache = null;
        this.bootstrapCachePromise = null;
        this.bootstrapCacheGeneration = 0;
    }

    invalidatePluginsCache() {
        this.pluginsCache = null;
    }

    invalidatePluginCustomStorageCache() {
        this.pluginCustomStorageCache = null;
    }

    invalidateBootstrapCache(changedKeys) {
        if (Array.isArray(changedKeys) &&
            !changedKeys.some((key) => BOOTSTRAP_SETTING_KEYS.includes(key))) return;
        this.bootstrapCacheGeneration += 1;
        this.bootstrapCache = null;
        this.bootstrapCachePromise = null;
    }

    async loadChatMessages(chatId) {
        const chat = await this.loadChat(chatId);
        return chat ? chat.message : [];
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

    async loadBootstrapData() {
        if (this.bootstrapCache) return this.bootstrapCache;
        if (this.bootstrapCachePromise) return this.bootstrapCachePromise;

        const generation = this.bootstrapCacheGeneration;
        const pending = this.loadSettingKeys(BOOTSTRAP_SETTING_KEYS).then(({ settings, hash }) => {
            const result = { database: settings, hash };
            if (generation === this.bootstrapCacheGeneration) this.bootstrapCache = result;
            return result;
        }).finally(() => {
            if (this.bootstrapCachePromise === pending) this.bootstrapCachePromise = null;
        });
        this.bootstrapCachePromise = pending;
        return pending;
    }

    async warmBootstrapCache() {
        if (!this.enabled) return;
        await this.loadBootstrapData();
    }

    async loadPersonas() {
        return this.loadSettingCollection('personas', 'personas');
    }

    async loadLorebooks() {
        return this.loadSettingCollection('loreBook', 'loreBook');
    }

    async loadModules() {
        return this.loadSettingCollection('modules', 'modules');
    }

    async loadSettingCollection(settingKey, resultKey) {
        const { settings, hash } = await this.loadSettingKeys([settingKey]);
        return { [resultKey]: settings[settingKey] || [], hash };
    }

    async loadPrompts() {
        const { settings, hash } = await this.loadSettingKeys(PROMPT_SETTING_KEYS);
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
}

/**
 * SQL-dialect-independent validation and normalization shared by every
 * relational storage driver. Database-specific queries stay in each driver.
 */
function createSqlStorageHelpers({
    PayloadError,
    maxIdLength = 4000,
    maxColdStorageKeys = DEFAULT_MAX_COLD_STORAGE_KEYS,
    allowShortColdStorageKeys = false,
    suppressLegacyReadErrors = false,
} = {}) {
    if (typeof PayloadError !== 'function') {
        throw new TypeError('PayloadError must be an error constructor');
    }

    const coldStorageKeyPattern = allowShortColdStorageKeys ? COMPAT_UUID_PATTERN : UUID_PATTERN;
    const coldStoragePathPattern = new RegExp(`^coldstorage/(${coldStorageKeyPattern.source.slice(1, -1)})$`, 'i');

    function asArray(value, field) {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new PayloadError(`${field} must be an array`);
        return value;
    }

    function assertId(value, field) {
        if (typeof value !== 'string' || value.length === 0 || value.length > maxIdLength) {
            throw new PayloadError(`${field} must be a non-empty string of at most ${maxIdLength} characters`);
        }
    }

    function assertPosition(value, field) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new PayloadError(`${field} must be a non-negative integer`);
        }
    }

    function assertData(row, field) {
        if (!row || !Object.prototype.hasOwnProperty.call(row, 'data') || row.data === null ||
            typeof row.data !== 'object' || Array.isArray(row.data)) {
            throw new PayloadError(`${field} must be a JSON object`);
        }
    }

    function normalizeColdStorageKey(value, field = 'coldStorageKey') {
        if (typeof value !== 'string' || !coldStorageKeyPattern.test(value)) {
            throw new PayloadError(`${field} must be a UUID`);
        }
        return value.toLowerCase();
    }

    function validateColdStorageValue(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') {
            throw new PayloadError('Cold storage data must be an array or an object containing character or message data');
        }
        if ('character' in value) {
            const character = value.character;
            if (!character || typeof character !== 'object' || Array.isArray(character) ||
                (character.chats !== undefined && !Array.isArray(character.chats))) {
                throw new PayloadError('Cold storage character data is invalid');
            }
            for (const chat of character.chats || []) {
                if (!chat || typeof chat !== 'object' || Array.isArray(chat) ||
                    (chat.message !== undefined && !Array.isArray(chat.message))) {
                    throw new PayloadError('Cold storage character chat data is invalid');
                }
                validateMessages(chat.message || []);
            }
            return value;
        }
        if (!('message' in value) || !Array.isArray(value.message)) {
            throw new PayloadError('Cold storage data must be an array or an object containing character or message data');
        }
        validateMessages(value.message);
        return value;
    }

    function validateMessages(messages) {
        for (const message of messages) {
            if (!message || typeof message !== 'object' || Array.isArray(message)) {
                throw new PayloadError('Cold storage message data is invalid');
            }
        }
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
        if (keys.length > maxColdStorageKeys) {
            throw new PayloadError(`${field} exceeds the ${maxColdStorageKeys} key limit`);
        }
        return Array.from(new Set(keys.map((key) => normalizeColdStorageKey(key, `${field}[]`))));
    }

    async function findLegacyColdStorageFiles(savePath) {
        try {
            const entries = await fs.readdir(savePath, { withFileTypes: true });
            const candidates = [];
            for (const entry of entries) {
                if (!entry.isFile() || !/^(?:[0-9a-f]{2})+$/i.test(entry.name)) continue;
                const logicalPath = Buffer.from(entry.name, 'hex').toString('utf8');
                if (Buffer.from(logicalPath, 'utf8').toString('hex') !== entry.name.toLowerCase()) continue;
                const match = logicalPath.match(coldStoragePathPattern);
                if (match) candidates.push({ filename: entry.name, key: match[1].toLowerCase() });
            }
            return candidates;
        } catch (error) {
            if (suppressLegacyReadErrors) return [];
            throw error;
        }
    }

    function validateSyncPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new PayloadError('Sync payload must be an object');
        }
        if (!Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0) {
            throw new PayloadError('baseRevision must be a non-negative integer');
        }

        let rootUpserts = [];
        let rootDeletes = [];
        if (payload.root !== undefined) {
            if (!payload.root || typeof payload.root !== 'object' || Array.isArray(payload.root)) {
                throw new PayloadError('root must be an object');
            }
            rootUpserts = asArray(payload.root.upserts, 'root.upserts').map((item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new PayloadError(`root.upserts[${index}] must be an object`);
                }
                assertId(item.key, `root.upserts[${index}].key`);
                if (item.key === 'botPresets' || item.key === 'botPresetsId') {
                    throw new PayloadError(`${item.key} must be written through presets`);
                }
                return { key: item.key, value: item.value };
            });
            rootDeletes = asArray(payload.root.deletes, 'root.deletes').map((key, index) => {
                assertId(key, `root.deletes[${index}]`);
                if (key === 'botPresets' || key === 'botPresetsId') throw new PayloadError(`${key} is not a root setting`);
                return key;
            });
        }

        let presets;
        if (payload.presets !== undefined) {
            if (!payload.presets || typeof payload.presets !== 'object' || Array.isArray(payload.presets)) {
                throw new PayloadError('presets must be an object');
            }
            const upserts = asArray(payload.presets.upserts, 'presets.upserts').map((item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new PayloadError(`presets.upserts[${index}] must be an object`);
                assertId(item.id, `presets.upserts[${index}].id`);
                if (item.position !== undefined) assertPosition(item.position, `presets.upserts[${index}].position`);
                if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) throw new PayloadError(`presets.upserts[${index}].data must be an object`);
                return { id: item.id, position: item.position, data: item.data };
            });
            const deletes = asArray(payload.presets.deletes, 'presets.deletes').map((id, index) => {
                assertId(id, `presets.deletes[${index}]`); return id;
            });
            const order = payload.presets.order === undefined ? undefined : asArray(payload.presets.order, 'presets.order').map((id, index) => {
                assertId(id, `presets.order[${index}]`); return id;
            });
            if (payload.presets.activeId !== undefined) assertId(payload.presets.activeId, 'presets.activeId');
            presets = { upserts, deletes, order, activeId: payload.presets.activeId };
        }

        let pluginStorageUpserts = [];
        let pluginStorageDeletes = [];
        let pluginStorageClear = false;
        if (payload.pluginStorage !== undefined) {
            if (!payload.pluginStorage || typeof payload.pluginStorage !== 'object' || Array.isArray(payload.pluginStorage)) {
                throw new PayloadError('pluginStorage must be an object');
            }
            pluginStorageClear = Boolean(payload.pluginStorage.clear);
            pluginStorageUpserts = asArray(payload.pluginStorage.upserts, 'pluginStorage.upserts').map((item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new PayloadError(`pluginStorage.upserts[${index}] must be an object`);
                }
                assertId(item.key, `pluginStorage.upserts[${index}].key`);
                return { key: item.key, value: item.value };
            });
            pluginStorageDeletes = asArray(payload.pluginStorage.deletes, 'pluginStorage.deletes').map((key, index) => {
                assertId(key, `pluginStorage.deletes[${index}]`);
                return key;
            });
        }

        const characters = validateRows(payload.characters, 'characters', (row, index) => {
            assertId(row.id, `characters[${index}].id`);
            assertPosition(row.position, `characters[${index}].position`);
            assertData(row, `characters[${index}].data`);
            return { id: row.id, position: row.position, data: row.data };
        });
        const chats = validateRows(payload.chats, 'chats', (row, index) => {
            assertId(row.id, `chats[${index}].id`);
            assertId(row.characterId, `chats[${index}].characterId`);
            assertPosition(row.position, `chats[${index}].position`);
            assertData(row, `chats[${index}].data`);
            return { id: row.id, characterId: row.characterId, position: row.position, data: row.data };
        });
        const messages = validateRows(payload.messages, 'messages', (row, index) => {
            assertId(row.id, `messages[${index}].id`);
            assertId(row.chatId, `messages[${index}].chatId`);
            assertPosition(row.position, `messages[${index}].position`);
            assertData(row, `messages[${index}].data`);
            return { id: row.id, chatId: row.chatId, position: row.position, data: row.data };
        });
        const chatManifests = validateManifests(payload.chatManifests, 'chatManifests', 'characterId');
        const messageManifests = validateManifests(payload.messageManifests, 'messageManifests', 'chatId');
        const messageDeletes = payload.messageDeletes === undefined
            ? undefined
            : validateManifests(payload.messageDeletes, 'messageDeletes', 'chatId');
        const characterIds = payload.characterIds === undefined
            ? undefined
            : asArray(payload.characterIds, 'characterIds').map((id, index) => {
                assertId(id, `characterIds[${index}]`);
                return id;
            });

        const action = typeof payload.action === 'string' && payload.action.length > 0 && payload.action.length <= 64
            ? payload.action
            : undefined;

        return {
            replaceAll: Boolean(payload.replaceAll),
            action,
            baseRevision: payload.baseRevision,
            rootUpserts,
            rootDeletes,
            pluginStorageUpserts,
            pluginStorageDeletes,
            pluginStorageClear,
            presets,
            characters,
            chats,
            messages,
            chatManifests,
            messageManifests,
            messageDeletes,
            characterIds,
        };
    }

    function validateRows(value, field, validateRow) {
        return asArray(value, field).map((row, index) => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
                throw new PayloadError(`${field}[${index}] must be an object`);
            }
            return validateRow(row, index);
        });
    }

    function validateManifests(value, field, ownerKey) {
        return validateRows(value, field, (item, index) => {
            assertId(item[ownerKey], `${field}[${index}].${ownerKey}`);
            const ids = asArray(item.ids, `${field}[${index}].ids`).map((id, idIndex) => {
                assertId(id, `${field}[${index}].ids[${idIndex}]`);
                return id;
            });
            return { [ownerKey]: item[ownerKey], ids };
        });
    }

    return {
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

function createMessageRelations({ attributes, generations, promptInfos, promptToggles, promptItems }) {
    return {
        attributes: groupMessageRows(attributes),
        generation: new Map(generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
        promptInfo: new Map(promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row])),
        promptToggles: groupMessageRows(promptToggles),
        promptItems: groupMessageRows(promptItems),
    };
}

function createCharacterRelations({
    attributes, tags, greetings, biases, emotions, modules, groupMembers,
    chatFolders, scripts, sdData, assets, lore,
}) {
    return {
        attributes: groupRows(attributes, 'character_id'),
        tags: groupRows(tags, 'character_id'),
        greetings: groupRows(greetings, 'character_id'),
        biases: groupRows(biases, 'character_id'),
        emotions: groupRows(emotions, 'character_id'),
        modules: groupRows(modules, 'character_id'),
        groupMembers: groupRows(groupMembers, 'group_id'),
        chatFolders: groupRows(chatFolders, 'character_id'),
        scripts: groupRows(scripts, 'character_id'),
        sdData: groupRows(sdData, 'character_id'),
        assets: groupRows(assets, 'character_id'),
        lore: groupRows(lore, 'character_id'),
    };
}

function createChatRelations({ attributes, suggestions, modules, scriptState, bookmarks, memory, lore }) {
    return {
        attributes: groupRows(attributes, 'chat_id'),
        suggestions: groupRows(suggestions, 'chat_id'),
        modules: groupRows(modules, 'chat_id'),
        scriptState: groupRows(scriptState, 'chat_id'),
        bookmarks: groupRows(bookmarks, 'chat_id'),
        memory: groupRows(memory, 'chat_id'),
        lore: groupRows(lore, 'chat_id'),
    };
}

/** Reassembles normalized relational rows into the application database graph. */
function rebuildDatabaseGraph({
    database,
    characters,
    chats,
    messages = [],
    characterRelations,
    chatRelations,
    messageRelations = null,
    rebuildCharacter,
    rebuildChat,
    rebuildMessage,
    shallow = false,
}) {
    const messagesByChat = new Map();
    if (!shallow && messageRelations) {
        for (const row of messages) {
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
    for (const row of chats) {
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

    database.characters = characters.map((row) => {
        const related = { chats: chatsByCharacter.get(row.id) || [] };
        for (const [name, grouped] of Object.entries(characterRelations)) {
            related[name] = grouped.get(row.id) || [];
        }
        const rebuilt = rebuildCharacter(row, related, { shallow });
        rebuilt.detailsLoaded = !shallow;
        return rebuilt;
    });
    return database;
}

module.exports = {
    DEFERRED_SETTING_KEYS,
    PROMPT_SETTING_KEYS,
    BOOTSTRAP_SETTING_KEYS,
    SqlStorageBase,
    createSqlStorageHelpers,
    groupRows,
    groupMessageRows,
    createCharacterRelations,
    createChatRelations,
    createMessageRelations,
    rebuildDatabaseGraph,
};
