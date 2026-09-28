export interface ProviderPluginCustomLink {
  link: string;
  hoverText?: string;
}

export interface ProviderPlugin {
  name: string;
  displayName?: string;
  script: string;
  arguments: { [key: string]: "int" | "string" | string[] };
  realArg: { [key: string]: number | string };
  version?: 1 | 2 | "2.1" | "3.0";
  customLink: ProviderPluginCustomLink[];
  argMeta: { [key: string]: { [key: string]: string } };
  versionOfPlugin?: string;
  updateURL?: string;
  enabled?: boolean;
  allowedIPC?: string[];
}

export type RisuPlugin = ProviderPlugin;

export type StoredPlugin = Omit<RisuPlugin, "script"> & {
  id: string;
  position: number;
};
