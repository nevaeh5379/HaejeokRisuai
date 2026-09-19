import { promisify } from "node:util";
import { gzip, gunzipSync, inflateSync } from "node:zlib";
import { Packr, Unpackr } from "msgpackr";
import {
  makeLegacyCompatibleDatabase,
  type ColdStorageValueMap,
} from "../compatibility";
import { expandPortableDatabaseBranchGraphsForCompatibility } from "../portableBranches";
import {
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
  LEGACY_RAW_DATABASE_HEADER_BYTES,
} from "../legacyHeaders";

const RAW_HEADER = Buffer.from(LEGACY_RAW_DATABASE_HEADER_BYTES);
const COMPRESSED_HEADER = Buffer.from(LEGACY_COMPRESSED_DATABASE_HEADER_BYTES);

const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ int64AsType: "number", useRecords: false });
const gzipAsync = promisify(gzip) as (input: Uint8Array) => Promise<Buffer>;

function decodeCompressedLegacyPayload(payload: Uint8Array): Uint8Array {
  try {
    return gunzipSync(payload);
  } catch (gzipError) {
    try {
      // Transitional HaejeokRisu server builds wrote zlib-wrapped deflate
      // bytes behind the same legacy header. Keep those backups readable.
      return inflateSync(payload);
    } catch {
      throw gzipError;
    }
  }
}

export function createLocalBackupEntryHeader(
  name: string,
  size: number,
): Buffer {
  const normalizedName = String(name).replace(/\\/g, "/");
  const segments = normalizedName.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid local backup entry name: ${name}`);
  }

  const encodedName = Buffer.from(normalizedName, "utf8");
  if (encodedName.length === 0 || encodedName.length > 1024 * 1024) {
    throw new Error(`Invalid local backup entry name: ${name}`);
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff) {
    throw new Error(`Local backup entry is too large: ${name}`);
  }

  const header = Buffer.alloc(8 + encodedName.length);
  header.writeUInt32LE(encodedName.length, 0);
  encodedName.copy(header, 4);
  header.writeUInt32LE(size, 4 + encodedName.length);
  return header;
}

export async function encodeLegacyBackupDatabase(
  database: unknown,
): Promise<Buffer> {
  const packed = packr.encode(database);
  const compressed = await gzipAsync(packed);
  return Buffer.concat([COMPRESSED_HEADER, compressed]);
}

export async function encodeLegacyCompatibleBackupDatabase(
  database: Record<string, any>,
  coldStorageValues: ColdStorageValueMap = new Map(),
): Promise<Buffer> {
  const expanded = expandPortableDatabaseBranchGraphsForCompatibility(database);
  const compatible = makeLegacyCompatibleDatabase(expanded, coldStorageValues);
  return await encodeLegacyBackupDatabase(compatible);
}

export function decodeLegacyBackupDatabase(data: Uint8Array): unknown {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.subarray(0, COMPRESSED_HEADER.length).equals(COMPRESSED_HEADER)) {
    return unpackr.decode(
      decodeCompressedLegacyPayload(buffer.subarray(COMPRESSED_HEADER.length)),
    );
  }
  if (buffer.subarray(0, RAW_HEADER.length).equals(RAW_HEADER)) {
    return unpackr.decode(buffer.subarray(RAW_HEADER.length));
  }
  return unpackr.decode(buffer);
}

export {
  COMPRESSED_HEADER as LEGACY_COMPRESSED_DATABASE_HEADER,
  RAW_HEADER as LEGACY_RAW_DATABASE_HEADER,
  makeLegacyCompatibleDatabase,
};
