'use strict';

const RESERVED_ROOT_SETTING_KEYS = Object.freeze(['botPresets', 'botPresetsId']);

function createSqlCommitValidator({ PayloadError, maxIdLength = 4000 } = {}) {
    if (typeof PayloadError !== 'function') {
        throw new TypeError('PayloadError must be an error constructor');
    }

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

    return function validateSqlCommit(payload) {
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
                if (RESERVED_ROOT_SETTING_KEYS.includes(item.key)) {
                    throw new PayloadError(`${item.key} must be written through presets`);
                }
                return { key: item.key, value: item.value };
            });
            rootDeletes = asArray(payload.root.deletes, 'root.deletes').map((key, index) => {
                assertId(key, `root.deletes[${index}]`);
                if (RESERVED_ROOT_SETTING_KEYS.includes(key)) {
                    throw new PayloadError(`${key} is not a root setting`);
                }
                return key;
            });
        }

        let presets;
        if (payload.presets !== undefined) {
            if (!payload.presets || typeof payload.presets !== 'object' || Array.isArray(payload.presets)) {
                throw new PayloadError('presets must be an object');
            }
            const upserts = asArray(payload.presets.upserts, 'presets.upserts').map((item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new PayloadError(`presets.upserts[${index}] must be an object`);
                }
                assertId(item.id, `presets.upserts[${index}].id`);
                if (item.position !== undefined) assertPosition(item.position, `presets.upserts[${index}].position`);
                if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
                    throw new PayloadError(`presets.upserts[${index}].data must be an object`);
                }
                return { id: item.id, position: item.position, data: item.data };
            });
            const deletes = asArray(payload.presets.deletes, 'presets.deletes').map((id, index) => {
                assertId(id, `presets.deletes[${index}]`);
                return id;
            });
            const order = payload.presets.order === undefined
                ? undefined
                : asArray(payload.presets.order, 'presets.order').map((id, index) => {
                    assertId(id, `presets.order[${index}]`);
                    return id;
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
        const characterTouches = validateRows(payload.characterTouches, 'characterTouches', (row, index) => {
            assertId(row.id, `characterTouches[${index}].id`);
            if (!Number.isSafeInteger(row.lastInteraction) || row.lastInteraction < 0) {
                throw new PayloadError(`characterTouches[${index}].lastInteraction must be a non-negative safe integer`);
            }
            return { id: row.id, lastInteraction: row.lastInteraction };
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
        const characterDeletes = payload.characterDeletes === undefined
            ? undefined
            : asArray(payload.characterDeletes, 'characterDeletes').map((id, index) => {
                assertId(id, `characterDeletes[${index}]`);
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
            characterTouches,
            chats,
            messages,
            chatManifests,
            messageManifests,
            messageDeletes,
            characterIds,
            characterDeletes,
        };
    };
}

module.exports = {
    RESERVED_ROOT_SETTING_KEYS,
    createSqlCommitValidator,
};
