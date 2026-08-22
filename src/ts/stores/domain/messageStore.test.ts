import { describe, expect, it, beforeEach } from 'vitest'
import { messageStore } from './messageStore.svelte'
import { characterStore } from './characterStore.svelte'
import { setSqlStorageForTesting } from '../../storage/sqlStorageFactory'
import type { ISqlStorage } from '../../storage/ISqlStorage'
import type { SqlCommit, SqlCommitResult } from '../../storage/sqlCommit'
import type { character } from '../../storage/database.svelte'

class MockSqlStorage {
    backendKind = 'web-sqlite' as const
    revision = 1
    commits: SqlCommit[] = []

    async commit(commit: SqlCommit): Promise<SqlCommitResult> {
        this.commits.push(commit)
        this.revision += 1
        return { revision: this.revision }
    }

    getRevision(): number {
        return this.revision
    }

    isEnabled(): boolean {
        return true
    }

    async close(): Promise<void> {}
    async loadDatabase(): Promise<any> { return {} }
    async replaceDatabase(): Promise<boolean> { return true }
    async loadCharacter(): Promise<any> { return null }
    async loadChat(): Promise<any> { return null }
    async loadChatMessagePage(): Promise<any> { return { messages: [], offset: 0, total: 0, hasMore: false } }
    async searchMessages(): Promise<any[]> { return [] }
}

describe('messageStore', () => {
    let mockStorage: MockSqlStorage

    beforeEach(() => {
        mockStorage = new MockSqlStorage()
        setSqlStorageForTesting(mockStorage as unknown as ISqlStorage)

        const testChar: character = {
            chaId: 'char-1',
            type: 'character',
            name: 'TestChar',
            chatPage: 0,
            chats: [{
                id: 'chat-1',
                name: 'Chat 1',
                message: [
                    { chatId: 'msg-1', role: 'user', data: 'hello' },
                    { chatId: 'msg-2', role: 'char', data: 'hi there' },
                    { chatId: 'msg-3', role: 'user', data: 'how are you?' },
                ],
                messagesFullyLoaded: true,
                messageTotal: 3,
            }],
        } as any

        characterStore.init([testChar], mockStorage as unknown as ISqlStorage)
    })

    it('deletes a single message selectively and commits messageDeletes', async () => {
        await messageStore.deleteMessage('chat-1', 'msg-2')

        const chat = characterStore.characters[0].chats[0]
        expect(chat.message).toHaveLength(2)
        expect(chat.message.map((m) => m.chatId)).toEqual(['msg-1', 'msg-3'])
        expect(chat.messageTotal).toBe(2)

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.action).toBe('message-delete')
        expect(commit.messageDeletes).toEqual([{
            chatId: 'chat-1',
            ids: ['msg-2'],
        }])
        expect(commit.messages).toHaveLength(0)
    })

    it('deletes multiple messages selectively with deleteMessages', async () => {
        await messageStore.deleteMessages('chat-1', ['msg-1', 'msg-3'])

        const chat = characterStore.characters[0].chats[0]
        expect(chat.message).toHaveLength(1)
        expect(chat.message[0].chatId).toBe('msg-2')
        expect(chat.messageTotal).toBe(1)

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.action).toBe('message-delete')
        expect(commit.messageDeletes).toEqual([{
            chatId: 'chat-1',
            ids: ['msg-1', 'msg-3'],
        }])
    })

    it('updates a message and commits to SQL', async () => {
        const updatedMsg = { chatId: 'msg-2', role: 'char' as const, data: 'edited content' }
        await messageStore.updateMessage('chat-1', updatedMsg)

        const chat = characterStore.characters[0].chats[0]
        expect(chat.message[1].data).toBe('edited content')

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.action).toBe('message')
        expect(commit.messages).toHaveLength(1)
        expect(commit.messages[0]).toEqual({
            id: 'msg-2',
            chatId: 'chat-1',
            position: 1,
            data: { role: 'char', data: 'edited content' },
        })
    })

    it('commits newly appended messages to SQL', async () => {
        const newMsg = { chatId: 'msg-4', role: 'char' as const, data: 'brand new message' }
        await messageStore.appendMessage('chat-1', newMsg)

        const chat = characterStore.characters[0].chats[0]
        expect(chat.message).toHaveLength(4)
        expect(chat.message[3].chatId).toBe('msg-4')

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.messages).toHaveLength(1)
        expect(commit.messages[0].id).toBe('msg-4')
    })
})
