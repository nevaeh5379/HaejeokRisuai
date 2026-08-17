import { createRequire } from 'node:module'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const {
    isHex,
    hexToKey,
    keyToHex,
    getContentType,
    LocalFsStorage,
    S3AssetStorage,
    AssetStorageManager
} = require('./assetStorage.cjs')

describe('AssetStorage utilities', () => {
    it('validates hex strings correctly', () => {
        expect(isHex('6173736574732f746573742e706e67')).toBe(true)
        expect(isHex('invalid_hex')).toBe(false)
        expect(isHex('')).toBe(false)
        expect(isHex('abc')).toBe(false) // Odd length
        expect(isHex(123 as any)).toBe(false)
    })

    it('encodes and decodes hex and keys bidirectionally', () => {
        const key = 'assets/avatar_123.png'
        const hex = keyToHex(key)
        expect(hexToKey(hex)).toBe(key)
    })

    it('returns appropriate content type for various extensions', () => {
        expect(getContentType('assets/image.png')).toBe('image/png')
        expect(getContentType('assets/image.jpg')).toBe('image/jpeg')
        expect(getContentType('assets/image.webp')).toBe('image/webp')
        expect(getContentType('assets/audio.mp3')).toBe('audio/mpeg')
        expect(getContentType('assets/audio.wav')).toBe('audio/wav')
        expect(getContentType('database/database.bin')).toBe('application/octet-stream')
        expect(getContentType('data.json')).toBe('application/json')
    })
})

describe('LocalFsStorage', () => {
    let tmpDir: string
    let storage: any

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-fs-'))
        storage = new LocalFsStorage(tmpDir)
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('writes, checks existence, reads, and deletes files', async () => {
        await storage.init()
        const key = 'assets/test.png'
        const hex = keyToHex(key)
        const payload = Buffer.from('fake-image-bytes')

        expect(await storage.exists(hex)).toBe(false)
        const initialRead = await storage.read(hex)
        expect(initialRead.exists).toBe(false)

        await storage.write(hex, payload)
        expect(await storage.exists(hex)).toBe(true)

        const readResult = await storage.read(hex)
        expect(readResult.exists).toBe(true)
        expect(readResult.contentLength).toBe(payload.length)

        const listResult = await storage.list()
        expect(listResult).toContain(key)

        const stats = await storage.getStats()
        expect(stats.totalObjects).toBe(1)
        expect(stats.totalSizeBytes).toBe(payload.length)

        await storage.remove(hex)
        expect(await storage.exists(hex)).toBe(false)
    })

    it('ignores internal files starting with __ in list and stats', async () => {
        await storage.init()
        fs.writeFileSync(path.join(tmpDir, '__postgres_config.json'), '{}')
        fs.writeFileSync(path.join(tmpDir, '__s3_config.json'), '{}')
        
        const key = 'assets/real.png'
        const hex = keyToHex(key)
        await storage.write(hex, Buffer.from('data'))

        const list = await storage.list()
        expect(list).toEqual([key])

        const stats = await storage.getStats()
        expect(stats.totalObjects).toBe(1)
    })
})

describe('AssetStorageManager', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-mgr-'))
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('initializes with Local FS by default', async () => {
        const mgr = new AssetStorageManager(tmpDir)
        await mgr.init()
        expect(mgr.getStorage().type).toBe('fs')
        expect(mgr.getPublicConfig().enabled).toBe(false)
    })
})
