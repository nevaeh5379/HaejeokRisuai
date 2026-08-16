import { v4 as uuidv4 } from 'uuid'
import type { Chat, Database, Message, character, groupChat } from './database.svelte'
import type { toSaveType } from './risuSave'

export interface NodeDatabaseSyncPayload {
    baseRevision: number
    replaceAll?: boolean
    root: {
        upserts: { key: string, value: unknown }[]
        deletes: string[]
    }
    characters: { id: string, position: number, data: unknown }[]
    characterIds?: string[]
    chats: { id: string, characterId: string, position: number, data: unknown }[]
    chatManifests: { characterId: string, ids: string[] }[]
    messages: { id: string, chatId: string, position: number, data: unknown }[]
    messageManifests: { chatId: string, ids: string[] }[]
}

export interface NodeDatabaseSyncCache {
    revision: number
    initialized: boolean
    root: Map<string, string>
    characters: Map<string, string>
    chats: Map<string, string>
    chatParents: Map<string, string>
    messages: Map<string, string>
    messageParents: Map<string, string>
    characterManifest: string
    chatManifests: Map<string, string>
    messageManifests: Map<string, string>
}

export interface NodeDatabaseSyncBuild {
    payload: NodeDatabaseSyncPayload
    nextCache: NodeDatabaseSyncCache
}

function serialize(value: unknown) {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
        return null
    }
    return serialized
}

function jsonValue(serialized: string) {
    return JSON.parse(serialized) as unknown
}

function fingerprint(serialized: string) {
    let first = 2166136261
    let second = 2246822519
    for (let index = 0; index < serialized.length; index++) {
        const code = serialized.charCodeAt(index)
        first = Math.imul(first ^ code, 16777619)
        second = Math.imul(second ^ (code + index), 3266489917)
    }
    return `${serialized.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}

function messageKey(chatId: string, messageId: string) {
    return `${chatId}\u0000${messageId}`
}

function characterData(value: character | groupChat) {
    const { chats: _chats, chaId: _chaId, ...data } = value
    return data
}

function chatData(value: Chat) {
    const { message: _messages, id: _id, ...data } = value
    return data
}

function messageData(value: Message) {
    const { chatId: _chatId, ...data } = value
    return data
}

function cloneCache(cache: NodeDatabaseSyncCache): NodeDatabaseSyncCache {
    return {
        revision: cache.revision,
        initialized: cache.initialized,
        root: new Map(cache.root),
        characters: new Map(cache.characters),
        chats: new Map(cache.chats),
        chatParents: new Map(cache.chatParents),
        messages: new Map(cache.messages),
        messageParents: new Map(cache.messageParents),
        characterManifest: cache.characterManifest,
        chatManifests: new Map(cache.chatManifests),
        messageManifests: new Map(cache.messageManifests),
    }
}

export function createNodeDatabaseSyncCache(revision = 0): NodeDatabaseSyncCache {
    return {
        revision,
        initialized: false,
        root: new Map(),
        characters: new Map(),
        chats: new Map(),
        chatParents: new Map(),
        messages: new Map(),
        messageParents: new Map(),
        characterManifest: '[]',
        chatManifests: new Map(),
        messageManifests: new Map(),
    }
}

function ensureNodeHierarchyIds(database: Database) {
    const characterIds = new Set<string>()
    const chatIds = new Set<string>()
    for (const character of database.characters ?? []) {
        if (!character.chaId || characterIds.has(character.chaId)) {
            character.chaId = uuidv4()
        }
        characterIds.add(character.chaId)

        for (const chat of character.chats ?? []) {
            if (!chat.id || chatIds.has(chat.id)) {
                chat.id = uuidv4()
            }
            chatIds.add(chat.id)
        }
    }
}

function ensureMessageIds(chat: Chat) {
    const messageIds = new Set<string>()
    for (const message of chat.message ?? []) {
        if (!message.chatId || messageIds.has(message.chatId)) {
            message.chatId = uuidv4()
        }
        messageIds.add(message.chatId)
    }
}

export function ensureNodeDatabaseIds(database: Database) {
    ensureNodeHierarchyIds(database)
    for (const character of database.characters ?? []) {
        for (const chat of character.chats ?? []) {
            ensureMessageIds(chat)
        }
    }
}

export function primeNodeDatabaseSyncCache(database: Database, revision: number): NodeDatabaseSyncCache {
    ensureNodeDatabaseIds(database)
    const cache = createNodeDatabaseSyncCache(revision)
    cache.initialized = true

    for (const [key, value] of Object.entries(database)) {
        if (key === 'characters') {
            continue
        }
        const serialized = serialize(value)
        if (serialized !== null) {
            cache.root.set(key, fingerprint(serialized))
        }
    }

    const characters = database.characters ?? []
    cache.characterManifest = JSON.stringify(characters.map((value) => value.chaId))
    for (let characterPosition = 0; characterPosition < characters.length; characterPosition++) {
        const currentCharacter = characters[characterPosition]
        const characterSerialized = serialize({
            position: characterPosition,
            data: characterData(currentCharacter),
        })!
        cache.characters.set(currentCharacter.chaId, fingerprint(characterSerialized))

        const chats = currentCharacter.chats ?? []
        cache.chatManifests.set(currentCharacter.chaId, JSON.stringify(chats.map((value) => value.id)))
        for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
            const chat = chats[chatPosition]
            cache.chatParents.set(chat.id!, currentCharacter.chaId)
            cache.chats.set(chat.id!, fingerprint(serialize({
                position: chatPosition,
                data: chatData(chat),
            })!))

            const messages = chat.message ?? []
            cache.messageManifests.set(chat.id!, JSON.stringify(messages.map((value) => value.chatId)))
            for (let messagePosition = 0; messagePosition < messages.length; messagePosition++) {
                const message = messages[messagePosition]
                const key = messageKey(chat.id!, message.chatId!)
                cache.messageParents.set(key, chat.id!)
                cache.messages.set(key, fingerprint(serialize({
                    position: messagePosition,
                    data: messageData(message),
                })!))
            }
        }
    }
    return cache
}

function buildFullSync(
    database: Database,
    cache: NodeDatabaseSyncCache,
): NodeDatabaseSyncBuild {
    ensureNodeDatabaseIds(database)
    const payload: NodeDatabaseSyncPayload = {
        baseRevision: cache.revision,
        replaceAll: true,
        root: { upserts: [], deletes: [] },
        characters: [],
        characterIds: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
    }

    for (const [key, value] of Object.entries(database)) {
        if (key === 'characters') {
            continue
        }
        const serialized = serialize(value)
        if (serialized !== null) {
            payload.root.upserts.push({ key, value: jsonValue(serialized) })
        }
    }

    const characters = database.characters ?? []
    payload.characterIds = characters.map((value) => value.chaId)
    for (let characterPosition = 0; characterPosition < characters.length; characterPosition++) {
        const currentCharacter = characters[characterPosition]
        payload.characters.push({
            id: currentCharacter.chaId,
            position: characterPosition,
            data: jsonValue(serialize(characterData(currentCharacter))!),
        })
        const chats = currentCharacter.chats ?? []
        payload.chatManifests.push({
            characterId: currentCharacter.chaId,
            ids: chats.map((value) => value.id!),
        })
        for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
            const chat = chats[chatPosition]
            payload.chats.push({
                id: chat.id!,
                characterId: currentCharacter.chaId,
                position: chatPosition,
                data: jsonValue(serialize(chatData(chat))!),
            })
            const messages = chat.message ?? []
            payload.messageManifests.push({
                chatId: chat.id!,
                ids: messages.map((value) => value.chatId!),
            })
            for (let messagePosition = 0; messagePosition < messages.length; messagePosition++) {
                const message = messages[messagePosition]
                payload.messages.push({
                    id: message.chatId!,
                    chatId: chat.id!,
                    position: messagePosition,
                    data: jsonValue(serialize(messageData(message))!),
                })
            }
        }
    }

    return {
        payload,
        nextCache: primeNodeDatabaseSyncCache(database, cache.revision),
    }
}

function removeChatFromCache(cache: NodeDatabaseSyncCache, chatId: string) {
    cache.chats.delete(chatId)
    cache.chatParents.delete(chatId)
    cache.messageManifests.delete(chatId)
    for (const [key, parent] of cache.messageParents) {
        if (parent === chatId) {
            cache.messageParents.delete(key)
            cache.messages.delete(key)
        }
    }
}

function removeCharacterFromCache(cache: NodeDatabaseSyncCache, characterId: string) {
    cache.characters.delete(characterId)
    cache.chatManifests.delete(characterId)
    for (const [chatId, parent] of cache.chatParents) {
        if (parent === characterId) {
            removeChatFromCache(cache, chatId)
        }
    }
}

function hasPayloadChanges(payload: NodeDatabaseSyncPayload) {
    return payload.root.upserts.length > 0 || payload.root.deletes.length > 0 ||
        payload.characters.length > 0 || payload.characterIds !== undefined ||
        payload.chats.length > 0 || payload.chatManifests.length > 0 ||
        payload.messages.length > 0 || payload.messageManifests.length > 0
}

export function buildNodeDatabaseSync(
    database: Database,
    changes: toSaveType,
    cache: NodeDatabaseSyncCache,
    options: { forceFull?: boolean } = {},
): NodeDatabaseSyncBuild | null {
    if (options.forceFull || !cache.initialized) {
        return buildFullSync(database, cache)
    }

    ensureNodeHierarchyIds(database)
    const nextCache = cloneCache(cache)
    const payload: NodeDatabaseSyncPayload = {
        baseRevision: cache.revision,
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
    }

    const currentRootKeys = new Set<string>()
    for (const [key, value] of Object.entries(database)) {
        if (key === 'characters') {
            continue
        }
        const serialized = serialize(value)
        if (serialized === null) {
            continue
        }
        currentRootKeys.add(key)
        const valueFingerprint = fingerprint(serialized)
        if (nextCache.root.get(key) !== valueFingerprint) {
            payload.root.upserts.push({ key, value: jsonValue(serialized) })
            nextCache.root.set(key, valueFingerprint)
        }
    }
    for (const key of nextCache.root.keys()) {
        if (!currentRootKeys.has(key)) {
            payload.root.deletes.push(key)
            nextCache.root.delete(key)
        }
    }

    const characters = database.characters ?? []
    const characterIds = characters.map((value) => value.chaId)
    const characterIdSet = new Set(characterIds)
    const characterPositions = new Map(characters.map((value, index) => [value.chaId, index]))
    const characterManifest = JSON.stringify(characterIds)
    const touchedCharacterIds = new Set(changes.character)
    for (const [characterId] of changes.chat) {
        touchedCharacterIds.add(characterId)
    }
    if (characterManifest !== nextCache.characterManifest) {
        payload.characterIds = characterIds
        nextCache.characterManifest = characterManifest
        for (const value of characters) {
            touchedCharacterIds.add(value.chaId)
        }
        for (const cachedId of nextCache.characters.keys()) {
            if (!characterIdSet.has(cachedId)) {
                removeCharacterFromCache(nextCache, cachedId)
            }
        }
    }

    for (const characterId of touchedCharacterIds) {
        const characterPosition = characterPositions.get(characterId)
        if (characterPosition === undefined) {
            continue
        }
        const currentCharacter = characters[characterPosition]
        const serializedCharacterData = serialize(characterData(currentCharacter))!
        const characterFingerprint = fingerprint(serialize({
            position: characterPosition,
            data: jsonValue(serializedCharacterData),
        })!)
        if (nextCache.characters.get(characterId) !== characterFingerprint) {
            payload.characters.push({
                id: characterId,
                position: characterPosition,
                data: jsonValue(serializedCharacterData),
            })
            nextCache.characters.set(characterId, characterFingerprint)
        }

        const chats = currentCharacter.chats ?? []
        const chatIds = chats.map((value) => value.id!)
        const chatIdSet = new Set(chatIds)
        const chatManifest = JSON.stringify(chatIds)
        if (nextCache.chatManifests.get(characterId) !== chatManifest) {
            payload.chatManifests.push({ characterId, ids: chatIds })
            nextCache.chatManifests.set(characterId, chatManifest)
            for (const [chatId, parent] of nextCache.chatParents) {
                if (parent === characterId && !chatIdSet.has(chatId)) {
                    removeChatFromCache(nextCache, chatId)
                }
            }
        }

        for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
            const chat = chats[chatPosition]
            const chatId = chat.id!
            ensureMessageIds(chat)
            const serializedChatData = serialize(chatData(chat))!
            const chatFingerprint = fingerprint(serialize({
                position: chatPosition,
                data: jsonValue(serializedChatData),
            })!)
            if (nextCache.chats.get(chatId) !== chatFingerprint || nextCache.chatParents.get(chatId) !== characterId) {
                payload.chats.push({
                    id: chatId,
                    characterId,
                    position: chatPosition,
                    data: jsonValue(serializedChatData),
                })
                nextCache.chats.set(chatId, chatFingerprint)
                nextCache.chatParents.set(chatId, characterId)
            }

            const messages = chat.message ?? []
            const messageIds = messages.map((value) => value.chatId!)
            const messageIdSet = new Set(messageIds)
            const messageManifest = JSON.stringify(messageIds)
            if (nextCache.messageManifests.get(chatId) !== messageManifest) {
                payload.messageManifests.push({ chatId, ids: messageIds })
                nextCache.messageManifests.set(chatId, messageManifest)
                for (const [key, parent] of nextCache.messageParents) {
                    if (parent === chatId) {
                        const messageId = key.slice(chatId.length + 1)
                        if (!messageIdSet.has(messageId)) {
                            nextCache.messageParents.delete(key)
                            nextCache.messages.delete(key)
                        }
                    }
                }
            }

            for (let messagePosition = 0; messagePosition < messages.length; messagePosition++) {
                const message: Message = messages[messagePosition]
                const messageId = message.chatId!
                const key = messageKey(chatId, messageId)
                const serializedMessageData = serialize(messageData(message))!
                const messageFingerprint = fingerprint(serialize({
                    position: messagePosition,
                    data: jsonValue(serializedMessageData),
                })!)
                if (nextCache.messages.get(key) !== messageFingerprint) {
                    payload.messages.push({
                        id: messageId,
                        chatId,
                        position: messagePosition,
                        data: jsonValue(serializedMessageData),
                    })
                    nextCache.messages.set(key, messageFingerprint)
                    nextCache.messageParents.set(key, chatId)
                }
            }
        }
    }

    if (!hasPayloadChanges(payload)) {
        return null
    }
    return { payload, nextCache }
}
