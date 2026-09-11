import { Buffer } from "buffer";
import type { NodeApiClient } from "./nodeApiClient";

export type NodeStorageBulkReadProgress = {
  completedFiles: number;
  totalFiles: number;
  currentFile: string | null;
  receivedBytes: number;
  totalBytes: bigint;
  assetListSource?: string;
};

export type NodeStorageBulkReadHandlers = {
  onFileStart: (name: string, size: bigint) => Promise<void> | void;
  onFileChunk: (name: string, chunk: Uint8Array) => Promise<void> | void;
  onFileEnd?: (name: string) => Promise<void> | void;
};

export type NodeStorageBulkWriteProgress = {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
};

const BULK_IMAGE_CACHE_NAME = "risu-node-bulk-images-v1";
const BULK_IMAGE_CACHE_MAX_ENTRIES = 256;

function writeUint64BE(
  target: Uint8Array,
  offset: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid unsigned 64-bit value: ${value}`);
  }
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  const view = new DataView(
    target.buffer,
    target.byteOffset,
    target.byteLength,
  );
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}

function readUint64BE(source: Uint8Array, offset: number): bigint {
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return (BigInt(high) << 32n) | BigInt(low);
}

function canUseBulkImageCache(): boolean {
  return typeof caches !== "undefined" && typeof Response !== "undefined";
}

function getBulkImageCacheUrl(
  key: string,
  options: {
    thumbnail?: boolean;
    size?: "thumb" | "display" | "full";
    width?: number;
    height?: number;
  },
): string {
  const origin =
    typeof location !== "undefined" && location.origin
      ? location.origin
      : "http://localhost";
  const params = new URLSearchParams({
    path: Buffer.from(key, "utf8").toString("hex"),
    size: options.size ?? (options.thumbnail ? "thumb" : "full"),
    width: String(options.width ?? 0),
    height: String(options.height ?? 0),
  });
  return `${origin}/api/read-bulk-cache?${params.toString()}`;
}

function isCacheableBulkImageRequest(options?: {
  thumbnail?: boolean;
  size?: "thumb" | "display" | "full";
  width?: number;
  height?: number;
}): options is NonNullable<typeof options> {
  return Boolean(
    options &&
    (options.thumbnail ||
      options.size === "thumb" ||
      options.size === "display" ||
      (options.width && options.height)),
  );
}

export class RemoteBulkAssetClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
  ) {}

  private async openBulkImageCache(): Promise<Cache | null> {
    if (!canUseBulkImageCache()) return null;
    try {
      return await caches.open(BULK_IMAGE_CACHE_NAME);
    } catch {
      return null;
    }
  }

  private async trimBulkImageCache(cache: Cache): Promise<void> {
    try {
      const requests = await cache.keys();
      const excess = requests.length - BULK_IMAGE_CACHE_MAX_ENTRIES;
      if (excess <= 0) return;
      await Promise.all(
        requests.slice(0, excess).map((request) => cache.delete(request)),
      );
    } catch {
      // CacheStorage is only an optimization.
    }
  }

  async invalidateCache(keys: Iterable<string>): Promise<void> {
    const cache = await this.openBulkImageCache();
    if (!cache) return;
    const encodedKeys = new Set(
      [...keys].map((key) => Buffer.from(key, "utf8").toString("hex")),
    );
    if (encodedKeys.size === 0) return;
    try {
      const requests = await cache.keys();
      await Promise.all(
        requests
          .filter((request) => {
            try {
              return encodedKeys.has(
                new URL(request.url).searchParams.get("path") ?? "",
              );
            } catch {
              return false;
            }
          })
          .map((request) => cache.delete(request)),
      );
    } catch {
      // A stale cache entry is preferable to failing a completed write.
    }
  }

  async setItems(
    items: ReadonlyMap<string, Uint8Array>,
    onProgress?: (progress: NodeStorageBulkWriteProgress) => void,
  ): Promise<void> {
    const parts: BlobPart[] = [];
    const chunkSize = 256 * 1024;
    let fileId = 0;

    for (const [name, data] of items) {
      const nameBuffer = Buffer.from(name, "utf8");
      const header = Buffer.alloc(1 + 4 + 4 + nameBuffer.length + 8);
      let offset = 0;

      header.writeUInt8(0x01, offset);
      offset += 1;
      header.writeUInt32BE(fileId, offset);
      offset += 4;
      header.writeUInt32BE(nameBuffer.length, offset);
      offset += 4;
      nameBuffer.copy(header, offset);
      offset += nameBuffer.length;
      writeUint64BE(header, offset, data.byteLength);
      parts.push(header as unknown as BlobPart);

      for (
        let dataOffset = 0;
        dataOffset < data.byteLength;
        dataOffset += chunkSize
      ) {
        const chunk = data.subarray(
          dataOffset,
          Math.min(dataOffset + chunkSize, data.byteLength),
        );
        const chunkHeader = Buffer.alloc(1 + 4 + 4);
        chunkHeader.writeUInt8(0x02, 0);
        chunkHeader.writeUInt32BE(fileId, 1);
        chunkHeader.writeUInt32BE(chunk.byteLength, 5);
        parts.push(chunkHeader as unknown as BlobPart);
        parts.push(chunk as unknown as BlobPart);
      }

      const end = Buffer.alloc(1 + 4);
      end.writeUInt8(0x03, 0);
      end.writeUInt32BE(fileId, 1);
      parts.push(end as unknown as BlobPart);
      fileId += 1;
    }

    const body = new Blob(parts, { type: "application/x-risu-bulk" });
    const auth = await this.getAuth();

    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", this.apiClient.resolve("/api/write-bulk"));
      request.responseType = "json";
      request.setRequestHeader("content-type", body.type);
      request.setRequestHeader("risu-auth", auth);

      request.upload.onprogress = (event) => {
        const totalBytes = event.lengthComputable ? event.total : body.size;
        const percent =
          totalBytes === 0
            ? 100
            : Math.min(100, (event.loaded / totalBytes) * 100);
        onProgress?.({
          uploadedBytes: event.loaded,
          totalBytes,
          percent,
        });
      };
      request.onerror = () => reject(new Error("setItems network error"));
      request.onabort = () => reject(new Error("setItems request aborted"));
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          let message = request.response?.error;
          if (
            !message &&
            typeof request.responseText === "string" &&
            request.responseText
          ) {
            try {
              message = JSON.parse(request.responseText)?.error;
            } catch {}
          }
          reject(new Error(message ?? `setItems Error: ${request.status}`));
          return;
        }
        onProgress?.({
          uploadedBytes: body.size,
          totalBytes: body.size,
          percent: 100,
        });
        resolve();
      };

      request.send(body);
    });
    await this.invalidateCache(items.keys());
  }

  async getItems(
    keys: string[],
    onProgress?: (progress: NodeStorageBulkReadProgress) => void,
    options?: {
      thumbnail?: boolean;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
    },
  ): Promise<Map<string, Buffer>> {
    const results = new Map<string, Buffer>();
    const receivingChunks = new Map<string, Buffer[]>();

    const cache = isCacheableBulkImageRequest(options)
      ? await this.openBulkImageCache()
      : null;
    const missingKeys: string[] = [];
    if (cache) {
      await Promise.all(
        keys.map(async (key) => {
          try {
            const cached = await cache.match(
              getBulkImageCacheUrl(key, options),
            );
            if (cached) {
              const data = Buffer.from(await cached.arrayBuffer());
              if (data.length > 0) {
                results.set(key, data);
                return;
              }
            }
          } catch {
            // Treat an unreadable entry as a miss and repair it from the server.
          }
          missingKeys.push(key);
        }),
      );
    } else {
      missingKeys.push(...keys);
    }

    if (missingKeys.length === 0) return results;
    const cacheWrites: Promise<void>[] = [];

    await this.streamItems(
      missingKeys,
      {
        onFileStart: (name) => {
          receivingChunks.set(name, []);
        },
        onFileChunk: (name, chunk) => {
          const chunks = receivingChunks.get(name);
          if (!chunks) {
            throw new Error(`Received chunk before file start: ${name}`);
          }
          chunks.push(Buffer.from(chunk));
        },
        onFileEnd: (name) => {
          const chunks = receivingChunks.get(name);
          if (!chunks) {
            throw new Error(`Received file end before file start: ${name}`);
          }
          const data = Buffer.concat(chunks);
          results.set(name, data);
          receivingChunks.delete(name);
          if (cache && options) {
            cacheWrites.push(
              cache
                .put(
                  getBulkImageCacheUrl(name, options),
                  new Response(data as unknown as BodyInit, {
                    headers: { "content-type": "application/octet-stream" },
                  }),
                )
                .catch(() => undefined),
            );
          }
        },
      },
      onProgress,
      options,
    );

    if (cacheWrites.length > 0) {
      await Promise.all(cacheWrites);
      await this.trimBulkImageCache(cache!);
    }

    return results;
  }

  async streamItems(
    keys: string[],
    handlers: NodeStorageBulkReadHandlers,
    onProgress?: (progress: NodeStorageBulkReadProgress) => void,
    options?: {
      thumbnail?: boolean;
      prefix?: string;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
    },
  ): Promise<void> {
    const filePaths = keys.map((key) =>
      Buffer.from(key, "utf8").toString("hex"),
    );

    const isThumb = options?.thumbnail ?? false;
    const isDisplay = options?.size === "display";
    const params: string[] = [];
    if (isThumb) params.push("thumb=1");
    if (isDisplay) params.push("size=display");
    if (options?.width) params.push(`width=${options.width}`);
    if (options?.height) params.push(`height=${options.height}`);
    const queryStr = params.length > 0 ? `?${params.join("&")}` : "";
    const url = `/api/read-bulk${queryStr}`;

    const response = await this.apiClient.request(url, {
      method: "POST",
      body: JSON.stringify({
        ...(options?.prefix ? { prefix: options.prefix } : { filePaths }),
        thumb: isThumb,
        size: options?.size,
        width: options?.width,
        height: options?.height,
      }),
      cache: "no-cache",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getAuth(),
      },
    });

    if (!response.ok) {
      throw new Error(`getItems Error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("getItems Error: response body is missing");
    }

    const responseTotal = Number.parseInt(
      response.headers.get("x-risu-total-files") ?? "",
      10,
    );
    const totalFiles = Number.isFinite(responseTotal)
      ? responseTotal
      : keys.length;
    const assetListSource =
      response.headers.get("x-risu-asset-list-source") ?? undefined;

    type ReceivingFile = {
      name: string;
      expectedSize: bigint;
      receivedSize: number;
    };

    const reader = response.body.getReader();
    const receivingFiles = new Map<number, ReceivingFile>();
    let completedFiles = 0;

    let pending = Buffer.alloc(0);

    onProgress?.({
      completedFiles,
      totalFiles,
      currentFile: null,
      receivedBytes: 0,
      totalBytes: 0n,
      assetListSource,
    });

    while (true) {
      const { value, done } = await reader.read();

      if (value) {
        pending = Buffer.concat([pending, Buffer.from(value)]);
      }

      let offset = 0;

      while (offset < pending.length) {
        const available = pending.length - offset;

        if (available < 1) break;

        const type = pending.readUInt8(offset);

        if (type === 0x01) {
          // Type(1) + File ID(4) + NameLength(4)
          if (available < 9) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const nameLength = pending.readUInt32BE(offset + 5);
          const packetLength = 1 + 4 + 4 + nameLength + 8;

          if (available < packetLength) break;

          const nameStart = offset + 9;
          const nameEnd = nameStart + nameLength;

          const name = Buffer.from(
            pending.subarray(nameStart, nameEnd),
          ).toString("utf8");

          const expectedSize = readUint64BE(pending, nameEnd);

          receivingFiles.set(fileId, {
            name,
            expectedSize,
            receivedSize: 0,
          });

          await handlers.onFileStart(name, expectedSize);

          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: name,
            receivedBytes: 0,
            totalBytes: expectedSize,
            assetListSource,
          });

          offset += packetLength;
          continue;
        }

        if (type === 0x02) {
          // Type(1) + File ID(4) + ChunkSize(4)
          if (available < 9) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const chunkSize = pending.readUInt32BE(offset + 5);
          const packetLength = 1 + 4 + 4 + chunkSize;

          if (available < packetLength) break;

          const file = receivingFiles.get(fileId);

          if (!file) {
            throw new Error(`Received chunk for unknown file ID: ${fileId}`);
          }

          const chunkStart = offset + 9;
          const chunkEnd = chunkStart + chunkSize;
          const chunk = pending.subarray(chunkStart, chunkEnd);

          file.receivedSize += chunk.length;

          if (BigInt(file.receivedSize) > file.expectedSize) {
            throw new Error(`Received too much data for file: ${file.name}`);
          }

          await handlers.onFileChunk(file.name, chunk);

          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: file.name,
            receivedBytes: file.receivedSize,
            totalBytes: file.expectedSize,
            assetListSource,
          });

          offset += packetLength;
          continue;
        }

        if (type === 0x03) {
          // Type(1) + File ID(4)
          if (available < 5) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const file = receivingFiles.get(fileId);

          if (!file) {
            throw new Error(
              `Received end packet for unknown file ID: ${fileId}`,
            );
          }

          if (BigInt(file.receivedSize) !== file.expectedSize) {
            throw new Error(
              `File size mismatch for ${file.name}: ` +
                `expected ${file.expectedSize}, received ${file.receivedSize}`,
            );
          }

          await handlers.onFileEnd?.(file.name);

          receivingFiles.delete(fileId);
          completedFiles += 1;
          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: null,
            receivedBytes: 0,
            totalBytes: 0n,
            assetListSource,
          });
          offset += 5;
          continue;
        }

        throw new Error(`Unknown bulk packet type: ${type}`);
      }

      pending = Buffer.from(pending.subarray(offset));

      if (done) break;
    }

    if (pending.length !== 0) {
      throw new Error("Bulk response ended with an incomplete packet");
    }

    if (receivingFiles.size !== 0) {
      throw new Error("Bulk response ended before all files were completed");
    }

    if (completedFiles !== totalFiles) {
      throw new Error(
        `Bulk response completed ${completedFiles} of ${totalFiles} files`,
      );
    }
  }
}
