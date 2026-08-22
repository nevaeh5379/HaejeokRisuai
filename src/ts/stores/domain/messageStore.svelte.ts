import type { Message, Chat } from '../../storage/database.svelte'
import { getSqlStorage } from '../../storage/sqlStorageFactory'
import { characterStore } from './characterStore.svelte'
import { v4 as uuidv4 } from 'uuid'
import { sqlMessageData } from '../../storage/sqlCommit'

function findChatAcrossCharacters(chatId: string): Chat | undefined {
    for (const char of characterStore.characters) {
        const chat = char.chats?.find((c) => c.id === chatId)
        if (chat) return chat
    }
    return characterStore.currentChat?.id === chatId ? characterStore.currentChat : undefined
}

class MessageStore {
    get currentMessages(): Message[] {
        return characterStore.currentChat?.message ?? []
    }

    async appendMessage(chatId: string, message: Message): Promise<void> {
        message.chatId ||= uuidv4()
        const chat = findChatAcrossCharacters(chatId)
        if (chat) {
            chat.message ??= []
            const existingIndex = chat.message.findIndex((m) => m.chatId === message.chatId)
            if (existingIndex >= 0) {
                chat.message[existingIndex] = message
            } else {
                chat.message.push(message)
            }
        }
        try {
            const storage = await getSqlStorage()
            const messages = chat?.message ?? [message]
            const msgIndex = messages.findIndex((m) => m.chatId === message.chatId)
            const position = (chat?.messagesFullyLoaded === false ? (chat?.messageOffset ?? 0) : 0) + (msgIndex >= 0 ? msgIndex : messages.length - 1)
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'message',
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [{
                    id: message.chatId,
                    chatId,
                    position,
                    data: sqlMessageData(message),
                }],
                messageManifests: [],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit appendMessage:', error)
        }
    }

    async commitMessages(chatId: string, msgs: Message[]): Promise<void> {
        if (msgs.length === 0) return
        const chat = findChatAcrossCharacters(chatId)
        const allMessages = chat?.message ?? msgs
        const baseOffset = (chat?.messagesFullyLoaded === false ? (chat?.messageOffset ?? 0) : 0)

        const messageUpserts = msgs.map((m) => {
            m.chatId ||= uuidv4()
            const idx = allMessages.findIndex((item) => item.chatId === m.chatId)
            const position = baseOffset + (idx >= 0 ? idx : allMessages.length - 1)
            return {
                id: m.chatId,
                chatId,
                position,
                data: sqlMessageData(m),
            }
        })

        try {
            const storage = await getSqlStorage()
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'message',
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: messageUpserts,
                messageManifests: chat?.messagesFullyLoaded === false ? [] : [{
                    chatId,
                    ids: allMessages.map((m) => m.chatId!).filter(Boolean),
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit messages:', error)
        }
    }

    async updateMessage(chatId: string, message: Message): Promise<void> {
        const chat = findChatAcrossCharacters(chatId)
        let position = 0
        if (chat && chat.message) {
            const index = chat.message.findIndex((m) => m.chatId === message.chatId)
            if (index >= 0) {
                chat.message[index] = message
                position = (chat.messagesFullyLoaded === false ? (chat.messageOffset ?? 0) : 0) + index
            }
        }
        try {
            const storage = await getSqlStorage()
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'message',
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [{
                    id: message.chatId!,
                    chatId,
                    position,
                    data: sqlMessageData(message),
                }],
                messageManifests: [],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit updateMessage:', error)
        }
    }

    async deleteMessage(chatId: string, messageId: string): Promise<void> {
        const chat = findChatAcrossCharacters(chatId)
        if (chat && chat.message) {
            const beforeLen = chat.message.length
            chat.message = chat.message.filter((m) => m.chatId !== messageId)
            const deletedCount = beforeLen - chat.message.length
            if (deletedCount > 0 && typeof chat.messageTotal === 'number') {
                chat.messageTotal = Math.max(0, chat.messageTotal - deletedCount)
            }
        }
        try {
            const storage = await getSqlStorage()
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'message-delete',
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [],
                messageManifests: [],
                messageDeletes: [{
                    chatId,
                    ids: [messageId],
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit deleteMessage:', error)
        }
    }

    async deleteMessages(chatId: string, messageIds: string[]): Promise<void> {
        if (!messageIds || messageIds.length === 0) return
        const idSet = new Set(messageIds)
        const chat = findChatAcrossCharacters(chatId)
        if (chat && chat.message) {
            const beforeLen = chat.message.length
            chat.message = chat.message.filter((m) => !m.chatId || !idSet.has(m.chatId))
            const deletedCount = beforeLen - chat.message.length
            if (deletedCount > 0 && typeof chat.messageTotal === 'number') {
                chat.messageTotal = Math.max(0, chat.messageTotal - deletedCount)
            }
        }
        try {
            const storage = await getSqlStorage()
            await storage.commit({
                baseRevision: storage.getRevision(),
                action: 'message-delete',
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [],
                messageManifests: [],
                messageDeletes: [{
                    chatId,
                    ids: messageIds,
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit deleteMessages:', error)
        }
    }

    async finalizeStreaming(chatId: string, message: Message): Promise<void> {
        await this.appendMessage(chatId, message)
    }

    async loadOlderMessages(chatId: string, limit?: number): Promise<number> {
        return characterStore.loadOlderChatMessages(chatId, limit)
    }
}

export const messageStore = new MessageStore()

export function releaseInactiveChatMessages(_activeChatId?: string): void {}
export function compactChatMessages(_chatId: string): void {}
export function cancelChatMessageCompaction(_chatId: string): void {}
