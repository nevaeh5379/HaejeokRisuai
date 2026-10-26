import type { AssetEntry } from "../serverTypes.ts";

export function readAssetCatalogBatchSize(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): number {
  if (!value?.trim()) return 256;
  const size = Number(value);
  if (Number.isSafeInteger(size) && size > 0) return size;
  warn(
    "[local-backup] Invalid HAEJEOK_BACKUP_ASSET_CATALOG_BATCH_SIZE; using 256",
  );
  return 256;
}

export function createAssetCatalogBatch(
  batchSize: number,
  write: (entries: AssetEntry[]) => Promise<void>,
) {
  let pending: AssetEntry[] = [];
  let finished = false;

  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const entries = pending;
    // A failed write ends the restore; abort must not retry the same batch.
    pending = [];
    await write(entries);
  }

  return {
    async add(entry: AssetEntry): Promise<void> {
      pending.push(entry);
      if (finished || pending.length >= batchSize) await flush();
    },
    flush,
    async finish(): Promise<void> {
      // Cancellation may finish while the parser still awaits a saved file.
      finished = true;
      await flush();
    },
  };
}
