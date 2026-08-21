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
            chat.message.push(message)
        }
        try {
            const storage = await getSqlStorage()
            const messages = chat?.message ?? [message]
            const position = (chat?.messagesFullyLoaded === false ? (chat?.messageOffset ?? 0) : 0) + (chat?.message ? chat.message.length - 1 : 0)
            await storage.commit({
                baseRevision: storage.getRevision(),
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
                messageManifests: [{
                    chatId,
                    ids: messages.map((m) => m.chatId!),
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit appendMessage:', error)
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
            chat.message = chat.message.filter((m) => m.chatId !== messageId)
        }
        try {
            const storage = await getSqlStorage()
            const messages = chat?.message ?? []
            await storage.commit({
                baseRevision: storage.getRevision(),
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [],
                messageManifests: [{
                    chatId,
                    ids: messages.map((m) => m.chatId!),
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit deleteMessage:', error)
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
