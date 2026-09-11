import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import {
  getSqlDeferredDomain,
  PROMPT_SETTING_KEYS,
  type SqlDeferredDomain,
} from "../../storage/sql/sqlDeferredSettings";

type HydrateSettingKey = (
  key: string,
  value: unknown,
  exists?: boolean,
) => void;

/**
 * Coordinates lazy SQL hydration without owning any setting values.
 * SettingsStore remains the sole owner of live settings; this loader retains
 * only availability metadata and in-flight promises.
 */
class DeferredSettingsLoader {
  private storage: ISqlStorage | null = null;
  private hydrateSettingKey: HydrateSettingKey | null = null;
  private hydrateRemoteSettingKey: HydrateSettingKey | null = null;
  private unloadedKeys = new Set<string>();
  private domainLoads = new Map<SqlDeferredDomain, Promise<void>>();
  private keyLoads = new Map<string, Promise<void>>();
  private generation = 0;

  init(options: {
    storage: ISqlStorage;
    unloadedKeys?: readonly string[];
    hydrateSettingKey: HydrateSettingKey;
    hydrateRemoteSettingKey?: HydrateSettingKey;
  }): void {
    this.generation += 1;
    this.storage = options.storage;
    this.hydrateSettingKey = options.hydrateSettingKey;
    this.hydrateRemoteSettingKey =
      options.hydrateRemoteSettingKey ?? options.hydrateSettingKey;
    this.unloadedKeys = new Set(options.unloadedKeys ?? []);
    this.domainLoads.clear();
    this.keyLoads.clear();
  }

  reset(): void {
    this.generation += 1;
    this.storage = null;
    this.hydrateSettingKey = null;
    this.hydrateRemoteSettingKey = null;
    this.unloadedKeys.clear();
    this.domainLoads.clear();
    this.keyLoads.clear();
  }

  request(key: string): void {
    void this.ensureKey(key);
  }

  async ensureKey(key: string): Promise<void> {
    if (!this.unloadedKeys.has(key)) return;
    const domain = getSqlDeferredDomain(key);
    if (domain) {
      await this.ensureDomain(domain);
      return;
    }

    const existing = this.keyLoads.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const pending = (async () => {
      const { storage, hydrateSettingKey } = this.requireInitialized();
      try {
        const value = await storage.loadSettingKey(key);
        if (generation !== this.generation) return;
        if (!this.unloadedKeys.has(key)) return;
        hydrateSettingKey(key, value, value !== undefined);
        this.markLoaded([key]);
      } catch (error) {
        console.error(
          `[DeferredSettingsLoader] Failed to hydrate ${key}:`,
          error,
        );
      }
    })().finally(() => {
      if (this.keyLoads.get(key) === pending) this.keyLoads.delete(key);
    });
    this.keyLoads.set(key, pending);
    return pending;
  }

  markLoaded(keys: Iterable<string>): void {
    for (const key of keys) this.unloadedKeys.delete(key);
  }

  isLoaded(key: string): boolean {
    return !this.unloadedKeys.has(key);
  }

  async ensureAll(): Promise<void> {
    const domains = new Set<SqlDeferredDomain>();
    const individualKeys = new Set<string>();
    for (const key of this.unloadedKeys) {
      const domain = getSqlDeferredDomain(key);
      if (domain) domains.add(domain);
      else if (key !== "pluginCustomStorage") individualKeys.add(key);
    }

    // Sequential hydration avoids concurrent large bridge payloads on Android.
    for (const domain of domains) await this.ensureDomain(domain);
    for (const key of individualKeys) await this.ensureKey(key);

    const unresolved = [...this.unloadedKeys].filter(
      (key) => key !== "pluginCustomStorage",
    );
    if (unresolved.length > 0) {
      throw new Error(
        `Cannot create a complete backup because deferred settings failed to load: ${unresolved.join(", ")}`,
      );
    }
  }

  /**
   * Refreshes only deferred values that are already resident. Unopened
   * lorebooks/scripts/prompts stay lazy, while in-flight first loads are
   * allowed to finish before a post-notification refresh closes the race.
   */
  async refreshLoadedKeys(keys: Iterable<string>): Promise<void> {
    const requested = [...new Set(keys)].filter(Boolean);
    if (requested.length === 0) return;
    const generation = this.generation;
    const domains = new Map<SqlDeferredDomain, Set<string>>();
    const individualKeys: string[] = [];

    for (const key of requested) {
      const domain = getSqlDeferredDomain(key);
      if (!domain) {
        individualKeys.push(key);
        continue;
      }
      const domainKeys = domains.get(domain) ?? new Set<string>();
      domainKeys.add(key);
      domains.set(domain, domainKeys);
    }

    // Keep large deferred domains sequential on low-memory Android devices.
    for (const [domain, domainKeys] of domains) {
      const activeLoad = this.domainLoads.get(domain);
      if (activeLoad) await activeLoad;
      if (generation !== this.generation) return;
      const loadedKeys = [...domainKeys].filter((key) => this.isLoaded(key));
      if (loadedKeys.length === 0) continue;
      const { storage, hydrateRemoteSettingKey } = this.requireInitialized();

      if (domain === "loreBook") {
        const loreBooks = await storage.loadLorebooks();
        if (generation !== this.generation) return;
        hydrateRemoteSettingKey("loreBook", loreBooks);
        continue;
      }
      if (domain === "scripts") {
        const scripts = await storage.loadScripts();
        if (generation !== this.generation) return;
        hydrateRemoteSettingKey("globalscript", scripts);
        continue;
      }

      const prompts = await storage.loadPrompts();
      if (generation !== this.generation) return;
      for (const key of loadedKeys) {
        const exists = Object.prototype.hasOwnProperty.call(prompts, key);
        hydrateRemoteSettingKey(key, prompts[key], exists);
      }
    }

    for (const key of individualKeys) {
      const activeLoad = this.keyLoads.get(key);
      if (activeLoad) await activeLoad;
      if (generation !== this.generation) return;
      if (!this.isLoaded(key)) continue;
      const { storage, hydrateRemoteSettingKey } = this.requireInitialized();
      const value = await storage.loadSettingKey(key);
      if (generation !== this.generation) return;
      hydrateRemoteSettingKey(key, value, value !== undefined);
    }
  }

  private async ensureDomain(domain: SqlDeferredDomain): Promise<void> {
    const existing = this.domainLoads.get(domain);
    if (existing) return existing;
    const generation = this.generation;

    const pending = (async () => {
      const { storage, hydrateSettingKey } = this.requireInitialized();
      try {
        if (domain === "loreBook") {
          const loreBooks = await storage.loadLorebooks();
          if (generation !== this.generation) return;
          hydrateSettingKey("loreBook", loreBooks);
          this.markLoaded(["loreBook"]);
          return;
        }
        if (domain === "scripts") {
          const scripts = await storage.loadScripts();
          if (generation !== this.generation) return;
          hydrateSettingKey("globalscript", scripts);
          this.markLoaded(["globalscript"]);
          return;
        }

        const prompts = await storage.loadPrompts();
        if (generation !== this.generation) return;
        for (const key of PROMPT_SETTING_KEYS) {
          if (!this.unloadedKeys.has(key)) continue;
          if (Object.prototype.hasOwnProperty.call(prompts, key)) {
            hydrateSettingKey(key, (prompts as Record<string, unknown>)[key]);
          }
          this.markLoaded([key]);
        }
      } catch (error) {
        console.error(
          `[DeferredSettingsLoader] Failed to hydrate ${domain}:`,
          error,
        );
      }
    })().finally(() => {
      if (this.domainLoads.get(domain) === pending) {
        this.domainLoads.delete(domain);
      }
    });
    this.domainLoads.set(domain, pending);
    return pending;
  }

  private requireInitialized(): {
    storage: ISqlStorage;
    hydrateSettingKey: HydrateSettingKey;
    hydrateRemoteSettingKey: HydrateSettingKey;
  } {
    if (
      !this.storage ||
      !this.hydrateSettingKey ||
      !this.hydrateRemoteSettingKey
    ) {
      throw new Error("DeferredSettingsLoader is not initialized");
    }
    return {
      storage: this.storage,
      hydrateSettingKey: this.hydrateSettingKey,
      hydrateRemoteSettingKey: this.hydrateRemoteSettingKey,
    };
  }
}

export const deferredSettingsLoader = new DeferredSettingsLoader();
