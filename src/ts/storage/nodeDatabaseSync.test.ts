import { describe, expect, it } from 'vitest'
import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'
import {
    buildNodeDatabaseSync,
    createNodeDatabaseSyncCache,
    primeNodeDatabaseSyncCache,
} from './nodeDatabaseSync'

function database():Database {
    return {
        formatversion: 5,
        username: 'user',
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
        characters: [{
            type: 'character',
            chaId: 'character-1',
            name: 'Character',
            chats: [{
                id: 'chat-1',
                name: 'Chat',
                note: '',
                localLore: [],
                message: [
                    { chatId: 'message-1', role: 'user', data: 'hello' },
                    { chatId: 'message-2', role: 'char', data: 'hi' },
                ],
            }],
        }],
    } as unknown as Database
}

function changes(character = true):toSaveType {
    return {
        character: character ? ['character-1'] : [],
        chat: character ? [['character-1', 'chat-1']] : [],
        botPreset: false,
        modules: false,
        loadouts: false,
        plugins: false,
        pluginCustomStorage: false,
    }
}

describe('node PostgreSQL database sync', () => {
    it('creates a complete normalized payload for first migration', () => {
        const built = buildNodeDatabaseSync(database(), changes(), createNodeDatabaseSyncCache(0))

        expect(built?.payload.replaceAll).toBe(true)
        expect(built?.payload.characterIds).toEqual(['character-1'])
        expect(built?.payload.characters).toHaveLength(1)
        expect(built?.payload.chats).toHaveLength(1)
        expect(built?.payload.messages).toHaveLength(2)
        expect(built?.payload.characters[0].data).not.toHaveProperty('chats')
        expect(built?.payload.characters[0].data).not.toHaveProperty('chaId')
        expect(built?.payload.chats[0].data).not.toHaveProperty('message')
        expect(built?.payload.chats[0].data).not.toHaveProperty('id')
        expect(built?.payload.messages[0].data).not.toHaveProperty('chatId')
    })

    it('sends only the edited message after the initial snapshot', () => {
        const value = database()
        const cache = primeNodeDatabaseSyncCache(value, 7)
        value.characters[0].chats[0].message[1].data = 'edited'

        const built = buildNodeDatabaseSync(value, changes(), cache)

        expect(built?.payload.baseRevision).toBe(7)
        expect(built?.payload.root.upserts).toEqual([])
        expect(built?.payload.characters).toEqual([])
        expect(built?.payload.chats).toEqual([])
        expect(built?.payload.messages).toHaveLength(1)
        expect(built?.payload.messages[0]).toMatchObject({
            id: 'message-2',
            chatId: 'chat-1',
            position: 1,
            data: { data: 'edited' },
        })
    })

    it('sends an ordered manifest and only the new message when appending', () => {
        const value = database()
        const cache = primeNodeDatabaseSyncCache(value, 3)
        value.characters[0].chats[0].message.push({
            chatId: 'message-3',
            role: 'user',
            data: 'next',
        })

        const built = buildNodeDatabaseSync(value, changes(), cache)

        expect(built?.payload.messageManifests).toEqual([{
            chatId: 'chat-1',
            ids: ['message-1', 'message-2', 'message-3'],
        }])
        expect(built?.payload.messages).toHaveLength(1)
        expect(built?.payload.messages[0].id).toBe('message-3')
    })

    it('uses a compact character manifest for deletion', () => {
        const value = database()
        const cache = primeNodeDatabaseSyncCache(value, 2)
        value.characters = []

        const built = buildNodeDatabaseSync(value, {
            ...changes(false),
            character: ['character-1'],
        }, cache)

        expect(built?.payload.characterIds).toEqual([])
        expect(built?.payload.characters).toEqual([])
        expect(built?.payload.chats).toEqual([])
        expect(built?.payload.messages).toEqual([])
    })

    it('does not make a request when the tracked data is unchanged', () => {
        const value = database()
        const cache = primeNodeDatabaseSyncCache(value, 9)

        expect(buildNodeDatabaseSync(value, changes(), cache)).toBeNull()
    })

    it('keeps an edit delta small for a long chat', () => {
        const value = database()
        value.characters[0].chats[0].message = Array.from({ length: 1000 }, (_, index) => ({
            chatId: `message-${index}`,
            role: index % 2 === 0 ? 'user' as const : 'char' as const,
            data: 'x'.repeat(1000),
        }))
        const fullSize = JSON.stringify(value).length
        const cache = primeNodeDatabaseSyncCache(value, 10)
        value.characters[0].chats[0].message[999].data = 'edited'

        const built = buildNodeDatabaseSync(value, changes(), cache)
        const deltaSize = JSON.stringify(built?.payload).length

        expect(built?.payload.messages).toHaveLength(1)
        expect(deltaSize).toBeLessThan(fullSize / 100)
    })
})
