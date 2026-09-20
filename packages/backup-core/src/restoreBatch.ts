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
