import {
  classifyBackupEntry,
  normalizeBackupEntryName,
  type BackupEntryClassification,
} from "./entryPolicy";

export const BACKUP_CONTAINER_MAX_NAME_BYTES = 1024 * 1024;
export const BACKUP_CONTAINER_MAX_ENTRY_BYTES = 0xffffffff;

export class BackupContainerEntryHeaderError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_name" | "invalid_size",
  ) {
    super(message);
    this.name = "BackupContainerEntryHeaderError";
  }
}

export function createBackupContainerEntryHeader(
  name: string,
  size: number | bigint,
): Uint8Array {
  const normalizedName = normalizeBackupEntryName(name);
  if (!normalizedName) {
    throw new BackupContainerEntryHeaderError(
      `Invalid backup entry path: ${name}`,
      "invalid_name",
    );
  }

  const encodedName = new TextEncoder().encode(normalizedName);
  if (
    encodedName.byteLength === 0 ||
    encodedName.byteLength > BACKUP_CONTAINER_MAX_NAME_BYTES
  ) {
    throw new BackupContainerEntryHeaderError(
      `Invalid backup entry path: ${name}`,
      "invalid_name",
    );
  }

  if (
    (typeof size === "number" && !Number.isSafeInteger(size)) ||
    (typeof size === "bigint" && size < 0n)
  ) {
    throw new BackupContainerEntryHeaderError(
      `Backup entry is too large: ${name}`,
      "invalid_size",
    );
  }
  const normalizedSize = typeof size === "bigint" ? size : BigInt(size);
  if (
    normalizedSize < 0n ||
    normalizedSize > BigInt(BACKUP_CONTAINER_MAX_ENTRY_BYTES)
  ) {
    throw new BackupContainerEntryHeaderError(
      `Backup entry is too large: ${name}`,
      "invalid_size",
    );
  }

  const header = new Uint8Array(8 + encodedName.byteLength);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, encodedName.byteLength, true);
  header.set(encodedName, 4);
  view.setUint32(4 + encodedName.byteLength, Number(normalizedSize), true);
  return header;
}

export interface BackupContainerEntryInfo {
  name: string;
  size: number;
}

export interface BackupContainerParserHandlers {
  onEntryStart?(entry: BackupContainerEntryInfo): Promise<void> | void;
  onEntryChunk?(
    entry: BackupContainerEntryInfo,
    chunk: Uint8Array,
    offset: number,
  ): Promise<void> | void;
  onEntryEnd?(entry: BackupContainerEntryInfo): Promise<void> | void;
}

export interface BackupContainerParserOptions {
  maxNameBytes?: number;
  maxEntryBytes?: number;
}

type ParserPhase = "nameLength" | "name" | "dataLength" | "data";

export class BackupContainerParser {
  private readonly decoder = new TextDecoder();
  private readonly maxNameBytes: number;
  private readonly maxEntryBytes: number;
  private phase: ParserPhase = "nameLength";
  private readonly lengthBuffer = new Uint8Array(4);
  private lengthOffset = 0;
  private nameBuffer = new Uint8Array();
  private nameOffset = 0;
  private entryName = "";
  private entrySize = 0;
  private entryOffset = 0;
  private currentEntry: BackupContainerEntryInfo | null = null;

  constructor(
    private readonly handlers: BackupContainerParserHandlers,
    options: BackupContainerParserOptions = {},
  ) {
    this.maxNameBytes =
      options.maxNameBytes ?? BACKUP_CONTAINER_MAX_NAME_BYTES;
    this.maxEntryBytes =
      options.maxEntryBytes ?? BACKUP_CONTAINER_MAX_ENTRY_BYTES;
  }

  async write(chunk: Uint8Array): Promise<void> {
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      if (this.phase === "nameLength" || this.phase === "dataLength") {
        const copyLength = Math.min(
          4 - this.lengthOffset,
          chunk.length - chunkOffset,
        );
        this.lengthBuffer.set(
          chunk.subarray(chunkOffset, chunkOffset + copyLength),
          this.lengthOffset,
        );
        this.lengthOffset += copyLength;
        chunkOffset += copyLength;
        if (this.lengthOffset < 4) continue;

        const length = new DataView(
          this.lengthBuffer.buffer,
          this.lengthBuffer.byteOffset,
          4,
        ).getUint32(0, true);
        this.lengthOffset = 0;

        if (this.phase === "nameLength") {
          if (length === 0 || length > this.maxNameBytes) {
            throw new Error("Invalid backup entry name length");
          }
          this.nameBuffer = new Uint8Array(length);
          this.nameOffset = 0;
          this.phase = "name";
        } else {
          if (length > this.maxEntryBytes) {
            throw new Error("Backup entry exceeds configured size limit");
          }
          this.entrySize = length;
          this.entryOffset = 0;
          this.currentEntry = { name: this.entryName, size: length };
          await this.handlers.onEntryStart?.(this.currentEntry);
          this.phase = "data";

          if (length === 0) {
            await this.handlers.onEntryEnd?.(this.currentEntry);
            this.resetEntry();
          }
        }
        continue;
      }

      if (this.phase === "name") {
        const copyLength = Math.min(
          this.nameBuffer.length - this.nameOffset,
          chunk.length - chunkOffset,
        );
        this.nameBuffer.set(
          chunk.subarray(chunkOffset, chunkOffset + copyLength),
          this.nameOffset,
        );
        this.nameOffset += copyLength;
        chunkOffset += copyLength;
        if (this.nameOffset === this.nameBuffer.length) {
          this.entryName = this.decoder.decode(this.nameBuffer);
          this.phase = "dataLength";
        }
        continue;
      }

      const entry = this.currentEntry;
      if (!entry) throw new Error("Backup parser lost current entry state");
      const copyLength = Math.min(
        this.entrySize - this.entryOffset,
        chunk.length - chunkOffset,
      );
      const entryChunk = chunk.subarray(
        chunkOffset,
        chunkOffset + copyLength,
      );
      await this.handlers.onEntryChunk?.(
        entry,
        entryChunk,
        this.entryOffset,
      );
      this.entryOffset += copyLength;
      chunkOffset += copyLength;

      if (this.entryOffset === this.entrySize) {
        await this.handlers.onEntryEnd?.(entry);
        this.resetEntry();
      }
    }
  }

  finish(): void {
    if (this.phase !== "nameLength" || this.lengthOffset !== 0) {
      throw new Error("Backup file ended with an incomplete entry");
    }
  }

  private resetEntry(): void {
    this.phase = "nameLength";
    this.entryName = "";
    this.entrySize = 0;
    this.entryOffset = 0;
    this.currentEntry = null;
  }
}

export async function parseBackupContainer(
  chunks: AsyncIterable<Uint8Array>,
  handlers: BackupContainerParserHandlers,
  options?: BackupContainerParserOptions,
): Promise<void> {
  const parser = new BackupContainerParser(handlers, options);
  for await (const chunk of chunks) {
    await parser.write(chunk);
  }
  parser.finish();
}

export interface BufferedBackupContainerHandlers {
  onEntry(
    entry: BackupContainerEntryInfo,
    data: Uint8Array,
    classification: BackupEntryClassification,
  ): Promise<void> | void;
  onEntryStart?(
    entry: BackupContainerEntryInfo,
    classification: BackupEntryClassification,
  ): Promise<void> | void;
  onEntryEnd?(
    entry: BackupContainerEntryInfo,
    classification: BackupEntryClassification,
  ): Promise<void> | void;
  onExtensionEntry?(
    entry: BackupContainerEntryInfo,
    classification: BackupEntryClassification,
  ): Promise<void> | void;
  onChunk?(chunk: Uint8Array, totalBytesRead: number): Promise<void> | void;
}

export interface BufferedBackupContainerResult {
  bytesRead: number;
  entriesHandled: number;
  ignoredExtensionEntries: number;
}

/**
 * Parses a backup container and materializes at most one supported entry at a
 * time. Entry names are classified centrally; invalid paths abort parsing and
 * unsupported extension entries are consumed without allocating their
 * payload. Hosts keep platform I/O and progress reporting in callbacks.
 */
export async function parseBufferedBackupContainer(
  chunks: AsyncIterable<Uint8Array>,
  handlers: BufferedBackupContainerHandlers,
  options: BackupContainerParserOptions = {},
): Promise<BufferedBackupContainerResult> {
  let currentClassification: BackupEntryClassification | null = null;
  let currentData: Uint8Array | null = null;
  let bytesRead: number = 0;
  let entriesHandled: number = 0;
  let ignoredExtensionEntries: number = 0;

  const parser: BackupContainerParser = new BackupContainerParser(
    {
      async onEntryStart(entry: BackupContainerEntryInfo): Promise<void> {
        const classification: BackupEntryClassification = classifyBackupEntry(
          entry.name,
        );
        if (classification.kind === "invalid") {
          throw new Error(`Invalid backup entry path: ${entry.name}`);
        }
        currentClassification = classification;
        currentData =
          classification.kind === "extension"
            ? null
            : new Uint8Array(entry.size);
        await handlers.onEntryStart?.(entry, classification);
      },
      onEntryChunk(
        _entry: BackupContainerEntryInfo,
        chunk: Uint8Array,
        offset: number,
      ): void {
        currentData?.set(chunk, offset);
      },
      async onEntryEnd(entry: BackupContainerEntryInfo): Promise<void> {
        const classification: BackupEntryClassification | null =
          currentClassification;
        const data: Uint8Array | null = currentData;
        currentClassification = null;
        currentData = null;
        if (!classification) {
          throw new Error(`Backup entry ${entry.name} was not initialized`);
        }

        try {
          if (classification.kind === "extension") {
            ignoredExtensionEntries += 1;
            await handlers.onExtensionEntry?.(entry, classification);
            return;
          }
          if (!data) {
            throw new Error(`Backup entry ${entry.name} has no payload`);
          }
          await handlers.onEntry(entry, data, classification);
          entriesHandled += 1;
        } finally {
          await handlers.onEntryEnd?.(entry, classification);
        }
      },
    },
    options,
  );

  const chunkIterator: AsyncIterator<Uint8Array> =
    chunks[Symbol.asyncIterator]();
  let chunksExhausted: boolean = false;
  try {
    while (true) {
      const nextChunk: IteratorResult<Uint8Array> = await chunkIterator.next();
      if (nextChunk.done) {
        chunksExhausted = true;
        break;
      }
      const chunk: Uint8Array = nextChunk.value;
      bytesRead += chunk.byteLength;
      await handlers.onChunk?.(chunk, bytesRead);
      await parser.write(chunk);
    }
  } finally {
    if (!chunksExhausted) {
      await chunkIterator.return?.();
    }
  }
  parser.finish();
  return { bytesRead, entriesHandled, ignoredExtensionEntries };
}
