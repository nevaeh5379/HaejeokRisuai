import type { RisuPersona } from '../../storage/database.svelte'
import { settingsStore } from './settingsStore.svelte'
import { DBState } from '../../stores.svelte'

class PersonaStore {
    get list(): RisuPersona[] {
        return settingsStore.get('personas') ?? DBState.db?.personas ?? []
    }

    get activeIndex(): number {
        return settingsStore.get('selectedPersona') ?? DBState.db?.selectedPersona ?? 0
    }

    get activePersona(): RisuPersona | undefined {
        const personas = this.list
        return personas[this.activeIndex] ?? personas[0]
    }

    async savePersona(persona: RisuPersona, position?: number): Promise<void> {
        const targetPos = position !== undefined ? position : this.activeIndex
        const current = [...this.list]
        current[targetPos] = persona
        settingsStore.set('personas', current)
        if (DBState.db) {
            DBState.db.personas = current
        }
        await settingsStore.flush()
    }

    async removePersona(index: number): Promise<void> {
        const current = this.list.filter((_, i) => i !== index)
        settingsStore.set('personas', current)
        if (DBState.db) {
            DBState.db.personas = current
        }
        await settingsStore.flush()
    }

    async setActiveIndex(index: number): Promise<void> {
        settingsStore.set('selectedPersona', index)
        if (DBState.db) {
            DBState.db.selectedPersona = index
        }
        await settingsStore.flush()
    }
}

export const personaStore = new PersonaStore()
