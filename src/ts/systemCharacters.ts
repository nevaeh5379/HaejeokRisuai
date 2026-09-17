/**
 * Reserved "system" character identities.
 *
 * Risu keeps a few characters that are owned by internal features rather than
 * by the user. They share SQL-backed storage with normal characters but must
 * never show up in the ordinary character lists, recents, ordering, or card
 * export. Centralising the identifiers here keeps those decisions consistent
 * and avoids scattered string comparisons.
 */

/** Risu Agent's reserved identity. Distinct from §playground so the legacy
 * Playground chat data is never silently reused. */
export const RISU_AGENT_CHARACTER_ID = "§risu-agent";

/** Temporary multi-user / sync character. */
export const TEMP_CHARACTER_ID = "§temp";

/** Legacy Playground chat character. Kept reserved (and preserved), never
 * repurposed or deleted by Risu Agent. */
export const PLAYGROUND_CHARACTER_ID = "§playground";

export const RESERVED_SYSTEM_CHARACTER_IDS = [
  TEMP_CHARACTER_ID,
  PLAYGROUND_CHARACTER_ID,
  RISU_AGENT_CHARACTER_ID,
] as const;

export type ReservedSystemCharacterId =
  (typeof RESERVED_SYSTEM_CHARACTER_IDS)[number];

const RESERVED_SYSTEM_CHARACTER_ID_SET: ReadonlySet<string> = new Set(
  RESERVED_SYSTEM_CHARACTER_IDS,
);

/** True when the id belongs to an internal, non-user character. */
export function isReservedSystemCharacterId(
  chaId: string | null | undefined,
): boolean {
  if (!chaId) return false;
  return RESERVED_SYSTEM_CHARACTER_ID_SET.has(chaId);
}

/** True when the id is Risu Agent's reserved identity. */
export function isRisuAgentCharacterId(
  chaId: string | null | undefined,
): boolean {
  return chaId === RISU_AGENT_CHARACTER_ID;
}

export interface CharacterListVisibilityFields {
  chaId?: string | null;
  trashTime?: number | null;
}

/**
 * Single source of truth for "should this character be hidden from ordinary
 * character surfaces (main menu, recents, grid, mobile list, native app menu)".
 */
export function isHiddenFromCharacterLists(
  char: CharacterListVisibilityFields | null | undefined,
): boolean {
  if (!char) return true;
  return Boolean(char.trashTime) || isReservedSystemCharacterId(char.chaId);
}
