import {
  findBackupAssetInfo,
  filterEssentialBackupAssetKeys,
  type BackupAssetMap,
  type BackupAssetScope,
} from "./assetScope";

export interface MissingBackupAssetsResult {
  success: boolean;
  message?: string;
}

export interface BackupAssetExportProgress {
  current: number;
  total: number;
}

export interface NativeBackupAssetBatchResult {
  missing: string[];
}

export interface ExportNativeBackupAssetsOptions {
  keys: readonly string[];
  writeBatch(keys: string[]): Promise<NativeBackupAssetBatchResult>;
  onProgress?(progress: BackupAssetExportProgress): Promise<void> | void;
  yieldControl?(): Promise<void>;
  batchSize?: number;
}

export interface ExportStoredBackupAssetsOptions {
  keys: readonly string[];
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, data: Uint8Array): Promise<void>;
  readCached?(key: string): Promise<Uint8Array | undefined>;
  onProgress?(progress: BackupAssetExportProgress): Promise<void> | void;
  yieldControl?(): Promise<void>;
  delay?(milliseconds: number): Promise<void>;
  delayAfterUncachedMs?: number;
  progressUpdateMs?: number;
  now?(): number;
}

export function selectBackupAssetKeys(
  keys: readonly string[],
  scope: BackupAssetScope,
  assetMap: BackupAssetMap,
): string[] {
  return scope === "essential"
    ? filterEssentialBackupAssetKeys(keys, assetMap)
    : Array.from(keys);
}

export function formatMissingBackupAssets(
  missingAssets: readonly string[],
  assetMap: BackupAssetMap,
  partial: boolean,
): MissingBackupAssetsResult {
  if (missingAssets.length === 0) return { success: true };
  let message: string = partial
    ? "Partial backup successful, but the following profile images were missing and skipped:\n\n"
    : "Backup Successful, but the following assets were missing and skipped:\n\n";
  for (const key of missingAssets) {
    const info = findBackupAssetInfo(assetMap, key);
    message += info
      ? `* **${info.assetName}** (from *${info.charName}*)  \n  *File: ${key}*\n`
      : `* **Unknown Asset**  \n  *File: ${key}*\n`;
  }
  return { success: false, message };
}

function normalizeBatchSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 128;
}

export async function exportNativeBackupAssets(
  options: ExportNativeBackupAssetsOptions,
): Promise<string[]> {
  const missing: string[] = [];
  const total: number = options.keys.length;
  const batchSize: number = normalizeBatchSize(options.batchSize);
  for (let offset: number = 0; offset < total; offset += batchSize) {
    const batch: string[] = options.keys.slice(offset, offset + batchSize);
    const result: NativeBackupAssetBatchResult =
      await options.writeBatch(batch);
    missing.push(...result.missing);
    await options.onProgress?.({
      current: Math.min(offset + batch.length, total),
      total,
    });
    await options.yieldControl?.();
  }
  return missing;
}

export async function exportStoredBackupAssets(
  options: ExportStoredBackupAssetsOptions,
): Promise<string[]> {
  const missing: string[] = [];
  const total: number = options.keys.length;
  const updateInterval: number = Math.max(0, options.progressUpdateMs ?? 0);
  const now: () => number = options.now ?? Date.now;
  let lastProgressUpdate: number = 0;

  for (let index: number = 0; index < total; index += 1) {
    const key: string = options.keys[index];
    const timestamp: number = now();
    if (
      index === 0 ||
      index === total - 1 ||
      timestamp - lastProgressUpdate >= updateInterval
    ) {
      lastProgressUpdate = timestamp;
      await options.onProgress?.({ current: index + 1, total });
      await options.yieldControl?.();
    }

    const cached: Uint8Array | undefined = await options.readCached?.(key);
    const data: Uint8Array | undefined = cached ?? (await options.read(key));
    if (data) await options.write(key, data);
    else missing.push(key);

    if (!cached && options.delayAfterUncachedMs && options.delay) {
      await options.delay(options.delayAfterUncachedMs);
    }
  }
  return missing;
}
