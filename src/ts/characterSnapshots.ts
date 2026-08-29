import { v4 as uuidv4 } from "uuid";
import { safeStructuredClone } from "./polyfill";
import type {
  character,
  CharacterSnapshot,
  CharacterSnapshotData,
} from "./storage/database/schema";

export const CHARACTER_SNAPSHOT_VERSION = 1 as const;

const EXCLUDED_KEYS = new Set<keyof character>([
  "chaId",
  "detailsLoaded",
  "chats",
  "chatFolders",
  "chatPage",
  "scriptstate",
  "realmId",
  "trashTime",
  "lastInteraction",
  "coldstorage",
  "coldStoragedChats",
  "creation_date",
  "modification_date",
  "snapshots",
  "snapshotAssetRefs",
]);

function copySnapshotData(char: character): CharacterSnapshotData {
  const source = safeStructuredClone(char) as unknown as Record<string, unknown>;
  for (const key of EXCLUDED_KEYS) delete source[key as string];
  source.type = "character";
  return source as CharacterSnapshotData;
}

export function createCharacterSnapshot(
  char: character,
  name: string,
  now = Date.now(),
): CharacterSnapshot {
  return {
    id: uuidv4(),
    name: name.trim() || new Date(now).toLocaleString(),
    createdAt: now,
    version: CHARACTER_SNAPSHOT_VERSION,
    data: copySnapshotData(char),
  };
}

export function getCharacterSnapshots(char: character): CharacterSnapshot[] {
  return Array.isArray(char.snapshots) ? char.snapshots : [];
}

type CharacterAssetSource = Pick<
  CharacterSnapshotData,
  | "image"
  | "emotionImages"
  | "additionalAssets"
  | "vits"
  | "ccAssets"
  | "gptSoVitsConfig"
> & { customBackground?: string };

export function collectCharacterAssetReferences(
  source: Partial<CharacterAssetSource>,
): string[] {
  const refs = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) refs.add(value);
  };

  add(source.image);
  add(source.customBackground);
  for (const emotion of source.emotionImages ?? []) add(emotion[1]);
  for (const asset of source.additionalAssets ?? []) add(asset[1]);
  for (const asset of Object.values(source.vits?.files ?? {})) add(asset);
  for (const asset of source.ccAssets ?? []) add(asset.uri);
  add(source.gptSoVitsConfig?.ref_audio_data?.assetId);
  return [...refs];
}

export function collectCharacterSnapshotAssetReferences(
  snapshots: readonly CharacterSnapshot[],
): string[] {
  const refs = new Set<string>();
  for (const snapshot of snapshots) {
    for (const ref of collectCharacterAssetReferences(snapshot.data)) refs.add(ref);
  }
  return [...refs];
}

export function syncCharacterSnapshotAssetReferences(char: character): void {
  char.snapshotAssetRefs = collectCharacterSnapshotAssetReferences(
    getCharacterSnapshots(char),
  );
}

export function applyCharacterSnapshot(
  current: character,
  snapshot: CharacterSnapshot,
): character {
  const restored = safeStructuredClone(snapshot.data) as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;

  for (const key of EXCLUDED_KEYS) {
    const keyString = key as string;
    if (keyString in currentRecord) restored[keyString] = currentRecord[keyString];
  }

  restored.type = "character";
  restored.chaId = current.chaId;
  restored.chats = current.chats;
  restored.chatFolders = current.chatFolders;
  restored.chatPage = current.chatPage;
  restored.snapshots = current.snapshots;
  restored.snapshotAssetRefs = current.snapshotAssetRefs;

  return restored as unknown as character;
}
