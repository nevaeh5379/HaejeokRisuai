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

  constructor(
    private readonly storage: ISqlStorage,
    private readonly documentClient: RemoteSqlDocumentClient,
    private readonly loadPlugins: (
      options?: PluginLoadOptions,
    ) => Promise<PluginMetadata[] | null>,
  ) {}

  async load(pluginId: string): Promise<PluginMetadata | null> {
    return (
      ((await this.loadPlugins()) ?? []).find(
        (plugin) => plugin.id === pluginId,
      ) ?? null
    );
  }
  async loadAll(options?: PluginLoadOptions): Promise<PluginMetadata[]> {
    return (await this.loadPlugins(options)) ?? [];
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
