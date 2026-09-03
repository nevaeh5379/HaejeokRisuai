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
  private unloadedKeys = new Set<string>();
  private domainLoads = new Map<SqlDeferredDomain, Promise<void>>();
  private keyLoads = new Map<string, Promise<void>>();
  private generation = 0;

  init(options: {
    storage: ISqlStorage;
    unloadedKeys?: readonly string[];
    hydrateSettingKey: HydrateSettingKey;
  }): void {
    this.generation += 1;
    this.storage = options.storage;
    this.hydrateSettingKey = options.hydrateSettingKey;
    this.unloadedKeys = new Set(options.unloadedKeys ?? []);
    this.domainLoads.clear();
    this.keyLoads.clear();
  }

  reset(): void {
    this.generation += 1;
    this.storage = null;
    this.hydrateSettingKey = null;
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
  } {
    if (!this.storage || !this.hydrateSettingKey) {
      throw new Error("DeferredSettingsLoader is not initialized");
    }
    return {
      storage: this.storage,
      hydrateSettingKey: this.hydrateSettingKey,
    };
  }
}

export const deferredSettingsLoader = new DeferredSettingsLoader();
