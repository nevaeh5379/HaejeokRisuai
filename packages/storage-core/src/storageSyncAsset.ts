export const STORAGE_SYNC_ASSET_CHUNK_BYTES = 4 * 1024 * 1024;
export const STORAGE_SYNC_ASSET_MAX_CONCURRENCY = 2;

export interface StorageSyncAssetManifestEntry {
  key: string;
  size: number;
  sha256: string;
}

/**
 * Compare asset keys by UTF-16 code units, which is exactly what the bare
 * `Array.prototype.sort()` used across every asset listing backend does.
 * Passing an explicit comparator keeps that byte order instead of falling back
 * to the engine's locale-sensitive default ordering.
 */
export function compareStorageSyncAssetKeys(
  left: string,
  right: string,
): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
