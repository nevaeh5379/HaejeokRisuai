import { Sha256 } from "@aws-crypto/sha256-js";

export const STORAGE_SYNC_ASSET_CHUNK_BYTES = 4 * 1024 * 1024;
export const STORAGE_SYNC_ASSET_MAX_CONCURRENCY = 2;

export interface StorageSyncAssetManifestEntry {
  key: string;
  size: number;
  sha256: string;
}

export interface StorageSyncAssetReader {
  listKeys(prefix: string): Promise<string[]>;
  getSize(key: string): Promise<number>;
  readChunk(key: string, offset: number, length: number): Promise<Uint8Array>;
}

export class StorageSyncAssetReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "StorageSyncAssetReadError";
  }
}
function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageSyncAssetReadError(
      `${label} must be a non-negative safe integer`,
      "invalid_asset_range",
    );
  }
}

function digestToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
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
export async function buildStorageSyncAssetManifest(
  reader: StorageSyncAssetReader,
  prefix = "assets/",
): Promise<StorageSyncAssetManifestEntry[]> {
  const keys = [...new Set(await reader.listKeys(prefix))]
    .filter((key) => key.startsWith(prefix))
    .sort();
  const manifest = new Array<StorageSyncAssetManifestEntry>(keys.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= keys.length) return;
      manifest[index] = await hashStorageSyncAsset(reader, keys[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(STORAGE_SYNC_ASSET_MAX_CONCURRENCY, keys.length) },
      () => worker(),
    ),
  );
  return manifest;
}

export function validateStorageSyncAssetChunkRange(
  offset: number,
  length: number,
): void {
  assertNonNegativeInteger(offset, "Asset offset");
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > STORAGE_SYNC_ASSET_CHUNK_BYTES
  ) {
    throw new StorageSyncAssetReadError(
      `Asset chunk length must be between 1 and ${STORAGE_SYNC_ASSET_CHUNK_BYTES} bytes`,
      "invalid_asset_range",
    );
  }
}
