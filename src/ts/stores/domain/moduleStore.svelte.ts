import type { RisuModule, ModuleFolder } from "../../process/modules";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sqlCommit";
import { commitSqlChanges } from "../../storage/sqlCommitCoordinator";
import { snapshotFingerprint, trackDeep } from "./reactiveUtils";
import { DurableStore } from "./durableStore";

class ModuleStore extends DurableStore {
  modules = $state<RisuModule[]>([]);
  enabledModules = $state<string[]>([]);
  moduleFolders = $state<ModuleFolder[]>([]);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observeDispose: (() => void) | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private committed = { modules: "", enabled: "", folders: "" };

  get list(): RisuModule[] {
    return this.modules;
  }

  get folders(): ModuleFolder[] {
    return this.moduleFolders;
  }

  get enabledList(): RisuModule[] {
    const enabled = new Set(this.enabledModules);
    return this.modules.filter((module) => enabled.has(module.id));
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.disposeObserver();
    this.storage = storage;
    const [modules, enabled, folders] = await Promise.all([
      storage.loadModules(),
      storage.loadSettingKey("enabledModules"),
      storage.loadSettingKey("moduleFolders"),
    ]);
    this.modules = [...modules];
    this.enabledModules = Array.isArray(enabled)
      ? enabled.filter((id): id is string => typeof id === "string")
      : [];
    this.moduleFolders = Array.isArray(folders)
      ? folders as ModuleFolder[]
      : [];
    this.loaded = true;
    this.committed = this.fingerprints();
    this.observeDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.modules);
        trackDeep(this.enabledModules);
        trackDeep(this.moduleFolders);
        const current = this.fingerprints();
        if (
          current.modules !== this.committed.modules ||
          current.enabled !== this.committed.enabled ||
          current.folders !== this.committed.folders
        ) this.scheduleCommit();
      });
    });
  }

  getById(id: string): RisuModule | undefined {
    return this.modules.find((module) => module.id === id);
  }

  getFolderById(id: string): ModuleFolder | undefined {
    return this.moduleFolders.find((folder) => folder.id === id);
  }

  modulesInFolder(folderId: string | undefined): RisuModule[] {
    return this.modules.filter((module) => module.folderId === folderId);
  }

  modulesWithoutFolder(): RisuModule[] {
    return this.modules.filter(
      (module) => !module.folderId || !this.getFolderById(module.folderId),
    );
  }
  async installModule(module: RisuModule): Promise<void> {
    const index = this.modules.findIndex((current) => current.id === module.id);
    if (index >= 0) this.modules[index] = module;
    else this.modules.push(module);
    await this.flush();
  }

  async updateModule(id: string, module: RisuModule): Promise<void> {
    const index = this.modules.findIndex((current) => current.id === id);
    if (index < 0) throw new Error(`Module not found: ${id}`);
    this.modules[index] = module;
    await this.flush();
  }

  async removeModule(id: string): Promise<void> {
    this.modules = this.modules.filter((module) => module.id !== id);
    this.enabledModules = this.enabledModules.filter(
      (moduleId) => moduleId !== id,
    );
    await this.flush();
  }

  async toggleModule(id: string, forceEnabled?: boolean): Promise<boolean> {
    const enabled = new Set(this.enabledModules);
    const shouldEnable = forceEnabled ?? !enabled.has(id);
    if (shouldEnable) enabled.add(id);
    else enabled.delete(id);
    this.enabledModules = [...enabled];
    await this.flush();
    return shouldEnable;
  }

  isModuleEnabled(id: string): boolean {
    return this.enabledModules.includes(id);
  }

  async setEnabledModules(ids: string[]): Promise<void> {
    this.enabledModules = [...new Set(ids)];
    await this.flush();
  }

  async addFolder(name: string, color = ""): Promise<ModuleFolder> {
    const folder: ModuleFolder = {
      id: crypto.randomUUID(),
      name,
      color,
    };
    this.moduleFolders.push(folder);
    await this.flush();
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const folder = this.getFolderById(id);
    if (!folder) throw new Error(`Module folder not found: ${id}`);
    folder.name = name;
    await this.flush();
  }

  async removeFolder(id: string): Promise<void> {
    this.moduleFolders = this.moduleFolders.filter((folder) => folder.id !== id);
    for (const module of this.modules) {
      if (module.folderId === id) module.folderId = undefined;
    }
    await this.flush();
  }

  async moveModuleToFolder(
    moduleId: string,
    folderId: string | undefined,
  ): Promise<void> {
    const module = this.getById(moduleId);
    if (!module) throw new Error(`Module not found: ${moduleId}`);
    if (folderId !== undefined && !this.getFolderById(folderId)) {
      throw new Error(`Module folder not found: ${folderId}`);
    }
    module.folderId = folderId;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const current = this.fingerprints();
    if (
      current.modules === this.committed.modules &&
      current.enabled === this.committed.enabled &&
      current.folders === this.committed.folders
    ) return;

    const storage = this.storage;
    if (!storage) {
      this.committed = current;
      return;
    }
    const commit = createEmptySqlCommit(0, "modules");
    if (current.modules !== this.committed.modules) {
      commit.root.upserts.push({
        key: "modules",
        value: $state.snapshot(this.modules),
      });
    }
    if (current.enabled !== this.committed.enabled) {
      commit.root.upserts.push({
        key: "enabledModules",
        value: $state.snapshot(this.enabledModules),
      });
    }
    if (current.folders !== this.committed.folders) {
      commit.root.upserts.push({
        key: "moduleFolders",
        value: $state.snapshot(this.moduleFolders),
      });
    }
    const operation = this.writeChain.then(() => commitSqlChanges(storage, commit));
    this.writeChain = operation.then(() => undefined, () => undefined);
    await operation;
    this.committed = current;
  }

  hasPendingWrites(): boolean {
    const current = this.fingerprints();
    return (
      current.modules !== this.committed.modules ||
      current.enabled !== this.committed.enabled ||
      current.folders !== this.committed.folders
    );
  }

  private fingerprints() {
    return {
      modules: snapshotFingerprint($state.snapshot(this.modules)),
      enabled: snapshotFingerprint($state.snapshot(this.enabledModules)),
      folders: snapshotFingerprint($state.snapshot(this.moduleFolders)),
    };
  }

  private scheduleCommit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.flush().catch((error) => {
        console.error("[ModuleStore] Failed to persist modules:", error);
      });
    }, 100);
  }

  private disposeObserver(): void {
    this.observeDispose?.();
    this.observeDispose = null;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  resetForTesting(): void {
    this.disposeObserver();
    this.storage = null;
    this.modules = [];
    this.enabledModules = [];
    this.moduleFolders = [];
    this.loaded = false;
    this.committed = { modules: "", enabled: "", folders: "" };
    this.writeChain = Promise.resolve();
  }
}

export const moduleStore = new ModuleStore();
