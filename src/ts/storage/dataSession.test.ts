// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { tick } from 'svelte'
import { DataSession } from './dataSession.svelte'
import { createSqlDatabaseAdapter } from './databaseAdapters.svelte'
import type { SqlCommit } from './sqlCommit'

let session: DataSession | null = null

afterEach(() => {
    session?.dispose()
    session = null
})

describe('DataSession commands', () => {
    it('commits an appended message without serializing unrelated database state', async () => {
        const commits: SqlCommit[] = []
        const storage = {
            getRevision: () => 11,
            commit: async (commit: SqlCommit) => {
                commits.push(commit)
                return { revision: 12 }
            },
        } as any
        const database = {
            expensiveUnrelatedSetting: { untouched: true },
            characters: [{
                chaId: 'character-1',
                type: 'character',
                detailsLoaded: true,
                chats: [{
                    id: 'chat-1',
                    detailsLoaded: true,
                    messagesLoaded: true,
                    message: [],
                }],
            }],
        } as any
        session = new DataSession(database, storage)

        session.commands.appendMessage('chat-1', {
            chatId: 'message-1',
            role: 'user',
            data: 'hello',
        } as any)
        await session.flush()

        expect(commits).toHaveLength(1)
        expect(commits[0].baseRevision).toBe(11)
        expect(commits[0].messages).toEqual([{
            id: 'message-1',
            chatId: 'chat-1',
            position: 0,
            data: { role: 'user', data: 'hello' },
        }])
        expect(commits[0].messageManifests).toEqual([{ chatId: 'chat-1', ids: ['message-1'] }])
        expect(commits[0].root.upserts).toEqual([])
        expect(commits[0].characters).toEqual([])
        expect(commits[0].chats).toEqual([])
    })

    it('releases inactive chat messages without committing deletions', async () => {
        const commits: SqlCommit[] = []
        const storage = {
            getRevision: () => 1,
            commit: async (commit: SqlCommit) => {
                commits.push(commit)
                return { revision: 2 }
            },
        } as any
        const inactiveMessages = [{ chatId: 'old-message', role: 'char', data: 'large history' }]
        const database = {
            characters: [{
                chaId: 'character-1',
                type: 'character',
                detailsLoaded: true,
                chats: [{
                    id: 'active-chat',
                    detailsLoaded: true,
                    messagesLoaded: true,
                    message: [{ chatId: 'active-message', role: 'user', data: 'keep me' }],
                }, {
                    id: 'inactive-chat',
                    detailsLoaded: true,
                    messagesLoaded: true,
                    message: inactiveMessages,
                }],
            }],
        } as any
        session = new DataSession(database, storage)

        await session.releaseInactiveChatMessages('active-chat')
        await Promise.resolve()

        expect(database.characters[0].chats[0].message).toHaveLength(1)
        expect(database.characters[0].chats[1]).toMatchObject({
            messagesLoaded: false,
            message: [],
        })
        expect(commits).toEqual([])
    })

    it('uses absolute positions and never writes a destructive manifest for a partial page', async () => {
        const commits: SqlCommit[] = []
        const storage = {
            getRevision: () => 1,
            commit: async (commit: SqlCommit) => {
                commits.push(commit)
                return { revision: 2 }
            },
        } as any
        const database = {
            characters: [{
                chaId: 'character-1',
                type: 'character',
                detailsLoaded: true,
                chats: [{
                    id: 'partial-chat',
                    detailsLoaded: true,
                    messagesLoaded: true,
                    messagesFullyLoaded: false,
                    messageOffset: 90,
                    messageTotal: 100,
                    message: [{ chatId: 'message-90', role: 'char', data: 'before' }],
                }],
            }],
        } as any
        const reactiveDatabase = createSqlDatabaseAdapter(database, storage)
        session = new DataSession(reactiveDatabase, storage)

        await tick()
        reactiveDatabase.characters[0].chats[0].message[0].data = 'after'
        await tick()
        await session.flush()

        expect(commits).toHaveLength(1)
        expect(commits[0].messages).toEqual([{
            id: 'message-90',
            chatId: 'partial-chat',
            position: 90,
            data: { role: 'char', data: 'after' },
        }])
        expect(commits[0].messageManifests).toEqual([])
        expect(() => session!.commands.deleteMessage('partial-chat', 'message-90')).toThrow(/fully loaded/)
    })

    it('compacts a fully saved active chat without deleting server history', async () => {
        const commits: SqlCommit[] = []
        const storage = {
            getRevision: () => 1,
            commit: async (commit: SqlCommit) => {
                commits.push(commit)
                return { revision: 2 }
            },
        } as any
        const database = {
            characters: [{
                chaId: 'character-1',
                type: 'character',
                detailsLoaded: true,
                chats: [{
                    id: 'chat-1',
                    detailsLoaded: true,
                    messagesLoaded: true,
                    messagesFullyLoaded: true,
                    messageOffset: 0,
                    messageTotal: 100,
                    message: Array.from({ length: 100 }, (_, index) => ({
                        chatId: `message-${index}`,
                        role: 'char',
                        data: `message ${index}`,
                    })),
                }],
            }],
        } as any
        const reactiveDatabase = createSqlDatabaseAdapter(database, storage)
        session = new DataSession(reactiveDatabase, storage)
        await tick()
        await session.flush()
        commits.length = 0

        await session.compactChatMessages('chat-1', 10)
        await tick()
        await session.flush()

        const chat = reactiveDatabase.characters[0].chats[0]
        expect(chat.message).toHaveLength(10)
        expect(chat.message[0].chatId).toBe('message-90')
        expect(chat).toMatchObject({ messageOffset: 90, messageTotal: 100, messagesFullyLoaded: false })
        expect(commits).toEqual([])
    })
})
