import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GENERATION_POINTER_VERSION = 2;
const GENERATION_PREFIX = "__restore_generations/";

type AssetReadResult = {
  exists: boolean;
  buffer?: Uint8Array;
  stream?: AsyncIterable<Uint8Array>;
  filePath?: string;
  contentLength?: number;
  contentType?: string;
};

type UnderlyingWriter = {
  stream: Writable;
  done(): Promise<unknown>;
  abort?(): Promise<void>;
};

type AssetDetails = {
  storageType?: string;
  totalObjects: number;
  totalSizeBytes: number;
  assets: Array<{ key: string; size?: number; mtime?: number }>;
  [key: string]: unknown;
};

export interface GenerationAssetBackend {
  readonly type: string;
  read(hexPath: string): Promise<AssetReadResult>;
  openReadStream?(hexPath: string): Promise<AssetReadResult>;
  readThumbnail?(
    hexPath: string,
    options?: Record<string, unknown>,
  ): Promise<AssetReadResult>;
  write(hexPath: string, content: Uint8Array): Promise<unknown>;
  writeFromPath(hexPath: string, sourcePath: string): Promise<unknown>;
  createWriteStream(
    hexPath: string,
    options?: Record<string, unknown>,
  ): UnderlyingWriter;
  remove(hexPaths: string | string[]): Promise<unknown>;
  list(prefix?: string): Promise<string[]>;
  exists(hexPath: string): Promise<boolean>;
  getAssetDetails(): Promise<AssetDetails>;
  migrateFromLocal?(
    savePath: string,
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>>;
  rollbackToLocal?(
    savePath: string,
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>>;
  generateMissingThumbnails?(
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>>;
}

interface GenerationPointer {
  version: typeof GENERATION_POINTER_VERSION;
  state: "pending" | "committed";
  activeGeneration: string | null;
  previousGeneration: string | null;
  expectedRevision: number | null;
  storageIdentity: string;
  databaseIdentity: string;
}

export interface GenerationEntryWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function validateGenerationId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error("Invalid asset restore generation id");
  }
  return id;
}

function keyToHex(key: string): string {
  return Buffer.from(key, "utf8").toString("hex");
}

function hexToKey(hexPath: string): string {
  return Buffer.from(hexPath, "hex").toString("utf8");
}

function generationPrefix(id: string): string {
  return `${GENERATION_PREFIX}${validateGenerationId(id)}/`;
}

function isHexAssetFilename(value: string): boolean {
  return (
    value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)
  );
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async (): Promise<void> => {
        while (cursor < values.length) {
          const index = cursor++;
          await worker(values[index]);
        }
      },
    ),
  );
}

async function writeJsonAtomic(
  filePath: string,
  value: GenerationPointer,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
    const directory = await fs.open(dirname(filePath), "r").catch(() => null);
    try {
      await directory?.sync().catch(() => {});
    } finally {
      await directory?.close().catch(() => {});
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function parsePointer(value: unknown): GenerationPointer | null {
  const pointer = value as Partial<GenerationPointer> | null;
  if (
    !pointer ||
    pointer.version !== GENERATION_POINTER_VERSION ||
    (pointer.state !== "pending" && pointer.state !== "committed") ||
    !(
      pointer.activeGeneration === null ||
      (typeof pointer.activeGeneration === "string" &&
        /^[A-Za-z0-9_-]{8,128}$/.test(pointer.activeGeneration))
    ) ||
    !(
      pointer.previousGeneration === null ||
      (typeof pointer.previousGeneration === "string" &&
        /^[A-Za-z0-9_-]{8,128}$/.test(pointer.previousGeneration))
    ) ||
    !(
      pointer.expectedRevision === null ||
      (Number.isSafeInteger(pointer.expectedRevision) &&
        Number(pointer.expectedRevision) >= 0)
    ) ||
    typeof pointer.storageIdentity !== "string" ||
    typeof pointer.databaseIdentity !== "string"
  ) {
    return null;
  }
  return pointer as GenerationPointer;
}

export class GenerationAssetStorage {
  private readonly pointerPath: string;
  private pointer: GenerationPointer | null = null;

  constructor(
    rootPath: string,
    private readonly getBackend: () => GenerationAssetBackend,
    private readonly getStorageIdentity: () => string,
  ) {
    this.pointerPath = join(resolve(rootPath), "__asset_generation.json");
    try {
      const raw = JSON.parse(readFileSync(this.pointerPath, "utf8"));
      this.pointer = parsePointer(raw);
    } catch {
      this.pointer = null;
    }
  }

  get type(): string {
    return this.getBackend().type;
  }

  get activeGeneration(): string | null {
    if (this.pointer?.storageIdentity !== this.getStorageIdentity())
      return null;
    return this.pointer?.state === "pending"
      ? this.pointer.previousGeneration
      : (this.pointer?.activeGeneration ?? null);
  }

  private physicalKey(
    logicalKey: string,
    generation = this.activeGeneration,
  ): string {
    return generation
      ? `${generationPrefix(generation)}${logicalKey}`
      : logicalKey;
  }

  private physicalHex(
    hexPath: string,
    generation = this.activeGeneration,
  ): string {
    return keyToHex(this.physicalKey(hexToKey(hexPath), generation));
  }

  private logicalAssetDetails(details: AssetDetails): AssetDetails {
    const prefix = this.activeGeneration
      ? generationPrefix(this.activeGeneration)
      : null;
    const assets = details.assets.flatMap((asset) => {
      if (prefix) {
        if (!asset.key.startsWith(prefix)) return [];
        return [{ ...asset, key: asset.key.slice(prefix.length) }];
      }
      if (
        asset.key.startsWith(GENERATION_PREFIX) ||
        asset.key.startsWith(`thumbnails/${GENERATION_PREFIX}`)
      )
        return [];
      return [asset];
    });
    return {
      ...details,
      totalObjects: assets.length,
      totalSizeBytes: assets.reduce(
        (sum, asset) => sum + (Number(asset.size) || 0),
        0,
      ),
      assets,
    };
  }

  async read(hexPath: string): Promise<AssetReadResult> {
    return await this.getBackend().read(this.physicalHex(hexPath));
  }

  async openReadStream(hexPath: string): Promise<AssetReadResult> {
    const backend = this.getBackend();
    return backend.openReadStream
      ? await backend.openReadStream(this.physicalHex(hexPath))
      : await backend.read(this.physicalHex(hexPath));
  }

  async readThumbnail(
    hexPath: string,
    options?: Record<string, unknown>,
  ): Promise<AssetReadResult> {
    const backend = this.getBackend();
    return backend.readThumbnail
      ? await backend.readThumbnail(this.physicalHex(hexPath), options)
      : await this.openReadStream(hexPath);
  }

  async write(hexPath: string, content: Uint8Array): Promise<unknown> {
    return await this.getBackend().write(this.physicalHex(hexPath), content);
  }

  async writeFromPath(hexPath: string, sourcePath: string): Promise<unknown> {
    return await this.getBackend().writeFromPath(
      this.physicalHex(hexPath),
      sourcePath,
    );
  }

  createWriteStream(
    hexPath: string,
    options?: Record<string, unknown>,
  ): UnderlyingWriter {
    return this.getBackend().createWriteStream(
      this.physicalHex(hexPath),
      options,
    );
  }

  async remove(hexPaths: string | string[]): Promise<unknown> {
    const paths = (Array.isArray(hexPaths) ? hexPaths : [hexPaths]).map(
      (path) => this.physicalHex(path),
    );
    return await this.getBackend().remove(paths);
  }

  async list(prefix = ""): Promise<string[]> {
    const generation = this.activeGeneration;
    const physicalPrefix = generation
      ? `${generationPrefix(generation)}${prefix}`
      : prefix;
    const keys = await this.getBackend().list(physicalPrefix);
    if (!generation) {
      return keys.filter(
        (key) =>
          !key.startsWith(GENERATION_PREFIX) &&
          !key.startsWith(`thumbnails/${GENERATION_PREFIX}`),
      );
    }
    const root = generationPrefix(generation);
    return keys
      .filter((key) => key.startsWith(root))
      .map((key) => key.slice(root.length));
  }

  async exists(hexPath: string): Promise<boolean> {
    return await this.getBackend().exists(this.physicalHex(hexPath));
  }

  async getAssetDetails(): Promise<AssetDetails> {
    return this.logicalAssetDetails(await this.getBackend().getAssetDetails());
  }

  async getStats(): Promise<Record<string, unknown>> {
    const details = await this.getAssetDetails();
    return {
      storageType: this.type,
      totalObjects: details.totalObjects,
      totalSizeBytes: details.totalSizeBytes,
    };
  }

  async migrateFromLocal(
    savePath: string,
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const backend = this.getBackend();
    if (!this.activeGeneration && backend.migrateFromLocal) {
      return await backend.migrateFromLocal(savePath, onProgress);
    }
    const entries = await fs.readdir(savePath).catch(() => [] as string[]);
    const sources = entries.filter((entry) => {
      if (!isHexAssetFilename(entry)) return false;
      const key = hexToKey(entry);
      return (
        !key.startsWith(GENERATION_PREFIX) && !key.startsWith("thumbnails/")
      );
    });
    const existing = new Set(await this.list());
    let migrated = 0;
    let skipped = 0;
    let completed = 0;
    const errors: string[] = [];
    await runBounded(sources, 4, async (hexName) => {
      const key = hexToKey(hexName);
      try {
        if (existing.has(key)) {
          skipped++;
          return;
        }
        const sourcePath = join(savePath, hexName);
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) return;
        const writer = this.createWriteStream(hexName, {
          generateThumbnail: false,
        });
        try {
          await pipeline(createReadStream(sourcePath), writer.stream);
          await writer.done();
          migrated++;
        } catch (error) {
          await writer.abort?.().catch(() => {});
          throw error;
        }
      } catch (error) {
        errors.push(
          `Failed to migrate ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        completed++;
        onProgress?.({
          current: completed,
          total: sources.length,
          migrated,
          skipped,
          percentage:
            sources.length > 0
              ? Math.round((completed / sources.length) * 100)
              : 100,
          currentKey: key,
        });
      }
    });
    return { total: sources.length, migrated, skipped, errors };
  }

  async rollbackToLocal(
    savePath: string,
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const backend = this.getBackend();
    if (!this.activeGeneration && backend.rollbackToLocal) {
      return await backend.rollbackToLocal(savePath, onProgress);
    }
    await fs.mkdir(savePath, { recursive: true });
    const keys = await this.list();
    let downloaded = 0;
    let completed = 0;
    const errors: string[] = [];
    await runBounded(keys, 4, async (key) => {
      try {
        const hexName = keyToHex(key);
        const opened = await this.openReadStream(hexName);
        if (!opened.exists) throw new Error("active asset is missing");
        const outputPath = join(savePath, hexName);
        if (opened.stream) {
          await pipeline(opened.stream, createWriteStream(outputPath));
        } else if (opened.buffer) {
          await fs.writeFile(outputPath, opened.buffer);
        } else {
          throw new Error("asset storage returned no readable body");
        }
        downloaded++;
      } catch (error) {
        errors.push(
          `Failed to rollback ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        completed++;
        onProgress?.({
          current: completed,
          total: keys.length,
          downloaded,
          percentage:
            keys.length > 0 ? Math.round((completed / keys.length) * 100) : 100,
          currentKey: key,
        });
      }
    });
    return { total: keys.length, downloaded, errors };
  }

  async generateMissingThumbnails(
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const backend = this.getBackend();
    if (!this.activeGeneration && backend.generateMissingThumbnails) {
      return await backend.generateMissingThumbnails(onProgress);
    }
    const keys = (await this.list()).filter((key) =>
      /\.(?:png|jpe?g|webp|gif|avif|apng|bmp|svg|ico|tiff?)$/i.test(key),
    );
    let created = 0;
    let completed = 0;
    const errors: string[] = [];
    await runBounded(keys, 2, async (key) => {
      try {
        const result = await this.readThumbnail(keyToHex(key), {
          width: 128,
          height: 128,
        });
        if (!result.exists) throw new Error("asset is missing");
        created++;
      } catch (error) {
        errors.push(
          `Error generating thumbnail for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        completed++;
        onProgress?.({
          type: "progress",
          current: completed,
          total: keys.length,
          created,
          skipped: 0,
          percentage:
            keys.length > 0 ? Math.round((completed / keys.length) * 100) : 100,
          currentKey: key,
        });
      }
    });
    return { total: keys.length, created, skipped: 0, errors };
  }

  async openGenerationWriter(
    id: string,
    logicalKey: string,
    expectedSize: number,
  ): Promise<GenerationEntryWriter> {
    const generation = validateGenerationId(id);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new Error("Asset restore entry size is invalid");
    }
    const writer = this.getBackend().createWriteStream(
      keyToHex(this.physicalKey(logicalKey, generation)),
      { generateThumbnail: false },
    );
    let written = 0;
    let closed = false;
    return {
      async write(chunk: Uint8Array): Promise<void> {
        if (closed) throw new Error("Asset restore writer is already closed");
        written += chunk.byteLength;
        if (written > expectedSize) {
          throw new Error(`Asset restore entry exceeded ${expectedSize} bytes`);
        }
        if (!writer.stream.write(chunk)) await once(writer.stream, "drain");
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (written !== expectedSize) {
          await writer.abort?.().catch(() => {});
          throw new Error(
            `Asset restore entry size mismatch: expected ${expectedSize}, got ${written}`,
          );
        }
        writer.stream.end();
        await writer.done();
      },
      async abort(): Promise<void> {
        if (closed) return;
        closed = true;
        writer.stream.destroy();
        await writer.abort?.().catch(() => {});
      },
    };
  }

  async beginActivation(
    id: string,
    expectedRevision: number,
    databaseIdentity: string,
  ): Promise<void> {
    const generation = validateGenerationId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Asset generation activation revision is invalid");
    }
    if (!databaseIdentity) {
      throw new Error("Asset generation database identity is missing");
    }
    const pointer: GenerationPointer = {
      version: GENERATION_POINTER_VERSION,
      state: "pending",
      activeGeneration: generation,
      previousGeneration: this.activeGeneration,
      expectedRevision,
      storageIdentity: this.getStorageIdentity(),
      databaseIdentity,
    };
    await writeJsonAtomic(this.pointerPath, pointer);
    this.pointer = pointer;
  }

  async commitActivation(
    id: string,
    actualRevision: number,
  ): Promise<string | null> {
    const generation = validateGenerationId(id);
    if (
      this.pointer?.state !== "pending" ||
      this.pointer.activeGeneration !== generation ||
      this.pointer.expectedRevision !== actualRevision
    ) {
      throw new Error(
        "Asset generation activation journal does not match commit",
      );
    }
    const previous = this.pointer.previousGeneration;
    const committed: GenerationPointer = {
      ...this.pointer,
      state: "committed",
      previousGeneration: null,
    };
    this.pointer = committed;
    await writeJsonAtomic(this.pointerPath, committed);
    return previous;
  }

  async rollbackActivation(id: string): Promise<void> {
    const generation = validateGenerationId(id);
    if (
      this.pointer?.state !== "pending" ||
      this.pointer.activeGeneration !== generation
    ) {
      return;
    }
    const rolledBack: GenerationPointer = {
      version: GENERATION_POINTER_VERSION,
      state: "committed",
      activeGeneration: this.pointer.previousGeneration,
      previousGeneration: null,
      expectedRevision: null,
      storageIdentity: this.pointer.storageIdentity,
      databaseIdentity: this.pointer.databaseIdentity,
    };
    await writeJsonAtomic(this.pointerPath, rolledBack);
    this.pointer = rolledBack;
  }

  async reconcile(
    databaseRevision: number | null,
    databaseIdentity: string,
  ): Promise<void> {
    if (this.pointer?.state !== "pending") return;
    if (this.pointer.storageIdentity !== this.getStorageIdentity()) {
      const cleared: GenerationPointer = {
        version: GENERATION_POINTER_VERSION,
        state: "committed",
        activeGeneration: null,
        previousGeneration: null,
        expectedRevision: null,
        storageIdentity: this.getStorageIdentity(),
        databaseIdentity,
      };
      this.pointer = cleared;
      await writeJsonAtomic(this.pointerPath, cleared);
      return;
    }
    if (!Number.isSafeInteger(databaseRevision) || databaseRevision === null) {
      return;
    }
    const pending = this.pointer.activeGeneration;
    if (
      pending &&
      this.pointer.databaseIdentity === databaseIdentity &&
      databaseRevision === this.pointer.expectedRevision
    ) {
      await this.commitActivation(pending, Number(databaseRevision));
      return;
    }
    if (pending) {
      await this.rollbackActivation(pending);
      await this.discardGeneration(pending).catch(() => {});
    }
  }

  async discardGeneration(id: string): Promise<void> {
    const generation = validateGenerationId(id);
    if (this.activeGeneration === generation) return;
    const backend = this.getBackend();
    const prefixes = [
      generationPrefix(generation),
      `thumbnails/${generationPrefix(generation)}`,
    ];
    for (const prefix of prefixes) {
      const keys = await backend.list(prefix);
      for (let offset = 0; offset < keys.length; offset += 500) {
        await backend.remove(keys.slice(offset, offset + 500).map(keyToHex));
      }
    }
  }

  async cleanupInactiveGenerations(): Promise<void> {
    const keys = await this.getBackend().list(GENERATION_PREFIX);
    const generations = new Set<string>();
    for (const key of keys) {
      const remainder = key.slice(GENERATION_PREFIX.length);
      const id = remainder.split("/", 1)[0];
      if (/^[A-Za-z0-9_-]{8,128}$/.test(id)) generations.add(id);
    }
    for (const id of generations) {
      if (id !== this.activeGeneration) await this.discardGeneration(id);
    }
  }

  async cleanupPrevious(previous: string | null): Promise<void> {
    if (previous) {
      await this.discardGeneration(previous);
      return;
    }
    const backend = this.getBackend();
    const legacyKeys = (await backend.list()).filter(
      (key) =>
        !key.startsWith(GENERATION_PREFIX) &&
        !key.startsWith(`thumbnails/${GENERATION_PREFIX}`),
    );
    for (let offset = 0; offset < legacyKeys.length; offset += 500) {
      await backend.remove(
        legacyKeys.slice(offset, offset + 500).map(keyToHex),
      );
    }
  }
}

export { GENERATION_PREFIX, GENERATION_POINTER_VERSION };
