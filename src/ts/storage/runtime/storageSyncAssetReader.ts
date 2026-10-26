import { Sha256 } from "@aws-crypto/sha256-js";

import {
  compareStorageSyncAssetKeys,
  STORAGE_SYNC_ASSET_CHUNK_BYTES,
  STORAGE_SYNC_ASSET_MAX_CONCURRENCY,
  StorageSyncAssetReadError,
  validateStorageSyncAssetChunkRange,
  type StorageSyncAssetManifestEntry,
  type StorageSyncAssetReader,
} from "@risuai/storage-core/storageSyncAsset";

export {
  STORAGE_SYNC_ASSET_CHUNK_BYTES,
  STORAGE_SYNC_ASSET_MAX_CONCURRENCY,
  StorageSyncAssetReadError,
  validateStorageSyncAssetChunkRange,
  type StorageSyncAssetManifestEntry,
  type StorageSyncAssetReader,
} from "@risuai/storage-core/storageSyncAsset";

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageSyncAssetReadError(
      `${label} must be a non-negative safe integer`,
      "invalid_asset_range",
    );
  }
}

const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

function digestToHex(value: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < value.length; i++) {
    hex += HEX_TABLE[value[i]];
  }
  return hex;
}

export function createStorageSyncAssetReader(
  storage: unknown,
): StorageSyncAssetReader {
  const candidate = storage as any;
  if (
    typeof candidate?.listSyncAssetKeys === "function" &&
    typeof candidate?.getSyncAssetSize === "function" &&
    typeof candidate?.readSyncAssetChunk === "function"
  ) {
    return {
      listKeys: (prefix) => candidate.listSyncAssetKeys(prefix),
      getSize: (key) => candidate.getSyncAssetSize(key),
      readChunk: async (key, offset, length) => {
        validateStorageSyncAssetChunkRange(offset, length);
        return await candidate.readSyncAssetChunk(key, offset, length);
      },
    };
  }
  throw new StorageSyncAssetReadError(
    "This local asset backend cannot provide bounded reads. Migrate browser assets to OPFS before syncing.",
    "bounded_asset_read_unsupported",
  );
}

export async function hashStorageSyncAsset(
  reader: StorageSyncAssetReader,
  key: string,
): Promise<StorageSyncAssetManifestEntry> {
  const size = await reader.getSize(key);
  assertNonNegativeInteger(size, "Asset size");
  const hash = new Sha256();
  let offset = 0;
  while (offset < size) {
    const length = Math.min(STORAGE_SYNC_ASSET_CHUNK_BYTES, size - offset);
    const chunk = await reader.readChunk(key, offset, length);
    if (chunk.byteLength <= 0 || chunk.byteLength > length) {
      throw new StorageSyncAssetReadError(
        `Asset '${key}' returned an invalid chunk at offset ${offset}`,
        "invalid_asset_chunk",
      );
    }
    hash.update(chunk);
    offset += chunk.byteLength;
  }
  return { key, size, sha256: digestToHex(await hash.digest()) };
}
export interface StorageSyncAssetSummary {
  count: number;
  sizeBytes: number;
}

function extractSortedUniquePrefixKeys(
  rawKeys: string[],
  prefix: string,
): string[] {
  const keySet = new Set<string>();
  for (let i = 0; i < rawKeys.length; i++) {
    const key = rawKeys[i];
    if (key.startsWith(prefix)) {
      keySet.add(key);
    }
  }
  return Array.from(keySet).sort(compareStorageSyncAssetKeys);
}

export async function summarizeStorageSyncAssets(
  reader: StorageSyncAssetReader,
  prefix = "assets/",
  concurrency = 8,
): Promise<StorageSyncAssetSummary> {
  const keys = extractSortedUniquePrefixKeys(
    await reader.listKeys(prefix),
    prefix,
  );
  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency) || 1, keys.length || 1),
  );
  let cursor = 0;
  let sizeBytes = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= keys.length) return;
      const size = await reader.getSize(keys[index]);
      assertNonNegativeInteger(size, "Asset size");
      sizeBytes += size;
    }
  };
  const workers = new Array(workerCount);
  for (let i = 0; i < workerCount; i++) {
    workers[i] = worker();
  }
  await Promise.all(workers);
  return { count: keys.length, sizeBytes };
}

export async function buildStorageSyncAssetManifest(
  reader: StorageSyncAssetReader,
  prefix = "assets/",
): Promise<StorageSyncAssetManifestEntry[]> {
  const keys = extractSortedUniquePrefixKeys(
    await reader.listKeys(prefix),
    prefix,
  );
  const manifest = new Array<StorageSyncAssetManifestEntry>(keys.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= keys.length) return;
      manifest[index] = await hashStorageSyncAsset(reader, keys[index]);
    }
  };
  const workerCount = Math.min(STORAGE_SYNC_ASSET_MAX_CONCURRENCY, keys.length);
  const workers = new Array(workerCount);
  for (let i = 0; i < workerCount; i++) {
    workers[i] = worker();
  }
  await Promise.all(workers);
  return manifest;
}
