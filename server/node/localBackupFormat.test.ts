import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    createEntryHeader,
    makeLegacyCompatibleDatabase,
    encodeDatabase,
    decodeDatabase,
} = require('./localBackupFormat.cjs')

describe('local backup format', () => {
    it('round-trips the legacy compressed database payload', async () => {
        const database = {
            username: '테스트',
            characters: [{ chaId: 'character-1', name: '봇', chats: [] }],
        }
        const encoded = await encodeDatabase(database)

        expect([...encoded.subarray(0, 11)]).toEqual([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])
        expect(decodeDatabase(encoded)).toEqual(database)
    })

    it('removes asset folder metadata without mutating the live database', () => {
        const database = {
            username: 'test',
            characters: [{
                name: 'bot',
                additionalAssets: [['a.png', 'assets/a.png', 'png']],
                additionalAssetFolders: [{ id: 'folder', name: 'Folder' }],
                additionalAssetFolderAssignments: { 'a.png': 'folder' },
            }],
        }
        const portable = makeLegacyCompatibleDatabase(database)

        expect(portable.characters[0].additionalAssets).toEqual(database.characters[0].additionalAssets)
        expect(portable.characters[0]).not.toHaveProperty('additionalAssetFolders')
        expect(portable.characters[0]).not.toHaveProperty('additionalAssetFolderAssignments')
        expect(database.characters[0]).toHaveProperty('additionalAssetFolders')
    })

    it('encodes the existing little-endian entry framing', () => {
        const header = createEntryHeader('assets/example.webp', 1234)
        expect(header.readUInt32LE(0)).toBe('example.webp'.length)
        expect(header.subarray(4, 16).toString()).toBe('example.webp')
        expect(header.readUInt32LE(16)).toBe(1234)
    })

    it('expands native branch timelines into independent legacy chats', () => {
        const database = {
            moduleFolders: [{ id: 'native-only' }],
            characters: [{
                name: 'bot',
                chatPage: 0,
                chats: [{
                    id: 'chat-1',
                    name: 'Adventure',
                    message: [
                        { chatId: 'u1', role: 'user', data: 'Choose' },
                        { chatId: 'r1', role: 'char', data: 'River' },
                    ],
                    bookmarks: ['u1', 'r1'],
                    bookmarkNames: { u1: 'fork', r1: 'answer' },
                    scriptstate: { '$lb-xnai-stack': 'reroll-live' },
                    GLGlobalVariables: { lightboard: 'reroll-live' },
                    useLocallySetGlobalVariables: false,
                    branchState: {
                        baseMessageIndex: 0,
                        activeBranchId: 'reroll',
                        branches: [
                            {
                                id: 'root',
                                reason: 'root',
                                branchMessageIndex: 0,
                                createdAt: 1,
                                messages: [{ chatId: 'a1', role: 'char', data: 'Mountain' }],
                                scriptstate: { '$lb-xnai-stack': 'root' },
                                GLGlobalVariables: { lightboard: 'root' },
                                useLocallySetGlobalVariables: true,
                            },
                            {
                                id: 'reroll',
                                parentBranchId: 'root',
                                reason: 'reroll',
                                branchMessageIndex: 0,
                                createdAt: 2,
                                messages: [{ chatId: 'r1', role: 'char', data: 'River' }],
                                scriptstate: { '$lb-xnai-stack': 'stale-reroll-snapshot' },
                                GLGlobalVariables: { lightboard: 'stale-reroll' },
                                useLocallySetGlobalVariables: true,
                            },
                        ],
                    },
                }],
            }],
        }

        const portable = makeLegacyCompatibleDatabase(database)
        const chats = portable.characters[0].chats
        expect(chats).toHaveLength(2)
        expect(chats.map((chat) => chat.name)).toEqual(['Adventure', 'Adventure (Reroll 1)'])
        expect(chats.map((chat) => chat.message.map((message) => message.data))).toEqual([
            ['Choose', 'Mountain'],
            ['Choose', 'River'],
        ])
        expect(chats.every((chat) => chat.branchState === undefined)).toBe(true)
        expect(chats[0].scriptstate).toEqual({ '$lb-xnai-stack': 'root' })
        expect(chats[0].GLGlobalVariables).toEqual({ lightboard: 'root' })
        expect(chats[0].useLocallySetGlobalVariables).toBe(true)
        expect(chats[1].scriptstate).toEqual({ '$lb-xnai-stack': 'reroll-live' })
        expect(chats[1].GLGlobalVariables).toEqual({ lightboard: 'reroll-live' })
        expect(chats[1].useLocallySetGlobalVariables).toBe(false)
        expect(new Set(chats.map((chat) => chat.id)).size).toBe(2)
        expect(portable.characters[0].chatPage).toBe(1)
        expect(portable).not.toHaveProperty('moduleFolders')
        expect(database.characters[0].chats).toHaveLength(1)
        expect(database.characters[0].chats[0]).toHaveProperty('branchState')
    })

    it('materializes cold-stored characters and chats for compatible backups', () => {
        const characterKey = '44444444-4444-4444-4444-444444444444'
        const chatKey = '55555555-5555-5555-5555-555555555555'
        const coldHeader = '\uEF01COLDSTORAGE\uEF01'
        const database = {
            characters: [{
                chaId: 'cold-char',
                name: 'Stub',
                chatPage: 0,
                coldstorage: characterKey,
                coldStoragedChats: [chatKey],
                chats: [],
            }],
        }
        const coldStorageValues = new Map([
            [characterKey, {
                character: {
                    chaId: 'cold-char',
                    name: 'Restored Bot',
                    chatPage: 0,
                    chats: [{
                        id: 'cold-chat',
                        name: 'Old chat',
                        message: [{ role: 'char', data: coldHeader + chatKey }],
                    }],
                },
            }],
            [chatKey, {
                message: [
                    { chatId: 'old-u', role: 'user', data: 'old question' },
                    { chatId: 'old-a', role: 'char', data: 'old answer' },
                ],
                scriptstate: { restored: true },
                localLore: [],
            }],
        ])

        const portable = makeLegacyCompatibleDatabase(database, coldStorageValues)
        const character = portable.characters[0]
        expect(character.name).toBe('Restored Bot')
        expect(character.chats[0].message.map((message) => message.data)).toEqual([
            'old question',
            'old answer',
        ])
        expect(character.chats[0].scriptstate).toEqual({ restored: true })
        expect(character).not.toHaveProperty('coldstorage')
        expect(character).not.toHaveProperty('coldStoragedChats')
        expect(database.characters[0].name).toBe('Stub')
    })

    it('limits partial export assets to the essential profile image set', async () => {
        // The helper lives inside server.cjs; extract it the same way
        // partial exports use it (plain function on the module scope).
        const { collectEssentialBackupAssetKeys } = extractServerPartialHelper()
        const database = {
            characters: [
                { name: 'main', image: 'assets/char-main.png' },
                { name: 'emotion-bot', image: 'assets/char-emotions.png', emotionImages: [['joy', 'assets/emotion.png']] },
            ],
            personas: [{ name: 'user', icon: 'assets/persona.png' }],
            userIcon: 'assets/user-icon.png',
            customBackground: 'assets/background.png',
            characterOrder: [
                'plain-folder-id',
                { name: 'folder', img: 'assets/folder.png', imgFile: 'assets/folder-file.png' },
            ],
            botPresets: [{ name: 'preset', image: 'assets/preset.png' }],
        }
        const assetKeys = [
            'assets/char-main.png',
            'assets/char-emotions.png',
            'assets/emotion.png',
            'assets/persona.png',
            'assets/user-icon.png',
            'assets/background.png',
            'assets/folder.png',
            'assets/folder-file.png',
            'assets/preset.png',
            'assets/orphan.png',
            'https://example.com/external.png',
        ]

        const keys = collectEssentialBackupAssetKeys(database, assetKeys)
        expect(keys).toEqual([
            'assets/char-main.png',
            'assets/char-emotions.png',
            'assets/persona.png',
            'assets/user-icon.png',
            'assets/background.png',
            'assets/folder.png',
            'assets/folder-file.png',
            'assets/preset.png',
        ])
        expect(keys).not.toContain('assets/emotion.png')
        expect(keys).not.toContain('assets/orphan.png')
    })

    it('keeps full exports untouched after the partial filter runs', () => {
        const { collectEssentialBackupAssetKeys } = extractServerPartialHelper()
        const database = { characters: [{ image: 'assets/a.png' }] }
        const assetKeys = ['assets/a.png', 'assets/b.png']
        const copy = [...assetKeys]
        collectEssentialBackupAssetKeys(database, copy)
        expect(copy).toEqual(assetKeys)
    })
})

// server.cjs starts an actual server when required, so instead of importing it
// the partial-scope helper is duplicated here via a tiny regex extraction that
// keeps the test in sync with the production routine.
function extractServerPartialHelper() {
    const fs = require('node:fs')
    const path = require('node:path')
    const source = fs.readFileSync(path.join(__dirname, 'server.cjs'), 'utf8')
    const start = source.indexOf('function collectEssentialBackupAssetKeys(')
    const end = source.indexOf('\n}', start)
    if (start < 0 || end < 0) throw new Error('partial-scope helper not found in server.cjs')
    const factory = new Function(`${source.slice(start, end + 2)}; return collectEssentialBackupAssetKeys;`)
    return { collectEssentialBackupAssetKeys: factory() }
}
