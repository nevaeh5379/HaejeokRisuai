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

describe('AzureStorage Server Interface Compatibility', () => {
    it('implements all methods required by server.cjs and storageDriver', () => {
        const storage = new AzureStorage({ server: 'dummy.database.windows.net' })

        // Lifecycle & Settings
        expect(typeof storage.initialize).toBe('function')
        expect(typeof storage.getState).toBe('function')
        expect(typeof storage.getStatus).toBe('function')
        expect(typeof storage.reconfigure).toBe('function')
        expect(typeof storage.loadDatabase).toBe('function')
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
        expect(typeof storage.loadBotPresets).toBe('function')
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

