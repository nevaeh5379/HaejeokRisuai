// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { settingsStore } from './settingsStore.svelte'
import type { ISqlStorage } from '../../storage/ISqlStorage'
import type { SqlCommit } from '../../storage/sqlCommit'

describe('SettingsStore Reactivity and Persistence', () => {
    let committed: SqlCommit[] = []
    let mockStorage: ISqlStorage

    beforeEach(() => {
        committed = []
        mockStorage = {
            getRevision: vi.fn(() => committed.length),
            commit: vi.fn(async (commit: SqlCommit) => {
                committed.push(structuredClone(commit))
                return { revision: committed.length }
            }),
        } as unknown as ISqlStorage
    })

    it('initializes without firing an immediate commit', async () => {
        settingsStore.init(
            {
                theme: 'dark',
                customModels: [
                    {
                        id: 'xcustom:::test-1',
                        name: 'Initial Model',
                        internalId: 'gpt-4o',
                        url: 'https://api.openai.com',
                        format: 0,
                        tokenizer: 1,
                        key: 'sk-test',
                        params: '',
                        flags: [],
                    },
                ],
            } as any,
            mockStorage,
        )

        // Wait a tick to let initial effect run
        await new Promise((r) => setTimeout(r, 50))
        expect(mockStorage.commit).not.toHaveBeenCalled()
    })

    it('detects deep mutations on customModels across consecutive edits', async () => {
        settingsStore.init(
            {
                customModels: [],
            } as any,
            mockStorage,
        )

        // 1st Edit: Push new custom model
        settingsStore.state.customModels.push({
            id: 'xcustom:::model-1',
            name: 'Initial Name',
            internalId: 'claude-3-5',
            url: '',
            format: 2,
            tokenizer: 6,
            key: '',
            params: '',
            flags: [],
        })

        // Flush 1st edit
        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        expect(committed[0].root.upserts).toContainEqual({
            key: 'customModels',
            value: [
                expect.objectContaining({
                    id: 'xcustom:::model-1',
                    name: 'Initial Name',
                    internalId: 'claude-3-5',
                }),
            ],
        })

        // 2nd Edit: Mutate nested properties (name, url, flags)
        settingsStore.state.customModels[0].name = 'Updated Claude 3.5'
        settingsStore.state.customModels[0].url = 'https://api.anthropic.com'
        settingsStore.state.customModels[0].flags.push(4) // LLMFlags.hasPrefill

        // Flush 2nd edit
        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(2)
        })

        expect(committed[1].root.upserts).toContainEqual({
            key: 'customModels',
            value: [
                expect.objectContaining({
                    id: 'xcustom:::model-1',
                    name: 'Updated Claude 3.5',
                    url: 'https://api.anthropic.com',
                    flags: [4],
                }),
            ],
        })

        // 3rd Edit: Add a second model
        settingsStore.state.customModels.push({
            id: 'xcustom:::model-2',
            name: 'DeepSeek V3',
            internalId: 'deepseek-chat',
            url: 'https://api.deepseek.com',
            format: 0,
            tokenizer: 13,
            key: 'sk-ds',
            params: 'temperature=0.7',
            flags: [8],
        })

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(3)
        })

        expect(committed[2].root.upserts).toContainEqual({
            key: 'customModels',
            value: [
                expect.objectContaining({ id: 'xcustom:::model-1', name: 'Updated Claude 3.5' }),
                expect.objectContaining({ id: 'xcustom:::model-2', name: 'DeepSeek V3' }),
            ],
        })
    })

    it('detects setting key deletions and stages them for commit', async () => {
        settingsStore.init(
            {
                theme: 'dark',
                customBackground: 'bg.jpg',
            } as any,
            mockStorage,
        )

        // Delete a setting key
        delete settingsStore.state.customBackground

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        expect(committed[0].root.deletes).toContain('customBackground')
    })

    it('simulates reload flow preserving custom models', async () => {
        // Initial setup & save
        settingsStore.init(
            {
                customModels: [],
            } as any,
            mockStorage,
        )

        settingsStore.state.customModels.push({
            id: 'xcustom:::my-custom-model',
            name: 'My Custom LLM',
            internalId: 'gemini-2.0-flash',
            url: 'https://generativelanguage.googleapis.com',
            format: 5,
            tokenizer: 10,
            key: 'AIzaSyTestKey',
            params: 'temperature=0.9\nmax_tokens=4096',
            flags: [0, 8, 15],
        })

        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(committed.length).toBe(1)
        })

        const savedPayload = committed[0].root.upserts.find((u) => u.key === 'customModels')?.value as any[]
        expect(savedPayload).toBeDefined()
        expect(savedPayload.length).toBe(1)

        // Reload simulation: re-initialize with saved payload
        const reloadedSettings = {
            customModels: savedPayload,
        }

        const newCommitted: SqlCommit[] = []
        const newMockStorage = {
            getRevision: vi.fn(() => newCommitted.length),
            commit: vi.fn(async (commit: SqlCommit) => {
                newCommitted.push(structuredClone(commit))
                return { revision: newCommitted.length }
            }),
        } as unknown as ISqlStorage

        settingsStore.init(reloadedSettings as any, newMockStorage)

        expect(settingsStore.state.customModels).toHaveLength(1)
        expect(settingsStore.state.customModels[0]).toEqual(
            expect.objectContaining({
                id: 'xcustom:::my-custom-model',
                name: 'My Custom LLM',
                internalId: 'gemini-2.0-flash',
                url: 'https://generativelanguage.googleapis.com',
                key: 'AIzaSyTestKey',
                params: 'temperature=0.9\nmax_tokens=4096',
                flags: [0, 8, 15],
            }),
        )

        // Verify that further edits after reload still trigger commits
        settingsStore.state.customModels[0].name = 'Renamed After Reload'
        await vi.waitFor(async () => {
            await settingsStore.flush()
            expect(newCommitted.length).toBe(1)
        })

        expect(newCommitted[0].root.upserts).toContainEqual({
            key: 'customModels',
            value: [
                expect.objectContaining({
                    id: 'xcustom:::my-custom-model',
                    name: 'Renamed After Reload',
                }),
            ],
        })
    })
})
