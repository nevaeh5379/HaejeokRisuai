import type { botPreset } from '../../storage/database.svelte'
import { settingsStore } from './settingsStore.svelte'
import { DBState } from '../../stores.svelte'

class PresetStore {
    get list(): botPreset[] {
        return settingsStore.get('botPresets') ?? DBState.db?.botPresets ?? []
    }

    get activeIndex(): number {
        return settingsStore.get('botPresetsId') ?? DBState.db?.botPresetsId ?? 0
    }

    get activePreset(): botPreset | undefined {
        const presets = this.list
        return presets[this.activeIndex] ?? presets[0]
    }

    async savePreset(preset: botPreset, position?: number): Promise<void> {
        const targetPos = position !== undefined ? position : this.activeIndex
        const presets = [...this.list]
        presets[targetPos] = preset
        settingsStore.set('botPresets', presets)
        if (DBState.db) {
            DBState.db.botPresets = presets
        }
        await settingsStore.flush()
    }

    async setPresets(presets: botPreset[]): Promise<void> {
        settingsStore.set('botPresets', presets)
        if (DBState.db) {
            DBState.db.botPresets = presets
        }
        await settingsStore.flush()
    }

    async setActiveIndex(index: number): Promise<void> {
        settingsStore.set('botPresetsId', index)
        if (DBState.db) {
            DBState.db.botPresetsId = index
        }
        await settingsStore.flush()
    }
}

export const presetStore = new PresetStore()
