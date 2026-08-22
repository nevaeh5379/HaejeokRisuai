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

    it('commits newly appended messages to SQL without messageManifests', async () => {
        const newMsg = { chatId: 'msg-4', role: 'char' as const, data: 'brand new message' }
        await messageStore.appendMessage('chat-1', newMsg)

        const chat = characterStore.characters[0].chats[0]
        expect(chat.message).toHaveLength(4)
        expect(chat.message[3].chatId).toBe('msg-4')

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.messages).toHaveLength(1)
        expect(commit.messages[0].id).toBe('msg-4')
        expect(commit.messageManifests).toEqual([])
    })

    it('omits messageManifests in commitMessages when messages are partially loaded', async () => {
        const chat = characterStore.characters[0].chats[0]
        chat.messagesFullyLoaded = false
        chat.messageOffset = 10

        const newMsg = { chatId: 'msg-5', role: 'char' as const, data: 'partial load commit' }
        chat.message.push(newMsg)
        await messageStore.commitMessages('chat-1', [newMsg])

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.messages).toHaveLength(1)
        expect(commit.messages[0].position).toBe(13) // offset (10) + index (3)
        expect(commit.messageManifests).toEqual([])
    })

    it('includes messageManifests in commitMessages when messages are fully loaded', async () => {
        const chat = characterStore.characters[0].chats[0]
        chat.messagesFullyLoaded = true

        const newMsg = { chatId: 'msg-5', role: 'char' as const, data: 'fully loaded commit' }
        chat.message.push(newMsg)
        await messageStore.commitMessages('chat-1', [newMsg])

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.messages).toHaveLength(1)
        expect(commit.messageManifests).toHaveLength(1)
        expect(commit.messageManifests[0].chatId).toBe('chat-1')
        expect(commit.messageManifests[0].ids).toContain('msg-1')
        expect(commit.messageManifests[0].ids).toContain('msg-5')
    })

    it('persists an empty fully-loaded message list', async () => {
        const chat = characterStore.characters[0].chats[0]
        chat.messagesFullyLoaded = true
        chat.message = []

        await messageStore.commitMessages('chat-1', [])

        expect(mockStorage.commits).toHaveLength(1)
        const commit = mockStorage.commits[0]
        expect(commit.messages).toEqual([])
        expect(commit.messageManifests).toEqual([{ chatId: 'chat-1', ids: [] }])
    })
})
