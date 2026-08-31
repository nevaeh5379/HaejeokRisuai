import protocolSettings from "../../../../packages/protocol/settings.json";

export const PROMPT_SETTING_KEYS = protocolSettings.PROMPT_SETTING_KEYS;
export const LEGACY_PERSONA_MIRROR_KEYS =
  protocolSettings.LEGACY_PERSONA_MIRROR_KEYS;
const LEGACY_PERSONA_MIRROR_KEY_SET = new Set<string>(
  LEGACY_PERSONA_MIRROR_KEYS,
);
export function isLegacyPersonaMirrorKey(key: string): boolean {
  return LEGACY_PERSONA_MIRROR_KEY_SET.has(key);
}
export const DOMAIN_STORE_SETTING_KEYS = protocolSettings.DOMAIN_STORE_SETTING_KEYS;
export const NON_SETTINGS_ROOT_KEYS = protocolSettings.NON_SETTINGS_ROOT_KEYS;
export const SETTINGS_STORE_EXCLUDED_KEYS = [
  ...NON_SETTINGS_ROOT_KEYS,
  ...DOMAIN_STORE_SETTING_KEYS,
];

export const DEFERRED_STARTUP_SETTING_KEYS =
  protocolSettings.DEFERRED_STARTUP_SETTING_KEYS;

export type SqlDeferredDomain = "loreBook" | "scripts" | "prompts";

export function getSqlDeferredDomain(key: string): SqlDeferredDomain | null {
  if (key === "loreBook") return "loreBook";
  if (key === "globalscript") return "scripts";
  if (PROMPT_SETTING_KEYS.includes(key as any)) return "prompts";
  return null;
}
