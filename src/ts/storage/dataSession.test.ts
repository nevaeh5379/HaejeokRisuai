// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { DataSession } from './dataSession.svelte'
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
})
