import type { Message } from '../../storage/database.svelte'
import { getSqlStorage } from '../../storage/sqlStorageFactory'
import { DBState, selectedCharID } from '../../stores.svelte'
import { get } from 'svelte/store'

class MessageStore {
    get currentMessages(): Message[] {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        if (!char) return []
        const chat = char.chats?.[char.chatPage]
        return chat?.message ?? []
    }

    async appendMessage(chatId: string, message: Message): Promise<void> {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        const chat = char?.chats?.[char.chatPage]
        if (chat && chat.id === chatId) {
            chat.message ??= []
            chat.message.push(message)
        }
        try {
            const storage = await getSqlStorage()
            const messages = chat?.message ?? [message]
            const position = messages.length - 1
            await storage.commit({
                baseRevision: storage.getRevision(),
                root: { upserts: [], deletes: [] },
                characters: [],
                chats: [],
                chatManifests: [],
                messages: [{
                    id: message.chatId || `${chatId}_${position}`,
                    chatId,
                    position,
                    data: message,
                }],
                messageManifests: [{
                    chatId,
                    ids: messages.map((m, idx) => m.chatId || `${chatId}_${idx}`),
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit appendMessage:', error)
        }
    }

    async updateMessage(chatId: string, message: Message): Promise<void> {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        const chat = char?.chats?.[char.chatPage]
        let position = 0
        if (chat && chat.id === chatId && chat.message) {
            const index = chat.message.findIndex((m) => m.chatId === message.chatId)
            if (index >= 0) {
                chat.message[index] = message
                position = index
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
                    id: message.chatId || `${chatId}_${position}`,
                    chatId,
                    position,
                    data: message,
                }],
                messageManifests: [],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit updateMessage:', error)
        }
    }

    async deleteMessage(chatId: string, messageId: string): Promise<void> {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        const chat = char?.chats?.[char.chatPage]
        if (chat && chat.id === chatId && chat.message) {
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
                    ids: messages.map((m, idx) => m.chatId || `${chatId}_${idx}`),
                }],
            })
        } catch (error) {
            console.error('[MessageStore] Failed to commit deleteMessage:', error)
        }
    }
}

export const messageStore = new MessageStore()
