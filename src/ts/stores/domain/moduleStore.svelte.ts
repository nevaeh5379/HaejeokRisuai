import type { RisuModule, ModuleFolder } from "../../process/modules";
import { settingsStore } from "./settingsStore.svelte";

class ModuleStore {
  modules = $state<RisuModule[]>([]);
  enabledModules = $state<string[]>([]);
  moduleFolders = $state<ModuleFolder[]>([]);

  init(
    modules: RisuModule[] = [],
    enabled: string[] = [],
    folders: ModuleFolder[] = [],
  ): void {
    this.modules = [...modules];
    this.enabledModules = [...enabled];
    this.moduleFolders = [...folders];
    settingsStore.hydrate((state) => {
      state.modules = this.modules;
      state.enabledModules = this.enabledModules;
      state.moduleFolders = this.moduleFolders;
    });
  }

  get list(): RisuModule[] {
    return this.modules.length > 0
      ? this.modules
      : (settingsStore.get("modules") ?? []);
  }

  get folders(): ModuleFolder[] {
    return this.moduleFolders.length > 0
      ? this.moduleFolders
      : (settingsStore.get("moduleFolders") ?? []);
  }

  get enabledList(): RisuModule[] {
    const enabledSet = new Set(
      this.enabledModules.length > 0
        ? this.enabledModules
        : (settingsStore.get("enabledModules") ?? []),
    );
    return this.list.filter((m) => enabledSet.has(m.id));
  }

  getById(id: string): RisuModule | undefined {
    return this.list.find((m) => m.id === id);
  }

  getFolderById(id: string): ModuleFolder | undefined {
    return this.folders.find((f) => f.id === id);
  }

  modulesInFolder(folderId: string | undefined): RisuModule[] {
    return this.list.filter((m) => m.folderId === folderId);
  }

  modulesWithoutFolder(): RisuModule[] {
    return this.list.filter(
      (m) => !m.folderId || !this.getFolderById(m.folderId),
    );
  }

  async installModule(module: RisuModule): Promise<void> {
    const current = [...this.list];
    const index = current.findIndex((m) => m.id === module.id);
    if (index >= 0) {
      current[index] = module;
    } else {
      current.push(module);
    }
    this.modules = current;
    settingsStore.set("modules", current);
    await settingsStore.flush();
  }

  async updateModule(id: string, module: RisuModule): Promise<void> {
    return this.installModule(module);
  }

  async removeModule(id: string): Promise<void> {
    this.modules = this.list.filter((m) => m.id !== id);
    this.enabledModules = (settingsStore.get("enabledModules") ?? []).filter(
      (mId: string) => mId !== id,
    );
    settingsStore.set("modules", this.modules);
    settingsStore.set("enabledModules", this.enabledModules);
    await settingsStore.flush();
  }

  async toggleModule(id: string, forceEnabled?: boolean): Promise<boolean> {
    const currentEnabled =
      settingsStore.get("enabledModules") ?? this.enabledModules;
    const enabledSet = new Set(currentEnabled);
    const shouldEnable =
      forceEnabled !== undefined ? forceEnabled : !enabledSet.has(id);
    if (shouldEnable) {
      enabledSet.add(id);
    } else {
      enabledSet.delete(id);
    }
    this.enabledModules = Array.from(enabledSet);
    settingsStore.set("enabledModules", this.enabledModules);
    await settingsStore.flush();
    return shouldEnable;
  }

  isModuleEnabled(id: string): boolean {
    const enabled = settingsStore.get("enabledModules") ?? this.enabledModules;
    return enabled.includes(id);
  }

  async addFolder(name: string, color = ""): Promise<ModuleFolder> {
    const folder: ModuleFolder = {
      id: crypto.randomUUID(),
      name,
      color,
    };
    this.moduleFolders = [...this.folders, folder];
    settingsStore.set("moduleFolders", this.moduleFolders);
    await settingsStore.flush();
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    this.moduleFolders = this.folders.map((f) =>
      f.id === id ? { ...f, name } : f,
    );
    settingsStore.set("moduleFolders", this.moduleFolders);
    await settingsStore.flush();
  }

  async removeFolder(id: string): Promise<void> {
    this.moduleFolders = this.folders.filter((f) => f.id !== id);
    const modules = this.list.map((m) =>
      m.folderId === id ? { ...m, folderId: undefined } : m,
    );
    this.modules = modules;
    settingsStore.set("moduleFolders", this.moduleFolders);
    settingsStore.set("modules", this.modules);
    await settingsStore.flush();
  }

  async moveModuleToFolder(
    moduleId: string,
    folderId: string | undefined,
  ): Promise<void> {
    this.modules = this.list.map((m) =>
      m.id === moduleId ? { ...m, folderId } : m,
    );
    settingsStore.set("modules", this.modules);
    await settingsStore.flush();
  }
}

export const moduleStore = new ModuleStore();