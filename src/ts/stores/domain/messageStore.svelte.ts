import type { Message } from '../../storage/database.svelte'
import { directSaveMessage, directDeleteMessage } from '../../api/client/directClient'
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
        await directSaveMessage(chatId, message)
    }

    async updateMessage(chatId: string, message: Message): Promise<void> {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        const chat = char?.chats?.[char.chatPage]
        if (chat && chat.id === chatId && chat.message) {
            const index = chat.message.findIndex((m) => m.chatId === message.chatId)
            if (index >= 0) {
                chat.message[index] = message
            }
        }
        await directSaveMessage(chatId, message)
    }

    async deleteMessage(chatId: string, messageId: string): Promise<void> {
        const charId = get(selectedCharID)
        const char = DBState.db?.characters?.[charId]
        const chat = char?.chats?.[char.chatPage]
        if (chat && chat.id === chatId && chat.message) {
            chat.message = chat.message.filter((m) => m.chatId !== messageId)
        }
        await directDeleteMessage(chatId, messageId)
    }
}

export const messageStore = new MessageStore()
