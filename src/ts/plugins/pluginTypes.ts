export interface PluginMetadata {
  id: string;
  position: number;
  name: string;
  displayName?: string;
  arguments: { [key: string]: "int" | "string" | string[] };
  realArg: { [key: string]: number | string };
  version?: 1 | 2 | "2.1" | "3.0";
  customLink: { link: string; hoverText?: string }[];
  argMeta: { [key: string]: { [key: string]: string } };
  versionOfPlugin?: string;
  updateURL?: string;
  enabled?: boolean;
  allowedIPC?: string[];
}

export interface PluginScript {
  pluginId: string;
  script: string;
}

/** Arbitrary JSON-compatible data persisted on behalf of a plugin. */
export type PluginStorageValue = unknown;

/** Plugin-owned values indexed by their storage key. */
export type PluginStorageRecord = Record<string, PluginStorageValue>;
