export interface BackupAssetReferenceRecord {
  type: string;
  key?: string;
  value?: unknown;
  data?: Record<string, any>;
}

/** Which assets a backup export should include. */
export type BackupAssetScope = "all" | "essential";

/**
 * Display metadata kept for missing-asset reporting:
 * `charName` is the owning category (character/preset/setting group) and
 * `assetName` is the human-readable asset label.
 */
export interface BackupAssetInfo {
  charName: string;
  assetName: string;
}

/**
 * Inventory of the asset keys a database references, with the metadata
 * needed to report entries that turned out to be missing.
 */
export type BackupAssetMap = Map<string, BackupAssetInfo>;

/**
 * Resolves an asset key against the inventory regardless of whether the
 * caller passes the key with or without the `assets/` prefix.
 */
export function findBackupAssetInfo(
  assetMap: BackupAssetMap,
  key: string,
): BackupAssetInfo | undefined {
  return (
    assetMap.get(key) ??
    assetMap.get(key.replace(/^assets\//, "")) ??
    assetMap.get(`assets/${key}`)
  );
}

/**
 * Essential-scope filtering only admits PNG profile-style images that the
 * database actually references.
 */
export function isEssentialBackupAsset(
  assetMap: BackupAssetMap,
  key: string,
): boolean {
  if (!key.endsWith(".png")) return false;
  return Boolean(findBackupAssetInfo(assetMap, key));
}

/**
 * Filters a listed set of storage keys down to the essential assets.
 * Performs a single pass over `keys`, preserves the input order, and
 * returns a new array without mutating the input.
 */
export function filterEssentialBackupAssetKeys(
  keys: readonly string[],
  assetMap: BackupAssetMap,
): string[] {
  return keys.filter((key) => isEssentialBackupAsset(assetMap, key));
}

function addAssetKey(target: Set<string>, key: unknown): void {
  if (typeof key === "string" && key.startsWith("assets/")) {
    target.add(key);
  }
}

export function collectStreamedEssentialAssetKeys(
  target: Set<string>,
  record: BackupAssetReferenceRecord,
): void {
  if (record.type === "setting") {
    if (record.key === "personas" && Array.isArray(record.value)) {
      for (const persona of record.value) addAssetKey(target, persona?.icon);
    } else if (
      record.key === "userIcon" ||
      record.key === "customBackground"
    ) {
      addAssetKey(target, record.value);
    } else if (
      record.key === "characterOrder" &&
      Array.isArray(record.value)
    ) {
      for (const item of record.value) {
        if (!item || typeof item === "string") continue;
        addAssetKey(target, item.img);
        addAssetKey(target, item.imgFile);
      }
    }
    return;
  }

  if (record.type === "module") {
    addAssetKey(target, record.data?.icon);
  } else if (record.type === "preset") {
    addAssetKey(target, record.data?.image);
  } else if (record.type === "character") {
    addAssetKey(target, record.data?.image);
  }
}

export function collectEssentialBackupAssetKeys(
  database: Record<string, any>,
  assetKeys: readonly string[],
): string[] {
  const wanted = new Set<string>();

  for (const character of database.characters ?? []) {
    if (character) addAssetKey(wanted, character.image);
  }
  for (const persona of database.personas ?? []) {
    if (persona?.icon) addAssetKey(wanted, persona.icon);
  }
  addAssetKey(wanted, database.userIcon);
  addAssetKey(wanted, database.customBackground);

  for (const mod of database.modules ?? []) {
    if (mod?.icon) addAssetKey(wanted, mod.icon);
  }
  for (const item of database.characterOrder ?? []) {
    if (!item || typeof item === "string") continue;
    addAssetKey(wanted, item.img);
    addAssetKey(wanted, item.imgFile);
  }
  for (const preset of database.botPresets ?? []) {
    if (preset?.image) addAssetKey(wanted, preset.image);
  }

  return assetKeys.filter((key) => wanted.has(key));
}
