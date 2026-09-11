import {
  StorageSyncAssetReadError,
  validateStorageSyncAssetChunkRange,
} from "@risuai/storage-core/storageSyncAsset";
import type { NodeApiClient } from "./nodeApiClient";
import type { NodeS3Storage } from "./nodeS3Storage";

function utf8ToHex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class RemoteSyncAssetReader {
  private sizeCache: {
    expiresAt: number;
    sizes: Map<string, number>;
  } | null = null;
  private sizePromise: Promise<Map<string, number>> | null = null;

  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
    private readonly assetAdmin: NodeS3Storage,
  ) {}

  private async loadSizes(force = false): Promise<Map<string, number>> {
    const now = Date.now();
    if (!force && this.sizeCache && this.sizeCache.expiresAt > now) {
      return this.sizeCache.sizes;
    }
    if (this.sizePromise) return await this.sizePromise;
    this.sizePromise = (async () => {
      const details = await this.assetAdmin.getAssetDetails("active");
      const sizes = new Map<string, number>();
      for (const asset of details.assets ?? []) {
        if (
          typeof asset?.key === "string" &&
          Number.isSafeInteger(asset.size) &&
          asset.size >= 0
        ) {
          sizes.set(asset.key, asset.size);
        }
      }
      this.sizeCache = { expiresAt: Date.now() + 30_000, sizes };
      return sizes;
    })();
    try {
      return await this.sizePromise;
    } finally {
      this.sizePromise = null;
    }
  }

  async listKeys(prefix = "assets/"): Promise<string[]> {
    const sizes = await this.loadSizes();
    return [...sizes.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async getSize(key: string): Promise<number> {
    let sizes = await this.loadSizes();
    if (!sizes.has(key)) sizes = await this.loadSizes(true);
    const size = sizes.get(key);
    if (size === undefined) {
      throw new StorageSyncAssetReadError(
        `Remote asset '${key}' was not found.`,
        "asset_missing",
      );
    }
    return size;
  }

  async readChunk(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    validateStorageSyncAssetChunkRange(offset, length);
    const size = await this.getSize(key);
    if (offset >= size) {
      throw new StorageSyncAssetReadError(
        `Asset '${key}' offset ${offset} is outside its ${size}-byte range.`,
        "invalid_asset_range",
      );
    }
    const expected = Math.min(length, size - offset);
    const end = offset + expected - 1;
    const response = await this.apiClient.request(
      `/api/read?path=${encodeURIComponent(utf8ToHex(key))}`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          range: `bytes=${offset}-${end}`,
          "risu-auth": await this.getAuth(),
        },
      },
    );
    if (
      response.status !== 206 &&
      !(
        response.status >= 200 &&
        response.status < 300 &&
        offset === 0 &&
        expected === size
      )
    ) {
      throw new StorageSyncAssetReadError(
        `Remote asset range read failed (${response.status}).`,
        "asset_read_failed",
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== expected) {
      throw new StorageSyncAssetReadError(
        `Remote asset '${key}' changed while it was being read.`,
        "asset_changed",
      );
    }
    return data;
  }
}
