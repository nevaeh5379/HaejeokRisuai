import { once } from "events";

const UINT16_MAX: any = 0xffff;
const UINT32_MAX: any = 0xffffffffn;
const ZIP64_EXTRA_ID: any = 0x0001;
const UTF8_DATA_DESCRIPTOR_FLAGS: any = 0x0808;
const STORE_METHOD: any = 0;
const ZIP64_VERSION: any = 45;

const crcTable: any = new Uint32Array(256);
for (let index: any = 0; index < 256; index++) {
  let value: any = index;
  for (let bit: any = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc32(crc?: any, chunk?: any): any {
  let value: any = crc;
  for (let index: any = 0; index < chunk.length; index++) {
    value = crcTable[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function getDosDateTime(date: any = new Date()): any {
  const year: any = Math.max(1980, Math.min(2107, date.getFullYear()));
  const time: any =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day: any = Math.max(1, date.getDate());
  const dosDate: any =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | day;
  return { time, date: dosDate };
}

function createZip64Extra(values?: any): any {
  if (values.length === 0) return Buffer.alloc(0);
  const extra: any = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  for (let index: any = 0; index < values.length; index++) {
    extra.writeBigUInt64LE(values[index], 4 + index * 8);
  }
  return extra;
}

async function writeWithBackpressure(output?: any, chunk?: any): Promise<any> {
  if (output.destroyed || output.writableEnded) {
    throw new Error("ZIP output was closed");
  }
  if (!output.write(chunk)) {
    await once(output, "drain");
  }
}

function asAsyncIterable(source?: any): any {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return (async function* (): AsyncGenerator<any> {
      yield Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    })();
  }
  if (source && typeof source[Symbol.asyncIterator] === "function")
    return source;
  throw new Error("ZIP entry source is not streamable");
}

/**
 * Streams an uncompressed ZIP/ZIP64 archive to a writable response.
 * Only central-directory metadata is retained; entry bodies are never buffered.
 */
async function streamZip(
  output?: any,
  entries?: any,
  options: any = {},
): Promise<any> {
  let offset: any = BigInt(options.initialOffset ?? 0);
  const centralEntries: any = [];

  const write: any = async (chunk?: any) => {
    await writeWithBackpressure(output, chunk);
    offset += BigInt(chunk.length);
  };

  for (const entry of entries) {
    const name: any = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > UINT16_MAX) {
      throw new Error(`Invalid ZIP entry name length: ${entry.name}`);
    }
    let opened: any;
    if (entry.size === undefined && typeof entry.open === "function") {
      opened = await entry.open();
    }
    const expectedSize: any = BigInt(entry.size ?? opened?.size);
    if (expectedSize < 0n)
      throw new Error(`Invalid ZIP entry size: ${entry.name}`);

    const entryOffset: any = offset;
    const usesZip64Size: any = expectedSize > UINT32_MAX;
    const localExtra: any = usesZip64Size
      ? createZip64Extra([expectedSize, expectedSize])
      : Buffer.alloc(0);
    const { time, date } = getDosDateTime(entry.mtime);
    const localHeader: any = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(usesZip64Size ? ZIP64_VERSION : 20, 4);
    localHeader.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(
      usesZip64Size ? Number(UINT32_MAX) : Number(expectedSize),
      18,
    );
    localHeader.writeUInt32LE(
      usesZip64Size ? Number(UINT32_MAX) : Number(expectedSize),
      22,
    );
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    await write(localHeader);
    await write(name);
    if (localExtra.length) await write(localExtra);

    let crc: any = 0xffffffff;
    let actualSize: any = 0n;
    const source: any =
      opened?.source ??
      opened?.stream ??
      (typeof entry.open === "function" ? await entry.open() : entry.source);
    for await (const value of asAsyncIterable(source)) {
      const chunk: any = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      crc = updateCrc32(crc, chunk);
      actualSize += BigInt(chunk.length);
      if (actualSize > expectedSize) {
        throw new Error(`ZIP entry exceeded declared size: ${entry.name}`);
      }
      await write(chunk);
    }
    if (actualSize !== expectedSize) {
      throw new Error(
        `ZIP entry size mismatch for ${entry.name}: expected ${expectedSize}, received ${actualSize}`,
      );
    }
    crc = (crc ^ 0xffffffff) >>> 0;

    const descriptor: any = Buffer.alloc(usesZip64Size ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (usesZip64Size) {
      descriptor.writeBigUInt64LE(actualSize, 8);
      descriptor.writeBigUInt64LE(actualSize, 16);
    } else {
      descriptor.writeUInt32LE(Number(actualSize), 8);
      descriptor.writeUInt32LE(Number(actualSize), 12);
    }
    await write(descriptor);
    centralEntries.push({
      name,
      size: actualSize,
      crc,
      offset: entryOffset,
      time,
      date,
    });
  }

  const centralOffset: any = offset;
  for (const entry of centralEntries) {
    const zip64Values: any = [];
    const sizeIsZip64: any = entry.size > UINT32_MAX;
    const offsetIsZip64: any = entry.offset > UINT32_MAX;
    if (sizeIsZip64) zip64Values.push(entry.size, entry.size);
    if (offsetIsZip64) zip64Values.push(entry.offset);
    const extra: any = createZip64Extra(zip64Values);
    const header: any = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP64_VERSION, 4);
    header.writeUInt16LE(sizeIsZip64 || offsetIsZip64 ? ZIP64_VERSION : 20, 6);
    header.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 8);
    header.writeUInt16LE(STORE_METHOD, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(
      sizeIsZip64 ? Number(UINT32_MAX) : Number(entry.size),
      20,
    );
    header.writeUInt32LE(
      sizeIsZip64 ? Number(UINT32_MAX) : Number(entry.size),
      24,
    );
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(
      offsetIsZip64 ? Number(UINT32_MAX) : Number(entry.offset),
      42,
    );
    await write(header);
    await write(entry.name);
    if (extra.length) await write(extra);
  }

  const centralSize: any = offset - centralOffset;
  const entryCount: any = BigInt(centralEntries.length);
  const archiveNeedsZip64: any =
    entryCount > BigInt(UINT16_MAX) ||
    centralOffset > UINT32_MAX ||
    centralSize > UINT32_MAX ||
    centralEntries.some(
      (entry?: any) => entry.size > UINT32_MAX || entry.offset > UINT32_MAX,
    );

  if (archiveNeedsZip64) {
    const zip64EndOffset: any = offset;
    const zip64End: any = Buffer.alloc(56);
    zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(44n, 4);
    zip64End.writeUInt16LE(ZIP64_VERSION, 12);
    zip64End.writeUInt16LE(ZIP64_VERSION, 14);
    zip64End.writeUInt32LE(0, 16);
    zip64End.writeUInt32LE(0, 20);
    zip64End.writeBigUInt64LE(entryCount, 24);
    zip64End.writeBigUInt64LE(entryCount, 32);
    zip64End.writeBigUInt64LE(centralSize, 40);
    zip64End.writeBigUInt64LE(centralOffset, 48);
    await write(zip64End);

    const locator: any = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(zip64EndOffset, 8);
    locator.writeUInt32LE(1, 16);
    await write(locator);
  }

  const end: any = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(archiveNeedsZip64 ? UINT16_MAX : Number(entryCount), 8);
  end.writeUInt16LE(archiveNeedsZip64 ? UINT16_MAX : Number(entryCount), 10);
  end.writeUInt32LE(
    archiveNeedsZip64 ? Number(UINT32_MAX) : Number(centralSize),
    12,
  );
  end.writeUInt32LE(
    archiveNeedsZip64 ? Number(UINT32_MAX) : Number(centralOffset),
    16,
  );
  end.writeUInt16LE(0, 20);
  await write(end);

  return { bytesWritten: offset, entriesWritten: centralEntries.length };
}

export { streamZip, updateCrc32 };
