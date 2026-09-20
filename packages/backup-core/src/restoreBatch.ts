/**
 * Bounded batching for restored asset payloads.
 *
 * Owns a key→Uint8Array Map without copying payload bytes, tracks the exact
 * byte size (accounting for duplicate-key replacement), and signals when the
 * batch reaches either limit. Designed for memory-constrained devices: only
 * one batch is alive at a time and `drain()` transfers ownership of the Map
 * instead of copying entries.
 */
export class BoundedAssetBatch {
  #maxFiles: number;
  #maxBytes: number;
  #map: Map<string, Uint8Array>;
  #bytes = 0;

  constructor(maxFiles: number, maxBytes: number) {
    if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
      throw new RangeError("maxFiles must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    this.#maxFiles = maxFiles;
    this.#maxBytes = maxBytes;
    this.#map = new Map();
  }

  get size(): number {
    return this.#map.size;
  }

  /** Exact tracked byte size of the pending payloads (no recomputation). */
  get byteSize(): number {
    return this.#bytes;
  }

  get maxFiles(): number {
    return this.#maxFiles;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  /** True once the batch meets either limit (>= maxFiles OR >= maxBytes). */
  get full(): boolean {
    return this.#map.size >= this.#maxFiles || this.#bytes >= this.#maxBytes;
  }

  /**
   * Inserts a payload, accounting for duplicate-key replacement, and
   * returns whether the batch is now full. Zero-length payloads are valid
   * and only count toward the file limit.
   */
  add(key: string, data: Uint8Array): boolean {
    const previous = this.#map.get(key);
    if (previous !== undefined) this.#bytes -= previous.byteLength;
    this.#map.set(key, data);
    this.#bytes += data.byteLength;
    return this.full;
  }

  /**
   * Transfers ownership of the current Map to the caller and resets the
   * batch atomically (count and bytes) so insertion can continue with an
   * empty batch. No payload bytes are copied.
   */
  drain(): Map<string, Uint8Array> {
    const map = this.#map;
    this.#map = new Map();
    this.#bytes = 0;
    return map;
  }

  /** Discards the current batch contents without transferring them. */
  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }
}

export type RestoredAssetBatch = Map<string, Uint8Array>;

export type RestoredAssetBatchWrite = (
  entries: RestoredAssetBatch,
) => Promise<void>;

/**
 * Owns a bounded asset batch and transfers each drained Map to an injected
 * platform writer. The payloads are not copied while moving between batches.
 */
export class BoundedAssetBatchWriter {
  readonly #batch: BoundedAssetBatch;
  readonly #write: RestoredAssetBatchWrite;

  constructor(
    maxFiles: number,
    maxBytes: number,
    write: RestoredAssetBatchWrite,
  ) {
    this.#batch = new BoundedAssetBatch(maxFiles, maxBytes);
    this.#write = write;
  }

  get size(): number {
    return this.#batch.size;
  }

  get byteSize(): number {
    return this.#batch.byteSize;
  }

  async add(key: string, data: Uint8Array): Promise<void> {
    if (this.#batch.add(key, data)) await this.flush();
  }

  async flush(): Promise<number> {
    const count: number = this.#batch.size;
    if (count === 0) return 0;
    const entries: RestoredAssetBatch = this.#batch.drain();
    await this.#write(entries);
    return count;
  }
}

/** Runs a bounded number of asynchronous item writes without copying items. */
export async function writeItemsConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  writeItem: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive safe integer");
  }
  let cursor: number = 0;
  const workerCount: number = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = Array.from(
    { length: workerCount },
    async (): Promise<void> => {
      while (cursor < items.length) {
        const index: number = cursor;
        cursor += 1;
        const item: T = items[index];
        await writeItem(item, index);
      }
    },
  );
  await Promise.all(workers);
}
