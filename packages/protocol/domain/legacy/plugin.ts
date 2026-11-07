/** Upstream plugin records, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
interface ProviderPlugin {
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

interface ProviderPluginCustomLink {
  link: string;
  hoverText?: string;
}

export type RisuPlugin = ProviderPlugin;
