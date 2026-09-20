import type { LocalBackupProgress } from "../api";
import {
  getColdStorageBackupKey,
  getColdStorageBackupName,
} from "../coldStorage";
import type { BackupEntrySource } from "./exportStream";

export interface LoadColdStorageExportValueResult {
  exists: boolean;
  value?: unknown;
}

export interface OpenBackupStorageEntryResult {
  exists: boolean;
  source?: BackupEntrySource | null;
  size?: number;
}

export type BackupStorageExportStage = "assets" | "inlays";

export interface StreamBackupStorageEntriesOptions {
  stage: BackupStorageExportStage;
  keys: readonly string[];
  open(key: string): Promise<OpenBackupStorageEntryResult>;
  writeEntry(
    name: string,
    source: BackupEntrySource,
    size: number,
  ): Promise<void>;
  onProgress?: (progress: LocalBackupProgress) => void;
}

export interface StreamColdStorageExportEntriesOptions {
  keys: readonly string[];
  load(key: string): Promise<LoadColdStorageExportValueResult>;
  writeEntry(
    name: string,
    source: BackupEntrySource,
    size: number,
  ): Promise<void>;
  onProgress?: (progress: LocalBackupProgress) => void;
}

export function coldStorageExportEntryName(key: string): string {
  const name = getColdStorageBackupName(key);
  if (getColdStorageBackupKey(name) !== key) {
    throw new Error(`Invalid cold storage backup key '${key}'`);
  }
  return name;
}

export async function streamColdStorageExportEntries(
  options: StreamColdStorageExportEntriesOptions,
): Promise<void> {
  const { keys, load, writeEntry, onProgress } = options;
  onProgress?.({ stage: "coldStorage", current: 0, total: keys.length });
  const encoder = new TextEncoder();

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const loaded = await load(key);
    if (!loaded.exists) continue;
    const serialized = JSON.stringify(loaded.value);
    if (typeof serialized !== "string") {
      throw new Error(
        `Cold storage backup payload is not serializable: ${key}`,
      );
    }
    const data = encoder.encode(serialized);
    await writeEntry(coldStorageExportEntryName(key), data, data.byteLength);
    onProgress?.({
      stage: "coldStorage",
      current: index + 1,
      total: keys.length,
    });
  }
}
export async function streamBackupStorageEntries(
  options: StreamBackupStorageEntriesOptions,
): Promise<void> {
  const { stage, keys, open, writeEntry, onProgress } = options;
  if (stage === "assets" || keys.length > 0) {
    onProgress?.({ stage, current: 0, total: keys.length });
  }

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const opened = await open(key);
    if (!opened.exists) continue;
    if (
      !opened.source ||
      !Number.isSafeInteger(opened.size) ||
      Number(opened.size) < 0
    ) {
      const label = stage === "inlays" ? "inlay" : "asset";
      throw new Error(`Backup ${label} is not streamable: ${key}`);
    }
    await writeEntry(key, opened.source, Number(opened.size));
    onProgress?.({
      stage,
      current: index + 1,
      total: keys.length,
    });
  }
}
