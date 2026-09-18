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
    this.maxNameBytes = options.maxNameBytes ?? 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 0xffffffff;
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
