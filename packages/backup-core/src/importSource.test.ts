import { describe, expect, it } from "vitest";
import {
  createEncodedBackupSource,
  iterateLocalBackupSource,
  type EncodedBackupChunkReader,
  type LocalBackupSource,
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
