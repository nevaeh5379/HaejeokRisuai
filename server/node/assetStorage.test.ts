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
    isImageKey,
    createThumbnailBuffer,
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

    it('identifies image keys properly', () => {
        expect(isImageKey('assets/pic.png')).toBe(true)
        expect(isImageKey('assets/pic.webp')).toBe(true)
        expect(isImageKey('assets/pic.jpg')).toBe(true)
        expect(isImageKey('assets/audio.mp3')).toBe(false)
        expect(isImageKey('data.json')).toBe(false)
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

    it('generates, caches, and deletes thumbnails for image assets', async () => {
        await storage.init()
        const sharp = require('sharp')
        // Create a real 500x500 PNG buffer
        const originalImageBuffer = await sharp({
            create: {
                width: 500,
                height: 500,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        }).png().toBuffer()

        const key = 'assets/avatar.png'
        const hex = keyToHex(key)
        await storage.write(hex, originalImageBuffer)

        // Read thumbnail for the first time (generates and caches)
        const thumbResult1 = await storage.readThumbnail(hex, { width: 128, height: 128 })
        expect(thumbResult1.exists).toBe(true)
        expect(thumbResult1.contentType).toBe('image/webp')

        // Verify dimensions of generated thumbnail
        const thumbMetadata = await sharp(thumbResult1.buffer || fs.readFileSync(thumbResult1.filePath)).metadata()
        expect(thumbMetadata.width).toBe(128)
        expect(thumbMetadata.height).toBe(128)
        expect(thumbMetadata.format).toBe('webp')

        // Read thumbnail for the second time (served from disk cache)
        const thumbResult2 = await storage.readThumbnail(hex, { width: 128, height: 128 })
        expect(thumbResult2.exists).toBe(true)
        expect(thumbResult2.contentType).toBe('image/webp')
        expect(thumbResult2.filePath).toBeDefined()

        // Deleting original asset should also clean up its thumbnails
        await storage.remove(hex)
        expect(await storage.exists(hex)).toBe(false)
        const thumbAfterRemove = await storage.readThumbnail(hex)
        expect(thumbAfterRemove.exists).toBe(false)
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

describe('S3AssetStorage readThumbnail', () => {
    it('fetches original, creates thumbnail, saves to S3, and returns buffer', async () => {
        const sharp = require('sharp')
        const originalImageBuffer = await sharp({
            create: {
                width: 300,
                height: 300,
                channels: 4,
                background: { r: 0, g: 255, b: 0, alpha: 1 }
            }
        }).png().toBuffer()

        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        })

        // Put original image into mock S3 store
        const key = 'assets/s3_char.png'
        const hex = keyToHex(key)
        s3Store.set(key, originalImageBuffer)

        // Mock client.send
        s3Storage.client = {
            send: async (command: any) => {
                const cmdName = command.constructor.name
                const cmdKey = command.input?.Key
                if (cmdName === 'GetObjectCommand' || cmdName.includes('GetObject')) {
                    if (s3Store.has(cmdKey)) {
                        const buf = s3Store.get(cmdKey)!
                        return {
                            Body: {
                                transformToByteArray: async () => new Uint8Array(buf),
                            },
                            ContentType: cmdKey.endsWith('.webp') ? 'image/webp' : 'image/png',
                            ContentLength: buf.length
                        }
                    }
                    const err: any = new Error('NoSuchKey')
                    err.name = 'NoSuchKey'
                    throw err
                }
                if (cmdName === 'PutObjectCommand' || cmdName.includes('PutObject')) {
                    s3Store.set(cmdKey, Buffer.from(command.input.Body))
                    return {}
                }
                return {}
            }
        } as any

        // 1. First thumbnail request -> generates thumbnail and uploads to mock S3
        const res1 = await s3Storage.readThumbnail(hex, { width: 128, height: 128 })
        expect(res1.exists).toBe(true)
        expect(res1.contentType).toBe('image/webp')
        expect(res1.buffer).toBeDefined()
        expect(res1.buffer.length).toBeGreaterThan(0)

        // Verify thumbnail was saved in S3 mock store
        const thumbKey = `thumbnails/${key}_128x128.webp`
        expect(s3Store.has(thumbKey)).toBe(true)

        // 2. Second thumbnail request -> fetches existing thumbnail directly from S3
        const res2 = await s3Storage.readThumbnail(hex, { width: 128, height: 128 })
        expect(res2.exists).toBe(true)
        expect(res2.contentType).toBe('image/webp')
        expect(res2.buffer).toBeDefined()
        expect(res2.buffer.length).toBe(s3Store.get(thumbKey)!.length)

        // 3. Requesting non-existent key returns exists: false
        const missingHex = keyToHex('assets/does_not_exist.png')
        const missingRes = await s3Storage.readThumbnail(missingHex)
        expect(missingRes.exists).toBe(false)
    })
})
