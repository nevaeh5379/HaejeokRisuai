import { getInlayBackupKey, getInlayBackupName } from "./entryPolicy";

export type BackupInlayEntry<TAsset> = readonly [id: string, asset: TAsset];

export interface StreamBackupInlaysOptions<TAsset> {
  entries: readonly BackupInlayEntry<TAsset>[];
  encode(asset: TAsset): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  onProgress?(current: number, total: number, id: string): Promise<void> | void;
  onUnsupportedKey?(id: string): Promise<void> | void;
}

export interface StreamBackupInlaysResult {
  written: number;
  skipped: number;
}

/** Validates, encodes, and streams inlay entries without retaining copies. */
export async function streamBackupInlays<TAsset>(
  options: StreamBackupInlaysOptions<TAsset>,
): Promise<StreamBackupInlaysResult> {
  let written: number = 0;
  let skipped: number = 0;
  const total: number = options.entries.length;

  for (let index: number = 0; index < total; index += 1) {
    const entry: BackupInlayEntry<TAsset> = options.entries[index];
    const id: string = entry[0];
    const asset: TAsset = entry[1];
    const name: string = getInlayBackupName(id);
    if (getInlayBackupKey(name) !== id) {
      skipped += 1;
      await options.onUnsupportedKey?.(id);
      continue;
    }
    await options.onProgress?.(index + 1, total, id);
    const encoded: Uint8Array = await options.encode(asset);
    await options.write(name, encoded);
    written += 1;
  }
  return { written, skipped };
}
