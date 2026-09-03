import type { RisuModule, ModuleFolder } from "../../process/modules";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { snapshotFingerprint, trackDeep } from "./reactiveUtils";
import { buildModuleDelta } from "./moduleCommit";
import { StoreCommitQueue } from "./storeCommitQueue";
import type { FlushableStore, InitializableStore } from "./storeContracts";

function fingerprintOf(value: unknown): string {
  return snapshotFingerprint($state.snapshot(value));
}

class ModuleStore
  implements InitializableStore<[storage: ISqlStorage]>, FlushableStore
{
  modules = $state<RisuModule[]>([]);
  enabledModules = $state<string[]>([]);
  moduleFolders = $state<ModuleFolder[]>([]);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observeDispose: (() => void) | null = null;
  private queue = new StoreCommitQueue();
  private dirtyModules = false;
  private dirtyEnabled = false;
  private dirtyFolders = false;
  private committedModules: RisuModule[] = [];
  // Fingerprint baselines, taken once at init/commit — never on reactive runs.
  private committedModulesFingerprint = "";
  private committedEnabledFingerprint = "";
  private committedFoldersFingerprint = "";

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
      ? (folders as ModuleFolder[])
      : [];
    this.loaded = true;
    this.committedModules = $state.snapshot(this.modules);
    this.committedModulesFingerprint = fingerprintOf(this.modules);
    this.committedEnabledFingerprint = fingerprintOf(this.enabledModules);
    this.committedFoldersFingerprint = fingerprintOf(this.moduleFolders);
    this.dirtyModules = false;
    this.dirtyEnabled = false;
    this.dirtyFolders = false;
    // Baselines come from the synchronous assignments above — effect runs
    // must never serialise modules (they can embed MB-sized lorebooks).
    // Content is verified once per flush / hasPendingWrites.
    let initial = true;
    this.observeDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.modules);
        trackDeep(this.enabledModules);
        trackDeep(this.moduleFolders);
        if (initial) {
          initial = false;
          return;
        }
        this.dirtyModules = true;
        this.dirtyEnabled = true;
        this.dirtyFolders = true;
        this.scheduleCommit();
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

  /**
   * Adds or updates modules without treating an external partial payload as
   * authority to delete every module it omitted.
   */
  upsertModules(modules: RisuModule[]): void {
    const nextModules = [...this.modules];
    const indexById = new Map(
      nextModules.map((module, index) => [module.id, index] as const),
    );

    for (const module of modules) {
      if (!module || typeof module.id !== "string" || module.id.length === 0) {
        throw new TypeError("Module id must be a non-empty string");
      }

      const existingIndex = indexById.get(module.id);
      if (existingIndex !== undefined) {
        nextModules[existingIndex] = module;
        continue;
      }

      indexById.set(module.id, nextModules.length);
      nextModules.push(module);
    }

    this.modules = nextModules;
    this.markModulesDirty();
  }

  async installModule(module: RisuModule): Promise<void> {
    this.upsertModules([module]);
    await this.flush();
  }

  async updateModule(id: string, module: RisuModule): Promise<void> {
    const index = this.modules.findIndex((current) => current.id === id);
    if (index < 0) throw new Error(`Module not found: ${id}`);
    this.modules[index] = module;
    this.markModulesDirty();
    await this.flush();
  }

  async removeModule(id: string): Promise<void> {
    this.modules = this.modules.filter((module) => module.id !== id);
    this.enabledModules = this.enabledModules.filter(
      (moduleId) => moduleId !== id,
    );
    this.markModulesDirty();
    this.dirtyEnabled = true;
    await this.flush();
  }

  async toggleModule(id: string, forceEnabled?: boolean): Promise<boolean> {
    const enabled = new Set(this.enabledModules);
    const shouldEnable = forceEnabled ?? !enabled.has(id);
    if (shouldEnable) enabled.add(id);
    else enabled.delete(id);
    this.enabledModules = [...enabled];
    this.dirtyEnabled = true;
    await this.flush();
    return shouldEnable;
  }

  isModuleEnabled(id: string): boolean {
    return this.enabledModules.includes(id);
  }

  async setEnabledModules(ids: string[]): Promise<void> {
    this.enabledModules = [...new Set(ids)];
    this.dirtyEnabled = true;
    await this.flush();
  }

  async addFolder(name: string, color = ""): Promise<ModuleFolder> {
    const folder: ModuleFolder = {
      id: crypto.randomUUID(),
      name,
      color,
    };
    this.moduleFolders.push(folder);
    this.markFoldersDirty();
    await this.flush();
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const folder = this.getFolderById(id);
    if (!folder) throw new Error(`Module folder not found: ${id}`);
    folder.name = name;
    this.dirtyFolders = true;
    await this.flush();
  }

  async removeFolder(id: string): Promise<void> {
    this.moduleFolders = this.moduleFolders.filter(
      (folder) => folder.id !== id,
    );
    for (const module of this.modules) {
      if (module.folderId === id) module.folderId = undefined;
    }
    this.markModulesDirty();
    this.dirtyFolders = true;
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
    this.markModulesDirty();
    await this.flush();
  }

  async flush(): Promise<void> {
    this.queue.cancel();
    // Verify dirty flags against content once at commit time — mutating and
    // awaiting flush() synchronously can beat effect-based detection.
    if (
      !this.dirtyModules &&
      !this.dirtyEnabled &&
      !this.dirtyFolders &&
      !this.hasPendingContentChange()
    )
      return;

    const storage = this.storage;
    if (!storage) {
      this.committedModules = $state.snapshot(this.modules);
      this.committedModulesFingerprint = fingerprintOf(this.modules);
      this.committedEnabledFingerprint = fingerprintOf(this.enabledModules);
      this.committedFoldersFingerprint = fingerprintOf(this.moduleFolders);
      this.clearDirty();
      return;
    }
    const commit = createEmptySqlCommit(0, "modules");
    let moduleSnapshot: RisuModule[] | undefined;
    // Only serialise domains known (or verified) to be dirty — a no-op flush
    // on a large library must not clone and stringify the whole domain.
    if (
      this.dirtyModules ||
      fingerprintOf(this.modules) !== this.committedModulesFingerprint
    ) {
      moduleSnapshot = $state.snapshot(this.modules);
      commit.modules = buildModuleDelta(this.committedModules, moduleSnapshot);
    }
    if (
      this.dirtyEnabled ||
      fingerprintOf(this.enabledModules) !== this.committedEnabledFingerprint
    ) {
      commit.root.upserts.push({
        key: "enabledModules",
        value: $state.snapshot(this.enabledModules),
      });
    }
    if (
      this.dirtyFolders ||
      fingerprintOf(this.moduleFolders) !== this.committedFoldersFingerprint
    ) {
      commit.root.upserts.push({
        key: "moduleFolders",
        value: $state.snapshot(this.moduleFolders),
      });
    }
    const operation = this.queue.enqueue(() =>
      commitSqlChanges(storage, commit),
    );
    await operation;
    if (moduleSnapshot) this.committedModules = moduleSnapshot;
    this.committedModulesFingerprint = fingerprintOf(this.modules);
    this.committedEnabledFingerprint = fingerprintOf(this.enabledModules);
    this.committedFoldersFingerprint = fingerprintOf(this.moduleFolders);
    this.clearDirty();
  }

  hasPendingWrites(): boolean {
    return (
      this.dirtyModules ||
      this.dirtyEnabled ||
      this.dirtyFolders ||
      this.hasPendingContentChange()
    );
  }

  /** O(modules) clone+stringify — call only from flush/backup paths. */
  private hasPendingContentChange(): boolean {
    return (
      fingerprintOf(this.modules) !== this.committedModulesFingerprint ||
      fingerprintOf(this.enabledModules) !== this.committedEnabledFingerprint ||
      fingerprintOf(this.moduleFolders) !== this.committedFoldersFingerprint
    );
  }

  private markModulesDirty(): void {
    this.dirtyModules = true;
    this.scheduleCommit();
  }

  private markFoldersDirty(): void {
    this.dirtyFolders = true;
    this.scheduleCommit();
  }

  private clearDirty(): void {
    this.dirtyModules = false;
    this.dirtyEnabled = false;
    this.dirtyFolders = false;
  }

  private scheduleCommit(): void {
    this.queue.schedule(() => this.flush());
  }

  private disposeObserver(): void {
    this.observeDispose?.();
    this.observeDispose = null;
    this.queue.cancel();
  }

  resetForTesting(): void {
    this.disposeObserver();
    this.storage = null;
    this.modules = [];
    this.enabledModules = [];
    this.moduleFolders = [];
    this.loaded = false;
    this.committedModules = [];
    this.committedModulesFingerprint = "";
    this.committedEnabledFingerprint = "";
    this.committedFoldersFingerprint = "";
    this.clearDirty();
    this.queue.reset();
  }
}

export const moduleStore = new ModuleStore();
