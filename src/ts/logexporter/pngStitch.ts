/**
 * Minimal dependency-free vertical PNG merger.
 *
 * The browser canvas cannot hold images taller than ~16384px — but split
 * capture exists precisely to build exports taller than that, so the merge
 * step must not be a canvas draw. PNG rows are self-describing scanlines:
 * sections are inflated with DecompressionStream, unfiltered row by row and
 * re-deflated straight into one output PNG, keeping memory to a couple of
 * rows plus the compressed streams regardless of total height.
 *
 * Only 8-bit RGB(A) non-interlaced PNGs are accepted — exactly what
 * `canvas.toBlob('image/png')` produces. The media pipeline re-encodes any
 * other input through the canvas first (each section is small enough for
 * that on its own).
 */

export class PngStitchError extends Error {}

// ─── CRC32 (PNG chunk checksums) ─────────────────────────────────────────────

const crcTable = new Uint32Array(256);
{
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    crcTable[n] = c >>> 0;
  }
}

function crc32(bytes: Uint8Array, start: number, length: number): number {
  let c = 0xffffffff;
  for (let i = start; i < start + length; i++)
    c = (crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// ─── Byte helpers ────────────────────────────────────────────────────────────

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  /** IDAT payloads collected in chunk order (zlib streams). */
  idat: Uint8Array[];
}

/** Parses the IHDR header and collects the IDAT payloads of a PNG. */
export function parsePng(bytes: Uint8Array): PngInfo {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i])
      throw new PngStitchError("Not a PNG file");
  }
  let p = 8;
  let info: PngInfo | null = null;
  const idat: Uint8Array[] = [];
  while (p + 12 <= bytes.length) {
    const len = readUint32(bytes, p);
    if (p + 12 + len > bytes.length)
      throw new PngStitchError("Corrupt PNG: chunk overruns file");
    let type = "";
    for (let i = 0; i < 4; i++) type += String.fromCharCode(bytes[p + 4 + i]);
    if (type === "IHDR") {
      info = {
        width: readUint32(bytes, p + 8),
        height: readUint32(bytes, p + 12),
        bitDepth: bytes[p + 16],
        colorType: bytes[p + 17],
        interlace: bytes[p + 20],
        idat,
      };
    } else if (type === "IDAT" && len > 0) {
      idat.push(bytes.subarray(p + 8, p + 8 + len));
    }
    p += 12 + len;
    if (type === "IEND") break;
  }
  if (!info) throw new PngStitchError("PNG has no IHDR chunk");
  if (idat.length === 0) throw new PngStitchError("PNG has no IDAT data");
  return info;
}

// ─── Row unfiltering ─────────────────────────────────────────────────────────

function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 3:
      return 1; // palette indices (lookup must be applied separately)
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new PngStitchError(`Unsupported PNG color type: ${colorType}`);
  }
}

function unfilterRow(
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): Uint8Array {
  const type = cur[0];
  const out = new Uint8Array(cur.length - 1);
  for (let i = 0; i < out.length; i++) {
    const x = cur[i + 1];
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0:
        out[i] = x;
        break;
      case 1:
        out[i] = x + a;
        break;
      case 2:
        out[i] = x + b;
        break;
      case 3:
        out[i] = x + (((a + b) >>> 1) & 0xff);
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out[i] = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default:
        throw new PngStitchError(`Unsupported PNG filter type: ${type}`);
    }
  }
  return out;
}

/** Async generator of unfiltered pixel rows over one PNG's IDAT payloads. */
export async function* unfilteredRows(
  idat: Uint8Array[],
  width: number,
  colorType: number,
): AsyncGenerator<Uint8Array, void, void> {
  const bpp = bytesPerPixel(colorType);
  const stride = 1 + width * bpp;
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Awaiting the pump propagates write/close failures back to the caller.
  const pump = (async () => {
    for (const chunk of idat) {
      // copy into a fresh buffer: write() needs an ArrayBuffer-backed view
      await writer.write(new Uint8Array(chunk));
    }
    await writer.close();
  })();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let prev: Uint8Array | null = null;
  for (;;) {
    while (pending.length >= stride) {
      const raw = unfilterRow(pending.subarray(0, stride), prev, bpp);
      prev = raw;
      yield raw;
      const rest = pending.subarray(stride);
      const next = new Uint8Array(rest.length);
      if (rest.length > 0) next.set(rest);
      pending = next;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    pending = pending.length === 0 ? value : concatBytes(pending, value);
  }
  if (pending.length !== 0)
    throw new PngStitchError("Corrupt PNG: incomplete scanline data");
}

// ─── Vertical merge ──────────────────────────────────────────────────────────

export interface StitchedPng {
  blob: Blob;
  width: number;
  height: number;
}

function ihdrData(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
): Uint8Array {
  const data = new Uint8Array(13);
  writeUint32(data, 0, width);
  writeUint32(data, 4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return data;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC covers the type field + data
  const crcBytes = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcBytes[i] = out[4 + i];
  crcBytes.set(data, 4);
  writeUint32(out, 8 + data.length, crc32(crcBytes, 0, crcBytes.length));
  return out;
}

/**
 * Merges equal-width 8-bit RGB(A) PNG blobs into one vertically stacked PNG
 * without a Canvas. Output rows are re-filtered as Filter 0 (None), which
 * deflate handles fine for UI-style screenshots.
 */
export async function mergePngBlobsVertically(
  blobs: Blob[],
): Promise<StitchedPng> {
  if (blobs.length === 0) throw new PngStitchError("No images to merge");

  let width = 0;
  let colorType = -1;
  let totalHeight = 0;
  const sections: PngInfo[] = [];
  for (const blob of blobs) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = parsePng(bytes);
    if (info.width <= 0 || info.height <= 0)
      throw new PngStitchError("Invalid PNG dimensions");
    if (width === 0) {
      width = info.width;
      colorType = info.colorType;
    } else if (info.width !== width) {
      throw new PngStitchError(
        `Section width mismatch: expected ${width}px, found ${info.width}px`,
      );
    } else if (info.colorType !== colorType) {
      throw new PngStitchError(
        `Section color type mismatch: expected ${colorType}, found ${info.colorType}`,
      );
    }
    sections.push(info);
    totalHeight += info.height;
  }

  // CompressionStream ('deflate' = zlib-wrapped) — never DecompressionStream:
  // emitting raw scanlines into the IDAT would produce an invalid zlib stream.
  const ds = new CompressionStream("deflate");
  const compressWriter = ds.writable.getWriter();
  const compressReader = ds.readable.getReader();
  const idatParts: Uint8Array[] = [];
  // MUST be awaited before assembling the output: close() resolving only
  // means the writer flushed, not that the reader consumed everything —
  // otherwise the produced PNG can end up with truncated IDAT data.
  const collectIdat = (async () => {
    for (;;) {
      const { done, value } = await compressReader.read();
      if (done) break;
      if (value && value.length > 0) idatParts.push(new Uint8Array(value));
    }
  })();

  // Rows are written with Filter 0; sections concatenate cleanly because the
  // raw pixels (not the filtered bytes) are what get re-encoded.
  let wroteAnyRow = false;
  for (const section of sections) {
    for await (const raw of unfilteredRows(
      section.idat,
      width,
      section.colorType,
    )) {
      const frame = new Uint8Array(raw.length + 1);
      frame[0] = 0; // filter type: None
      frame.set(raw, 1);
      await compressWriter.write(frame);
      wroteAnyRow = true;
    }
  }
  await compressWriter.close();
  await collectIdat;
  if (!wroteAnyRow) throw new PngStitchError("No pixel rows decoded");

  // Assemble: signature + IHDR + IDATs + IEND.
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
  parts.push(makeChunk("IHDR", ihdrData(width, totalHeight, 8, colorType)));
  for (const part of idatParts) {
    if (part.length === 0) continue;
    parts.push(makeChunk("IDAT", part));
  }
  if (idatParts.length === 0)
    throw new PngStitchError("PNG compression produced no data");
  parts.push(makeChunk("IEND", new Uint8Array(0)));
  const blob = new Blob(parts as unknown as BlobPart[], { type: "image/png" });
  return { blob, width, height: totalHeight };
}
