// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { moduleStore } from '../stores/domain/moduleStore.svelte'
import { settingsStore } from '../stores/domain/settingsStore.svelte'
import { presetStore } from '../stores/domain/presetStore.svelte'
import { messageStore } from '../stores/domain/messageStore.svelte'
import { DBState } from '../stores.svelte'

describe('Domain Stores Architecture', () => {
    it('manages modules through moduleStore', async () => {
        DBState.db = { modules: [], enabledModules: [] } as any
        moduleStore.init([], [])

        const testModule = {
            id: 'test-mod-1',
            name: 'Test Module',
            description: 'Testing module store',
        } as any

        await moduleStore.installModule(testModule)
        expect(moduleStore.list).toHaveLength(1)
        expect(moduleStore.getById('test-mod-1')?.name).toBe('Test Module')

        const enabled = await moduleStore.toggleModule('test-mod-1')
        expect(enabled).toBe(true)
        expect(moduleStore.isModuleEnabled('test-mod-1')).toBe(true)

        await moduleStore.removeModule('test-mod-1')
        expect(moduleStore.list).toHaveLength(0)
        expect(moduleStore.isModuleEnabled('test-mod-1')).toBe(false)
    })

    it('manages settings through settingsStore', async () => {
        DBState.db = { theme: 'light', didFirstSetup: false } as any

        expect(settingsStore.get('theme')).toBe('light')
        await settingsStore.set('theme', 'dark')
        expect(settingsStore.get('theme')).toBe('dark')
    })

    it('manages presets through presetStore', async () => {
        DBState.db = { botPresets: [{ name: 'Preset 1' } as any], botPresetsId: 0 } as any

        expect(presetStore.activeIndex).toBe(0)
        expect(presetStore.activePreset?.name).toBe('Preset 1')

        await presetStore.savePreset({ name: 'Preset Updated' } as any, 0)
        expect(presetStore.activePreset?.name).toBe('Preset Updated')
    })
})
