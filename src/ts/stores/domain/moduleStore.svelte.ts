import type { RisuModule } from '../../process/modules'
import { directSaveModule, directDeleteModule, directUpdateSetting } from '../../api/client/directClient'
import { DBState } from '../../stores.svelte'

class ModuleStore {
    modules = $state<RisuModule[]>([])
    enabledModules = $state<string[]>([])

    init(modules: RisuModule[] = [], enabled: string[] = []): void {
        this.modules = [...modules]
        this.enabledModules = [...enabled]
    }

    get list(): RisuModule[] {
        return this.modules
    }

    get enabledList(): RisuModule[] {
        const enabledSet = new Set(this.enabledModules)
        return this.modules.filter((m) => enabledSet.has(m.id))
    }

    getById(id: string): RisuModule | undefined {
        return this.modules.find((m) => m.id === id)
    }

    async installModule(module: RisuModule): Promise<void> {
        const index = this.modules.findIndex((m) => m.id === module.id)
        if (index >= 0) {
            this.modules[index] = module
        } else {
            this.modules.push(module)
        }
        if (DBState.db) {
            DBState.db.modules = this.modules
        }
        await directSaveModule(module)
    }

    async updateModule(id: string, module: RisuModule): Promise<void> {
        const index = this.modules.findIndex((m) => m.id === id)
        if (index >= 0) {
            this.modules[index] = module
        } else {
            this.modules.push(module)
        }
        if (DBState.db) {
            DBState.db.modules = this.modules
        }
        await directSaveModule(module)
    }

    async removeModule(id: string): Promise<void> {
        this.modules = this.modules.filter((m) => m.id !== id)
        this.enabledModules = this.enabledModules.filter((mId) => mId !== id)
        if (DBState.db) {
            DBState.db.modules = this.modules
            DBState.db.enabledModules = this.enabledModules
        }
        await directDeleteModule(id)
        await directUpdateSetting('enabledModules', this.enabledModules)
    }

    async toggleModule(id: string, forceEnabled?: boolean): Promise<boolean> {
        const enabledSet = new Set(this.enabledModules)
        const shouldEnable = forceEnabled !== undefined ? forceEnabled : !enabledSet.has(id)
        if (shouldEnable) {
            enabledSet.add(id)
        } else {
            enabledSet.delete(id)
        }
        this.enabledModules = Array.from(enabledSet)
        if (DBState.db) {
            DBState.db.enabledModules = this.enabledModules
        }
        await directUpdateSetting('enabledModules', this.enabledModules)
        return shouldEnable
    }

    isModuleEnabled(id: string): boolean {
        return this.enabledModules.includes(id)
    }
}

export const moduleStore = new ModuleStore()
