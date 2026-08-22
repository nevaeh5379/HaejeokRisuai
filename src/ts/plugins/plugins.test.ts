// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getV2PluginAPIs, importPlugin } from './plugins.svelte'
import { settingsStore } from '../stores/domain/settingsStore.svelte'
import type { ISqlStorage } from '../storage/ISqlStorage'
import type { SqlCommit } from '../storage/sqlCommit'

describe('Plugin Storage & SafeDatabase Persistence', () => {
    let committed: SqlCommit[] = []
    let mockStorage: ISqlStorage

    beforeEach(() => {
        committed = []
        mockStorage = {
            getRevision: vi.fn(() => committed.length),
            loadPluginCustomStorageKey: vi.fn(async () => undefined),
            commit: vi.fn(async (commit: SqlCommit) => {
                committed.push(structuredClone(commit))
                return { revision: committed.length }
            }),
        } as unknown as ISqlStorage

        settingsStore.init(
            {
                username: 'TestUser',
                pluginCustomStorage: {},
            } as any,
            mockStorage,
        )
    })

    it('persists pluginStorage.setItem to settingsStore and SQL', async () => {
        const apis = getV2PluginAPIs()

        apis.pluginStorage.setItem('testKey', { value: 123 })

        expect(await apis.pluginStorage.getItem('testKey')).toEqual({ value: 123 })
        expect(apis.pluginStorage.length()).toBe(1)
        expect(apis.pluginStorage.keys()).toEqual(['testKey'])
        expect(apis.pluginStorage.key(0)).toBe('testKey')

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        expect(committed[0].pluginStorage?.upserts).toContainEqual({
            key: 'testKey',
            value: { value: 123 },
        })
    })

    it('lists unloaded keys and fetches a plugin storage value on first access', async () => {
        mockStorage.loadPluginCustomStorageKey = vi.fn(async (key: string) => {
            return key === 'lazyKey' ? { loaded: true } : undefined
        })
        settingsStore.hydratePluginCustomStorageKeys(['lazyKey'])
        const apis = getV2PluginAPIs()

        expect(apis.pluginStorage.keys()).toEqual(['lazyKey'])
        expect(apis.pluginStorage.length()).toBe(1)
        expect(settingsStore.state.pluginCustomStorage).toEqual({})

        await expect(apis.pluginStorage.getItem('lazyKey')).resolves.toEqual({ loaded: true })
        await expect(apis.pluginStorage.getItem('lazyKey')).resolves.toEqual({ loaded: true })
        expect(mockStorage.loadPluginCustomStorageKey).toHaveBeenCalledTimes(1)

        await settingsStore.flush()
        expect(mockStorage.commit).not.toHaveBeenCalled()
    })

    it('persists pluginStorage.removeItem and clear to settingsStore and SQL', async () => {
        const apis = getV2PluginAPIs()

        apis.pluginStorage.setItem('keyA', 'valA')
        apis.pluginStorage.setItem('keyB', 'valB')

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        // Remove keyA
        apis.pluginStorage.removeItem('keyA')
        expect(await apis.pluginStorage.getItem('keyA')).toBeNull()
        expect(await apis.pluginStorage.getItem('keyB')).toBe('valB')

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(2)
        })

        expect(committed[1].pluginStorage?.deletes).toContain('keyA')

        // Clear
        apis.pluginStorage.clear()
        expect(apis.pluginStorage.length()).toBe(0)
        expect(apis.pluginStorage.keys()).toEqual([])

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(3)
        })

        expect(committed[2].pluginStorage?.clear).toBe(true)
    })

    it('persists custom property writes via safeDatabase proxy', async () => {
        const apis = getV2PluginAPIs()
        const db = apis.getDatabase()

        // Write custom property
        db.myCustomPluginData = { enabled: true, mode: 'fast' }

        expect(db.myCustomPluginData).toEqual({ enabled: true, mode: 'fast' })
        expect('myCustomPluginData' in db).toBe(true)
        expect(Object.keys(db)).toContain('myCustomPluginData')

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        expect(committed[0].pluginStorage?.upserts).toContainEqual({
            key: 'myCustomPluginData',
            value: { enabled: true, mode: 'fast' },
        })

        // Delete custom property
        delete db.myCustomPluginData
        expect(db.myCustomPluginData).toBeUndefined()
        expect('myCustomPluginData' in db).toBe(false)

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(2)
        })

        expect(committed[1].pluginStorage?.deletes).toContain('myCustomPluginData')
    })

    it('persists allowed DB property writes via safeDatabase proxy', async () => {
        const apis = getV2PluginAPIs()
        const db = apis.getDatabase()

        db.theme = 'dracula'
        expect(db.theme).toBe('dracula')

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        expect(committed[0].root.upserts).toContainEqual({
            key: 'theme',
            value: 'dracula',
        })
    })

    it('commits an updated plugin to SQL before reloading plugins', async () => {
        settingsStore.init(
            {
                plugins: [{
                    name: 'UpdateTest',
                    script: 'old script',
                    arguments: {},
                    realArg: {},
                    customLink: [],
                    argMeta: {},
                    version: '3.0',
                    versionOfPlugin: '1.0.0',
                    enabled: false,
                }],
                pluginCustomStorage: {},
            } as any,
            mockStorage,
        )

        await importPlugin([
            '//@name UpdateTest',
            '//@api 3.0',
            '//@version 1.1.0',
            '',
            'Risuai.log("updated");',
        ].join('\n'), {
            isUpdate: true,
            originalPluginName: 'UpdateTest',
        })

        const pluginCommit = committed.find((commit) =>
            commit.root.upserts.some((upsert) => upsert.key === 'plugins'),
        )
        expect(pluginCommit).toBeDefined()
        expect(pluginCommit?.root.upserts).toContainEqual({
            key: 'plugins',
            value: [expect.objectContaining({
                name: 'UpdateTest',
                versionOfPlugin: '1.1.0',
                script: expect.stringContaining('Risuai.log("updated");'),
            })],
        })
    })
})
