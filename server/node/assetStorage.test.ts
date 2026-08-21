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
    AzureSqlAssetStorage,
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
        expect(getContentType('assets/image.avif')).toBe('image/avif')
        expect(getContentType('assets/image.gif')).toBe('image/gif')
        expect(getContentType('assets/video.webm')).toBe('video/webm')
        expect(getContentType('assets/video.mp4')).toBe('video/mp4')
        expect(getContentType('assets/video.mkv')).toBe('video/x-matroska')
        expect(getContentType('assets/audio.mp3')).toBe('audio/mpeg')
        expect(getContentType('assets/audio.wav')).toBe('audio/wav')
        expect(getContentType('assets/audio.flac')).toBe('audio/flac')
        expect(getContentType('assets/audio.ogg')).toBe('audio/ogg')
        expect(getContentType('assets/font.woff2')).toBe('font/woff2')
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

    it('filters listed keys by prefix', async () => {
        await storage.init()
        await storage.write(keyToHex('assets/avatar.png'), Buffer.from('asset'))
        await storage.write(keyToHex('database/database.bin'), Buffer.from('database'))

        expect(await storage.list('assets/')).toEqual(['assets/avatar.png'])
    })

    it('correctly reads video assets with proper video MIME type', async () => {
        await storage.init()
        const key = 'assets/clip.webm'
        const hex = keyToHex(key)
        const videoData = Buffer.from('mock webm video bytes')

        await storage.write(hex, videoData)
        const readResult = await storage.read(hex)
        expect(readResult.exists).toBe(true)
        expect(readResult.contentType).toBe('video/webm')
        expect(readResult.contentLength).toBe(videoData.length)
        expect(readResult.stream).toBeDefined()
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

describe('S3AssetStorage prefix listing', () => {
    it('passes the prefix to ListObjectsV2', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-s3-list-'))
        try {
            const storage = new S3AssetStorage({
                endpoint: 'http://localhost:9000',
                region: 'us-east-1',
                bucket: 'test-bucket',
                accessKeyId: 'test',
                secretAccessKey: 'test',
            }, tmpDir)
            let requestedPrefix: string | undefined
            storage.client = {
                send: async (command: any) => {
                    requestedPrefix = command.input?.Prefix
                    return { Contents: [{ Key: 'assets/avatar.png', Size: 5 }] }
                },
            }

            expect(await storage.list('assets/')).toEqual(['assets/avatar.png'])
            expect(requestedPrefix).toBe('assets/')
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
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

    it('persists enabled: false on disk and switches to Local FS when setConfig({ storageType: "fs" }) is called', async () => {
        const mgr = new AssetStorageManager(tmpDir)
        await mgr.init()

        // Simulate existing enabled S3 and Azure configs
        mgr.saveS3Config({
            enabled: true,
            endpoint: 'http://localhost:9000',
            bucket: 'test-bucket'
        })
        mgr.saveAzureConfig({
            enabled: true,
            server: 'test.database.windows.net',
            database: 'test-db'
        })
        expect(mgr.s3Config.enabled).toBe(true)
        expect(mgr.azureConfig.enabled).toBe(true)

        // Switch to fs
        const res = await mgr.setConfig({ storageType: 'fs' })
        expect(res.enabled).toBe(false)
        expect(res.storageType).toBe('fs')
        expect(mgr.getStorage().type).toBe('fs')
        expect(mgr.s3Config.enabled).toBe(false)
        expect(mgr.azureConfig.enabled).toBe(false)

        // Read from disk to ensure persistence across restart
        const savedS3 = JSON.parse(fs.readFileSync(path.join(tmpDir, '__s3_config.json'), 'utf8'))
        const savedAzure = JSON.parse(fs.readFileSync(path.join(tmpDir, '__azure_asset_config.json'), 'utf8'))
        expect(savedS3.enabled).toBe(false)
        expect(savedAzure.enabled).toBe(false)

        // Verify a new manager instance initializes with Local FS
        const newMgr = new AssetStorageManager(tmpDir)
        await newMgr.init()
        expect(newMgr.getStorage().type).toBe('fs')
        expect(newMgr.getPublicConfig().enabled).toBe(false)
    })

    it('can build an explorer summary without listing S3', async () => {
        const mgr = new AssetStorageManager(tmpDir)
        await mgr.init()
        let getStatsCalls = 0
        mgr.s3Config = { bucket: 'catalog-bucket', endpoint: 'http://s3.test' }
        mgr.s3Storage = {
            async getStats() {
                getStatsCalls++
                return { totalObjects: 99, totalSizeBytes: 999 }
            }
        } as any

        const summary = await mgr.getSummary({ skipS3Stats: true })

        expect(getStatsCalls).toBe(0)
        expect(summary.s3).toMatchObject({
            storageType: 's3',
            bucketName: 'catalog-bucket',
            totalObjects: 0,
            totalSizeBytes: 0
        })
    })

})

// Mock client used by AssetStorageManager-level tests (kept here to avoid
// coupling the manager tests to the S3AssetStorage describe block).
function makeMockClientForMgr(s3Store: Map<string, Buffer>) {
    return {
        send: async (command: any) => {
            const cmdName = command.constructor.name
            const cmdKey = command.input?.Key
            if (cmdName.includes('PutObject')) {
                const body = command.input.Body
                let data: Buffer
                if (Buffer.isBuffer(body)) {
                    data = body
                } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
                    const chunks: Buffer[] = []
                    for await (const chunk of body) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                    }
                    data = Buffer.concat(chunks)
                } else {
                    data = Buffer.from(body || '')
                }
                s3Store.set(cmdKey, data)
                return {}
            }
            if (cmdName.includes('GetObject')) {
                if (s3Store.has(cmdKey)) {
                    const buf = s3Store.get(cmdKey)!
                    return {
                        Body: { transformToByteArray: async () => new Uint8Array(buf) },
                        ContentType: 'application/octet-stream',
                        ContentLength: buf.length
                    }
                }
                const err: any = new Error('NoSuchKey')
                err.name = 'NoSuchKey'
                throw err
            }
            if (cmdName.includes('ListObjectsV2')) {
                const keys = Array.from(s3Store.keys()).filter(k => !k.startsWith('thumbnails/'))
                return { Contents: keys.map(k => ({ Key: k, Size: s3Store.get(k)!.length })) }
            }
            return {}
        }
    }
}

describe('S3AssetStorage readThumbnail', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-s3thumb-'))
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

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
        }, tmpDir)
        await s3Storage.init()

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

        // 2. Second thumbnail request -> fetches from local disk cache or S3
        const res2 = await s3Storage.readThumbnail(hex, { width: 128, height: 128 })
        expect(res2.exists).toBe(true)
        expect(res2.contentType).toBe('image/webp')
        expect(res2.filePath || res2.buffer).toBeDefined()
        if (res2.buffer) {
            expect(res2.buffer.length).toBe(s3Store.get(thumbKey)!.length)
        } else if (res2.filePath) {
            expect(fs.existsSync(res2.filePath)).toBe(true)
        }

        // 3. Requesting non-existent key returns exists: false
        const missingHex = keyToHex('assets/does_not_exist.png')
        const missingRes = await s3Storage.readThumbnail(missingHex)
        expect(missingRes.exists).toBe(false)
    })
})

describe('writeFromPath support', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-writefrompath-'))
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('LocalFsStorage.writeFromPath moves temporary file and invalidates cached thumbnails', async () => {
        const storage = new LocalFsStorage(tmpDir)
        await storage.init()

        const tempFile = path.join(tmpDir, '__temp_file_123.bin')
        fs.writeFileSync(tempFile, Buffer.from('hello-from-backup'))

        const key = 'assets/restored_image.png'
        const hex = keyToHex(key)

        // Pre-create a thumbnail cache file
        const thumbDir = path.join(tmpDir, '__thumbs')
        fs.mkdirSync(thumbDir, { recursive: true })
        const thumbFile = path.join(thumbDir, `${hex}_128x128.webp`)
        fs.writeFileSync(thumbFile, Buffer.from('old-thumb'))

        await storage.writeFromPath(hex, tempFile)

        // Temporary file should be moved/unlinked
        expect(fs.existsSync(tempFile)).toBe(false)
        // Asset should exist in storage
        expect(await storage.exists(hex)).toBe(true)
        const readRes = await storage.read(hex)
        expect(readRes.exists).toBe(true)
        expect(readRes.contentLength).toBe(Buffer.from('hello-from-backup').length)
        // Outdated thumbnail cache should be removed
        expect(fs.existsSync(thumbFile)).toBe(false)
    })

    it('S3AssetStorage.writeFromPath streams temporary file to S3 and unlinks temporary file', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        })

        const tempFile = path.join(tmpDir, '__temp_s3_file.png')
        const fileContent = Buffer.from('mock-s3-png-data')
        fs.writeFileSync(tempFile, fileContent)

        s3Storage.client = {
            send: async (command: any) => {
                const cmdName = command.constructor.name
                const cmdKey = command.input?.Key
                if (cmdName === 'PutObjectCommand' || cmdName.includes('PutObject')) {
                    // Read stream to buffer for test verification
                    const chunks: Buffer[] = []
                    for await (const chunk of command.input.Body) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                    }
                    s3Store.set(cmdKey, Buffer.concat(chunks))
                    expect(command.input.ContentType).toBe('image/png')
                    expect(command.input.ContentLength).toBe(fileContent.length)
                    return {}
                }
                return {}
            }
        } as any

        const key = 'assets/s3_backup_char.png'
        const hex = keyToHex(key)
        await s3Storage.writeFromPath(hex, tempFile)

        // Temporary file must be deleted after upload
        expect(fs.existsSync(tempFile)).toBe(false)
        // S3 must contain uploaded object
        expect(s3Store.has(key)).toBe(true)
        expect(s3Store.get(key)!).toEqual(fileContent)
    })

    it('AssetStorageManager delegates writeFromPath to activeStorage', async () => {
        const mgr = new AssetStorageManager(tmpDir)
        await mgr.init()

        const tempFile = path.join(tmpDir, '__temp_mgr_file.bin')
        fs.writeFileSync(tempFile, Buffer.from('mgr-data'))

        const key = 'assets/mgr_test.png'
        const hex = keyToHex(key)

        await mgr.writeFromPath(hex, tempFile)
        expect(fs.existsSync(tempFile)).toBe(false)
        expect(await mgr.getStorage().exists(hex)).toBe(true)
    })
})

describe('createWriteStream streaming support', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-writestream-'))
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    it('LocalFsStorage.createWriteStream streams data directly and renames upon finish', async () => {
        const storage = new LocalFsStorage(tmpDir)
        await storage.init()

        const key = 'assets/streamed_file.png'
        const hex = keyToHex(key)

        const writer = storage.createWriteStream(hex)
        writer.stream.write(Buffer.from('chunk-1-'))
        writer.stream.write(Buffer.from('chunk-2'))
        writer.stream.end()

        await writer.done()

        expect(await storage.exists(hex)).toBe(true)
        const readRes = await storage.read(hex)
        expect(readRes.exists).toBe(true)
        expect(readRes.contentLength).toBe(Buffer.from('chunk-1-chunk-2').length)
    })

    it('S3AssetStorage.createWriteStream streams data into S3 Upload pipeline', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        })

        s3Storage.client.send = (async (command: any) => {
                const cmdName = command.constructor.name
                const cmdKey = command.input?.Key
                if (cmdName === 'PutObjectCommand' || cmdName.includes('PutObject')) {
                    const body = command.input.Body
                    let data: Buffer
                    if (Buffer.isBuffer(body)) {
                        data = body
                    } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
                        const chunks: Buffer[] = []
                        for await (const chunk of body) {
                            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                        }
                        data = Buffer.concat(chunks)
                    } else {
                        data = Buffer.from(body || '')
                    }
                    s3Store.set(cmdKey, data)
                    return {}
                }
                if (cmdName === 'CreateMultipartUploadCommand' || cmdName.includes('CreateMultipartUpload')) {
                    return { UploadId: 'mock-upload-id' }
                }
                if (cmdName === 'UploadPartCommand' || cmdName.includes('UploadPart')) {
                    return { ETag: 'mock-etag' }
                }
                if (cmdName === 'CompleteMultipartUploadCommand' || cmdName.includes('CompleteMultipartUpload')) {
                    return { Location: 'mock-location', Bucket: command.input.Bucket, Key: command.input.Key }
                }
                return {}
            }) as any

        const key = 'assets/s3_stream_test.png'
        const hex = keyToHex(key)

        const writer = s3Storage.createWriteStream(hex)
        writer.stream.write(Buffer.from('stream-part-1-'))
        writer.stream.write(Buffer.from('stream-part-2'))
        writer.stream.end()

        await writer.done()

        expect(s3Store.has(key)).toBe(true)
        expect(s3Store.get(key)!).toEqual(Buffer.from('stream-part-1-stream-part-2'))
    })

    it('AzureSqlAssetStorage.createWriteStream preserves uploads with more than 100 chunks', async () => {
        const storage = new AzureSqlAssetStorage({
            server: 'mock.database.windows.net',
            database: 'risuai',
            user: 'test',
            password: 'test'
        }, tmpDir)
        let persisted: Buffer | null = null
        storage.writeFromPath = async (_hex: string, sourcePath: string) => {
            persisted = await fs.promises.readFile(sourcePath)
            await fs.promises.unlink(sourcePath)
            return { success: true }
        }

        const chunks = Array.from({ length: 150 }, (_, index) =>
            Buffer.from(`chunk-${index.toString().padStart(3, '0')}|`))
        const writer = storage.createWriteStream(keyToHex('assets/large.bin'))
        for (const chunk of chunks) writer.stream.write(chunk)
        writer.stream.end()
        await writer.done()

        expect(persisted).toEqual(Buffer.concat(chunks))
        expect(fs.readdirSync(tmpDir).some((name) => name.startsWith('.__azuresql-upload-'))).toBe(false)
    })

    it('AssetStorageManager.createWriteStream delegates to activeStorage', async () => {
        const mgr = new AssetStorageManager(tmpDir)
        await mgr.init()

        const key = 'assets/mgr_stream_test.png'
        const hex = keyToHex(key)

        const writer = mgr.createWriteStream(hex)
        writer.stream.write(Buffer.from('mgr-stream-data'))
        writer.stream.end()

        await writer.done()

        expect(await mgr.getStorage().exists(hex)).toBe(true)
    })

    it('S3AssetStorage eager thumbnail generation on write and local disk caching', async () => {
        const sharp = require('sharp')
        const imageBuffer = await sharp({
            create: {
                width: 200,
                height: 200,
                channels: 4,
                background: { r: 255, g: 128, b: 0, alpha: 1 }
            }
        }).png().toBuffer()

        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        }, tmpDir)
        await s3Storage.init()

        s3Storage.client = {
            send: async (command: any) => {
                const cmdName = command.constructor.name
                const cmdKey = command.input?.Key
                if (cmdName.includes('PutObject')) {
                    s3Store.set(cmdKey, Buffer.from(command.input.Body))
                    return {}
                }
                if (cmdName.includes('GetObject')) {
                    if (s3Store.has(cmdKey)) {
                        const buf = s3Store.get(cmdKey)!
                        return {
                            Body: { transformToByteArray: async () => new Uint8Array(buf) },
                            ContentType: cmdKey.endsWith('.webp') ? 'image/webp' : 'image/png',
                            ContentLength: buf.length
                        }
                    }
                    const err: any = new Error('NoSuchKey')
                    err.name = 'NoSuchKey'
                    throw err
                }
                if (cmdName.includes('ListObjectsV2')) {
                    const contents = Array.from(s3Store.keys()).map(k => ({ Key: k, Size: s3Store.get(k)!.length }))
                    return { Contents: contents }
                }
                return {}
            }
        } as any

        const key = 'assets/eager_bot.png'
        const hex = keyToHex(key)

        // Write original image
        await s3Storage.write(hex, imageBuffer)
        expect(s3Store.has(key)).toBe(true)

        // Give async eager generation a brief tick
        await new Promise(r => setTimeout(r, 100))

        const thumbKey = `thumbnails/${key}_128x128.webp`
        expect(s3Store.has(thumbKey)).toBe(true)

        // Read thumbnail -> should serve from local disk cache
        const thumbRes = await s3Storage.readThumbnail(hex)
        expect(thumbRes.exists).toBe(true)
        expect(thumbRes.contentType).toBe('image/webp')
        expect(thumbRes.filePath).toBeDefined()
        expect(fs.existsSync(thumbRes.filePath)).toBe(true)
    })

    it('S3AssetStorage.generateMissingThumbnails batches thumbnails for images without thumbnails', async () => {
        const sharp = require('sharp')
        const img1 = await sharp({ create: { width: 150, height: 150, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer()
        const img2 = await sharp({ create: { width: 150, height: 150, channels: 4, background: { r: 40, g: 50, b: 60, alpha: 1 } } }).png().toBuffer()

        const s3Store = new Map<string, Buffer>()
        s3Store.set('assets/bot1.png', img1)
        s3Store.set('assets/bot2.png', img2)
        // bot1 already has a thumbnail
        s3Store.set('thumbnails/assets/bot1.png_128x128.webp', Buffer.from('thumb-1'))

        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket'
        }, tmpDir)
        await s3Storage.init()

        s3Storage.client = {
            send: async (command: any) => {
                const cmdName = command.constructor.name
                const cmdKey = command.input?.Key
                if (cmdName.includes('PutObject')) {
                    s3Store.set(cmdKey, Buffer.from(command.input.Body))
                    return {}
                }
                if (cmdName.includes('GetObject')) {
                    if (s3Store.has(cmdKey)) {
                        const buf = s3Store.get(cmdKey)!
                        return {
                            Body: { transformToByteArray: async () => new Uint8Array(buf) },
                            ContentType: cmdKey.endsWith('.webp') ? 'image/webp' : 'image/png',
                            ContentLength: buf.length
                        }
                    }
                    const err: any = new Error('NoSuchKey')
                    err.name = 'NoSuchKey'
                    throw err
                }
                if (cmdName.includes('ListObjectsV2')) {
                    const contents = Array.from(s3Store.keys()).map(k => ({ Key: k, Size: s3Store.get(k)!.length }))
                    return { Contents: contents }
                }
                return {}
            }
        } as any

        const progressEvents: any[] = []
        const result = await s3Storage.generateMissingThumbnails((p) => {
            progressEvents.push(p)
        })

        expect(result.total).toBe(2)
        expect(result.skipped).toBe(1) // bot1 was skipped
        expect(result.created).toBe(1) // bot2 thumbnail was created
        expect(s3Store.has('thumbnails/assets/bot2.png_128x128.webp')).toBe(true)
        expect(progressEvents.length).toBeGreaterThan(0)
    })
})

describe('S3AssetStorage parallel migrate / rollback', () => {
    let tmpDir: string
    let localDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-s3par-'))
        localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-test-s3par-local-'))
    })

    afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
        if (fs.existsSync(localDir)) fs.rmSync(localDir, { recursive: true, force: true })
    })

    const makeMockClient = (s3Store: Map<string, Buffer>) => ({
        send: async (command: any) => {
            const cmdName = command.constructor.name
            const cmdKey = command.input?.Key
            if (cmdName.includes('PutObject')) {
                const body = command.input.Body
                let data: Buffer
                if (Buffer.isBuffer(body)) {
                    data = body
                } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
                    const chunks: Buffer[] = []
                    for await (const chunk of body) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                    }
                    data = Buffer.concat(chunks)
                } else {
                    data = Buffer.from(body || '')
                }
                s3Store.set(cmdKey, data)
                return {}
            }
            if (cmdName.includes('GetObject')) {
                if (s3Store.has(cmdKey)) {
                    const buf = s3Store.get(cmdKey)!
                    return {
                        Body: { transformToByteArray: async () => new Uint8Array(buf) },
                        ContentType: 'application/octet-stream',
                        ContentLength: buf.length
                    }
                }
                const err: any = new Error('NoSuchKey')
                err.name = 'NoSuchKey'
                throw err
            }
            if (cmdName.includes('ListObjectsV2')) {
                // Exclude thumbnails from migration/rollback list (matches S3AssetStorage.list)
                const keys = Array.from(s3Store.keys()).filter(k => !k.startsWith('thumbnails/'))
                return { Contents: keys.map(k => ({ Key: k, Size: s3Store.get(k)!.length })) }
            }
            return {}
        }
    })

    it('migrateFromLocal uploads all local files in parallel and reports progress', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        }, tmpDir)
        await s3Storage.init()
        s3Storage.client = makeMockClient(s3Store) as any

        // Seed 30 local asset files
        const fileCount = 30
        const expectedKeys: string[] = []
        for (let i = 0; i < fileCount; i++) {
            const key = `assets/file_${i}.bin`
            const hex = keyToHex(key)
            fs.writeFileSync(path.join(localDir, hex), Buffer.from(`payload-${i}`))
            expectedKeys.push(key)
        }

        const progressEvents: any[] = []
        const result = await s3Storage.migrateFromLocal(localDir, (p) => progressEvents.push(p))

        expect(result.total).toBe(fileCount)
        expect(result.migrated).toBe(fileCount)
        expect(result.skipped).toBe(0)
        expect(result.errors).toEqual([])
        for (const key of expectedKeys) {
            expect(s3Store.has(key)).toBe(true)
        }
        // Progress is throttled but at least one event should fire.
        expect(progressEvents.length).toBeGreaterThan(0)
        // Final progress should reach 100%.
        const last = progressEvents[progressEvents.length - 1]
        expect(last.percentage).toBe(100)
        // Local files must be preserved (not deleted by migration).
        for (let i = 0; i < fileCount; i++) {
            const hex = keyToHex(`assets/file_${i}.bin`)
            expect(fs.existsSync(path.join(localDir, hex))).toBe(true)
        }
    })

    it('migrateFromLocal skips files already present in S3 (batched exists check)', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        }, tmpDir)
        await s3Storage.init()
        s3Storage.client = makeMockClient(s3Store) as any

        // Pre-seed S3 with one of the three files.
        s3Store.set('assets/keep.bin', Buffer.from('already-there'))

        for (const key of ['assets/keep.bin', 'assets/new1.bin', 'assets/new2.bin']) {
            const hex = keyToHex(key)
            fs.writeFileSync(path.join(localDir, hex), Buffer.from(`data-${key}`))
        }

        const result = await s3Storage.migrateFromLocal(localDir)
        expect(result.total).toBe(3)
        expect(result.migrated).toBe(2)
        expect(result.skipped).toBe(1)
        expect(result.errors).toEqual([])
        expect(s3Store.get('assets/keep.bin')).toEqual(Buffer.from('already-there'))
        expect(s3Store.has('assets/new1.bin')).toBe(true)
        expect(s3Store.has('assets/new2.bin')).toBe(true)
    })

    it('rollbackToLocal downloads all S3 objects in parallel via stream pipeline', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        }, tmpDir)
        await s3Storage.init()
        s3Storage.client = makeMockClient(s3Store) as any

        const fileCount = 25
        const expected: { key: string, body: Buffer }[] = []
        for (let i = 0; i < fileCount; i++) {
            const key = `assets/rb_${i}.bin`
            const body = Buffer.from(`rollback-payload-${i}`)
            s3Store.set(key, body)
            expected.push({ key, body })
        }

        const progressEvents: any[] = []
        const result = await s3Storage.rollbackToLocal(localDir, (p) => progressEvents.push(p))

        expect(result.total).toBe(fileCount)
        expect(result.downloaded).toBe(fileCount)
        expect(result.errors).toEqual([])
        for (const { key, body } of expected) {
            const hex = keyToHex(key)
            expect(fs.existsSync(path.join(localDir, hex))).toBe(true)
            expect(fs.readFileSync(path.join(localDir, hex))).toEqual(body)
        }
        expect(progressEvents.length).toBeGreaterThan(0)
        expect(progressEvents[progressEvents.length - 1].percentage).toBe(100)
    })

    it('migrateFromLocal skips the exists check entirely when RISUAI_MIGRATE_SKIP_EXISTS_CHECK=1', async () => {
        const s3Store = new Map<string, Buffer>()
        const s3Storage = new S3AssetStorage({
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test',
            secretAccessKey: 'test'
        }, tmpDir)
        await s3Storage.init()
        s3Storage.client = makeMockClient(s3Store) as any

        // Pre-seed S3 with one file that would normally be skipped.
        s3Store.set('assets/preexist.bin', Buffer.from('old-data'))

        for (const key of ['assets/preexist.bin', 'assets/fresh.bin']) {
            const hex = keyToHex(key)
            fs.writeFileSync(path.join(localDir, hex), Buffer.from(`new-${key}`))
        }

        const prev = process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK
        process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK = '1'
        try {
            const result = await s3Storage.migrateFromLocal(localDir)
            expect(result.total).toBe(2)
            expect(result.migrated).toBe(2)
            expect(result.skipped).toBe(0)
            // Both files overwritten with local content despite preexist in S3.
            expect(s3Store.get('assets/preexist.bin')).toEqual(Buffer.from('new-assets/preexist.bin'))
            expect(s3Store.get('assets/fresh.bin')).toEqual(Buffer.from('new-assets/fresh.bin'))
        } finally {
            if (prev === undefined) delete process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK
            else process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK = prev
        }
    })
})
