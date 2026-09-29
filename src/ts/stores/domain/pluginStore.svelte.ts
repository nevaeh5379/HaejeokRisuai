import { v4 as uuidv4 } from "uuid";
import type {
  PluginMetadata,
  PluginScript,
} from "../../plugins/pluginTypes";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { safeStructuredClone } from "../../polyfill";
import { snapshotFingerprint, trackDeep } from "./reactiveUtils";
import { StoreCommitQueue } from "./storeCommitQueue";
import type { FlushableStore, InitializableStore } from "./storeContracts";

type PluginMetadataDraft = Omit<PluginMetadata, "id" | "position">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyPluginMetadata(
  value: Record<string, unknown>,
  id: string,
  position: number,
): PluginMetadata {
  return {
    id,
    position,
    name: typeof value.name === "string" ? value.name : "",
    displayName:
      typeof value.displayName === "string" ? value.displayName : undefined,
    arguments: isRecord(value.arguments)
      ? (value.arguments as PluginMetadata["arguments"])
      : {},
    realArg: isRecord(value.realArg)
      ? (value.realArg as PluginMetadata["realArg"])
      : {},
    version:
      value.version === 1 ||
      value.version === 2 ||
      value.version === "2.1" ||
      value.version === "3.0"
        ? value.version
        : undefined,
    customLink: Array.isArray(value.customLink)
      ? (value.customLink as PluginMetadata["customLink"])
      : [],
    argMeta: isRecord(value.argMeta)
      ? (value.argMeta as PluginMetadata["argMeta"])
      : {},
    versionOfPlugin:
      typeof value.versionOfPlugin === "string"
        ? value.versionOfPlugin
        : undefined,
    updateURL:
      typeof value.updateURL === "string" ? value.updateURL : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    allowedIPC: Array.isArray(value.allowedIPC)
      ? value.allowedIPC.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
  };
}

class PluginStore
  implements InitializableStore<[storage: ISqlStorage]>, FlushableStore
{
  plugins = $state<PluginMetadata[]>([]);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observerDispose: (() => void) | null = null;
  private readonly queue = new StoreCommitQueue();
  private readonly scriptCache = new Map<string, PluginScript>();
  private committed = new Map<string, string>();
  private committedOrder: string[] = [];

  get list(): PluginMetadata[] {
    return this.plugins;
  }

  get enabled(): PluginMetadata[] {
    return this.plugins.filter((plugin) => plugin.enabled !== false);
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.observerDispose?.();
    this.queue.cancel();
    this.storage = storage;
    this.plugins = await storage.plugin.loadAll();

    if (this.plugins.length === 0) {
      await this.migrateLegacyPlugins(storage);
      this.plugins = await storage.plugin.loadAll();
    }

    this.loaded = true;
    this.scriptCache.clear();
    this.captureCommittedState();

    let initial = true;
    this.observerDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.plugins);
        if (initial) {
          initial = false;
          return;
        }
        this.queue.schedule(() => this.flush(), 300);
      });
    });
  }

  getById(id: string): PluginMetadata | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  getByName(name: string): PluginMetadata | undefined {
    return this.plugins.find((plugin) => plugin.name === name);
  }

  async loadScript(pluginId: string, force = false): Promise<PluginScript> {
    if (!this.storage) {
      throw new Error("Plugin store is not initialized");
    }

    if (!force) {
      const cached = this.scriptCache.get(pluginId);
      if (cached) return cached;
    }

    const script = await this.storage.plugin.script.load(pluginId);
    if (!script) {
      throw new Error(`Plugin script not found: ${pluginId}`);
    }

    this.scriptCache.set(pluginId, script);
    return script;
  }

  async install(
    metadata: PluginMetadataDraft,
    script: string,
    existingId?: string,
  ): Promise<PluginMetadata> {
    if (!this.storage) {
      throw new Error("Plugin store is not initialized");
    }

    const existing = existingId
      ? this.getById(existingId)
      : this.getByName(metadata.name);
    const id = existing?.id ?? uuidv4();
    const position = existing?.position ?? this.plugins.length;
    const storedMetadata: PluginMetadata = {
      ...metadata,
      id,
      position,
    };

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      existing ? "plugin-update" : "plugin-install",
    );
    commit.plugins = {
      upserts: [
        {
          id,
          position,
          data: this.metadataData(storedMetadata),
        },
      ],
      deletes: [],
      scripts: [{ id, script }],
      order: existing
        ? undefined
        : [...this.plugins.map((plugin) => plugin.id), id],
    };

    await commitSqlChanges(this.storage, commit);

    const next = [...this.plugins];
    const index = next.findIndex((plugin) => plugin.id === id);
    if (index >= 0) next[index] = storedMetadata;
    else next.push(storedMetadata);

    this.plugins = next;
    this.scriptCache.set(id, { pluginId: id, script });
    this.captureCommittedState();
    return storedMetadata;
  }

  compatibilityPlugins(): Array<
    Omit<PluginMetadata, "id" | "position"> & { script: string }
  > {
    return this.plugins.map((plugin) => {
      const { id, position: _position, ...metadata } = plugin;
      return {
        ...metadata,
        script: this.scriptCache.get(id)?.script ?? "",
      };
    });
  }

  async replaceCompatibilityPlugins(
    plugins: readonly (
      Omit<PluginMetadata, "id" | "position"> & { script: string }
    )[],
  ): Promise<void> {
    const metadata = plugins.map((plugin, position) => {
      const { script: _script, ...data } = plugin;
      return {
        ...data,
        id: this.getByName(plugin.name)?.id ?? uuidv4(),
        position,
      };
    });
    const scripts = plugins.map((plugin, position) => ({
      pluginId: metadata[position].id,
      script: plugin.script,
    }));
    await this.replaceAll(metadata, scripts);
  }

  async replaceAll(
    metadata: readonly PluginMetadata[],
    scripts: readonly PluginScript[],
  ): Promise<void> {
    if (!this.storage) {
      throw new Error("Plugin store is not initialized");
    }

    const scriptById = new Map(
      scripts.map((script) => [script.pluginId, script] as const),
    );
    const ids = new Set(metadata.map((plugin) => plugin.id));

    for (const plugin of metadata) {
      if (!scriptById.has(plugin.id)) {
        throw new Error(`Plugin script not found: ${plugin.id}`);
      }
    }

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-replace-all",
    );
    commit.plugins = {
      upserts: metadata.map((plugin) => ({
        id: plugin.id,
        position: plugin.position,
        data: this.metadataData(plugin),
      })),
      deletes: this.plugins
        .filter((plugin) => !ids.has(plugin.id))
        .map((plugin) => plugin.id),
      order: metadata.map((plugin) => plugin.id),
      scripts: scripts.map(({ pluginId, script }) => ({
        id: pluginId,
        script,
      })),
    };

    await commitSqlChanges(this.storage, commit);

    this.plugins = metadata.map((plugin) => ({ ...plugin }));
    this.scriptCache.clear();
    for (const script of scripts) {
      this.scriptCache.set(script.pluginId, { ...script });
    }
    this.captureCommittedState();
  }

  async remove(pluginId: string): Promise<void> {
    if (!this.storage) {
      throw new Error("Plugin store is not initialized");
    }

    await this.storage.plugin.delete(pluginId);
    this.plugins = this.plugins.filter((plugin) => plugin.id !== pluginId);
    this.scriptCache.delete(pluginId);
    this.captureCommittedState();
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (!this.storage) {
      throw new Error("Plugin store is not initialized");
    }

    await this.storage.plugin.setEnabled(pluginId, enabled);
    const plugin = this.getById(pluginId);
    if (plugin) plugin.enabled = enabled;
    this.captureCommittedState();
  }

  async refreshFromStorage(): Promise<void> {
    const storage = this.storage;
    if (!storage || !this.loaded) return;
    await this.flush();
    if (this.hasPendingWrites()) {
      throw new Error("Cannot refresh plugins while local changes are pending");
    }
    await this.init(storage);
  }

  async flush(): Promise<void> {
    this.queue.cancel();
    if (!this.storage || !this.loaded) return;

    this.plugins.forEach((plugin, position) => {
      plugin.position = position;
    });

    const snapshot = safeStructuredClone(this.plugins);
    const currentIds = snapshot.map((plugin) => plugin.id);
    const currentIdSet = new Set(currentIds);
    const upserts = snapshot.filter(
      (plugin) =>
        this.committed.get(plugin.id) !== snapshotFingerprint(plugin),
    );
    const deletes = [...this.committed.keys()].filter(
      (id) => !currentIdSet.has(id),
    );
    const orderChanged =
      currentIds.length !== this.committedOrder.length ||
      currentIds.some((id, index) => id !== this.committedOrder[index]);

    if (upserts.length === 0 && deletes.length === 0 && !orderChanged) {
      return;
    }

    const commit = createEmptySqlCommit(
      this.storage.getRevision(),
      "plugin-metadata",
    );
    commit.plugins = {
      upserts: upserts.map((plugin) => ({
        id: plugin.id,
        position: plugin.position,
        data: this.metadataData(plugin),
      })),
      deletes,
      order: orderChanged ? currentIds : undefined,
    };

    await this.queue.enqueue(() => commitSqlChanges(this.storage!, commit));
    this.captureCommittedState();
  }

  hasPendingWrites(): boolean {
    const currentIds = this.plugins.map((plugin) => plugin.id);
    if (
      currentIds.length !== this.committedOrder.length ||
      currentIds.some((id, index) => id !== this.committedOrder[index])
    ) {
      return true;
    }

    if (this.committed.size !== this.plugins.length) return true;

    return this.plugins.some(
      (plugin) =>
        this.committed.get(plugin.id) !==
        snapshotFingerprint($state.snapshot(plugin)),
    );
  }

  private async migrateLegacyPlugins(storage: ISqlStorage): Promise<void> {
    const legacy = await storage.loadSettingKey("plugins");
    if (!Array.isArray(legacy) || legacy.length === 0) return;

    const metadata: PluginMetadata[] = [];
    const scripts: PluginScript[] = [];

    for (const [position, value] of legacy.entries()) {
      if (!isRecord(value) || typeof value.script !== "string") continue;

      const id = uuidv4();
      const plugin = legacyPluginMetadata(value, id, position);
      if (!plugin.name) continue;

      metadata.push(plugin);
      scripts.push({
        pluginId: id,
        script: value.script,
      });
    }

    if (metadata.length === 0) return;

    const commit = createEmptySqlCommit(
      storage.getRevision(),
      "plugin-legacy-migration",
    );
    commit.root.deletes.push("plugins");
    commit.plugins = {
      upserts: metadata.map((plugin) => ({
        id: plugin.id,
        position: plugin.position,
        data: this.metadataData(plugin),
      })),
      deletes: [],
      order: metadata.map((plugin) => plugin.id),
      scripts: scripts.map(({ pluginId, script }) => ({
        id: pluginId,
        script,
      })),
    };

    await commitSqlChanges(storage, commit);
  }

  private metadataData(
    plugin: PluginMetadata,
  ): Omit<PluginMetadata, "id" | "position"> {
    const { id: _id, position: _position, ...data } = plugin;
    return data;
  }

  private captureCommittedState(): void {
    const snapshot = $state.snapshot(this.plugins);
    this.committed = new Map(
      snapshot.map((plugin) => [plugin.id, snapshotFingerprint(plugin)]),
    );
    this.committedOrder = snapshot.map((plugin) => plugin.id);
  }
}

export const pluginStore = new PluginStore();
