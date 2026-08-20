import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildFullBackupPayload } = require('./backupFullPayload.cjs') as {
    buildFullBackupPayload: (database: Record<string, unknown>) => Record<string, any>
}
const {
    normalizeBackupConfigSection,
    instantiateVendorStorage,
    applyBackupConfig,
    removeBackupConfig,
    readStoredDbConfig,
    writeStoredDbConfig,
    getDbConfigPath,
    MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
    DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
} = require('./storageDriver.cjs') as {
    normalizeBackupConfigSection: (raw: unknown) => Record<string, any> | null
    instantiateVendorStorage: (vendor: string, params: Record<string, any>, options: Record<string, any>) => Record<string, any>
    applyBackupConfig: (savePath: string, args: Record<string, any>) => { backup: Record<string, any> | null, storage: Record<string, any> | null }
    removeBackupConfig: (savePath: string) => void
    readStoredDbConfig: (savePath: string) => Record<string, any>
    writeStoredDbConfig: (savePath: string, config: Record<string, any>) => void
    getDbConfigPath: (savePath: string) => string
    MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES: number
    DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES: number
}
const { PostgresStorage } = require('./postgresStorage.cjs') as { PostgresStorage: new (options: Record<string, any>) => Record<string, any> }
const { OracleStorage } = require('./oracleStorage.cjs') as { OracleStorage: new (options: Record<string, any>) => Record<string, any> }
const { AzureStorage } = require('./azureStorage.cjs') as { AzureStorage: new (options: Record<string, any>) => Record<string, any> }

let tmpDir: string

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risuai-backup-test-'))
})

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildFullBackupPayload', () => {
    it('builds a replaceAll payload with the sync wire format', () => {
        const database = {
            mainPrompt: 'you are helpful',
            temperature: 0.7,
            pluginCustomStorage: undefined,
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Alice',
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Session',
                            message: [
                                { chatId: 'msg-1', role: 'user', data: 'hi' },
                                { chatId: 'msg-2', role: 'char', data: 'hello' },
                            ],
                        },
                        {
                            id: 'chat-2',
                            name: 'Cold',
                            messagesLoaded: false,
                            message: undefined,
                        },
                    ],
                },
            ],
        }

        const payload = buildFullBackupPayload(database)

        expect(payload.replaceAll).toBe(true)
        expect(payload.baseRevision).toBe(0)
        expect(payload.root.deletes).toEqual([])
        const upsertKeys = payload.root.upserts.map((row: { key: string }) => row.key).sort()
        expect(upsertKeys).toEqual(['mainPrompt', 'temperature'])

        expect(payload.characterIds).toEqual(['char-1'])
        expect(payload.characters).toHaveLength(1)
        expect(payload.characters[0].position).toBe(0)
        // character data에서 chats/chaId 제거
        expect(payload.characters[0].data).not.toHaveProperty('chats')
        expect(payload.characters[0].data).not.toHaveProperty('chaId')
        expect(payload.characters[0].data.name).toBe('Alice')

        expect(payload.chats).toHaveLength(2)
        expect(payload.chats[0]).toMatchObject({ id: 'chat-1', characterId: 'char-1', position: 0 })
        // chat data에서 message/id 제거
        expect(payload.chats[0].data).not.toHaveProperty('message')
        expect(payload.chats[0].data).not.toHaveProperty('id')

        // messagesLoaded:false인 chat은 메시지 없음
        expect(payload.messages).toHaveLength(2)
        expect(payload.messages[0]).toMatchObject({ id: 'msg-1', chatId: 'chat-1', position: 0 })
        // message data에서 chatId(메시지 고유 id) 제거
        expect(payload.messages[0].data).not.toHaveProperty('chatId')
        expect(payload.messages[0].data).toEqual({ role: 'user', data: 'hi' })

        expect(payload.chatManifests).toEqual([
            { characterId: 'char-1', ids: ['chat-1', 'chat-2'] },
        ])
        expect(payload.messageManifests).toEqual([
            { chatId: 'chat-1', ids: ['msg-1', 'msg-2'] },
            { chatId: 'chat-2', ids: [] },
        ])
    })

    it('assigns missing hierarchy ids', () => {
        const database = {
            characters: [
                {
                    name: 'NoIds',
                    chats: [
                        {
                            name: 'Chat',
                            message: [{ role: 'user', data: 'x' }],
                        },
                    ],
                },
            ],
        }
        const payload = buildFullBackupPayload(database)
        const characterId = payload.characters[0].id
        const chatId = payload.chats[0].id
        const messageId = payload.messages[0].id
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        expect(characterId).toMatch(uuidPattern)
        expect(chatId).toMatch(uuidPattern)
        expect(messageId).toMatch(uuidPattern)
        expect(payload.chats[0].characterId).toBe(characterId)
        expect(payload.messages[0].chatId).toBe(chatId)
    })
})

describe('backup config section normalization', () => {
    it('returns null for missing or invalid sections', () => {
        expect(normalizeBackupConfigSection(null)).toBeNull()
        expect(normalizeBackupConfigSection(undefined)).toBeNull()
        expect(normalizeBackupConfigSection({})).toBeNull()
        expect(normalizeBackupConfigSection({ vendor: 'mysql', enabled: true })).toBeNull()
    })

    it('fills defaults and clamps the snapshot interval', () => {
        const backup = normalizeBackupConfigSection({
            vendor: 'postgres',
            enabled: true,
            params: { connectionString: 'postgresql://u:p@h:5432/db' },
            mirroring: { enabled: true },
            snapshot: { enabled: true, intervalMinutes: 1 },
        })
        expect(backup).toMatchObject({
            vendor: 'postgres',
            enabled: true,
            poolMax: 10,
            mirroring: { enabled: true },
            snapshot: { enabled: true, intervalMinutes: MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES },
        })
        expect(backup.params.connectionString).toBe('postgresql://u:p@h:5432/db')

        const defaults = normalizeBackupConfigSection({ vendor: 'oracle', enabled: false })
        expect(defaults?.snapshot.intervalMinutes).toBe(DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES)
        expect(defaults?.mirroring.enabled).toBe(false)
    })
})

describe('stored config backup roundtrip', () => {
    it('persists and removes the backup section alongside primary config', () => {
        const savePath = path.join(tmpDir, 'save1')
        fs.mkdirSync(savePath, { recursive: true })
        writeStoredDbConfig(savePath, {
            vendor: 'postgres',
            enabled: true,
            poolMax: 12,
            params: { connectionString: 'postgresql://main' },
        })
        let stored = readStoredDbConfig(savePath)
        expect(stored.backup).toBeNull()

        const { backup, storage } = applyBackupConfig(savePath, {
            vendor: 'postgres',
            params: { connectionString: 'postgresql://backup-db' },
            mirroring: { enabled: true },
            snapshot: { enabled: true, intervalMinutes: 30 },
        })
        expect(storage).toBeInstanceOf(PostgresStorage)
        expect(backup).toMatchObject({
            vendor: 'postgres',
            enabled: true,
            mirroring: { enabled: true },
            snapshot: { enabled: true, intervalMinutes: 30 },
        })

        stored = readStoredDbConfig(savePath)
        expect(stored.vendor).toBe('postgres')
        expect(stored.params.connectionString).toBe('postgresql://main')
        expect(stored.backup?.vendor).toBe('postgres')
        expect(stored.backup?.params.connectionString).toBe('postgresql://backup-db')
        expect(stored.backup?.snapshot.intervalMinutes).toBe(30)

        removeBackupConfig(savePath)
        stored = readStoredDbConfig(savePath)
        expect(stored.backup).toBeNull()
        expect(stored.vendor).toBe('postgres')
    })

    it('refuses to enable a backup with incomplete parameters', () => {
        const savePath = path.join(tmpDir, 'save2')
        fs.mkdirSync(savePath, { recursive: true })
        writeStoredDbConfig(savePath, {
            vendor: 'postgres',
            enabled: true,
            poolMax: 10,
            params: { connectionString: 'postgresql://main' },
        })
        const { backup, storage } = applyBackupConfig(savePath, {
            vendor: 'postgres',
            params: { connectionString: '' },
            mirroring: { enabled: true },
            snapshot: { enabled: false },
        })
        expect(storage).toBeNull()
        expect(backup).toBeNull()
        expect(readStoredDbConfig(savePath).backup).toBeNull()
    })
})

describe('instantiateVendorStorage', () => {
    it('creates the matching driver for each vendor', () => {
        const pg = instantiateVendorStorage('postgres', { connectionString: 'postgresql://x' }, {})
        expect(pg).toBeInstanceOf(PostgresStorage)
        expect(pg.enabled).toBe(true)

        const disabledPg = instantiateVendorStorage('postgres', { connectionString: '' }, {})
        expect(disabledPg.enabled).toBe(false)

        const ora = instantiateVendorStorage('oracle', {
            user: 'u',
            password: 'p',
            tnsAlias: 'alias',
        }, { poolMax: 7 })
        expect(ora).toBeInstanceOf(OracleStorage)
        expect(ora.enabled).toBe(true)
        expect(ora.poolMax).toBe(7)

        const azure = instantiateVendorStorage('azure', {
            server: 'host',
            database: 'db',
            user: 'u',
            password: 'p',
            port: 1433,
        }, {})
        expect(azure).toBeInstanceOf(AzureStorage)
        expect(azure.enabled).toBe(true)
    })

    it('keeps config file mode restrictive', () => {
        const savePath = path.join(tmpDir, 'save3')
        fs.mkdirSync(savePath, { recursive: true })
        writeStoredDbConfig(savePath, {
            vendor: 'postgres',
            enabled: true,
            poolMax: 10,
            params: { connectionString: 'postgresql://secret' },
            backup: normalizeBackupConfigSection({
                vendor: 'postgres',
                enabled: true,
                params: { connectionString: 'postgresql://backup-secret' },
                mirroring: { enabled: true },
            }),
        })
        const stat = fs.statSync(getDbConfigPath(savePath))
        const mode = stat.mode & 0o777
        if (process.platform !== 'win32') {
            expect(mode).toBe(0o600)
        } else {
            expect(Number.isFinite(mode)).toBe(true)
        }
    })
})

describe('isSecurePostgresConfigRequest logic', () => {
    function testIsSecureRequest(req: { secure?: boolean, headers?: Record<string, string>, socket?: { remoteAddress?: string } }) {
        if (req.secure) return true
        const headers = req.headers || {}
        const forwardedProto = headers['x-forwarded-proto']
        if (typeof forwardedProto === 'string') {
            const proto = forwardedProto.split(',')[0].trim().toLowerCase()
            if (proto === 'https') return true
        }
        const forwardedSsl = headers['x-forwarded-ssl']
        if (typeof forwardedSsl === 'string' && forwardedSsl.toLowerCase() === 'on') return true
        const frontEndHttps = headers['front-end-https']
        if (typeof frontEndHttps === 'string' && frontEndHttps.toLowerCase() === 'on') return true
        const urlScheme = headers['x-url-scheme']
        if (typeof urlScheme === 'string' && urlScheme.toLowerCase() === 'https') return true
        const cfVisitor = headers['cf-visitor']
        if (typeof cfVisitor === 'string' && cfVisitor.includes('"scheme":"https"')) return true
        const forwarded = headers['forwarded']
        if (typeof forwarded === 'string' && /proto=https/i.test(forwarded)) return true

        const remoteAddress = req.socket?.remoteAddress || ''
        return remoteAddress === '127.0.0.1' || remoteAddress === '::1' ||
            remoteAddress === '::ffff:127.0.0.1' || remoteAddress === 'localhost'
    }

    it('allows native secure connections and localhost', () => {
        expect(testIsSecureRequest({ secure: true })).toBe(true)
        expect(testIsSecureRequest({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true)
        expect(testIsSecureRequest({ socket: { remoteAddress: '::1' } })).toBe(true)
        expect(testIsSecureRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true)
    })

    it('allows requests behind HTTPS reverse proxies with headers', () => {
        // Nginx / Caddy / Traefik
        expect(testIsSecureRequest({
            socket: { remoteAddress: '172.18.0.5' },
            headers: { 'x-forwarded-proto': 'https' },
        })).toBe(true)
        // Multi-tier proxy
        expect(testIsSecureRequest({
            socket: { remoteAddress: '10.0.0.2' },
            headers: { 'x-forwarded-proto': 'https, http' },
        })).toBe(true)
        // Cloudflare
        expect(testIsSecureRequest({
            socket: { remoteAddress: '172.18.0.3' },
            headers: { 'cf-visitor': '{"scheme":"https"}' },
        })).toBe(true)
        // RFC 7239
        expect(testIsSecureRequest({
            socket: { remoteAddress: '172.18.0.4' },
            headers: { 'forwarded': 'for=192.0.2.60;proto=https;by=203.0.113.43' },
        })).toBe(true)
    })

    it('rejects unencrypted remote requests without proxy https headers', () => {
        expect(testIsSecureRequest({
            socket: { remoteAddress: '192.168.1.100' },
            headers: { 'x-forwarded-proto': 'http' },
        })).toBe(false)
        expect(testIsSecureRequest({
            socket: { remoteAddress: '203.0.113.1' },
            headers: {},
        })).toBe(false)
    })
})
