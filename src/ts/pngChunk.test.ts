import { describe, expect, test } from "vitest";
import { PngChunk } from "./pngChunk";

// Minimal valid 1x1 PNG image
const MINIMAL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length (13)
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
  0x00, 0x00, 0x00, 0x0a, // IDAT length (10)
  0x49, 0x44, 0x41, 0x54, // IDAT
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
  0x0d, 0x0a, 0x2d, 0xb4, // IDAT CRC
  0x00, 0x00, 0x00, 0x00, // IEND length (0)
  0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82, // IEND CRC
]);

describe("PngChunk", () => {
  test("writes and reads tEXt chunks correctly with CRC check", async () => {
    const written = (await PngChunk.write(MINIMAL_PNG, {
      chara: "test character data",
      ccv3: "test ccv3 data",
    })) as Buffer;

    expect(written.byteLength).toBeGreaterThan(0);

    const read = PngChunk.read(new Uint8Array(written), ["chara", "ccv3"], {
      checkCrc: true,
    });
    expect(read).toEqual({
      chara: "test character data",
      ccv3: "test ccv3 data",
    });
  });

  test("readGenerator reads tEXt chunks correctly", async () => {
    const written = (await PngChunk.write(MINIMAL_PNG, {
      chara: "character payload",
      author: "baboyeongae",
    })) as Buffer;

    const generator = PngChunk.readGenerator(new Uint8Array(written), {
      checkCrc: true,
    });
    const chunks: Record<string, string> = {};
    for await (const chunk of generator) {
      if (chunk && "key" in chunk) {
        chunks[chunk.key] = chunk.value;
      }
    }

    expect(chunks).toEqual({
      chara: "character payload",
      author: "baboyeongae",
    });
  });

  test("streamWriter correctly appends and filters chunks", async () => {
    const chunksWritten: Uint8Array[] = [];
    const writer = {
      write: async (chunk: Uint8Array) => {
        chunksWritten.push(chunk);
      },
      close: async () => {},
    };

    const streamWriter = new PngChunk.streamWriter(MINIMAL_PNG, writer as any);
    await streamWriter.init();
    await streamWriter.write("chara", "streamed chara");
    await streamWriter.write("custom", "streamed custom");
    await streamWriter.end();

    const result = Buffer.concat(chunksWritten);
    const read = PngChunk.read(new Uint8Array(result), ["chara", "custom"], {
      checkCrc: true,
    });
    expect(read).toEqual({
      chara: "streamed chara",
      custom: "streamed custom",
    });
  });
});
