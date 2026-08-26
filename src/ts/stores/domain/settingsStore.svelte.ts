import type { Database } from "../../storage/database.svelte";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { getSqlStorage } from "../../storage/sqlStorageFactory";
import { trackDeep, snapshotFingerprint } from "./reactiveUtils";

class SettingsStore {
  private storage: ISqlStorage | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyKeys = new Set<string>();
  private pendingDeletes = new Set<string>();
  private pendingPluginStorageUpserts = new Map<string, unknown>();
  private pendingPluginStorageDeletes = new Set<string>();
  private pendingPluginStorageClear = false;
  private pluginStorageKeys = new Set<string>();
  private pluginStorageLoads = new Map<string, Promise<any>>();
  private keyDisposers = new Map<string, () => void>();
  private keySetDispose: (() => void) | null = null;

  state = $state<Record<string, any>>({});

  init(initialSettings: Partial<Database>, storage: ISqlStorage | null): void {
    this.storage = storage;
    for (const dispose of this.keyDisposers.values()) dispose();
    this.keyDisposers.clear();
    this.keySetDispose?.();
    this.keySetDispose = null;
    this.dirtyKeys.clear();
    this.pendingDeletes.clear();
    this.pendingPluginStorageUpserts.clear();
    this.pendingPluginStorageDeletes.clear();
    this.pendingPluginStorageClear = false;
    this.pluginStorageLoads.clear();

    const adapter = initialSettings as Partial<Database> & {
      getLoadedRootKeys?: () => string[];
    };
    const keys = adapter.getLoadedRootKeys?.() ?? Object.keys(initialSettings);
    const settingsCopy = Object.fromEntries(
      keys.map((key) => [key, (initialSettings as any)[key]]),
    );
    delete (settingsCopy as any).characters;
    delete (settingsCopy as any).isSql;
    delete (settingsCopy as any).botPresets;
    delete (settingsCopy as any).botPresetsId;
    settingsCopy.pluginCustomStorage ??= {};
    this.pluginStorageKeys = new Set(
      Object.keys(settingsCopy.pluginCustomStorage),
    );

    this.state = settingsCopy;
    this.observe();
  }

  private observe(): void {
    for (const key of Object.keys(this.state)) this.observeKey(key);
    this.keySetDispose = $effect.root(() => {
      $effect(() => {
        const keys = new Set(Object.keys(this.state));
        for (const key of keys) this.observeKey(key);
        for (const key of this.keyDisposers.keys()) {
          if (!keys.has(key)) {
            this.dirtyKeys.delete(key);
            this.pendingDeletes.add(key);
            this.scheduleCommit();
          }
        }
      });
    });
  }

  private observeKey(key: string): void {
    if (
      this.keyDisposers.has(key) ||
      key === "characters" ||
      key === "isSql" ||
      key === "pluginCustomStorage" ||
      key === "botPresets" ||
      key === "botPresetsId"
    )
      return;
    // Synchronous baseline taken at observe time.  The first (async) effect
    // run compares against it so mutations occurring between observe and the
    // first flush are still detected; later runs mark unconditionally.
    const baseline = Object.prototype.hasOwnProperty.call(this.state, key)
      ? snapshotFingerprint($state.snapshot(this.state[key]))
      : undefined;
    let initial = true;
    const dispose = $effect.root(() => {
      $effect(() => {
        if (!Object.prototype.hasOwnProperty.call(this.state, key)) {
          initial = false;
          this.dirtyKeys.delete(key);
          this.pendingDeletes.add(key);
          this.scheduleCommit();
          return;
        }
        trackDeep(this.state[key]);
        if (initial) {
          initial = false;
          if (
            snapshotFingerprint($state.snapshot(this.state[key])) !== baseline
          ) {
            this.dirtyKeys.add(key);
            this.scheduleCommit();
          }
          return;
        }
        this.dirtyKeys.add(key);
        this.scheduleCommit();
      });
    });
    this.keyDisposers.set(key, dispose);
  }

  private scheduleCommit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, 300);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const hasRootChanges =
      this.dirtyKeys.size > 0 || this.pendingDeletes.size > 0;
    const hasPluginChanges =
      this.pendingPluginStorageUpserts.size > 0 ||
      this.pendingPluginStorageDeletes.size > 0 ||
      this.pendingPluginStorageClear;
    if (!hasRootChanges && !hasPluginChanges) {
      return;
    }
    const storage = this.storage || (await getSqlStorage());
    // Serialise at flush time — snapshots are never retained between commits
    const upserts: { key: string; value: unknown }[] = [];
    for (const key of this.dirtyKeys) {
      if (!Object.prototype.hasOwnProperty.call(this.state, key)) continue;
      if (this.pendingDeletes.has(key)) continue;
      upserts.push({ key, value: $state.snapshot(this.state[key]) });
    }
    const deletes = Array.from(this.pendingDeletes);
    this.dirtyKeys.clear();
    this.pendingDeletes.clear();

    let pluginStoragePayload: import("../../storage/sqlCommit").SqlCommit["pluginStorage"] =
      undefined;
    if (hasPluginChanges) {
      pluginStoragePayload = {
        upserts: Array.from(this.pendingPluginStorageUpserts.entries()).map(
          ([key, value]) => ({ key, value }),
        ),
        deletes: Array.from(this.pendingPluginStorageDeletes),
        clear: this.pendingPluginStorageClear || undefined,
      };
      this.pendingPluginStorageUpserts.clear();
      this.pendingPluginStorageDeletes.clear();
      this.pendingPluginStorageClear = false;
    }

    try {
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "settings",
        root: {
          upserts,
          deletes,
        },
        pluginStorage: pluginStoragePayload,
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
      });
    } catch (error) {
      console.error(
        "[SettingsStore] Failed to commit setting changes to SQL storage:",
        error,
      );
    }
  }

  get<K extends keyof Database>(key: K): Database[K] | undefined {
    const keyStr = String(key);
    return this.state[keyStr];
  }

  set<K extends keyof Database>(key: K, value: Database[K]): void {
    const keyStr = String(key);
    this.state[keyStr] = value;
    if (keyStr === "pluginCustomStorage") {
      this.pluginStorageKeys.clear();
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          this.setPluginCustomStorageKey(k, v);
        }
      }
      return;
    }
    this.observeKey(keyStr);
    this.pendingDeletes.delete(keyStr);
    this.dirtyKeys.add(keyStr);
    this.scheduleCommit();
  }

  update(updater: (state: Record<string, any>) => void): void {
    updater(this.state);
    for (const key of Object.keys(this.state)) {
      if (
        key === "characters" ||
        key === "isSql" ||
        key === "pluginCustomStorage"
      )
        continue;
      this.pendingDeletes.delete(key);
      this.dirtyKeys.add(key);
    }
    this.scheduleCommit();
  }

  /** Apply storage-derived runtime values without turning hydration into a write. */
  hydrate(updater: (state: Record<string, any>) => void): void {
    // Tear down key effects so hydration mutations are not observed as changes,
    // then re-observe with a fresh initial pass that skips dirty marking.
    for (const dispose of this.keyDisposers.values()) dispose();
    this.keyDisposers.clear();
    this.keySetDispose?.();
    this.keySetDispose = null;
    this.dirtyKeys.clear();
    updater(this.state);
    for (const key of Object.keys(this.state)) {
      if (
        key === "characters" ||
        key === "isSql" ||
        key === "pluginCustomStorage" ||
        key === "botPresets" ||
        key === "botPresetsId"
      )
        continue;
      this.observeKey(key);
      this.pendingDeletes.delete(key);
    }
    this.observe();
  }

  hydrateSettingKey(key: string, value: unknown, exists = true): void {
    if (!key || key === "characters" || key === "isSql") return;
    this.keyDisposers.get(key)?.();
    this.keyDisposers.delete(key);
    this.dirtyKeys.delete(key);
    this.pendingDeletes.delete(key);
    if (exists) {
      this.state[key] = value;
      this.observeKey(key);
    } else {
      delete this.state[key];
    }
  }

  delete(key: keyof Database): void {
    const keyStr = String(key);
    if (keyStr === "pluginCustomStorage") {
      this.clearPluginCustomStorage();
      return;
    }
    delete this.state[keyStr];
    this.keyDisposers.get(keyStr)?.();
    this.keyDisposers.delete(keyStr);
    this.dirtyKeys.delete(keyStr);
    this.pendingDeletes.add(keyStr);
    this.scheduleCommit();
  }

  getPluginCustomStorage(): Record<string, any> {
    this.state.pluginCustomStorage ??= {};
    return this.state.pluginCustomStorage;
  }

  getPluginCustomStorageKeys(): string[] {
    return Array.from(this.pluginStorageKeys);
  }

  hasPluginCustomStorageKey(key: string): boolean {
    return this.pluginStorageKeys.has(key);
  }

  hasLoadedPluginCustomStorageKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.state.pluginCustomStorage ?? {},
      key,
    );
  }

  hydratePluginCustomStorageKeys(keys: string[]): void {
    this.pluginStorageKeys = new Set([
      ...keys,
      ...Object.keys(this.state.pluginCustomStorage ?? {}),
    ]);
  }

  hydratePluginCustomStorageKey(key: string, value: any): void {
    this.state.pluginCustomStorage ??= {};
    this.state.pluginCustomStorage[key] = value;
    this.pluginStorageKeys.add(key);
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    if (this.hasLoadedPluginCustomStorageKey(key)) {
      return this.state.pluginCustomStorage[key];
    }
    const existingLoad = this.pluginStorageLoads.get(key);
    if (existingLoad) return existingLoad;
    const storage = this.storage || (await getSqlStorage());
    const pending = storage
      .loadPluginCustomStorageKey(key)
      .then((value) => {
        if (
          this.pendingPluginStorageClear ||
          this.pendingPluginStorageDeletes.has(key)
        )
          return undefined;
        if (this.hasLoadedPluginCustomStorageKey(key))
          return this.state.pluginCustomStorage[key];
        if (value !== undefined) this.hydratePluginCustomStorageKey(key, value);
        return value;
      })
      .finally(() => {
        if (this.pluginStorageLoads.get(key) === pending)
          this.pluginStorageLoads.delete(key);
      });
    this.pluginStorageLoads.set(key, pending);
    return pending;
  }

  setPluginCustomStorageKey(key: string, value: any): void {
    this.state.pluginCustomStorage ??= {};
    this.state.pluginCustomStorage[key] = value;
    this.pluginStorageKeys.add(key);
    this.pendingPluginStorageDeletes.delete(key);
    this.pendingPluginStorageUpserts.set(key, $state.snapshot(value));
    this.scheduleCommit();
  }

  removePluginCustomStorageKey(key: string): void {
    if (this.state.pluginCustomStorage) {
      delete this.state.pluginCustomStorage[key];
    }
    this.pluginStorageKeys.delete(key);
    this.pendingPluginStorageUpserts.delete(key);
    this.pendingPluginStorageDeletes.add(key);
    this.scheduleCommit();
  }

  clearPluginCustomStorage(): void {
    this.state.pluginCustomStorage = {};
    this.pluginStorageKeys.clear();
    this.pendingPluginStorageUpserts.clear();
    this.pendingPluginStorageDeletes.clear();
    this.pendingPluginStorageClear = true;
    this.scheduleCommit();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const dispose of this.keyDisposers.values()) dispose();
    this.keyDisposers.clear();
    this.keySetDispose?.();
    this.keySetDispose = null;
  }
}

export const settingsStore = new SettingsStore();
