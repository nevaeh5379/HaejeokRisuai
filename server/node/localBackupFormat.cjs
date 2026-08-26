'use strict';

const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { Packr, Unpackr } = require('msgpackr');

const RAW_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const COMPRESSED_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });

function createEntryHeader(name, size) {
    const normalizedName = path.basename(name);
    const encodedName = Buffer.from(normalizedName, 'utf8');
    if (encodedName.length === 0 || encodedName.length > 1024 * 1024) {
        throw new Error(`Invalid local backup entry name: ${name}`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff) {
        throw new Error(`Local backup entry is too large: ${name}`);
    }
    const header = Buffer.alloc(8 + encodedName.length);
    header.writeUInt32LE(encodedName.length, 0);
    encodedName.copy(header, 4);
    header.writeUInt32LE(size, 4 + encodedName.length);
    return header;
}

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return unpackr.decode(packr.encode(value));
}

function materializeColdChat(chat, coldStorageValues) {
    const copy = cloneValue(chat);
    const pointer = copy.message?.[0]?.data;
    if (typeof pointer !== 'string' || !pointer.startsWith(COLD_STORAGE_HEADER)) return copy;
    const key = pointer.slice(COLD_STORAGE_HEADER.length);
    const stored = coldStorageValues?.get(key);
    if (Array.isArray(stored)) {
        copy.message = cloneValue(stored);
    } else if (stored && typeof stored === 'object' && Array.isArray(stored.message)) {
        copy.message = cloneValue(stored.message);
        copy.hypaV2Data = cloneValue(stored.hypaV2Data);
        copy.hypaV3Data = cloneValue(stored.hypaV3Data);
        copy.scriptstate = cloneValue(stored.scriptstate);
        copy.localLore = cloneValue(stored.localLore ?? copy.localLore ?? []);
    }
    return copy;
}

function materializeColdCharacter(character, coldStorageValues) {
    let base = character;
    let wholeCharacterRestored = !character?.coldstorage;
    const stored = character?.coldstorage ? coldStorageValues?.get(character.coldstorage) : null;
    if (stored && typeof stored === 'object' && stored.character) {
        const restored = stored.character;
        if (!character.chaId || restored.chaId === character.chaId) {
            base = restored;
            wholeCharacterRestored = true;
        }
    }
    const copy = cloneValue(base);
    copy.chats = (base.chats || []).map((chat) => materializeColdChat(chat, coldStorageValues));
    const unresolved = copy.chats.some((chat) =>
        chat.message?.[0]?.data?.startsWith?.(COLD_STORAGE_HEADER)
    );
    if (wholeCharacterRestored && !unresolved) {
        delete copy.coldstorage;
        delete copy.coldStoragedChats;
    } else {
        if (character.coldstorage) copy.coldstorage = character.coldstorage;
        if (character.coldStoragedChats) copy.coldStoragedChats = cloneValue(character.coldStoragedChats);
    }
    return copy;
}

function cloneMessagesWithFreshIds(messages) {
    const cloned = cloneValue(messages || []);
    const idMap = new Map();
    for (const message of cloned) {
        const oldId = message.chatId;
        const newId = crypto.randomUUID();
        if (oldId) idMap.set(oldId, newId);
        message.chatId = newId;
    }
    return { messages: cloned, idMap };
}

function getBranchMessages(chat, branch) {
    const state = chat.branchState;
    if (!state || branch.id === state.activeBranchId) {
        return cloneValue(chat.message || []);
    }
    const prefix = (chat.message || []).slice(0, state.baseMessageIndex + 1);
    return [...cloneValue(prefix), ...cloneValue(branch.messages || [])];
}

function makeStandaloneChat(source, messages, name) {
    const chat = cloneValue(source);
    const cloned = cloneMessagesWithFreshIds(messages);
    chat.id = crypto.randomUUID();
    chat.name = name;
    chat.message = cloned.messages;
    if (Array.isArray(chat.bookmarks)) {
        chat.bookmarks = chat.bookmarks
            .map((id) => cloned.idMap.get(id))
            .filter(Boolean);
    }
    if (chat.bookmarkNames && typeof chat.bookmarkNames === 'object') {
        chat.bookmarkNames = Object.fromEntries(
            Object.entries(chat.bookmarkNames)
                .map(([id, value]) => [cloned.idMap.get(id), value])
                .filter(([id]) => Boolean(id))
        );
    }
    delete chat.branch;
    delete chat.branchState;
    chat.isStreaming = false;
    delete chat.activeStreamingDisplayOptimizationMode;
    chat.preventMessageCompaction = false;
    chat.messagesLoaded = true;
    chat.messagesFullyLoaded = true;
    chat.messageOffset = 0;
    chat.messageTotal = chat.message.length;
    chat.detailsLoaded = true;
    return chat;
}

function expandChatBranches(chat) {
    const state = chat && chat.branchState;
    if (!state || !Array.isArray(state.branches) || state.branches.length <= 1) {
        const copy = cloneValue(chat);
        delete copy.branch;
        delete copy.branchState;
        return { chats: [copy], activeIndex: 0 };
    }
    const ordered = [...state.branches].sort((left, right) => {
        if (left.reason === 'root' && right.reason !== 'root') return -1;
        if (right.reason === 'root' && left.reason !== 'root') return 1;
        return Number(left.createdAt || 0) - Number(right.createdAt || 0);
    });
    let branchIndex = 0;
    let rerollIndex = 0;
    const chats = ordered.map((branch) => {
        const suffix = branch.reason === 'root'
            ? ''
            : branch.reason === 'reroll'
                ? ` (Reroll ${++rerollIndex})`
                : ` (Branch ${++branchIndex})`;
        return makeStandaloneChat(
            chat,
            getBranchMessages(chat, branch),
            `${chat.name || 'Chat'}${suffix}`
        );
    });
    return {
        chats,
        activeIndex: Math.max(0, ordered.findIndex((branch) => branch.id === state.activeBranchId)),
    };
}

function expandCharacterBranches(character, coldStorageValues) {
    const materialized = materializeColdCharacter(character, coldStorageValues);
    const copy = cloneValue(materialized);
    const nextChats = [];
    let nextChatPage = 0;
    const sourceChats = Array.isArray(materialized.chats) ? materialized.chats : [];
    for (let index = 0; index < sourceChats.length; index++) {
        const expanded = expandChatBranches(sourceChats[index]);
        if (index === Number(materialized.chatPage || 0)) {
            nextChatPage = nextChats.length + expanded.activeIndex;
        }
        nextChats.push(...expanded.chats);
    }
    copy.chats = nextChats;
    copy.chatPage = Math.min(Math.max(0, nextChatPage), Math.max(0, nextChats.length - 1));
    return copy;
}

function makeLegacyCompatibleDatabase(database, coldStorageValues = new Map()) {
    if (!database || typeof database !== 'object') return database;
    const portable = { ...database };
    if (Array.isArray(database.characters)) {
        portable.characters = database.characters.map((character) => {
            if (!character || typeof character !== 'object') return character;
            const copy = expandCharacterBranches(character, coldStorageValues);
            delete copy.additionalAssetFolders;
            delete copy.additionalAssetFolderAssignments;
            return copy;
        });
    }
    delete portable.moduleFolders;
    return portable;
}

async function encodeDatabase(database) {
    const packed = packr.encode(database);
    const compressed = await promisify(zlib.deflate)(packed);
    return Buffer.concat([COMPRESSED_HEADER, compressed]);
}

function decodeDatabase(data) {
    if (data.subarray(0, COMPRESSED_HEADER.length).equals(COMPRESSED_HEADER)) {
        return unpackr.decode(zlib.inflateSync(data.subarray(COMPRESSED_HEADER.length)));
    }
    if (data.subarray(0, RAW_HEADER.length).equals(RAW_HEADER)) {
        return unpackr.decode(data.subarray(RAW_HEADER.length));
    }
    return unpackr.decode(data);
}

module.exports = {
    createEntryHeader,
    makeLegacyCompatibleDatabase,
    encodeDatabase,
    decodeDatabase,
};
