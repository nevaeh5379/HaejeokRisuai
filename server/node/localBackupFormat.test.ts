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
})
