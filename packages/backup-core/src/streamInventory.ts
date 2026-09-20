import { COLD_STORAGE_HEADER } from "./coldStorage";
import type { LegacyBackupSqlRecord } from "./legacyRecords";
import type { BackupAssetMap, BackupAssetScope } from "./assetScope";

/**
 * Character bookkeeping reconstructed from a streamed database, used to
 * report which characters are affected by missing cold-storage entries.
 * Only a bounded subset of the character record is retained; chat bodies
 * are never buffered beyond the position-0 cold-storage marker.
 */
export interface ColdStorageChatCharacter {
  chaId: string;
  name: string;
  coldstorage?: string;
  coldStoragedChats?: string[];
  chats: Array<{ message: Array<{ data: string }> }>;
}

/**
 * Streaming state shared by backup export and restore: which cold-storage
 * keys the database references, which chat belongs to which character, and
 * the per-character cold-storage summary used by confirmation dialogs.
 */
export interface StreamingColdStorageInventory {
  referencedColdStorageKeys: Set<string>;
  chatOwners: Map<string, string>;
  coldStorageCharacters: Map<string, ColdStorageChatCharacter>;
}

export function createStreamingColdStorageInventory(): StreamingColdStorageInventory {
  return {
    referencedColdStorageKeys: new Set(),
    chatOwners: new Map(),
    coldStorageCharacters: new Map(),
  };
}

/**
 * Export-side streaming inventory. It combines bounded cold-storage reference
 * tracking with asset selection and records which referenced cold payloads
 * could actually be emitted.
 */
export class StreamingBackupExportInventory implements StreamingColdStorageInventory {
  readonly referencedColdStorageKeys: Set<string> = new Set<string>();
  readonly chatOwners: Map<string, string> = new Map<string, string>();
  readonly coldStorageCharacters: Map<string, ColdStorageChatCharacter> =
    new Map<string, ColdStorageChatCharacter>();
  readonly assetMap: BackupAssetMap = new Map();
  readonly exportedColdStorageKeys: Set<string> = new Set<string>();
  readonly unavailableColdStorageKeys: Set<string> = new Set<string>();
  readonly #scope: BackupAssetScope;

  constructor(scope: BackupAssetScope) {
    this.#scope = scope;
  }

  collect(record: LegacyBackupSqlRecord): void {
    collectStreamingInventoryRecord(this, record, {
      scope: this.#scope,
      assetMap: this.assetMap,
    });
  }

  markColdStorageExported(key: string): void {
    this.exportedColdStorageKeys.add(key);
    this.unavailableColdStorageKeys.delete(key);
  }

  markColdStorageUnavailable(key: string): void {
    this.unavailableColdStorageKeys.add(key);
  }

  finalizeUnavailableColdStorageKeys(): ReadonlySet<string> {
    const referencedKeys: string[] = Array.from(this.referencedColdStorageKeys);
    for (let index: number = 0; index < referencedKeys.length; index += 1) {
      const key: string = referencedKeys[index];
      if (!this.exportedColdStorageKeys.has(key)) {
        this.unavailableColdStorageKeys.add(key);
      }
    }
    return this.unavailableColdStorageKeys;
  }
}

export interface StreamingInventoryCollectOptions {
  /**
   * When set (backup export), asset metadata for the requested scope is
   * collected into `assetMap`. Restore paths omit this.
   */
  scope?: BackupAssetScope;
  assetMap?: BackupAssetMap;
  coldStorageHeader?: string;
}

/**
 * Feeds one streamed database record into the inventory. Records are read
 * without copying their `data` payloads; only a filtered copy of each
 * character's `coldStoragedChats` string list is retained.
 */
export function collectStreamingInventoryRecord(
  inventory: StreamingColdStorageInventory,
  record: LegacyBackupSqlRecord,
  options: StreamingInventoryCollectOptions = {},
): void {
  const coldStorageHeader = options.coldStorageHeader ?? COLD_STORAGE_HEADER;

  if (options.scope) collectAssetRecord(record, options);

  if (record.type === "character") {
    const data = record.data as Record<string, any> | undefined;
    const coldstorage =
      typeof data?.coldstorage === "string" ? data.coldstorage : undefined;
    const coldStoragedChats = Array.isArray(data?.coldStoragedChats)
      ? data.coldStoragedChats.filter(
          (key: unknown): key is string => typeof key === "string",
        )
      : [];
    if (coldstorage) inventory.referencedColdStorageKeys.add(coldstorage);
    for (const key of coldStoragedChats) {
      inventory.referencedColdStorageKeys.add(key);
    }
    inventory.coldStorageCharacters.set(record.id, {
      chaId: record.id,
      name: data?.name ?? "Unknown Character",
      coldstorage,
      coldStoragedChats,
      chats: [],
    });
    return;
  }

  if (record.type === "chat") {
    inventory.chatOwners.set(record.id, record.characterId);
    return;
  }

  if (record.type !== "message" || record.position !== 0) return;
  const firstMessage = record.data as Record<string, any> | undefined;
  if (
    typeof firstMessage?.data !== "string" ||
    !firstMessage.data.startsWith(coldStorageHeader)
  ) {
    return;
  }
  const key = firstMessage.data.slice(coldStorageHeader.length);
  if (!key) return;
  inventory.referencedColdStorageKeys.add(key);
  const owner = inventory.chatOwners.get(record.chatId);
  const character = owner
    ? inventory.coldStorageCharacters.get(owner)
    : undefined;
  character?.chats.push({ message: [{ data: firstMessage.data }] });
}

function collectAssetRecord(
  record: LegacyBackupSqlRecord,
  options: StreamingInventoryCollectOptions,
): void {
  const assetMap = options.assetMap;
  if (!assetMap) return;
  const scope = options.scope;
  if (!scope) return;

  const addAsset = (key: unknown, category: string, name: string) => {
    if (typeof key === "string" && key.length > 0) {
      assetMap.set(key, { charName: category, assetName: name });
    }
  };

  if (record.type === "setting") {
    if (record.key === "personas" && Array.isArray(record.value)) {
      for (const persona of record.value) {
        addAsset(persona?.icon, "Persona", `${persona?.name ?? "User"} Icon`);
      }
    } else if (record.key === "userIcon") {
      addAsset(record.value, "User Settings", "User Icon");
    } else if (record.key === "customBackground") {
      addAsset(record.value, "User Settings", "Custom Background");
    } else if (
      scope === "essential" &&
      record.key === "characterOrder" &&
      Array.isArray(record.value)
    ) {
      for (const item of record.value) {
        if (!item || typeof item === "string") continue;
        addAsset(item.img, "Folder", `${item.name ?? "Folder"} Folder Image`);
        addAsset(
          item.imgFile,
          "Folder",
          `${item.name ?? "Folder"} Folder Image File`,
        );
      }
    }
    return;
  }

  if (record.type === "module") {
    const mod = record.data as any;
    const moduleName = mod?.name ?? "Unknown Module";
    addAsset(mod?.icon, "Module", `${moduleName} Icon`);
    if (scope === "all") {
      for (const asset of mod?.assets ?? []) {
        addAsset(
          asset?.[1],
          "Module",
          `${moduleName} - ${asset?.[0] ?? "Asset"}`,
        );
      }
    }
    return;
  }

  if (record.type === "preset") {
    if (scope === "essential") {
      const preset = record.data as any;
      addAsset(
        preset?.image,
        "Preset",
        `${preset?.name ?? "Preset"} Preset Image`,
      );
    }
    return;
  }

  if (record.type === "character") {
    const data = record.data as Record<string, any> | undefined;
    const characterName = data?.name ?? "Unknown Character";
    addAsset(
      data?.image,
      characterName,
      scope === "essential" ? "Profile Image" : "Main Image",
    );
    if (scope !== "all") return;

    for (const emotion of data?.emotionImages ?? []) {
      addAsset(emotion?.[1], characterName, emotion?.[0] ?? "Emotion");
    }
    if (data?.type === "group") return;
    for (const asset of data?.additionalAssets ?? []) {
      addAsset(asset?.[1], characterName, asset?.[0] ?? "Asset");
    }
    for (const [name, key] of Object.entries(data?.vits?.files ?? {})) {
      addAsset(key, characterName, name);
    }
    for (const asset of data?.ccAssets ?? []) {
      addAsset(asset?.uri, characterName, asset?.name ?? "Asset");
    }
  }
}
