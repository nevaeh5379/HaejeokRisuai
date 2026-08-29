import { beforeAll, describe, expect, it } from "vitest";
import {
  mergePngBlobsVertically,
  parsePng,
  PngStitchError,
  unfilteredRows,
} from "./pngStitch";

// happy-dom does not ship the Web Streams APIs; vitest runs on Node, whose
// node:stream/web implementation is spec-compliant for 'deflate'.
beforeAll(async () => {
  if (typeof (globalThis as any).CompressionStream !== "function") {
    const streams = await import("node:stream/web");
    (globalThis as any).CompressionStream = streams.CompressionStream;
    (globalThis as any).DecompressionStream = streams.DecompressionStream;
  }
});

// ─── Test-local PNG fixture builder ──────────────────────────────────────────

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++)
    c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = (crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function be32(values: number[]): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = (values[i] >>> (24 - 8 * i)) & 0xff;
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const chunks: Uint8Array[] = [];
  for await (const chunk of cs.readable) chunks.push(chunk);
  const total = chunks.reduce((a: number, c: Uint8Array) => a + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(
    be32([
      data.length >>> 24,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
    ]),
    0,
  );
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crcBody = new Uint8Array(4 + data.length);
  crcBody.set(out.subarray(4, 8 + data.length), 0);
  out.set(
    be32([
      crc32(crcBody) >>> 24,
      (crc32(crcBody) >>> 16) & 0xff,
      (crc32(crcBody) >>> 8) & 0xff,
      crc32(crcBody) & 0xff,
    ]),
    8 + data.length,
  );
  return out;
}

/** Applies a PNG row filter to raw pixel bytes. (Test-side inverse of decoding.) */
function filterRow(
  raw: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  type: number,
): Uint8Array {
  const cur = new Uint8Array(raw.length + 1);
  cur[0] = type;
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0:
        cur[i + 1] = raw[i];
        break;
      case 1:
        cur[i + 1] = raw[i] - a;
        break;
      case 2:
        cur[i + 1] = raw[i] - b;
        break;
      case 3:
        cur[i + 1] = raw[i] - (((a + b) >>> 1) & 0xff);
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i + 1] = raw[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
    }
  }
  return cur;
}

interface PngFixture {
  width: number;
  colorType: 2 | 6;
  /** Raw pixel rows (each width * bpp long). */
  rawRows: Uint8Array[];
  /** Filter type per row (cycles when shorter). */
  filters: number[];
}

async function fixtureToBlob(fixture: PngFixture): Promise<Blob> {
  const bpp = fixture.colorType === 6 ? 4 : 3;
  let scanlines = new Uint8Array(0);
  let prev: Uint8Array | null = null;
  fixture.rawRows.forEach((raw, i) => {
    const filtered = filterRow(
      raw,
      prev,
      bpp,
      fixture.filters[i % fixture.filters.length],
    );
    scanlines = new Uint8Array([...scanlines, ...filtered]);
    prev = raw;
  });
  const ihdr = new Uint8Array(13);
  ihdr.set(
    be32([
      fixture.width >>> 24,
      (fixture.width >>> 16) & 0xff,
      (fixture.width >>> 8) & 0xff,
      fixture.width & 0xff,
    ]),
    0,
  );
  ihdr.set(
    be32([
      fixture.rawRows.length >>> 24,
      (fixture.rawRows.length >>> 16) & 0xff,
      (fixture.rawRows.length >>> 8) & 0xff,
      fixture.rawRows.length & 0xff,
    ]),
    4,
  );
  ihdr[8] = 8; // bit depth
  ihdr[9] = fixture.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // non-interlaced
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", await deflate(scanlines));
  const iend = chunk("IEND", new Uint8Array(0));
  const total = sig.length + ihdrChunk.length + idatChunk.length + iend.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of [sig, ihdrChunk, idatChunk, iend]) {
    out.set(part, offset);
    offset += part.length;
  }
  return new Blob([out], { type: "image/png" });
}

async function decodeFixture(blob: Blob): Promise<{
  width: number;
  height: number;
  colorType: number;
  rows: number[][];
}> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = parsePng(bytes);
  const rows: number[][] = [];
  for await (const raw of unfilteredRows(
    info.idat,
    info.width,
    info.colorType,
  )) {
    rows.push(Array.from(raw));
  }
  return {
    width: info.width,
    height: info.height,
    colorType: info.colorType,
    rows,
  };
}

// ─── Cases ───────────────────────────────────────────────────────────────────

describe("pngStitch", () => {
  it("merges 8-bit RGBA sections with mixed row filters", async () => {
    // section A: 3x2, filters Sub + Paeth
    const rawA0 = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
    const rawA1 = [10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 200];
    const A: PngFixture = {
      width: 3,
      colorType: 6,
      rawRows: [new Uint8Array(rawA0), new Uint8Array(rawA1)],
      filters: [1, 4],
    };
    // section B: 3x3, runs through every remaining filter
    const rawB0 = [0, 0, 0, 128, 0, 0, 0, 128, 0, 0, 0, 128];
    const rawB1 = [5, 5, 5, 255, 5, 5, 5, 255, 5, 5, 5, 255];
    const rawB2 = [90, 90, 90, 255, 40, 40, 40, 255, 4, 8, 15, 16];
    const B: PngFixture = {
      width: 3,
      colorType: 6,
      rawRows: [
        new Uint8Array(rawB0),
        new Uint8Array(rawB1),
        new Uint8Array(rawB2),
      ],
      filters: [2, 3, 2],
    };

    const merged = await mergePngBlobsVertically([
      await fixtureToBlob(A),
      await fixtureToBlob(B),
    ]);
    expect(merged.width).toBe(3);
    expect(merged.height).toBe(5);

    const decoded = await decodeFixture(merged.blob);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(5);
    expect(decoded.colorType).toBe(6);
    expect(decoded.rows).toEqual([rawA0, rawA1, rawB0, rawB1, rawB2]);
  });

  it("merges 8-bit RGB sections", async () => {
    const raw0 = [200, 100, 50, 0, 20, 40];
    const raw1 = [1, 2, 3, 4, 5, 6];
    const fixture: PngFixture = {
      width: 2,
      colorType: 2,
      rawRows: [new Uint8Array(raw0), new Uint8Array(raw1)],
      filters: [3, 0],
    };
    const merged = await mergePngBlobsVertically([
      await fixtureToBlob(fixture),
    ]);
    const decoded = await decodeFixture(merged.blob);
    expect(decoded.height).toBe(2);
    expect(decoded.colorType).toBe(2);
    expect(decoded.rows).toEqual([raw0, raw1]);
  });

  it("rejects width mismatches", async () => {
    const a = await fixtureToBlob({
      width: 3,
      colorType: 6,
      rawRows: [new Uint8Array(12)],
      filters: [0],
    });
    const b = await fixtureToBlob({
      width: 4,
      colorType: 6,
      rawRows: [new Uint8Array(16)],
      filters: [0],
    });
    await expect(mergePngBlobsVertically([a, b])).rejects.toThrow(
      PngStitchError,
    );
  });

  it("rejects color type mismatches", async () => {
    const a = await fixtureToBlob({
      width: 2,
      colorType: 6,
      rawRows: [new Uint8Array(8)],
      filters: [0],
    });
    const b = await fixtureToBlob({
      width: 2,
      colorType: 2,
      rawRows: [new Uint8Array(6)],
      filters: [0],
    });
    await expect(mergePngBlobsVertically([a, b])).rejects.toThrow(
      PngStitchError,
    );
  });

  it("rejects non-PNG payloads", async () => {
    await expect(
      mergePngBlobsVertically([
        new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      ]),
    ).rejects.toThrow(PngStitchError);
  });

  it("exposes decoded rows through the parse helper", async () => {
    const fixture: PngFixture = {
      width: 2,
      colorType: 6,
      rawRows: [new Uint8Array([9, 9, 9, 255, 8, 8, 8, 255])],
      filters: [0],
    };
    const blob = await fixtureToBlob(fixture);
    const info = parsePng(new Uint8Array(await blob.arrayBuffer()));
    expect(info.width).toBe(2);
    expect(info.height).toBe(1);
    expect(info.bitDepth).toBe(8);
    expect(info.interlace).toBe(0);
    const first = await unfilteredRows(
      info.idat,
      info.width,
      info.colorType,
    ).next();
    expect(first.done).toBe(false);
    expect(Array.from(first.value as Uint8Array)).toEqual([
      9, 9, 9, 255, 8, 8, 8, 255,
    ]);
  });
});
