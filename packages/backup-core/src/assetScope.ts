export interface BackupAssetReferenceRecord {
  type: string;
  key?: string;
  value?: unknown;
  data?: Record<string, any>;
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
