import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    AzureStorage,
    assertSqlIdentifier,
    normalizeColdStorageKey,
} = require('./azureStorage.cjs')
const {
    resolveVendor,
    createStorageDriver,
    loadAzureEnvFile,
    readAzureConfigFromEnv,
} = require('./storageDriver.cjs')
const { splitCharacter, splitChat, splitMessage, rebuildCharacter, rebuildChat, rebuildMessage } = require('./postgresRelationalCodec.cjs')
const { splitSetting, rebuildSettings } = require('./postgresSettingsCodec.cjs')

describe('AzureStorage Driver & StorageDriver Integration', () => {
    it('resolves azure vendor properly from options and environment', () => {
        expect(resolveVendor({ vendor: 'azure' })).toBe('azure')

        const prevHost = process.env.AZURE_HOST
        try {
            process.env.AZURE_HOST = 'test.database.windows.net'
            expect(resolveVendor({})).toBe('azure')
        } finally {
            if (prevHost !== undefined) {
                process.env.AZURE_HOST = prevHost
            } else {
                delete process.env.AZURE_HOST
            }
        }
    })

    it('creates AzureStorage instance via createStorageDriver factory', () => {
        const storage = createStorageDriver({ vendor: 'azure', server: 'dummy.database.windows.net' })
        expect(storage).toBeInstanceOf(AzureStorage)
        expect(storage.server).toBe('dummy.database.windows.net')
    })

    it('validates SQL identifier safety', () => {
        expect(assertSqlIdentifier('character.characters')).toBe('[character].[characters]')
        expect(assertSqlIdentifier('system.settings')).toBe('[system].[settings]')
        expect(() => assertSqlIdentifier('system.settings; DROP TABLE users;')).toThrow()
    })

    it('normalizes cold storage UUID keys', () => {
        const uuid = '12345678-1234-1234-1234-123456789abc'
        expect(normalizeColdStorageKey(uuid)).toBe(uuid)
        expect(() => normalizeColdStorageKey('invalid-uuid')).toThrow()
    })
})

describe('Azure SQL Codec & Relational Mapping Consistency', () => {
    it('correctly decomposes and rebuilds character records', () => {
        const charData = {
            name: 'Azure Test Character',
            chaId: 'char-azure-1',
            first_message: 'Hello from Azure!',
            tags: ['test', 'azure', 'ai'],
            alternateGreetings: ['Alt 1', 'Alt 2'],
            bias: [['test', 1.5]],
            chatFolders: [{ id: 'f1', name: 'Folder 1', folded: false }],
        }

        const split = splitCharacter({
            id: 'char-azure-1',
            position: 0,
            data: charData,
        })

        expect(split.core.name).toBe('Azure Test Character')
        expect(split.core.id).toBe('char-azure-1')
        expect(split.tags).toHaveLength(3)
        expect(split.greetings).toHaveLength(2)
        expect(split.biases).toHaveLength(1)
        expect(split.chatFolders).toHaveLength(1)

        const reconstructed = rebuildCharacter(split.core, {
            tags: split.tags,
            greetings: split.greetings,
            biases: split.biases,
            chatFolders: split.chatFolders,
            chats: [],
        })

        expect(reconstructed.name).toBe('Azure Test Character')
        expect(reconstructed.chaId).toBe('char-azure-1')
        expect(reconstructed.tags).toEqual(['test', 'azure', 'ai'])
        expect(reconstructed.alternateGreetings).toEqual(['Alt 1', 'Alt 2'])
        expect(reconstructed.bias).toEqual([['test', 1.5]])
    })

    it('correctly decomposes and rebuilds chat and message records', () => {
        const chatData = {
            id: 'chat-1',
            name: 'First Azure Chat',
            suggestMessages: ['Hi', 'How are you?'],
            bookmarks: ['msg-1'],
            bookmarkNames: { 'msg-1': 'Bookmark 1' },
        }

        const msgData = {
            id: 'msg-1',
            role: 'user',
            data: 'Hello, Azure SQL!',
            name: 'User',
            time: 1234567890,
        }

        const splitC = splitChat({
            id: 'chat-1',
            characterId: 'char-azure-1',
            position: 0,
            data: chatData,
        })

        const splitM = splitMessage({
            id: 'msg-1',
            chatId: 'chat-1',
            position: 0,
            data: msgData,
        })

        expect(splitC.core.name).toBe('First Azure Chat')
        expect(splitC.suggestions).toHaveLength(2)
        expect(splitM.core.role).toBe('user')
        expect(splitM.core.content_text).toBe('Hello, Azure SQL!')

        const reconstructedMsg = rebuildMessage(splitM.core, {
            attributes: [],
            generation: null,
            promptInfo: null,
            promptToggles: [],
            promptItems: [],
        })

        const reconstructedChat = rebuildChat(splitC.core, {
            suggestions: splitC.suggestions,
            bookmarks: splitC.bookmarks,
            messages: [reconstructedMsg],
        })

        expect(reconstructedChat.name).toBe('First Azure Chat')
        expect(reconstructedChat.suggestMessages).toEqual(['Hi', 'How are you?'])
        expect(reconstructedChat.message).toHaveLength(1)
        expect(reconstructedChat.message[0].data).toBe('Hello, Azure SQL!')
        expect(reconstructedChat.message[0].role).toBe('user')
    })

    it('correctly decomposes and rebuilds settings hierarchy', () => {
        const originalSettings = {
            theme: 'dark',
            fontSize: 16,
            nestedConfig: {
                enabled: true,
                items: ['alpha', 'beta'],
            },
        }

        const split = splitSetting('userSettings', originalSettings)
        expect(split.setting.key).toBe('userSettings')
        expect(split.values.length).toBeGreaterThan(0)

        const reconstructed = rebuildSettings(
            [{ key: 'userSettings' }],
            split.values
        )

        expect(reconstructed.userSettings).toEqual(originalSettings)
    })
})

// Lightweight mssql mock that records every SQL statement executed against a
// transaction/pool, so we can assert on the direction of prune DELETEs emitted
// by AzureStorage.sync() without standing up a real SQL Server.
function makeRecordingMssqlMock() {
    const queries: string[] = []

    function record(sqlText: string) {
        queries.push(sqlText.trim().replace(/\s+/g, ' '))
        return { recordset: [] }
    }

    class MockRequest {
        params: Record<string, any> = {}
        input(name: string, _t: any, v?: any) {
            this.params[name] = v !== undefined ? v : _t
            return this
        }
        async query(sqlText: string) { return record(sqlText) }
        async batch(sqlText: string) { return record(sqlText) }
    }

    class MockTransaction {
        constructor(public parent: any) {}
        async begin() {}
        async commit() {}
        async rollback() {}
        request() { return new MockRequest() }
    }

    const sql: any = {
        NVarChar: (len: any) => ({ type: 'NVarChar', length: len }),
        VarBinary: (len: any) => ({ type: 'VarBinary', length: len }),
        Int: { type: 'Int' },
        BigInt: { type: 'BigInt' },
        Bit: { type: 'Bit' },
        Float: { type: 'Float' },
        MAX: 'max',
        ConnectionPool: class MockConnectionPool {
            connected = true
            request() { return new MockRequest() }
            on() {}
            async connect() { this.connected = true; return this }
            async close() { this.connected = false }
        },
        Transaction: MockTransaction,
    }

    return { sql, queries }
}

describe('AzureStorage.sync() entity deletion', () => {
    it('deletes only explicitly named characters, chats, and messages', async () => {
        const { sql, queries } = makeRecordingMssqlMock()

        // Patch the module-local `sql` reference by constructing AzureStorage
        // and overriding its getPool to return a pool that uses our mock.
        const storage = new AzureStorage({ server: 'dummy.database.windows.net' })
        // @ts-ignore — inject mock mssql
        storage.pool = new sql.ConnectionPool({})
        storage.pool.connected = true

        // withTransaction must run the callback against a mock transaction whose
        // request() returns a request that (a) returns revision 5 for the meta
        // SELECT, (b) returns an id for the revision INSERT, and (c) records all
        // other SQL for our assertions.
        class RecordingRequest {
            params: Record<string, any> = {}
            input(name: string, _t: any, v?: any) { this.params[name] = v !== undefined ? v : _t; return this }
            async query(q: string) {
                const t = q.trim().replace(/\s+/g, ' ')
                queries.push(t)
                if (/SELECT revision, initialized FROM \[system\]\.\[storage_meta\]/i.test(q)) {
                    return { recordset: [{ revision: 5, initialized: true }] }
                }
                if (/INSERT INTO \[system\]\.\[revisions\]/i.test(q)) {
                    return { recordset: [{ id: 1 }] }
                }
                return { recordset: [] }
            }
            async batch(q: string) { queries.push(q.trim().replace(/\s+/g, ' ')); return { recordset: [] } }
        }
        class MockTx {
            request() { return new RecordingRequest() }
            async begin() {}
            async commit() {}
            async rollback() {}
        }
        ;(storage as any).withTransaction = async (cb: any) => cb(new MockTx())
        ;(storage as any).getPool = async () => storage.pool

        const payload = {
            baseRevision: 5,
            root: { upserts: [], deletes: [] },
            characters: [],
            characterIds: ['char-a', 'char-b'],
            characterDeletes: ['char-old'],
            chats: [],
            chatManifests: [
                { characterId: 'char-a', ids: ['chat-1', 'chat-2'] },
                { characterId: 'char-b', ids: [] },
            ],
            chatDeletes: ['chat-old'],
            messages: [],
            messageManifests: [
                { chatId: 'chat-1', ids: ['msg-1'] },
            ],
            messageDeletes: [{ chatId: 'chat-1', ids: ['msg-old'] }],
        }

        await storage.sync(payload)

        const joined = queries.join('\n')

        // Character order manifests are non-destructive; only explicit IDs are deleted.
        expect(joined).toMatch(/DELETE target FROM \[character\]\.\[characters\] target INNER JOIN OPENJSON\(@character_delete_ids\)/)
        expect(joined).not.toMatch(/DELETE FROM \[character\]\.\[characters\] WHERE id NOT IN/)

        expect(joined).toMatch(/DELETE target FROM \[chat\]\.\[chats\] target INNER JOIN OPENJSON\(@chat_delete_ids\)/)
        expect(joined).toMatch(/DELETE FROM \[chat\]\.\[messages\] WHERE chat_id = @msg_del_chat_id AND id IN \('msg-old'\)/)
        expect(joined).not.toMatch(/DELETE FROM \[chat\]\.\[chats\].*NOT IN/)
        expect(joined).not.toMatch(/DELETE FROM \[chat\]\.\[messages\].*NOT IN/)
    })
})

describe('AzureStorage Server Interface Compatibility', () => {
    it('implements all methods required by server.cjs and storageDriver', () => {
        const storage = new AzureStorage({ server: 'dummy.database.windows.net' })

        // Lifecycle & Settings
        expect(typeof storage.initialize).toBe('function')
        expect(typeof storage.getState).toBe('function')
        expect(typeof storage.getStatus).toBe('function')
        expect(typeof storage.reconfigure).toBe('function')
        expect(typeof storage.loadStartupData).toBe('function')
        expect(typeof storage.exportDatabaseSnapshot).toBe('function')
        expect(typeof storage.loadCharacter).toBe('function')
        expect(typeof storage.loadChat).toBe('function')
        expect(typeof storage.loadChatMessages).toBe('function')
        expect(typeof storage.loadPlugins).toBe('function')
        expect(typeof storage.loadPluginCustomStorage).toBe('function')
        expect(typeof storage.listPluginCustomStorageKeys).toBe('function')
        expect(typeof storage.loadPluginCustomStorageKey).toBe('function')
        expect(typeof storage.loadPluginsData).toBe('function')
        expect(typeof storage.loadSettingKeys).toBe('function')
        expect(typeof storage.loadPersonas).toBe('function')
        expect(typeof storage.listBotPresets).toBe('function')
        expect(typeof storage.loadBotPreset).toBe('function')
        expect(typeof storage.loadLorebooks).toBe('function')
        expect(typeof storage.loadModules).toBe('function')
        expect(typeof storage.loadPrompts).toBe('function')
        expect(typeof storage.loadScripts).toBe('function')
        expect(typeof storage.loadSettingKey).toBe('function')
        expect(typeof storage.sync).toBe('function')

        // Revisions & Audit
        expect(typeof storage.listRevisions).toBe('function')
        expect(typeof storage.getRevisions).toBe('function')
        expect(typeof storage.getRevision).toBe('function')
        expect(typeof storage.restoreRevision).toBe('function')

        // Cold Storage & Migration
        expect(typeof storage.migrateLegacyColdStorage).toBe('function')
        expect(typeof storage.exportColdStorageToLegacy).toBe('function')
        expect(typeof storage.upsertColdStorage).toBe('function')
        expect(typeof storage.loadColdStorage).toBe('function')
        expect(typeof storage.deleteColdStorage).toBe('function')
        expect(typeof storage.pruneColdStorage).toBe('function')
        expect(typeof storage.listColdStorage).toBe('function')
        expect(typeof storage.listColdStorageKeys).toBe('function')
        expect(typeof storage.listColdStorageOverview).toBe('function')
        expect(typeof storage.inspectColdStorage).toBe('function')

        // DB Explorer
        expect(typeof storage.getTableNames).toBe('function')
        expect(typeof storage.getTableSchema).toBe('function')
        expect(typeof storage.getTableRows).toBe('function')
    })
})
