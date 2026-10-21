import { gunzipSync } from "node:zlib";
import { RISU_SAVE_BLOCK_HEADER_BYTES } from "../legacyHeaders.ts";

export function isRisuSaveBlocks(data: Uint8Array): boolean {
  return RISU_SAVE_BLOCK_HEADER_BYTES.every(
    (value, index) => data[index] === value,
  );
}

/** Self-contained upstream backups; remote references require their original device. */
export function decodeRisuSaveBlocks(
  data: Uint8Array,
  maxOutputBytes?: number,
): Record<string, unknown> {
  const database: Record<string, unknown> = Object.create(null);
  const decoder = new TextDecoder();
  let offset = RISU_SAVE_BLOCK_HEADER_BYTES.length;
  let decodedBytes = 0;
  while (offset < data.byteLength) {
    if (offset + 3 > data.byteLength)
      throw new Error("Truncated RisuSave block header");
    const type = data[offset++];
    const compressed = data[offset++] === 1;
    const nameLength = data[offset++];
    if (offset + nameLength + 4 > data.byteLength)
      throw new Error("Truncated RisuSave block name");
    const name = decoder.decode(data.subarray(offset, offset + nameLength));
    offset += nameLength;
    const length = new DataView(
      data.buffer,
      data.byteOffset + offset,
      4,
    ).getUint32(0, true);
    offset += 4;
    if (length > data.byteLength - offset)
      throw new Error("Truncated RisuSave block payload");
    let bytes = data.subarray(offset, offset + length);
    offset += length;
    if (type === 0) continue;
    if (compressed)
      bytes = gunzipSync(
        bytes,
        maxOutputBytes === undefined
          ? undefined
          : { maxOutputLength: Math.max(1, maxOutputBytes - decodedBytes) },
      );
    decodedBytes += bytes.byteLength;
    if (maxOutputBytes !== undefined && decodedBytes > maxOutputBytes)
      throw new Error("RisuSave exceeds decoded size limit");
    const value = JSON.parse(decoder.decode(bytes));
    switch (type) {
      case 1: {
        const { __directory: _directory, ...root } = value;
        Object.assign(database, root);
        break;
      }
      case 2:
      case 7: {
        const characters = (database.characters ??= []);
        (characters as unknown[]).push(value);
        break;
      }
      case 4:
        database.botPresets = value;
        break;
      case 5:
        database.modules = value;
        break;
      case 8:
        Object.defineProperty(database, value.key, {
          value: value.data,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      case 9:
        database.plugins = value;
        break;
      case 10:
        database.loadouts = value;
        break;
      case 11:
        database.pluginCustomStorage = value;
        break;
      case 12:
        if (name.startsWith("kv:")) {
          const spaces = (database.upstreamSaveKV ??= Object.create(null));
          (spaces as Record<string, unknown>)[name.slice(3)] = value;
        }
        break;
      case 6:
        throw new Error(
          "RisuSave contains remote blocks; export a local backup from the original device",
        );
      default:
        throw new Error(`Unsupported RisuSave block type: ${type}`);
    }
  }
  return database;
}
