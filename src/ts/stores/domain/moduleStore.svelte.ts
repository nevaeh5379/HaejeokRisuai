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

export type ModuleRootItem =
  | { type: "folder"; folder: ModuleFolder; modules: RisuModule[] }
  | { type: "module"; module: RisuModule };

class ModuleStore
  implements InitializableStore<[storage: ISqlStorage]>, FlushableStore
{
  modules = $state<RisuModule[]>([]);
  enabledModules = $state<string[]>([]);
  moduleFolders = $state<ModuleFolder[]>([]);
  moduleOrder = $state<string[]>([]);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observeDispose: (() => void) | null = null;
  private queue = new StoreCommitQueue();
  private dirtyModules = false;
  private dirtyEnabled = false;
  private dirtyFolders = false;
  private dirtyOrder = false;
  private committedModules: RisuModule[] = [];
  // Fingerprint baselines, taken once at init/commit — never on reactive runs.
  private committedModulesFingerprint = "";
  private committedEnabledFingerprint = "";
  private committedFoldersFingerprint = "";
  private committedOrderFingerprint = "";

  get list(): RisuModule[] {
    return this.modules;
  }

  get folders(): ModuleFolder[] {
    return this.moduleFolders;
  }

  get order(): string[] {
    return this.moduleOrder;
  }

  get enabledList(): RisuModule[] {
    const enabled = new Set(this.enabledModules);
    return this.modules.filter((module) => enabled.has(module.id));
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.disposeObserver();
    this.storage = storage;
    const [modules, enabled, folders, order] = await Promise.all([
      storage.loadModules(),
      storage.loadSettingKey("enabledModules"),
      storage.loadSettingKey("moduleFolders"),
      storage.loadSettingKey("moduleOrder"),
    ]);
    this.modules = [...modules];
    this.enabledModules = Array.isArray(enabled)
      ? enabled.filter((id): id is string => typeof id === "string")
      : [];
    this.moduleFolders = Array.isArray(folders)
      ? (folders as ModuleFolder[])
      : [];
    this.moduleOrder = this.sanitizeRootOrder(
      Array.isArray(order)
        ? order.filter((id): id is string => typeof id === "string")
        : [],
    );
    this.loaded = true;
    this.committedModules = $state.snapshot(this.modules);
    this.committedModulesFingerprint = fingerprintOf(this.modules);
    this.committedEnabledFingerprint = fingerprintOf(this.enabledModules);
    this.committedFoldersFingerprint = fingerprintOf(this.moduleFolders);
    this.committedOrderFingerprint = fingerprintOf(this.moduleOrder);
    this.dirtyModules = false;
    this.dirtyEnabled = false;
    this.dirtyFolders = false;
    this.dirtyOrder = false;
    // Baselines come from the synchronous assignments above — effect runs
    // must never serialise modules (they can embed MB-sized lorebooks).
    // Content is verified once per flush / hasPendingWrites.
    let initial = true;
    this.observeDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.modules);
        trackDeep(this.enabledModules);
        trackDeep(this.moduleFolders);
        trackDeep(this.moduleOrder);
        if (initial) {
          initial = false;
          return;
        }
        this.dirtyModules = true;
        this.dirtyEnabled = true;
        this.dirtyFolders = true;
        this.dirtyOrder = true;
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

  sanitizeRootOrder(rawOrder: string[]): string[] {
    const validFolders = new Set(this.moduleFolders.map((f) => f.id));
    const validUngrouped = new Set(
      this.modules
        .filter((m) => !m.folderId || !validFolders.has(m.folderId))
        .map((m) => m.id),
    );
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of rawOrder) {
      if (typeof item !== "string") continue;
      if (item.startsWith("folder:")) {
        const folderId = item.slice("folder:".length);
        if (validFolders.has(folderId) && !seen.has(item)) {
          seen.add(item);
          result.push(item);
        }
      } else {
        if (validUngrouped.has(item) && !seen.has(item)) {
          seen.add(item);
          result.push(item);
        }
      }
    }

    // Append any ungrouped modules not yet in order
    for (const module of this.modules) {
      if (validUngrouped.has(module.id) && !seen.has(module.id)) {
        seen.add(module.id);
        result.push(module.id);
      }
    }

    // Append any folders not yet in order
    for (const folder of this.moduleFolders) {
      const folderKey = `folder:${folder.id}`;
      if (!seen.has(folderKey)) {
        seen.add(folderKey);
        result.push(folderKey);
      }
    }

    return result;
  }

  getRootItems(): ModuleRootItem[] {
    const sanitized = this.sanitizeRootOrder(this.moduleOrder);
    if (
      sanitized.length !== this.moduleOrder.length ||
      sanitized.some((id, idx) => id !== this.moduleOrder[idx])
    ) {
      this.moduleOrder = sanitized;
    }
    const folderMap = new Map(this.moduleFolders.map((f) => [f.id, f]));
    const moduleMap = new Map(this.modules.map((m) => [m.id, m]));

    const items: ModuleRootItem[] = [];
    for (const key of this.moduleOrder) {
      if (key.startsWith("folder:")) {
        const folderId = key.slice("folder:".length);
        const folder = folderMap.get(folderId);
        if (folder) {
          items.push({
            type: "folder",
            folder,
            modules: this.modulesInFolder(folder.id),
          });
        }
      } else {
        const module = moduleMap.get(key);
        if (module) {
          items.push({
            type: "module",
            module,
          });
        }
      }
    }
    return items;
  }

  private syncModulesOrderToRoot(): void {
    const nextModules: RisuModule[] = [];
    const moduleMap = new Map(this.modules.map((m) => [m.id, m]));
    const addedIds = new Set<string>();

    for (const key of this.moduleOrder) {
      if (key.startsWith("folder:")) {
        const folderId = key.slice("folder:".length);
        for (const module of this.modulesInFolder(folderId)) {
          if (!addedIds.has(module.id)) {
            addedIds.add(module.id);
            nextModules.push(module);
          }
        }
      } else {
        const module = moduleMap.get(key);
        if (module && !addedIds.has(module.id)) {
          addedIds.add(module.id);
          nextModules.push(module);
        }
      }
    }

    for (const module of this.modules) {
      if (!addedIds.has(module.id)) {
        addedIds.add(module.id);
        nextModules.push(module);
      }
    }

    this.modules = nextModules;
    this.markModulesDirty();
  }

  async setModuleOrder(order: string[]): Promise<void> {
    this.moduleOrder = this.sanitizeRootOrder(order);
    this.syncModulesOrderToRoot();
    this.markOrderDirty();
    await this.flush();
  }

  async moveRootItem(fromIndex: number, toIndex: number): Promise<void> {
    const current = [...this.sanitizeRootOrder(this.moduleOrder)];
    if (
      fromIndex < 0 ||
      fromIndex >= current.length ||
      toIndex < 0 ||
      toIndex >= current.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = current.splice(fromIndex, 1);
    current.splice(toIndex, 0, moved);
    this.moduleOrder = current;
    this.syncModulesOrderToRoot();
    this.markOrderDirty();
    await this.flush();
  }

  async moveFolder(folderId: string, direction: "up" | "down"): Promise<void> {
    const current = this.sanitizeRootOrder(this.moduleOrder);
    const key = `folder:${folderId}`;
    const idx = current.indexOf(key);
    if (idx < 0) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= current.length) return;
    await this.moveRootItem(idx, targetIdx);
  }

  async moveRootModule(moduleId: string, direction: "up" | "down"): Promise<void> {
    const current = this.sanitizeRootOrder(this.moduleOrder);
    const idx = current.indexOf(moduleId);
    if (idx < 0) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= current.length) return;
    await this.moveRootItem(idx, targetIdx);
  }

  async moveFolderModule(moduleId: string, direction: "up" | "down"): Promise<void> {
    const module = this.getById(moduleId);
    if (!module || !module.folderId) return;
    const folderModules = this.modulesInFolder(module.folderId);
    const idx = folderModules.findIndex((m) => m.id === moduleId);
    if (idx < 0) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= folderModules.length) return;

    const otherModule = folderModules[targetIdx];
    const posA = this.modules.findIndex((m) => m.id === moduleId);
    const posB = this.modules.findIndex((m) => m.id === otherModule.id);
    if (posA >= 0 && posB >= 0) {
      const copy = [...this.modules];
      copy[posA] = otherModule;
      copy[posB] = module;
      this.modules = copy;
      this.markModulesDirty();
      await this.flush();
    }
  }

  async reorderFolderModules(folderId: string, moduleIds: string[]): Promise<void> {
    const folderModules = this.modulesInFolder(folderId);
    const idSet = new Set(folderModules.map((m) => m.id));
    const orderedFolderModules: RisuModule[] = [];
    const moduleMap = new Map(folderModules.map((m) => [m.id, m]));

    for (const id of moduleIds) {
      const mod = moduleMap.get(id);
      if (mod) {
        orderedFolderModules.push(mod);
        idSet.delete(id);
      }
    }
    for (const id of idSet) {
      const mod = moduleMap.get(id);
      if (mod) orderedFolderModules.push(mod);
    }

    let insertIdx = 0;
    const nextModules = [...this.modules];
    for (let i = 0; i < nextModules.length; i++) {
      if (nextModules[i].folderId === folderId) {
        nextModules[i] = orderedFolderModules[insertIdx++];
      }
    }
    this.modules = nextModules;
    this.markModulesDirty();
    await this.flush();
  }

  async moveModule(
    moduleId: string,
    targetFolderId: string | undefined,
    targetIndex?: number,
  ): Promise<void> {
    const module = this.getById(moduleId);
    if (!module) throw new Error(`Module not found: ${moduleId}`);
    if (targetFolderId !== undefined && !this.getFolderById(targetFolderId)) {
      throw new Error(`Module folder not found: ${targetFolderId}`);
    }

    const previousFolderId = module.folderId;
    module.folderId = targetFolderId;
    this.markModulesDirty();

    if (targetFolderId === undefined) {
      const order = this.moduleOrder.filter((k) => k !== moduleId);
      if (
        targetIndex !== undefined &&
        targetIndex >= 0 &&
        targetIndex <= order.length
      ) {
        order.splice(targetIndex, 0, moduleId);
      } else if (previousFolderId) {
        const folderKey = `folder:${previousFolderId}`;
        const folderIdx = order.indexOf(folderKey);
        if (folderIdx >= 0) {
          order.splice(folderIdx + 1, 0, moduleId);
        } else {
          order.push(moduleId);
        }
      } else {
        order.push(moduleId);
      }
      this.moduleOrder = order;
      this.syncModulesOrderToRoot();
      this.markOrderDirty();
    } else {
      this.moduleOrder = this.moduleOrder.filter((k) => k !== moduleId);
      this.markOrderDirty();
      if (targetIndex !== undefined) {
        const folderModules = this.modulesInFolder(targetFolderId).filter(
          (m) => m.id !== moduleId,
        );
        const targetModuleIds = folderModules.map((m) => m.id);
        const boundedIndex = Math.max(
          0,
          Math.min(targetIndex, targetModuleIds.length),
        );
        targetModuleIds.splice(boundedIndex, 0, moduleId);
        await this.reorderFolderModules(targetFolderId, targetModuleIds);
        return;
      }
      this.syncModulesOrderToRoot();
    }
    await this.flush();
  }

  async installModule(module: RisuModule): Promise<void> {
    this.upsertModules([module]);
    if (!module.folderId && !this.moduleOrder.includes(module.id)) {
      this.moduleOrder.push(module.id);
      this.markOrderDirty();
    }
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
    this.moduleOrder = this.moduleOrder.filter((k) => k !== id);
    this.markModulesDirty();
    this.dirtyEnabled = true;
    this.markOrderDirty();
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
    this.moduleOrder.push(`folder:${folder.id}`);
    this.markFoldersDirty();
    this.markOrderDirty();
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
    const folderKey = `folder:${id}`;
    const folderIdx = this.moduleOrder.indexOf(folderKey);
    const unparentedIds: string[] = [];
    for (const module of this.modules) {
      if (module.folderId === id) {
        module.folderId = undefined;
        unparentedIds.push(module.id);
      }
    }
    if (folderIdx >= 0) {
      this.moduleOrder.splice(folderIdx, 1, ...unparentedIds);
    } else {
      this.moduleOrder = this.moduleOrder.filter((k) => k !== folderKey);
      this.moduleOrder.push(...unparentedIds);
    }
    this.markModulesDirty();
    this.dirtyFolders = true;
    this.markOrderDirty();
    await this.flush();
  }

  async moveModuleToFolder(
    moduleId: string,
    folderId: string | undefined,
  ): Promise<void> {
    await this.moveModule(moduleId, folderId);
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
    if (
      this.dirtyOrder ||
      fingerprintOf(this.moduleOrder) !== this.committedOrderFingerprint
    ) {
      commit.root.upserts.push({
        key: "moduleOrder",
        value: $state.snapshot(this.moduleOrder),
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
    this.committedOrderFingerprint = fingerprintOf(this.moduleOrder);
    this.clearDirty();
  }

  hasPendingWrites(): boolean {
    return (
      this.dirtyModules ||
      this.dirtyEnabled ||
      this.dirtyFolders ||
      this.dirtyOrder ||
      this.hasPendingContentChange()
    );
  }

  /** O(modules) clone+stringify — call only from flush/backup paths. */
  private hasPendingContentChange(): boolean {
    return (
      fingerprintOf(this.modules) !== this.committedModulesFingerprint ||
      fingerprintOf(this.enabledModules) !== this.committedEnabledFingerprint ||
      fingerprintOf(this.moduleFolders) !== this.committedFoldersFingerprint ||
      fingerprintOf(this.moduleOrder) !== this.committedOrderFingerprint
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

  private markOrderDirty(): void {
    this.dirtyOrder = true;
    this.scheduleCommit();
  }

  private clearDirty(): void {
    this.dirtyModules = false;
    this.dirtyEnabled = false;
    this.dirtyFolders = false;
    this.dirtyOrder = false;
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
    this.moduleOrder = [];
    this.loaded = false;
    this.committedModules = [];
    this.committedModulesFingerprint = "";
    this.committedEnabledFingerprint = "";
    this.committedFoldersFingerprint = "";
    this.committedOrderFingerprint = "";
    this.clearDirty();
    this.queue.reset();
  }
}

export const moduleStore = new ModuleStore();
