import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { getSqlStorage } from "../../storage/sql/sqlStorageFactory";
import type { SqlCommit } from "../../storage/sql/sqlCommit";

/** Lazily loaded per-key values written by plugins. Unknown JSON by design. */
export type PluginStorageValue = unknown;
export type PluginStorageRecord = Record<string, PluginStorageValue>;

/**
 * Read/write access to the live `pluginCustomStorage` record owned by
 * SettingsStore's `$state`, plus the commit-scheduling hook.
 */
export interface PluginStorageHost {
  getRecord(): PluginStorageRecord | undefined;
  ensureRecord(): PluginStorageRecord;
  setRecord(record: PluginStorageRecord): void;
  notifyChanged(): void;
}

/**
 * Owns the `pluginCustomStorage` bookkeeping: the known-key set, per-key
 * lazy loads, coalesced pending writes, and remote (multi-device) hydration
 * guards. The live record itself stays on SettingsStore's `$state` object so
 * existing Svelte consumers keep working; this class never holds a record
 * reference, it goes through the host on every access.
 */
export class PluginCustomStorageSubsystem {
  private storage: ISqlStorage | null = null;
  private keys = new Set<string>();
  private pendingUpserts = new Map<string, PluginStorageValue>();
  private pendingDeletes = new Set<string>();
  private pendingClear = false;
  private loads = new Map<string, Promise<PluginStorageValue>>();

  constructor(private readonly host: PluginStorageHost) {}

  /** Reset bookkeeping when SettingsStore re-initializes its state. */
  reset(storage: ISqlStorage | null, knownKeys?: readonly string[]): void {
    this.storage = storage;
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.pendingClear = false;
    this.loads.clear();
    this.keys = new Set(knownKeys ?? Object.keys(this.host.getRecord() ?? {}));
  }

  getKeys(): string[] {
    return Array.from(this.keys);
  }

  hasKey(key: string): boolean {
    return this.keys.has(key);
  }

  hasLoadedKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.host.getRecord() ?? {},
      key,
    );
  }

  hydrateKeys(keys: readonly string[]): void {
    this.keys = new Set([...keys, ...Object.keys(this.host.getRecord() ?? {})]);
  }

  hydrateKey(key: string, value: PluginStorageValue): void {
    this.host.ensureRecord()[key] = value;
    this.keys.add(key);
  }

  /** A pending local write must win over a stale remote event. */
  private hasPendingWrite(key: string): boolean {
    return (
      this.pendingClear ||
      this.pendingDeletes.has(key) ||
      this.pendingUpserts.has(key)
    );
  }

  hydrateRemoteKey(key: string, value: PluginStorageValue): void {
    if (this.hasPendingWrite(key)) return;
    this.hydrateKey(key, value);
  }

  hydrateRemoteDelete(key: string): void {
    if (this.hasPendingWrite(key)) return;
    const record = this.host.getRecord();
    if (record) delete record[key];
    this.keys.delete(key);
  }

  hydrateRemoteClear(): void {
    const preserved = Object.fromEntries(this.pendingUpserts.entries());
    this.host.setRecord(preserved);
    this.keys = new Set(Object.keys(preserved));
  }

  async loadKey(key: string): Promise<PluginStorageValue> {
    if (this.hasLoadedKey(key)) {
      return (this.host.getRecord() ?? {})[key];
    }
    const existingLoad = this.loads.get(key);
    if (existingLoad) return existingLoad;
    const storage = this.storage || (await getSqlStorage());
    const pending = storage
      .loadPluginCustomStorageKey(key)
      .then((value) => {
        if (this.pendingClear || this.pendingDeletes.has(key)) {
          return undefined;
        }
        if (this.hasLoadedKey(key)) {
          return (this.host.getRecord() ?? {})[key];
        }
        if (value !== undefined) this.hydrateKey(key, value);
        return value;
      })
      .finally(() => {
        if (this.loads.get(key) === pending) this.loads.delete(key);
      });
    this.loads.set(key, pending);
    return pending;
  }

  setKey(key: string, value: PluginStorageValue): void {
    this.host.ensureRecord()[key] = value;
    this.keys.add(key);
    this.pendingDeletes.delete(key);
    this.pendingUpserts.set(key, $state.snapshot(value));
    this.host.notifyChanged();
  }

  removeKey(key: string): void {
    const record = this.host.getRecord();
    if (record) delete record[key];
    this.keys.delete(key);
    this.pendingUpserts.delete(key);
    this.pendingDeletes.add(key);
    this.host.notifyChanged();
  }

  clear(): void {
    const record = this.host.getRecord();
    if (record) {
      for (const key of Object.keys(record)) delete record[key];
    }
    this.keys.clear();
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.pendingClear = true;
    this.host.notifyChanged();
  }

  /** Adopt a whole record assigned through `settingsStore.set()`. */
  replaceRecord(next: PluginStorageValue): void {
    this.keys.clear();
    if (next && typeof next === "object") {
      for (const [key, value] of Object.entries(next)) {
        this.setKey(key, value);
      }
    }
  }

  hasPendingChanges(): boolean {
    return (
      this.pendingUpserts.size > 0 ||
      this.pendingDeletes.size > 0 ||
      this.pendingClear
    );
  }

  /** Build the SQL commit payload and clear pending state. */
  takeCommitPayload(): SqlCommit["pluginStorage"] {
    const payload: SqlCommit["pluginStorage"] = {
      upserts: Array.from(this.pendingUpserts.entries()).map(
        ([key, value]) => ({ key, value }),
      ),
      deletes: Array.from(this.pendingDeletes),
      clear: this.pendingClear || undefined,
    };
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
    this.pendingClear = false;
    return payload;
  }

  /** Restore pending state after a failed commit so nothing is lost. */
  restoreAfterFailedCommit(payload: SqlCommit["pluginStorage"]): void {
    if (!payload) return;
    const impactedKeys = new Set<string>([
      ...payload.upserts.map(({ key }) => key),
      ...payload.deletes,
    ]);
    if (payload.clear) {
      this.pendingClear = true;
      for (const key of Object.keys(this.host.getRecord() ?? {}))
        impactedKeys.add(key);
    }
    const record = this.host.getRecord() ?? {};
    for (const key of impactedKeys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        this.pendingDeletes.delete(key);
        this.pendingUpserts.set(key, $state.snapshot(record[key]));
      } else {
        this.pendingUpserts.delete(key);
        this.pendingDeletes.add(key);
      }
    }
  }
}
