import type {
  PluginMetadata,
  PluginScript,
} from "../../plugins/pluginTypes";

export interface PluginLoadOptions {
  enabledOnly?: boolean;
}

export interface IPluginScriptStorage {
  load(pluginId: string): Promise<PluginScript | null>;
  upsert(script: PluginScript): Promise<void>;
  upsertMany(scripts: readonly PluginScript[]): Promise<void>;
}

export interface IPluginStorage {
  readonly script: IPluginScriptStorage;

  load(pluginId: string): Promise<PluginMetadata | null>;
  loadAll(options?: PluginLoadOptions): Promise<PluginMetadata[]>;

  upsert(plugin: PluginMetadata): Promise<void>;
  upsertMany(plugins: readonly PluginMetadata[]): Promise<void>;
  delete(pluginId: string): Promise<void>;
  deleteMany(pluginIds: readonly string[]): Promise<void>;
  setEnabled(pluginId: string, enabled: boolean): Promise<void>;
  reorder(pluginIds: readonly string[]): Promise<void>;
}
