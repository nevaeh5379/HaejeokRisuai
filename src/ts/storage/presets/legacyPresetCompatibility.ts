/** Aliases belong only to aggregate backups and their external API format. */
const legacyPresetKeys = {
  NAIsettings: "NAISettings",
  presetRegex: "regex",
  reasoningEffort: "reasonEffort",
} as const;

const LEGACY_PRESET_ENTRIES = Object.entries(legacyPresetKeys) as ReadonlyArray<
  [
    keyof typeof legacyPresetKeys,
    (typeof legacyPresetKeys)[keyof typeof legacyPresetKeys],
  ]
>;

export function readLegacyPresetFields(root: Record<string, unknown>): void {
  for (const [legacy, current] of LEGACY_PRESET_ENTRIES) {
    if (root[current] == null && root[legacy] != null)
      root[current] = root[legacy];
    delete root[legacy];
  }
}

/** Shallow copy: large aggregate character/asset data is never duplicated. */
export function writeLegacyPresetFields(
  root: Record<string, unknown>,
): Record<string, unknown> {
  if (!root || typeof root !== "object" || Array.isArray(root)) return root;
  const result = { ...root };
  for (const [legacy, current] of LEGACY_PRESET_ENTRIES) {
    if (current in result) {
      result[legacy] = result[current];
      delete result[current];
    }
  }
  return result;
}
