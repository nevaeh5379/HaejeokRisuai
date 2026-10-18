import localforage from "localforage";
import type { PluginMetadata, PluginScript } from "../../../plugins/pluginTypes";
import type { ISqlStorage } from "../ISqlStorage";
import type {
  IPluginScriptStorage,
  IPluginStorage,
  PluginLoadOptions,
} from "../pluginStorage";
import { createEmptySqlCommit } from "../sqlCommit";
import { commitSqlChanges } from "../sqlCommitCoordinator";
import type { RemoteSqlDocumentClient } from "@risuai/storage-remote/remoteSqlDocumentClient";

export class NodePluginStorage implements IPluginStorage {
  readonly script: IPluginScriptStorage = {
    load: (pluginId) => this.loadScript(pluginId),
    upsert: (script) => this.upsertScripts([script]),
    upsertMany: (scripts) => this.upsertScripts(scripts),
  };

  private readonly pluginsCache = localforage.createInstance({
    name: "risuaiPostgresPlugins",
  });
  private memoryPluginsCache: {
    hash: string;
    plugins: PluginMetadata[];
  } | null = null;
  private memoryRuntimePluginsCache: {
    hash: string;
    plugins: PluginMetadata[];
  } | null = null;

  constructor(
    private readonly storage: ISqlStorage,
    private readonly documentClient: RemoteSqlDocumentClient,
  ) {}

  async load(pluginId: string): Promise<PluginMetadata | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.documentClient.loadPlugin<PluginMetadata>(pluginId);
  }

  async loadAll(options?: PluginLoadOptions): Promise<PluginMetadata[]> {
    if (!(await this.ensureEnabled())) return [];
    const enabledOnly = options?.enabledOnly === true;
    const cacheKey = enabledOnly ? "runtime-cache" : "cache";
    let cached = enabledOnly
      ? this.memoryRuntimePluginsCache
      : this.memoryPluginsCache;

    if (!cached) {
      try {
        cached = await this.pluginsCache.getItem(cacheKey);
      } catch {
        cached = null;
      }
    }

    const result = await this.documentClient.loadPlugins<PluginMetadata>(
      enabledOnly,
      cached?.hash,
    );
    if (result.status === "not-modified" && cached) {
      if (enabledOnly) this.memoryRuntimePluginsCache = cached;
      else this.memoryPluginsCache = cached;
      return cached.plugins;
    }
    if (result.status !== "ok") return [];

    const entry = {
      hash: result.body.hash,
      plugins: result.body.plugins ?? [],
    };
    if (enabledOnly) this.memoryRuntimePluginsCache = entry;
    else this.memoryPluginsCache = entry;
    try {
      await this.pluginsCache.setItem(cacheKey, entry);
    } catch {}
    return entry.plugins;
  }

  async upsert(plugin: PluginMetadata): Promise<void> {
    await this.upsertMany([plugin]);
  }

  async upsertMany(plugins: readonly PluginMetadata[]): Promise<void> {
    if (plugins.length === 0) return;

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-upsert",
    );
    commit.plugins = {
      upserts: plugins.map((plugin) => {
        const { id, position, ...data } = plugin;
        return { id, position, data };
      }),
      deletes: [],
    };
    await commitSqlChanges(this.storage, commit);
  }

  async delete(pluginId: string): Promise<void> {
    await this.deleteMany([pluginId]);
  }

  async deleteMany(pluginIds: readonly string[]): Promise<void> {
    if (pluginIds.length === 0) return;

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-delete",
    );
    commit.plugins = {
      upserts: [],
      deletes: [...pluginIds],
    };
    await commitSqlChanges(this.storage, commit);
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-toggle",
    );
    commit.plugins = {
      upserts: [],
      deletes: [],
      enabled: [{ id: pluginId, enabled }],
    };
    await commitSqlChanges(this.storage, commit);
  }

  async reorder(pluginIds: readonly string[]): Promise<void> {
    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-reorder",
    );
    commit.plugins = {
      upserts: [],
      deletes: [],
      order: [...pluginIds],
    };
    await commitSqlChanges(this.storage, commit);
  }

  private async ensureEnabled(): Promise<boolean> {
    if (this.storage.isEnabled()) return true;
    return await this.storage.init();
  }

  private async loadScript(pluginId: string): Promise<PluginScript | null> {
    const script = await this.documentClient.loadPluginScript(pluginId);
    return script === null ? null : { pluginId, script };
  }

  private async upsertScripts(
    scripts: readonly PluginScript[],
  ): Promise<void> {
    if (scripts.length === 0) return;

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-script-upsert",
    );
    commit.plugins = {
      upserts: [],
      deletes: [],
      scripts: scripts.map(({ pluginId, script }) => ({
        id: pluginId,
        script,
      })),
    };
    await commitSqlChanges(this.storage, commit);
  }
}
