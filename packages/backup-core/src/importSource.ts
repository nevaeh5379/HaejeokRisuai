export interface LocalBackupSource {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface EncodedBackupChunk {
  data: string;
  bytesRead: number;
  eof: boolean;
}

export interface EncodedBackupChunkReader {
  readImportChunk(options: {
    id: string;
    offset: number;
    length: number;
  }): Promise<EncodedBackupChunk>;
}

export interface EncodedBackupSourceOptions {
  chunkSize: number;
  decode(data: string): Uint8Array;
  importerLabel?: string;
}

export interface SequentialBackupFileHandle {
  read(buffer: Uint8Array): Promise<number | null>;
  close(): Promise<void>;
}

export interface SequentialBackupSourceOptions {
  chunkSize: number;
  importerLabel?: string;
}

interface DecodedBackupChunk extends EncodedBackupChunk {
  decoded: Uint8Array;
}

export async function* iterateLocalBackupSource(
  source: LocalBackupSource,
): AsyncGenerator<Uint8Array> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = source
    .stream()
    .getReader();
  try {
    while (true) {
      const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Exposes an encoded random-access import as a pull-based backup source.
 * Only one decoded chunk is retained while streaming; `arrayBuffer()` is the
 * explicit compatibility fallback that materializes the declared file size.
 */
export function createEncodedBackupSource(
  reader: EncodedBackupChunkReader,
  id: string,
  size: number,
  options: EncodedBackupSourceOptions,
): LocalBackupSource {
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new RangeError("Backup import chunk size must be a positive integer");
  }
  const normalizedSize: number = Math.max(0, Math.floor(size));
  const importerLabel: string = options.importerLabel ?? "Backup importer";

  const readChunk = async (offset: number): Promise<DecodedBackupChunk> => {
    const requested: number = Math.min(
      options.chunkSize,
      normalizedSize - offset,
    );
    const chunk: EncodedBackupChunk = await reader.readImportChunk({
      id,
      offset,
      length: requested,
    });
    if (chunk.bytesRead < 0 || chunk.bytesRead > requested) {
      throw new Error(`${importerLabel} returned an invalid chunk size`);
    }
    if (chunk.bytesRead === 0 && !chunk.eof) {
      throw new Error(`${importerLabel} stopped before reaching the end`);
    }
    const decoded: Uint8Array = chunk.data
      ? options.decode(chunk.data)
      : new Uint8Array();
    if (decoded.byteLength !== chunk.bytesRead) {
      throw new Error(`${importerLabel} returned an incomplete chunk`);
    }
    return { ...chunk, decoded };
  };

  return {
    size: normalizedSize,
    stream(): ReadableStream<Uint8Array> {
      let offset: number = 0;
      return new ReadableStream<Uint8Array>({
        async pull(
          controller: ReadableStreamDefaultController<Uint8Array>,
        ): Promise<void> {
          if (offset >= normalizedSize) {
            controller.close();
            return;
          }
          try {
            const chunk: DecodedBackupChunk = await readChunk(offset);
            offset += chunk.bytesRead;
            if (chunk.decoded.byteLength > 0) {
              controller.enqueue(chunk.decoded);
            }
            if (chunk.eof || offset >= normalizedSize) controller.close();
          } catch (error: unknown) {
            controller.error(error);
          }
        },
      });
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const output: Uint8Array<ArrayBuffer> = new Uint8Array(normalizedSize);
      let offset: number = 0;
      while (offset < normalizedSize) {
        const chunk: DecodedBackupChunk = await readChunk(offset);
        output.set(chunk.decoded, offset);
        offset += chunk.bytesRead;
        if (chunk.eof) break;
      }
      if (offset !== normalizedSize) {
        throw new Error(`${importerLabel} ended before the declared size`);
      }
      return output.buffer;
    },
  };
}

/**
 * Adapts a reopenable sequential file handle to a backup source. Stream reads
 * retain only one chunk; the compatibility `arrayBuffer()` path allocates the
 * declared size and rejects truncated files.
 */
export function createSequentialFileBackupSource(
  size: number,
  open: () => Promise<SequentialBackupFileHandle>,
  options: SequentialBackupSourceOptions,
): LocalBackupSource {
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new RangeError("Backup import chunk size must be a positive integer");
  }
  const normalizedSize: number = Math.max(0, Math.floor(size));
  const importerLabel: string = options.importerLabel ?? "Backup importer";

  return {
    size: normalizedSize,
    stream(): ReadableStream<Uint8Array> {
      const handlePromise: Promise<SequentialBackupFileHandle> = open();
      let closed: boolean = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          const handle: SequentialBackupFileHandle = await handlePromise;
          await handle.close();
        } catch {}
      };
      return new ReadableStream<Uint8Array>({
        async pull(
          controller: ReadableStreamDefaultController<Uint8Array>,
        ): Promise<void> {
          try {
            const handle: SequentialBackupFileHandle = await handlePromise;
            const buffer: Uint8Array = new Uint8Array(options.chunkSize);
            const bytesRead: number | null = await handle.read(buffer);
            if (bytesRead === null) {
              await close();
              controller.close();
              return;
            }
            if (bytesRead <= 0 || bytesRead > buffer.byteLength) {
              throw new Error(`${importerLabel} stopped before EOF`);
            }
            controller.enqueue(buffer.subarray(0, bytesRead));
          } catch (error: unknown) {
            await close();
            controller.error(error);
          }
        },
        async cancel(): Promise<void> {
          await close();
        },
      });
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const output: Uint8Array<ArrayBuffer> = new Uint8Array(normalizedSize);
      const handle: SequentialBackupFileHandle = await open();
      let offset: number = 0;
      try {
        while (offset < normalizedSize) {
          const target: Uint8Array = output.subarray(
            offset,
            Math.min(normalizedSize, offset + options.chunkSize),
          );
          const bytesRead: number | null = await handle.read(target);
          if (bytesRead === null) break;
          if (bytesRead <= 0 || bytesRead > target.byteLength) {
            throw new Error(`${importerLabel} stopped before EOF`);
          }
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      if (offset !== normalizedSize) {
        throw new Error(`${importerLabel} ended before the declared size`);
      }
      return output.buffer;
    },
  };
}
