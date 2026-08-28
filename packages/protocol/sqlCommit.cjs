"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_ROOT_SETTING_KEYS = void 0;
exports.createSqlCommitValidator = createSqlCommitValidator;
exports.RESERVED_ROOT_SETTING_KEYS = Object.freeze([
    "botPresets",
    "botPresetsId",
]);
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isReservedRootSettingKey(key) {
    return exports.RESERVED_ROOT_SETTING_KEYS.includes(key);
}
function createSqlCommitValidator(options) {
    const { PayloadError, maxIdLength = 4000 } = options ?? {};
    if (typeof PayloadError !== "function") {
        throw new TypeError("PayloadError must be an error constructor");
    }
    function asArray(value, field) {
        if (value === undefined)
            return [];
        if (!Array.isArray(value)) {
            throw new PayloadError(`${field} must be an array`);
        }
        return value;
    }
    function assertId(value, field) {
        if (typeof value !== "string" ||
            value.length === 0 ||
            value.length > maxIdLength) {
            throw new PayloadError(`${field} must be a non-empty string of at most ${maxIdLength} characters`);
        }
    }
    function assertPosition(value, field) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new PayloadError(`${field} must be a non-negative integer`);
        }
    }
    function assertData(row, field) {
        if (!Object.prototype.hasOwnProperty.call(row, "data") ||
            !isRecord(row.data)) {
            throw new PayloadError(`${field} must be a JSON object`);
        }
    }
    function validateRows(value, field, validateRow) {
        return asArray(value, field).map((row, index) => {
            if (!isRecord(row)) {
                throw new PayloadError(`${field}[${index}] must be an object`);
            }
            return validateRow(row, index);
        });
    }
    function validateEntityRows(value, field, ownerKey) {
        return validateRows(value, field, (row, index) => {
            const rowField = `${field}[${index}]`;
            assertId(row.id, `${rowField}.id`);
            if (ownerKey === undefined) {
                assertPosition(row.position, `${rowField}.position`);
                assertData(row, `${rowField}.data`);
                return { id: row.id, position: row.position, data: row.data };
            }
            const ownerId = row[ownerKey];
            assertId(ownerId, `${rowField}.${ownerKey}`);
            assertPosition(row.position, `${rowField}.position`);
            assertData(row, `${rowField}.data`);
            if (ownerKey === "characterId") {
                return {
                    id: row.id,
                    characterId: ownerId,
                    position: row.position,
                    data: row.data,
                };
            }
            return {
                id: row.id,
                chatId: ownerId,
                position: row.position,
                data: row.data,
            };
        });
    }
    function validateOptionalIds(value, field) {
        if (value === undefined)
            return undefined;
        return asArray(value, field).map((id, index) => {
            assertId(id, `${field}[${index}]`);
            return id;
        });
    }
    function validateManifests(value, field, ownerKey) {
        return validateRows(value, field, (item, index) => {
            const itemField = `${field}[${index}]`;
            const idsField = `${itemField}.ids`;
            const ownerId = item[ownerKey];
            assertId(ownerId, `${itemField}.${ownerKey}`);
            const ids = asArray(item.ids, idsField).map((id, idIndex) => {
                assertId(id, `${idsField}[${idIndex}]`);
                return id;
            });
            return { [ownerKey]: ownerId, ids };
        });
    }
    return function validateSqlCommit(payload) {
        if (!isRecord(payload)) {
            throw new PayloadError("Sync payload must be an object");
        }
        assertPosition(payload.baseRevision, "baseRevision");
        let rootUpserts = [];
        let rootDeletes = [];
        if (payload.root !== undefined) {
            if (!isRecord(payload.root)) {
                throw new PayloadError("root must be an object");
            }
            rootUpserts = asArray(payload.root.upserts, "root.upserts").map((item, index) => {
                if (!isRecord(item)) {
                    throw new PayloadError(`root.upserts[${index}] must be an object`);
                }
                assertId(item.key, `root.upserts[${index}].key`);
                if (isReservedRootSettingKey(item.key)) {
                    throw new PayloadError(`${item.key} must be written through presets`);
                }
                return { key: item.key, value: item.value };
            });
            rootDeletes = asArray(payload.root.deletes, "root.deletes").map((key, index) => {
                assertId(key, `root.deletes[${index}]`);
                if (isReservedRootSettingKey(key)) {
                    throw new PayloadError(`${key} is not a root setting`);
                }
                return key;
            });
        }
        let presets;
        if (payload.presets !== undefined) {
            if (!isRecord(payload.presets)) {
                throw new PayloadError("presets must be an object");
            }
            const upserts = asArray(payload.presets.upserts, "presets.upserts").map((item, index) => {
                if (!isRecord(item)) {
                    throw new PayloadError(`presets.upserts[${index}] must be an object`);
                }
                assertId(item.id, `presets.upserts[${index}].id`);
                if (item.position !== undefined) {
                    assertPosition(item.position, `presets.upserts[${index}].position`);
                }
                if (!isRecord(item.data)) {
                    throw new PayloadError(`presets.upserts[${index}].data must be an object`);
                }
                return { id: item.id, position: item.position, data: item.data };
            });
            const deletes = asArray(payload.presets.deletes, "presets.deletes").map((id, index) => {
                assertId(id, `presets.deletes[${index}]`);
                return id;
            });
            const order = payload.presets.order === undefined
                ? undefined
                : asArray(payload.presets.order, "presets.order").map((id, index) => {
                    assertId(id, `presets.order[${index}]`);
                    return id;
                });
            if (payload.presets.activeId !== undefined) {
                assertId(payload.presets.activeId, "presets.activeId");
            }
            presets = {
                upserts,
                deletes,
                order,
                activeId: payload.presets.activeId,
            };
        }
        let pluginStorageUpserts = [];
        let pluginStorageDeletes = [];
        let pluginStorageClear = false;
        if (payload.pluginStorage !== undefined) {
            if (!isRecord(payload.pluginStorage)) {
                throw new PayloadError("pluginStorage must be an object");
            }
            pluginStorageClear = Boolean(payload.pluginStorage.clear);
            pluginStorageUpserts = asArray(payload.pluginStorage.upserts, "pluginStorage.upserts").map((item, index) => {
                if (!isRecord(item)) {
                    throw new PayloadError(`pluginStorage.upserts[${index}] must be an object`);
                }
                assertId(item.key, `pluginStorage.upserts[${index}].key`);
                return { key: item.key, value: item.value };
            });
            pluginStorageDeletes = asArray(payload.pluginStorage.deletes, "pluginStorage.deletes").map((key, index) => {
                assertId(key, `pluginStorage.deletes[${index}]`);
                return key;
            });
        }
        const characters = validateEntityRows(payload.characters, "characters");
        const characterTouches = validateRows(payload.characterTouches, "characterTouches", (row, index) => {
            const rowField = `characterTouches[${index}]`;
            assertId(row.id, `${rowField}.id`);
            if (!Number.isSafeInteger(row.lastInteraction) ||
                row.lastInteraction < 0) {
                throw new PayloadError(`${rowField}.lastInteraction must be a non-negative safe integer`);
            }
            return { id: row.id, lastInteraction: row.lastInteraction };
        });
        const chats = validateEntityRows(payload.chats, "chats", "characterId");
        const messages = validateEntityRows(payload.messages, "messages", "chatId");
        const chatManifests = validateManifests(payload.chatManifests, "chatManifests", "characterId");
        const messageManifests = validateManifests(payload.messageManifests, "messageManifests", "chatId");
        const messageDeletes = payload.messageDeletes === undefined
            ? undefined
            : validateManifests(payload.messageDeletes, "messageDeletes", "chatId");
        const chatDeletes = validateOptionalIds(payload.chatDeletes, "chatDeletes");
        const characterIds = validateOptionalIds(payload.characterIds, "characterIds");
        const characterDeletes = validateOptionalIds(payload.characterDeletes, "characterDeletes");
        const action = typeof payload.action === "string" &&
            payload.action.length > 0 &&
            payload.action.length <= 64
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
            chatDeletes,
            messageManifests,
            messageDeletes,
            characterIds,
            characterDeletes,
        };
    };
}
