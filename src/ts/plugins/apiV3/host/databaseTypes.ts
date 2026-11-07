import type { Database } from "@risuai/protocol/domain/legacy/database.ts";
import type { PluginStorageRecord } from "@risuai/protocol/domain/pluginTypes.ts";

export const allowedDbKeys = [
  "characters",
  "modules",
  "enabledModules",
  "moduleIntergration",
  "pluginV2",
  "personas",
  "plugins",
  "pluginCustomStorage",
  "temperature",
  "askRemoval",
  "maxContext",
  "maxResponse",
  "frequencyPenalty",
  "PresensePenalty",
  "theme",
  "textTheme",
  "lineHeight",
  "seperateModelsForAxModels",
  "seperateModels",
  "customCSS",
  "guiHTML",
  "colorSchemeName",
  "selectedPersona",
  "characterOrder",
] as const satisfies readonly (keyof Database)[];

export type PluginDatabaseKey = (typeof allowedDbKeys)[number];
export type PluginDatabaseFields = Omit<
  Pick<Database, PluginDatabaseKey>,
  "pluginCustomStorage"
> & {
  pluginCustomStorage: PluginStorageRecord;
};
export type PluginDatabase = Partial<PluginDatabaseFields> &
  PluginStorageRecord;

export function isPluginDatabaseKey(key: string): key is PluginDatabaseKey {
  return allowedDbKeys.some((allowed) => allowed === key);
}

export type PluginDatabaseLite = Omit<
  Partial<PluginDatabaseFields>,
  "plugins"
> &
  PluginStorageRecord & { plugins?: never };
