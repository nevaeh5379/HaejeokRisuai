import { describe, expect, it } from 'vitest'
import { applySqliteCommit } from './sqliteCommit'
import {
    buildSqlReplaceCommit,
    createEmptySqlCommit,
    hasSqlCommitChanges,
} from './sqlCommit'
import type { Database } from './database.svelte'

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
        expect(commit.root.upserts).toEqual([
            { key: 'username', value: 'User' },
            { key: 'pluginCustomStorage', value: {} },
        ])
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

    it('syncs pluginCustomStorage upserts and deletions to plugin_custom_storage table', async () => {
        const commit = createEmptySqlCommit(1)
        commit.replaceAll = true
        commit.root.upserts.push({
            key: 'pluginCustomStorage',
            value: {
                'my-plugin': { setting1: 'val1' },
            },
        })
        const statements: { sql: string; bind: unknown[] }[] = []

        await applySqliteCommit(commit, (sql, bind = []) => {
            statements.push({ sql, bind })
        })

        expect(statements.some((s) => s.sql.includes('DELETE FROM plugin_custom_storage'))).toBe(true)
        expect(statements.some((s) => s.sql.includes('INSERT OR REPLACE INTO system_settings'))).toBe(true)
        const pluginStorageStmt = statements.find((s) => s.sql.includes('INSERT OR REPLACE INTO plugin_custom_storage'))
        expect(pluginStorageStmt).toBeDefined()
        expect(pluginStorageStmt?.bind[0]).toBe('my-plugin')
        expect(pluginStorageStmt?.bind[1]).toBe(JSON.stringify({ setting1: 'val1' }))
    })

    it('executes targeted plugin_custom_storage deletion when keys are removed', async () => {
        const commit = createEmptySqlCommit(2)
        commit.root.upserts.push({
            key: 'pluginCustomStorage',
            value: {
                'plugin-a': { key: 'a' },
            },
        })
        const statements: { sql: string; bind: unknown[] }[] = []

        await applySqliteCommit(commit, (sql, bind = []) => {
            statements.push({ sql, bind })
        })

        const deleteNotInStmt = statements.find((s) => s.sql.includes('DELETE FROM plugin_custom_storage WHERE key NOT IN'))
        expect(deleteNotInStmt).toBeDefined()
        expect(deleteNotInStmt?.bind).toEqual(['plugin-a'])
    })

    it('clears plugin_custom_storage table when pluginCustomStorage is an empty object', async () => {
        const commit = createEmptySqlCommit(3)
        commit.root.upserts.push({
            key: 'pluginCustomStorage',
            value: {},
        })
        const statements: { sql: string; bind: unknown[] }[] = []

        await applySqliteCommit(commit, (sql, bind = []) => {
            statements.push({ sql, bind })
        })

        const clearStmt = statements.find((s) => s.sql === 'DELETE FROM plugin_custom_storage')
        expect(clearStmt).toBeDefined()
    })

    it('executes targeted message deletions with messageDeletes', async () => {
        const commit = createEmptySqlCommit(5, 'message-delete')
        commit.messageDeletes = [{
            chatId: 'chat-1',
            ids: ['msg-1', 'msg-2'],
        }]
        expect(hasSqlCommitChanges(commit)).toBe(true)

        const statements: { sql: string; bind: unknown[] }[] = []
        await applySqliteCommit(commit, (sql, bind = []) => {
            statements.push({ sql, bind })
        })

        expect(statements).toHaveLength(1)
        expect(statements[0].sql).toBe('DELETE FROM messages WHERE chat_id = ? AND id IN (?,?)')
        expect(statements[0].bind).toEqual(['chat-1', 'msg-1', 'msg-2'])
    })

    it('ensures pluginCustomStorage is always included in buildSqlReplaceCommit root upserts', () => {
        const minimalDb = {
            apiType: 'gemini-3-flash-preview',
            characters: [],
        } as unknown as Database

        const commit = buildSqlReplaceCommit(minimalDb, 0)
        expect(commit.replaceAll).toBe(true)
        const pluginStorageUpsert = commit.root.upserts.find((u) => u.key === 'pluginCustomStorage')
        expect(pluginStorageUpsert).toBeDefined()
        expect(pluginStorageUpsert?.value).toEqual({})
    })
})

