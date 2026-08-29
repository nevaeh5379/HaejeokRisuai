import protocolSettings from "../../../packages/protocol/settings.json";

export const PROMPT_SETTING_KEYS = protocolSettings.PROMPT_SETTING_KEYS;

export const DEFERRED_STARTUP_SETTING_KEYS = [
  //Adding the plugin to the lazy loading list is meaningless, as it will inevitably load during the initial loading phase.
  // "plugins",
  "personas",
  "loreBook",
  "modules",
  "globalscript",
  "pluginCustomStorage",
  ...PROMPT_SETTING_KEYS,
] as const;

export type SqlDeferredDomain =
  "personas" | "loreBook" | "modules" | "scripts" | "prompts";

export function getSqlDeferredDomain(key: string): SqlDeferredDomain | null {
  if (key === "personas") return "personas";
  if (key === "loreBook") return "loreBook";
  if (key === "modules") return "modules";
  if (key === "globalscript") return "scripts";
  if (PROMPT_SETTING_KEYS.includes(key as any)) return "prompts";
  return null;
}
