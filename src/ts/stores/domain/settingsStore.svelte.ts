import type { Database, DatabaseSettings } from "../../storage/schema";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { getSqlStorage } from "../../storage/sqlStorageFactory";
import { commitSqlChanges } from "../../storage/sqlCommitCoordinator";
import {
  getSqlDeferredDomain,
  PROMPT_SETTING_KEYS,
  type SqlDeferredDomain,
} from "../../storage/sqlDeferredSettings";
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
  private deferredUnloaded = new Set<string>();
  private deferredDomainLoads = new Map<SqlDeferredDomain, Promise<void>>();
  private deferredKeyLoads = new Map<string, Promise<void>>();
  private keyDisposers = new Map<string, () => void>();
  private keySetDispose: (() => void) | null = null;

  private stateData = $state<DatabaseSettings>({} as DatabaseSettings);
  readonly state = new Proxy({} as DatabaseSettings, {
    get: (_target, prop) => {
      if (typeof prop === "string") this.requestDeferredLoad(prop);
      return Reflect.get(this.stateData, prop);
    },
    set: (_target, prop, value) => Reflect.set(this.stateData, prop, value),
    deleteProperty: (_target, prop) => Reflect.deleteProperty(this.stateData, prop),
    has: (_target, prop) => Reflect.has(this.stateData, prop),
    ownKeys: () => Reflect.ownKeys(this.stateData),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(this.stateData, prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });

  init(
    initialSettings: Partial<Database>,
    storage: ISqlStorage | null,
    options: { deferredUnloaded?: readonly string[] } = {},
  ): void {
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
    this.deferredDomainLoads.clear();
    this.deferredKeyLoads.clear();
    this.deferredUnloaded = new Set(options.deferredUnloaded ?? []);

    const settingsCopy = Object.fromEntries(
      Object.keys(initialSettings).map((key) => [
        key,
        (initialSettings as any)[key],
      ]),
    );
    delete (settingsCopy as any).characters;
    delete (settingsCopy as any).isSql;
    delete (settingsCopy as any).botPresets;
    delete (settingsCopy as any).botPresetsId;
    settingsCopy.pluginCustomStorage ??= {};
    this.pluginStorageKeys = new Set(
      Object.keys(settingsCopy.pluginCustomStorage),
    );

    this.stateData = settingsCopy as DatabaseSettings;
    this.observe();
  }

  private observe(): void {
    for (const key of Object.keys(this.stateData)) this.observeKey(key);
    this.keySetDispose = $effect.root(() => {
      $effect(() => {
        const keys = new Set(Object.keys(this.stateData));
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
    const baseline = Object.prototype.hasOwnProperty.call(this.stateData, key)
      ? snapshotFingerprint($state.snapshot(this.stateData[key]))
      : undefined;
    let initial = true;
    const dispose = $effect.root(() => {
      $effect(() => {
        if (!Object.prototype.hasOwnProperty.call(this.stateData, key)) {
          initial = false;
          this.dirtyKeys.delete(key);
          this.pendingDeletes.add(key);
          this.scheduleCommit();
          return;
        }
        trackDeep(this.stateData[key]);
        if (initial) {
          initial = false;
          if (
            snapshotFingerprint($state.snapshot(this.stateData[key])) !== baseline
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
      if (!Object.prototype.hasOwnProperty.call(this.stateData, key)) continue;
      if (this.pendingDeletes.has(key)) continue;
      upserts.push({ key, value: $state.snapshot(this.stateData[key]) });
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
      await commitSqlChanges(storage, {
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
      for (const { key } of upserts) {
        if (Object.prototype.hasOwnProperty.call(this.stateData, key)) {
          this.pendingDeletes.delete(key);
          this.dirtyKeys.add(key);
        } else {
          this.dirtyKeys.delete(key);
          this.pendingDeletes.add(key);
        }
      }
      for (const key of deletes) {
        if (Object.prototype.hasOwnProperty.call(this.stateData, key)) {
          this.pendingDeletes.delete(key);
          this.dirtyKeys.add(key);
        } else {
          this.pendingDeletes.add(key);
        }
      }
      if (pluginStoragePayload) {
        const impactedKeys = new Set([
          ...pluginStoragePayload.upserts.map(({ key }) => key),
          ...pluginStoragePayload.deletes,
        ]);
        if (pluginStoragePayload.clear) {
          this.pendingPluginStorageClear = true;
          for (const key of Object.keys(this.stateData.pluginCustomStorage ?? {}))
            impactedKeys.add(key);
        }
        for (const key of impactedKeys) {
          if (
            Object.prototype.hasOwnProperty.call(
              this.stateData.pluginCustomStorage ?? {},
              key,
            )
          ) {
            this.pendingPluginStorageDeletes.delete(key);
            this.pendingPluginStorageUpserts.set(
              key,
              $state.snapshot(this.stateData.pluginCustomStorage[key]),
            );
          } else {
            this.pendingPluginStorageUpserts.delete(key);
            this.pendingPluginStorageDeletes.add(key);
          }
        }
      }
      console.error(
        "[SettingsStore] Failed to commit setting changes to SQL storage:",
        error,
      );
    }
  }

  getStateRecord(): DatabaseSettings {
    return this.stateData;
  }

  hasPendingWrites(): boolean {
    return (
      this.dirtyKeys.size > 0 ||
      this.pendingDeletes.size > 0 ||
      this.pendingPluginStorageUpserts.size > 0 ||
      this.pendingPluginStorageDeletes.size > 0 ||
      this.pendingPluginStorageClear
    );
  }

  requestDeferredLoad(key: string): void {
    void this.ensureDeferredKey(key);
  }

  async ensureDeferredKey(key: string): Promise<void> {
    if (!this.deferredUnloaded.has(key)) return;
    const domain = getSqlDeferredDomain(key);
    if (domain) {
      await this.ensureDeferredDomain(domain);
      return;
    }

    const existing = this.deferredKeyLoads.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const storage = this.storage || (await getSqlStorage());
      try {
        const value = await storage.loadSettingKey(key);
        this.hydrateSettingKey(key, value, value !== undefined);
      } catch (error) {
        console.error(`[SettingsStore] Failed to hydrate setting ${key}:`, error);
      }
    })().finally(() => {
      if (this.deferredKeyLoads.get(key) === pending) {
        this.deferredKeyLoads.delete(key);
      }
    });
    this.deferredKeyLoads.set(key, pending);
    return pending;
  }

  markDeferredLoaded(keys: Iterable<string>): void {
    for (const key of keys) this.deferredUnloaded.delete(key);
  }

  async ensureDeferredLoaded(): Promise<void> {
    const domains = new Set<SqlDeferredDomain>();
    const individualKeys = new Set<string>();
    for (const key of this.deferredUnloaded) {
      const domain = getSqlDeferredDomain(key);
      if (domain) {
        domains.add(domain);
      } else if (key !== "pluginCustomStorage") {
        // pluginCustomStorage values live in their own table and are loaded
        // lazily per key. Other standalone deferred settings (notably large
        // plugin scripts) must be hydrated before a fallback backup snapshot
        // is serialized, or the normalized empty startup value is backed up.
        individualKeys.add(key);
      }
    }
    // Backup hydration is intentionally sequential. The final snapshot must
    // contain every value, but loading several large domains/scripts through
    // the Android bridge concurrently creates avoidable peak memory pressure.
    for (const domain of domains) await this.ensureDeferredDomain(domain);
    for (const key of individualKeys) await this.ensureDeferredKey(key);

    const unresolved = [...this.deferredUnloaded].filter(
      (key) => key !== "pluginCustomStorage",
    );
    if (unresolved.length > 0) {
      throw new Error(
        `Cannot create a complete backup because deferred settings failed to load: ${unresolved.join(", ")}`,
      );
    }
  }

  private async ensureDeferredDomain(domain: SqlDeferredDomain): Promise<void> {
    const existing = this.deferredDomainLoads.get(domain);
    if (existing) return existing;

    const pending = (async () => {
      const storage = this.storage || (await getSqlStorage());
      try {
        if (domain === "personas") {
          const personas = await storage.loadPersonas();
          const value =
            personas.length > 0
              ? personas.map((persona) => ({
                  ...persona,
                  largePortrait: persona.largePortrait ?? false,
                }))
              : [
                  {
                    name: this.stateData.username || "User",
                    icon: this.stateData.userIcon || "",
                    personaPrompt: "",
                    note: this.stateData.userNote || "",
                    largePortrait: false,
                  },
                ];
          this.hydrateSettingKey("personas", value);
          return;
        }
        if (domain === "loreBook") {
          this.hydrateSettingKey("loreBook", await storage.loadLorebooks());
          return;
        }
        if (domain === "modules") {
          this.hydrateSettingKey("modules", await storage.loadModules());
          return;
        }
        if (domain === "scripts") {
          this.hydrateSettingKey("globalscript", await storage.loadScripts());
          return;
        }

        const prompts = await storage.loadPrompts();
        for (const key of PROMPT_SETTING_KEYS) {
          if (Object.prototype.hasOwnProperty.call(prompts, key)) {
            this.hydrateSettingKey(key, (prompts as any)[key]);
          } else {
            this.deferredUnloaded.delete(key);
          }
        }
      } catch (error) {
        console.error(`[SettingsStore] Failed to hydrate ${domain}:`, error);
      }
    })().finally(() => {
      if (this.deferredDomainLoads.get(domain) === pending) {
        this.deferredDomainLoads.delete(domain);
      }
    });

    this.deferredDomainLoads.set(domain, pending);
    return pending;
  }

  get<K extends keyof Database>(key: K): Database[K] | undefined {
    const keyStr = String(key);
    this.requestDeferredLoad(keyStr);
    return this.stateData[keyStr];
  }

  set<K extends keyof Database>(key: K, value: Database[K]): void {
    const keyStr = String(key);
    this.stateData[keyStr] = value;
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
    updater(this.stateData);
    for (const key of Object.keys(this.stateData)) {
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
    const dirtyValues = new Map<string, any>();
    for (const key of this.dirtyKeys) {
      if (Object.prototype.hasOwnProperty.call(this.stateData, key)) {
        dirtyValues.set(key, $state.snapshot(this.stateData[key]));
      }
    }
    const pendingDeletes = new Set(this.pendingDeletes);
    // Tear down key effects so hydration mutations are not observed as changes,
    // then re-observe with a fresh initial pass that skips dirty marking.
    for (const dispose of this.keyDisposers.values()) dispose();
    this.keyDisposers.clear();
    this.keySetDispose?.();
    this.keySetDispose = null;
    updater(this.stateData);
    for (const [key, value] of dirtyValues) this.stateData[key] = value;
    for (const key of pendingDeletes) delete this.stateData[key];
    for (const key of Object.keys(this.stateData)) {
      if (
        key === "characters" ||
        key === "isSql" ||
        key === "pluginCustomStorage" ||
        key === "botPresets" ||
        key === "botPresetsId"
      )
        continue;
      this.observeKey(key);
      if (!pendingDeletes.has(key)) this.pendingDeletes.delete(key);
    }
    this.observe();
    // Svelte may replay invalidations from the hydration mutation while the
    // new root effect is installed. Explicit local deletions win last.
    for (const key of pendingDeletes) delete this.stateData[key];
  }

  hydrateSettingKey(key: string, value: unknown, exists = true): void {
    if (!key || key === "characters" || key === "isSql") return;
    this.keyDisposers.get(key)?.();
    this.keyDisposers.delete(key);
    this.dirtyKeys.delete(key);
    this.pendingDeletes.delete(key);
    this.deferredUnloaded.delete(key);
    if (exists) {
      this.stateData[key] = value;
      this.observeKey(key);
    } else {
      delete this.stateData[key];
    }
  }

  delete(key: keyof Database): void {
    const keyStr = String(key);
    if (keyStr === "pluginCustomStorage") {
      this.clearPluginCustomStorage();
      return;
    }
    delete this.stateData[keyStr];
    this.keyDisposers.get(keyStr)?.();
    this.keyDisposers.delete(keyStr);
    this.dirtyKeys.delete(keyStr);
    this.pendingDeletes.add(keyStr);
    this.scheduleCommit();
  }

  getPluginCustomStorage(): Record<string, any> {
    this.stateData.pluginCustomStorage ??= {};
    return this.stateData.pluginCustomStorage;
  }

  getPluginCustomStorageKeys(): string[] {
    return Array.from(this.pluginStorageKeys);
  }

  hasPluginCustomStorageKey(key: string): boolean {
    return this.pluginStorageKeys.has(key);
  }

  hasLoadedPluginCustomStorageKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.stateData.pluginCustomStorage ?? {},
      key,
    );
  }

  hydratePluginCustomStorageKeys(keys: string[]): void {
    this.pluginStorageKeys = new Set([
      ...keys,
      ...Object.keys(this.stateData.pluginCustomStorage ?? {}),
    ]);
  }

  hydratePluginCustomStorageKey(key: string, value: any): void {
    this.stateData.pluginCustomStorage ??= {};
    this.stateData.pluginCustomStorage[key] = value;
    this.pluginStorageKeys.add(key);
  }

  hydrateRemotePluginCustomStorageKey(key: string, value: any): void {
    if (
      this.pendingPluginStorageClear ||
      this.pendingPluginStorageDeletes.has(key) ||
      this.pendingPluginStorageUpserts.has(key)
    )
      return;
    this.hydratePluginCustomStorageKey(key, value);
  }

  hydrateRemotePluginCustomStorageDelete(key: string): void {
    if (
      this.pendingPluginStorageClear ||
      this.pendingPluginStorageDeletes.has(key) ||
      this.pendingPluginStorageUpserts.has(key)
    )
      return;
    if (this.stateData.pluginCustomStorage)
      delete this.stateData.pluginCustomStorage[key];
    this.pluginStorageKeys.delete(key);
  }

  hydrateRemotePluginCustomStorageClear(): void {
    const preserved = Object.fromEntries(
      this.pendingPluginStorageUpserts.entries(),
    );
    this.stateData.pluginCustomStorage = preserved;
    this.pluginStorageKeys = new Set(Object.keys(preserved));
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    if (this.hasLoadedPluginCustomStorageKey(key)) {
      return this.stateData.pluginCustomStorage[key];
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
          return this.stateData.pluginCustomStorage[key];
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
    this.stateData.pluginCustomStorage ??= {};
    this.stateData.pluginCustomStorage[key] = value;
    this.pluginStorageKeys.add(key);
    this.pendingPluginStorageDeletes.delete(key);
    this.pendingPluginStorageUpserts.set(key, $state.snapshot(value));
    this.scheduleCommit();
  }

  removePluginCustomStorageKey(key: string): void {
    if (this.stateData.pluginCustomStorage) {
      delete this.stateData.pluginCustomStorage[key];
    }
    this.pluginStorageKeys.delete(key);
    this.pendingPluginStorageUpserts.delete(key);
    this.pendingPluginStorageDeletes.add(key);
    this.scheduleCommit();
  }

  clearPluginCustomStorage(): void {
    this.stateData.pluginCustomStorage = {};
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
    this.deferredKeyLoads.clear();
  }
}

export const settingsStore = new SettingsStore();
