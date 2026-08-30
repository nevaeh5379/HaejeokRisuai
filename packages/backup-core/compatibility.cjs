'use strict';

const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

function randomUUID() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    throw new Error('A backup compatibility idFactory is required');
}

function defaultClone(value) {
    return structuredClone(value);
}

function resolveOptions(options = {}) {
    return {
        cloneValue: options.cloneValue || defaultClone,
        coldStorageHeader: options.coldStorageHeader || COLD_STORAGE_HEADER,
    };
}

function coldStorageValue(values, key) {
    if (!key || !values) return undefined;
    return values.get(key);
}

function materializeColdChat(source, values, options = {}) {
    const { cloneValue, coldStorageHeader } = resolveOptions(options);
    const chat = cloneValue(source);
    const pointer = chat.message?.[0]?.data;
    if (typeof pointer !== 'string' || !pointer.startsWith(coldStorageHeader)) return chat;

    const key = pointer.slice(coldStorageHeader.length);
    const stored = coldStorageValue(values, key);
    if (Array.isArray(stored)) {
        chat.message = cloneValue(stored);
    } else if (stored && typeof stored === 'object' && Array.isArray(stored.message)) {
        chat.message = cloneValue(stored.message);
        chat.hypaV2Data = cloneValue(stored.hypaV2Data);
        chat.hypaV3Data = cloneValue(stored.hypaV3Data);
        chat.scriptstate = cloneValue(stored.scriptstate);
        chat.localLore = cloneValue(stored.localLore ?? chat.localLore ?? []);
    }
    return chat;
}

function materializeColdCharacterForCompatibility(source, values, options = {}) {
    const { cloneValue, coldStorageHeader } = resolveOptions(options);
    let base = source;
    let wholeCharacterRestored = !source?.coldstorage;
    const stored = coldStorageValue(values, source?.coldstorage);
    if (stored && typeof stored === 'object' && stored.character) {
        const restored = stored.character;
        if (restored && (!source.chaId || restored.chaId === source.chaId)) {
            base = restored;
            wholeCharacterRestored = true;
        }
    }

    const character = cloneValue(base);
    character.chats = (base.chats || []).map((chat) =>
        materializeColdChat(chat, values, options)
    );
    const unresolved = character.chats.some((chat) =>
        chat.message?.[0]?.data?.startsWith?.(coldStorageHeader)
    );
    if (wholeCharacterRestored && !unresolved) {
        delete character.coldstorage;
        delete character.coldStoragedChats;
    } else {
        if (source.coldstorage) character.coldstorage = source.coldstorage;
        if (source.coldStoragedChats) {
            character.coldStoragedChats = cloneValue(source.coldStoragedChats);
        }
    }
    return character;
}

function cloneMessagesWithFreshIds(messages, idFactory, cloneValue) {
    const cloned = cloneValue(messages || []);
    const idMap = new Map();
    for (const message of cloned) {
        const oldId = message.chatId;
        const newId = idFactory();
        if (oldId) idMap.set(oldId, newId);
        message.chatId = newId;
    }
    return { messages: cloned, idMap };
}

function getBranchMessages(chat, branch, cloneValue) {
    const state = chat.branchState;
    if (!state || branch.id === state.activeBranchId) {
        return cloneValue(chat.message || []);
    }
    const prefix = (chat.message || []).slice(0, state.baseMessageIndex + 1);
    return [...cloneValue(prefix), ...cloneValue(branch.messages || [])];
}

function remapBookmarks(chat, idMap) {
    if (Array.isArray(chat.bookmarks)) {
        chat.bookmarks = chat.bookmarks.map((id) => idMap.get(id)).filter(Boolean);
    }
    if (chat.bookmarkNames && typeof chat.bookmarkNames === 'object') {
        chat.bookmarkNames = Object.fromEntries(
            Object.entries(chat.bookmarkNames)
                .map(([id, value]) => [idMap.get(id), value])
                .filter(([id]) => Boolean(id))
        );
    }
}

function applyBranchScriptState(chat, branch, cloneValue) {
    if (!branch || typeof branch !== 'object') return;
    if (chat.branchState?.activeBranchId === branch.id) return;
    if (Object.prototype.hasOwnProperty.call(branch, 'scriptstate')) {
        if (branch.scriptstate == null) delete chat.scriptstate;
        else chat.scriptstate = cloneValue(branch.scriptstate);
    }
    if (Object.prototype.hasOwnProperty.call(branch, 'GLGlobalVariables')) {
        if (branch.GLGlobalVariables == null) delete chat.GLGlobalVariables;
        else chat.GLGlobalVariables = cloneValue(branch.GLGlobalVariables);
    }
    if (Object.prototype.hasOwnProperty.call(branch, 'useLocallySetGlobalVariables')) {
        if (branch.useLocallySetGlobalVariables == null) delete chat.useLocallySetGlobalVariables;
        else chat.useLocallySetGlobalVariables = branch.useLocallySetGlobalVariables;
    }
}

function makeStandaloneChat(source, messages, name, idFactory, cloneValue, branch) {
    const chat = cloneValue(source);
    const cloned = cloneMessagesWithFreshIds(messages, idFactory, cloneValue);
    chat.id = idFactory();
    chat.name = name;
    chat.message = cloned.messages;
    applyBranchScriptState(chat, branch, cloneValue);
    remapBookmarks(chat, cloned.idMap);
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

function expandChatBranchesForCompatibility(source, idFactory = randomUUID, options = {}) {
    const { cloneValue } = resolveOptions(options);
    const state = source?.branchState;
    if (!state || !Array.isArray(state.branches) || state.branches.length <= 1) {
        const chat = cloneValue(source);
        delete chat.branch;
        delete chat.branchState;
        return { chats: [chat], activeIndex: 0 };
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
            source,
            getBranchMessages(source, branch, cloneValue),
            `${source.name || 'Chat'}${suffix}`,
            idFactory,
            cloneValue,
            branch
        );
    });
    return {
        chats,
        activeIndex: Math.max(0, ordered.findIndex((branch) => branch.id === state.activeBranchId)),
    };
}

function expandCharacterBranchesForCompatibility(
    source,
    idFactory = randomUUID,
    coldStorageValues,
    options = {},
) {
    const { cloneValue } = resolveOptions(options);
    const materialized = materializeColdCharacterForCompatibility(
        source,
        coldStorageValues,
        options,
    );
    const character = cloneValue(materialized);
    const nextChats = [];
    let nextChatPage = 0;
    const sourceChats = Array.isArray(materialized.chats) ? materialized.chats : [];
    for (let index = 0; index < sourceChats.length; index++) {
        const expanded = expandChatBranchesForCompatibility(
            sourceChats[index],
            idFactory,
            options,
        );
        if (index === Number(materialized.chatPage || 0)) {
            nextChatPage = nextChats.length + expanded.activeIndex;
        }
        nextChats.push(...expanded.chats);
    }
    character.chats = nextChats;
    character.chatPage = Math.min(
        Math.max(0, nextChatPage),
        Math.max(0, nextChats.length - 1),
    );
    return character;
}

function expandCharactersForCompatibility(
    characters,
    idFactory = randomUUID,
    coldStorageValues,
    options = {},
) {
    return characters.map((character) =>
        expandCharacterBranchesForCompatibility(
            character,
            idFactory,
            coldStorageValues,
            options,
        )
    );
}

function makeLegacyCompatibleDatabase(database, coldStorageValues = new Map(), options = {}) {
    if (!database || typeof database !== 'object') return database;
    const portable = { ...database };
    if (Array.isArray(database.personas)) {
        portable.personas = database.personas.map((persona) => {
            if (
                !persona ||
                typeof persona !== 'object' ||
                !Object.prototype.hasOwnProperty.call(persona, 'botLorebooks')
            ) {
                return persona;
            }
            const legacyPersona = { ...persona };
            delete legacyPersona.botLorebooks;
            return legacyPersona;
        });
    }
    if (Array.isArray(database.characters)) {
        portable.characters = expandCharactersForCompatibility(
            database.characters,
            options.idFactory || randomUUID,
            coldStorageValues,
            options,
        ).map((character) => {
            if (!character || typeof character !== 'object') return character;
            delete character.additionalAssetFolders;
            delete character.additionalAssetFolderAssignments;
            return character;
        });
    }
    delete portable.moduleFolders;
    return portable;
}

module.exports = {
    COLD_STORAGE_HEADER,
    materializeColdCharacterForCompatibility,
    expandChatBranchesForCompatibility,
    expandCharacterBranchesForCompatibility,
    expandCharactersForCompatibility,
    makeLegacyCompatibleDatabase,
};
