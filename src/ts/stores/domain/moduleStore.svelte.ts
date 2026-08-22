import type { RisuModule } from '../../process/modules'
import { settingsStore } from './settingsStore.svelte'

class ModuleStore {
    modules = $state<RisuModule[]>([])
    enabledModules = $state<string[]>([])

    init(modules: RisuModule[] = [], enabled: string[] = []): void {
        this.modules = [...modules]
        this.enabledModules = [...enabled]
        settingsStore.hydrate((state) => {
            state.modules = this.modules
            state.enabledModules = this.enabledModules
        })
    }

    get list(): RisuModule[] {
        return this.modules.length > 0 ? this.modules : (settingsStore.get('modules') ?? [])
    }

    get enabledList(): RisuModule[] {
        const enabledSet = new Set(this.enabledModules.length > 0 ? this.enabledModules : (settingsStore.get('enabledModules') ?? []))
        return this.list.filter((m) => enabledSet.has(m.id))
    }

    getById(id: string): RisuModule | undefined {
        return this.list.find((m) => m.id === id)
    }

    async installModule(module: RisuModule): Promise<void> {
        const current = [...this.list]
        const index = current.findIndex((m) => m.id === module.id)
        if (index >= 0) {
            current[index] = module
        } else {
            current.push(module)
        }
        this.modules = current
        settingsStore.set('modules', current)
        await settingsStore.flush()
    }

    async updateModule(id: string, module: RisuModule): Promise<void> {
        return this.installModule(module)
    }

    async removeModule(id: string): Promise<void> {
        this.modules = this.list.filter((m) => m.id !== id)
        this.enabledModules = (settingsStore.get('enabledModules') ?? []).filter((mId: string) => mId !== id)
        settingsStore.set('modules', this.modules)
        settingsStore.set('enabledModules', this.enabledModules)
        await settingsStore.flush()
    }

    async toggleModule(id: string, forceEnabled?: boolean): Promise<boolean> {
        const currentEnabled = settingsStore.get('enabledModules') ?? this.enabledModules
        const enabledSet = new Set(currentEnabled)
        const shouldEnable = forceEnabled !== undefined ? forceEnabled : !enabledSet.has(id)
        if (shouldEnable) {
            enabledSet.add(id)
        } else {
            enabledSet.delete(id)
        }
        this.enabledModules = Array.from(enabledSet)
        settingsStore.set('enabledModules', this.enabledModules)
        await settingsStore.flush()
        return shouldEnable
    }

    isModuleEnabled(id: string): boolean {
        const enabled = settingsStore.get('enabledModules') ?? this.enabledModules
        return enabled.includes(id)
    }
}

export const moduleStore = new ModuleStore()
