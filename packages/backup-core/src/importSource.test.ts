import { describe, expect, it } from "vitest";
import {
  createEncodedBackupSource,
  createImportCommit,
  createSequentialFileBackupSource,
  iterateLocalBackupSource,
  streamBackupResponse,
  type EncodedBackupChunkReader,
  type LocalBackupSource,
  type SequentialBackupFileHandle,
} from "./importSource";

function decodeHex(data: string): Uint8Array {
  const bytes: number[] = [];
  for (let offset: number = 0; offset < data.length; offset += 2) {
    bytes.push(Number.parseInt(data.slice(offset, offset + 2), 16));
  }
  return new Uint8Array(bytes);
}

describe("createEncodedBackupSource", (): void => {
  it("pulls bounded chunks and exposes the same bytes through both APIs", async (): Promise<void> => {
    const input: Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);
    const requests: Array<{ offset: number; length: number }> = [];
    const reader: EncodedBackupChunkReader = {
      async readImportChunk(options: {
        id: string;
        offset: number;
        length: number;
      }): Promise<{ data: string; bytesRead: number; eof: boolean }> {
        requests.push({ offset: options.offset, length: options.length });
        const chunk: Uint8Array = input.subarray(
          options.offset,
          options.offset + options.length,
        );
        return {
          data: Array.from(chunk)
            .map((value: number): string => value.toString(16).padStart(2, "0"))
            .join(""),
          bytesRead: chunk.byteLength,
          eof: options.offset + chunk.byteLength >= input.byteLength,
        };
      },
    };
    const source: LocalBackupSource = createEncodedBackupSource(
      reader,
      "import-1",
      input.byteLength,
      { chunkSize: 2, decode: decodeHex },
    );
    const streamed: number[] = [];
    const iterator: AsyncIterator<Uint8Array> =
      iterateLocalBackupSource(source)[Symbol.asyncIterator]();
    while (true) {
      const result: IteratorResult<Uint8Array> = await iterator.next();
      if (result.done) break;
      const chunk: Uint8Array = result.value;
      streamed.push(...chunk);
    }

    expect(streamed).toEqual(Array.from(input));
    expect(requests).toEqual([
      { offset: 0, length: 2 },
      { offset: 2, length: 2 },
      { offset: 4, length: 1 },
    ]);
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(input);
  });

  it("rejects decoded lengths that disagree with chunk metadata", async (): Promise<void> => {
    const reader: EncodedBackupChunkReader = {
      async readImportChunk(): Promise<{
        data: string;
        bytesRead: number;
        eof: boolean;
      }> {
        return { data: "", bytesRead: 1, eof: true };
      },
    };
    const source: LocalBackupSource = createEncodedBackupSource(
      reader,
      "import-2",
      1,
      { chunkSize: 1, decode: decodeHex },
    );

    await expect(source.stream().getReader().read()).rejects.toThrow(
      "incomplete chunk",
    );
  });
});

describe("createSequentialFileBackupSource", (): void => {
  function openBytes(
    input: Uint8Array,
    closed: number[],
  ): () => Promise<SequentialBackupFileHandle> {
    return async (): Promise<SequentialBackupFileHandle> => {
      let offset: number = 0;
      return {
        async read(buffer: Uint8Array): Promise<number | null> {
          if (offset >= input.byteLength) return null;
          const length: number = Math.min(
            buffer.byteLength,
            input.byteLength - offset,
          );
          buffer.set(input.subarray(offset, offset + length));
          offset += length;
          return length;
        },
        async close(): Promise<void> {
          closed.push(1);
        },
      };
    };
  }

  it("streams bounded file chunks and closes its handle", async (): Promise<void> => {
    const input: Uint8Array = new Uint8Array([1, 2, 3, 4, 5]);
    const closed: number[] = [];
    const source: LocalBackupSource = createSequentialFileBackupSource(
      input.byteLength,
      openBytes(input, closed),
      { chunkSize: 2, importerLabel: "Test importer" },
    );
    const reader: ReadableStreamDefaultReader<Uint8Array> = source
      .stream()
      .getReader();
    const chunks: number[][] = [];
    while (true) {
      const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (result.done) break;
      chunks.push(Array.from(result.value));
    }

    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
    expect(closed).toHaveLength(1);
  });

  it("rejects a truncated materialized file and closes its handle", async (): Promise<void> => {
    const closed: number[] = [];
    const source: LocalBackupSource = createSequentialFileBackupSource(
      3,
      openBytes(new Uint8Array([1, 2]), closed),
      { chunkSize: 2, importerLabel: "Test importer" },
    );

    await expect(source.arrayBuffer()).rejects.toThrow(
      "ended before the declared size",
    );
    expect(closed).toHaveLength(1);
  });
});

describe("backup import transport helpers", (): void => {
  it("retries commits until the first success and then becomes a no-op", async (): Promise<void> => {
    let attempts: number = 0;
    const commit: () => Promise<void> = createImportCommit(
      {
        async commitImport(options: { id: string }): Promise<void> {
          expect(options.id).toBe("import-1");
          attempts += 1;
          if (attempts === 1) throw new Error("temporary failure");
        },
      },
      "import-1",
    );

    await expect(commit()).rejects.toThrow("temporary failure");
    await commit();
    await commit();
    expect(attempts).toBe(2);
  });

  it("forwards response chunks without buffering the response", async (): Promise<void> => {
    const written: number[][] = [];
    const response: Response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>): void {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );

    await streamBackupResponse(response, {
      async write(chunk: Uint8Array): Promise<void> {
        written.push(Array.from(chunk));
      },
    });

    expect(written).toEqual([[1, 2], [3]]);
  });
});
