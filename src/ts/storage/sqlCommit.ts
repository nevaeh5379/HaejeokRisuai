import type { Chat, Database, Message, character, groupChat } from './database.svelte'
import { v4 as uuidv4 } from 'uuid'

export interface SqlSettingUpsert {
    key: string
    value: unknown
}

export interface SqlCharacterUpsert {
    id: string
    position: number
    data: unknown
}

export interface SqlChatUpsert {
    id: string
    characterId: string
    position: number
    data: unknown
}

export interface SqlMessageUpsert {
    id: string
    chatId: string
    position: number
    data: unknown
}

/**
 * A bounded, row-oriented database transaction. Unlike the former save
 * payload this is produced at the mutation boundary; building it never walks
 * the complete Database object.
 */
export interface SqlCommit {
    baseRevision: number
    idempotencyKey?: string
    replaceAll?: boolean
    root: {
        upserts: SqlSettingUpsert[]
        deletes: string[]
    }
    characters: SqlCharacterUpsert[]
    characterIds?: string[]
    chats: SqlChatUpsert[]
    chatManifests: { characterId: string, ids: string[] }[]
    messages: SqlMessageUpsert[]
    messageManifests: { chatId: string, ids: string[] }[]
}

export interface SqlCommitResult {
    revision: number
}

export class SqlRevisionConflictError extends Error {
    constructor(readonly currentRevision: number) {
        super(`SQL revision conflict: current revision is ${currentRevision}`)
        this.name = 'SqlRevisionConflictError'
    }
}

export function createEmptySqlCommit(baseRevision: number): SqlCommit {
    return {
        baseRevision,
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
    }
}

export function hasSqlCommitChanges(commit: SqlCommit): boolean {
    return commit.root.upserts.length > 0 || commit.root.deletes.length > 0 ||
        commit.characters.length > 0 || commit.characterIds !== undefined ||
        commit.chats.length > 0 || commit.chatManifests.length > 0 ||
        commit.messages.length > 0 || commit.messageManifests.length > 0
}

export function sqlCharacterData(value: character | groupChat): unknown {
    const { chats: _chats, chaId: _chaId, detailsLoaded: _detailsLoaded, ...data } = value
    return data
}

export function sqlChatData(value: Chat): unknown {
    const { message: _messages, id: _id, messagesLoaded: _messagesLoaded, detailsLoaded: _detailsLoaded, ...data } = value
    return data
}

export function sqlMessageData(value: Message): unknown {
    const { chatId: _messageId, ...data } = value
    return data
}

/** Used only by explicit database import/reset. Normal persistence must not call this. */
export function buildSqlReplaceCommit(database: Database, baseRevision: number): SqlCommit {
    const commit = createEmptySqlCommit(baseRevision)
    commit.replaceAll = true
    commit.characterIds = []

    for (const [key, value] of Object.entries(database)) {
        if (key !== 'characters' && value !== undefined && typeof value !== 'function' &&
            key !== 'isSql') {
            commit.root.upserts.push({ key, value })
        }
    }
    for (let characterPosition = 0; characterPosition < (database.characters ?? []).length; characterPosition++) {
        const currentCharacter = database.characters[characterPosition]
        currentCharacter.chaId ||= uuidv4()
        commit.characterIds.push(currentCharacter.chaId)
        commit.characters.push({ id: currentCharacter.chaId, position: characterPosition, data: sqlCharacterData(currentCharacter) })
        const chats = currentCharacter.chats ?? []
        for (const chat of chats) chat.id ||= uuidv4()
        commit.chatManifests.push({ characterId: currentCharacter.chaId, ids: chats.map((chat) => chat.id!) })
        for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
            const chat = chats[chatPosition]
            commit.chats.push({ id: chat.id!, characterId: currentCharacter.chaId, position: chatPosition, data: sqlChatData(chat) })
            if (chat.messagesLoaded === false) continue
            const messages = chat.message ?? []
            for (const message of messages) message.chatId ||= uuidv4()
            commit.messageManifests.push({ chatId: chat.id!, ids: messages.map((message) => message.chatId!) })
            for (let messagePosition = 0; messagePosition < messages.length; messagePosition++) {
                const message = messages[messagePosition]
                commit.messages.push({ id: message.chatId!, chatId: chat.id!, position: messagePosition, data: sqlMessageData(message) })
            }
        }
    }
    return commit
}
