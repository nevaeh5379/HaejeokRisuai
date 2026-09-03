import type { DatabaseSettings } from "../../storage/database/schema";
import type { SettingsKey, SettingsState } from "./stateOwnership";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { getSqlStorage } from "../../storage/sql/sqlStorageFactory";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import {
  PRESET_STORE_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
} from "../../storage/sql/sqlDeferredSettings";
import { trackDeep, snapshotFingerprint } from "./reactiveUtils";
import type { FlushableStore, InitializableStore } from "./storeContracts";
import { deferredSettingsLoader } from "./deferredSettingsLoader";

const FORBIDDEN_SETTINGS_KEYS = new Set(SETTINGS_STORE_EXCLUDED_KEYS);
const PRESET_OWNED_KEYS = new Set<string>(PRESET_STORE_SETTING_KEYS);

function assertSettingsKey(key: string): void {
  if (FORBIDDEN_SETTINGS_KEYS.has(key)) {
    throw new Error(`[SettingsStore] ${key} is owned by another domain store`);
  }
}

function assertPublicSettingsKey(key: string): void {
  assertSettingsKey(key);
  if (PRESET_OWNED_KEYS.has(key)) {
    throw new Error(`[SettingsStore] ${key} is owned by PresetStore`);
  }
}

function guardedSettingsState(state: Record<string, any>): Record<string, any> {
  return new Proxy(state, {
    get(target, property, receiver) {
      if (typeof property === "string") assertPublicSettingsKey(property);
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value) {
      if (typeof property === "string") assertPublicSettingsKey(property);
      return Reflect.set(target, property, value);
    },
    deleteProperty(target, property) {
      if (typeof property === "string") assertPublicSettingsKey(property);
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property, descriptor) {
      if (typeof property === "string") assertPublicSettingsKey(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
}

class SettingsStore
  implements
    InitializableStore<
      [initialSettings: Partial<DatabaseSettings>, storage: ISqlStorage | null]
    >,
    FlushableStore
{
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
  private presetStateReleased = false;

  private stateData = $state<DatabaseSettings>({} as DatabaseSettings);
  readonly state = new Proxy({} as SettingsState, {
    get: (_target, prop) => {
      if (typeof prop === "string") {
        assertPublicSettingsKey(prop);
        deferredSettingsLoader.request(prop);
      }
      return Reflect.get(this.stateData, prop);
    },
    set: (_target, prop, value) => {
      if (typeof prop === "string") assertPublicSettingsKey(prop);
      return Reflect.set(this.stateData, prop, value);
    },
    deleteProperty: (_target, prop) => {
      if (typeof prop === "string") assertPublicSettingsKey(prop);
      return Reflect.deleteProperty(this.stateData, prop);
    },
    defineProperty: (_target, prop, descriptor) => {
      if (typeof prop === "string") assertPublicSettingsKey(prop);
      // This forwarding proxy has an empty target; a non-configurable own
      // property would violate its invariants when state is replaced.
      if (descriptor.configurable !== true) {
        throw new TypeError(
          "SettingsStore state properties must be configurable",
        );
      }
      return Reflect.defineProperty(this.stateData, prop, descriptor);
    },
    has: (_target, prop) => Reflect.has(this.stateData, prop),
    ownKeys: () => Reflect.ownKeys(this.stateData),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(this.stateData, prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });

  init(
    initialSettings: Partial<DatabaseSettings>,
    storage: ISqlStorage | null,
  ): void {
    this.storage = storage;
    this.presetStateReleased = false;
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
    for (const key of Object.keys(initialSettings)) assertSettingsKey(key);
    const settingsCopy = { ...initialSettings } as DatabaseSettings;
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
    assertSettingsKey(key);
    // Startup may temporarily carry legacy preset fields. PresetStore alone
    // observes and persists these values after ownership is transferred.
    if (PRESET_OWNED_KEYS.has(key)) return;
    if (this.keyDisposers.has(key) || key === "pluginCustomStorage") return;
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
            snapshotFingerprint($state.snapshot(this.stateData[key])) !==
            baseline
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

    let pluginStoragePayload: import("../../storage/sql/sqlCommit").SqlCommit["pluginStorage"] =
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
          for (const key of Object.keys(
            this.stateData.pluginCustomStorage ?? {},
          ))
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

  getStateRecord(): SettingsState {
    return this.stateData;
  }

  /** @internal Startup migration only; may contain legacy preset values until release. */
  getBootstrapState(): DatabaseSettings {
    return this.stateData;
  }

  releasePresetOwnedState(): void {
    this.presetStateReleased = true;
    deferredSettingsLoader.markLoaded(PRESET_OWNED_KEYS);
    for (const key of PRESET_OWNED_KEYS) {
      this.keyDisposers.get(key)?.();
      this.keyDisposers.delete(key);
      this.dirtyKeys.delete(key);
      this.pendingDeletes.delete(key);
      delete this.stateData[key];
    }
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

  get<K extends SettingsKey>(key: K): SettingsState[K] | undefined {
    const keyStr = String(key);
    assertPublicSettingsKey(keyStr);
    deferredSettingsLoader.request(keyStr);
    return this.stateData[keyStr];
  }

  set<K extends SettingsKey>(key: K, value: SettingsState[K]): void {
    const keyStr = String(key);
    assertPublicSettingsKey(keyStr);
    this.stateData[keyStr] = value;
    if (PRESET_OWNED_KEYS.has(keyStr)) return;
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

  update(updater: (state: SettingsState) => void): void {
    updater(guardedSettingsState(this.stateData) as SettingsState);
    for (const key of Object.keys(this.stateData)) {
      assertSettingsKey(key);
      if (key === "pluginCustomStorage" || PRESET_OWNED_KEYS.has(key)) continue;
      this.pendingDeletes.delete(key);
      this.dirtyKeys.add(key);
    }
    this.scheduleCommit();
  }

  /** Apply storage-derived runtime values without turning hydration into a write. */
  hydrate(updater: (state: SettingsState) => void): void {
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
    let hydrationError: unknown;
    try {
      updater(guardedSettingsState(this.stateData) as SettingsState);
    } catch (error) {
      hydrationError = error;
    }
    for (const key of Object.keys(this.stateData)) assertSettingsKey(key);
    for (const [key, value] of dirtyValues) this.stateData[key] = value;
    for (const key of pendingDeletes) delete this.stateData[key];
    for (const key of Object.keys(this.stateData)) {
      if (key === "pluginCustomStorage") continue;
      this.observeKey(key);
      if (!pendingDeletes.has(key)) this.pendingDeletes.delete(key);
    }
    this.observe();
    // Svelte may replay invalidations from the hydration mutation while the
    // new root effect is installed. Explicit local deletions win last.
    for (const key of pendingDeletes) delete this.stateData[key];
    if (hydrationError) throw hydrationError;
  }

  hydrateSettingKey(key: string, value: unknown, exists = true): void {
    if (!key) return;
    assertSettingsKey(key);
    // A deferred SQL load or remote legacy event can finish after ownership
    // moved to PresetStore. Never retain a second copy of that state here.
    if (this.presetStateReleased && PRESET_OWNED_KEYS.has(key)) return;
    this.keyDisposers.get(key)?.();
    this.keyDisposers.delete(key);
    this.dirtyKeys.delete(key);
    this.pendingDeletes.delete(key);
    deferredSettingsLoader.markLoaded([key]);
    if (exists) {
      this.stateData[key] = value;
      this.observeKey(key);
    } else {
      delete this.stateData[key];
    }
  }

  delete(key: SettingsKey): void {
    const keyStr = String(key);
    assertPublicSettingsKey(keyStr);
    if (keyStr === "pluginCustomStorage") {
      this.clearPluginCustomStorage();
      return;
    }
    delete this.stateData[keyStr];
    if (PRESET_OWNED_KEYS.has(keyStr)) return;
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
  }
}

export const settingsStore = new SettingsStore();
