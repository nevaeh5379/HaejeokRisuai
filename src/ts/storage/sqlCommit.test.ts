import { describe, expect, it } from 'vitest'
import { applySqliteCommit } from './sqliteCommit'
import {
    buildSqlReplaceCommit,
    createEmptySqlCommit,
    hasSqlCommitChanges,
} from './sqlCommit'

describe('SQL row commits', () => {
    it('keeps character, chat, and message rows separate during explicit import', () => {
        const database = {
            username: 'User',
            characters: [{
                chaId: 'character-1',
                type: 'character',
                name: 'Character',
                chats: [{
                    id: 'chat-1',
                    name: 'Chat',
                    messagesLoaded: true,
                    messageOffset: 0,
                    messageTotal: 1,
                    messagesFullyLoaded: true,
                    message: [{ chatId: 'message-1', role: 'user', data: 'hello' }],
                }],
            }],
        } as any

        const commit = buildSqlReplaceCommit(database, 7)

        expect(commit.baseRevision).toBe(7)
        expect(commit.replaceAll).toBe(true)
        expect(commit.root.upserts).toEqual([{ key: 'username', value: 'User' }])
        expect(commit.characters).toHaveLength(1)
        expect(commit.characters[0].data).not.toHaveProperty('chats')
        expect(commit.chats).toHaveLength(1)
        expect(commit.chats[0].data).not.toHaveProperty('message')
        expect(commit.chats[0].data).not.toHaveProperty('messageOffset')
        expect(commit.chats[0].data).not.toHaveProperty('messageTotal')
        expect(commit.chats[0].data).not.toHaveProperty('messagesFullyLoaded')
        expect(commit.messages).toEqual([{
            id: 'message-1',
            chatId: 'chat-1',
            position: 0,
            data: { role: 'user', data: 'hello' },
        }])
    })

    it('recognizes an empty commit without serializing a Database and tracks action', () => {
        const commit = createEmptySqlCommit(3, 'message')
        expect(hasSqlCommitChanges(commit)).toBe(false)
        expect(commit.action).toBe('message')
    })

    it('executes only rows included in a bounded commit', async () => {
        const commit = createEmptySqlCommit(2)
        commit.root.upserts.push({ key: 'temperature', value: 80 })
        commit.messages.push({
            id: 'message-1',
            chatId: 'chat-1',
            position: 4,
            data: { role: 'char', data: 'answer' },
        })
        const statements: { sql: string, bind: unknown[] }[] = []

        await applySqliteCommit(commit, (sql, bind = []) => {
            statements.push({ sql, bind })
        })

        expect(statements).toHaveLength(2)
        expect(statements[0].sql).toContain('system_settings')
        expect(statements[1].sql).toContain('messages')
        expect(statements.every(({ sql }) => !sql.includes('DELETE FROM characters'))).toBe(true)
    })
})
