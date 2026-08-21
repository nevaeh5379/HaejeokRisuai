import type { botPreset } from '../../storage/database.svelte'
import { directSaveBotPreset, directUpdateSetting } from '../../api/client/directClient'
import { DBState } from '../../stores.svelte'

class PresetStore {
    get list(): botPreset[] {
        return DBState.db?.botPresets ?? []
    }

    get activeIndex(): number {
        return DBState.db?.botPresetsId ?? 0
    }

    get activePreset(): botPreset | undefined {
        const presets = this.list
        return presets[this.activeIndex] ?? presets[0]
    }

    async savePreset(preset: botPreset, position?: number): Promise<void> {
        const targetPos = position !== undefined ? position : this.activeIndex
        if (DBState.db) {
            DBState.db.botPresets ??= []
            DBState.db.botPresets[targetPos] = preset
        }
        await directSaveBotPreset(preset, targetPos)
    }

    async setActiveIndex(index: number): Promise<void> {
        if (DBState.db) {
            DBState.db.botPresetsId = index
        }
        await directUpdateSetting('botPresetsId', index)
    }
}

export const presetStore = new PresetStore()
