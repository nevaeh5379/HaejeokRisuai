import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { Packr, Unpackr, decode } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { presetTemplate } from "../presets/presetDefaults";
import type { Database, PortableDatabase } from "../database/schema";
import {
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
  LEGACY_RAW_DATABASE_HEADER_BYTES,
  LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES,
  RISU_SAVE_BLOCK_HEADER_BYTES,
} from "@risuai/backup-core/legacyHeaders";

import localforage from "localforage";
import { forageStorage } from "../../globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import {
  writeFile,
  BaseDirectory,
  exists,
  mkdir,
  readFile,
} from "@tauri-apps/plugin-fs";

const packr = new Packr({
  useRecords: false,
});

const unpackr = new Unpackr({
  int64AsType: "number",
  useRecords: false,
});

const disableRemoteSaving = () => {
  try {
    const db = settingsStore.state;
    return !db.enableRemoteSaving;
  } catch (error) {
    return true;
  }
};
const magicHeader = new Uint8Array(LEGACY_RAW_DATABASE_HEADER_BYTES);
const magicCompressedHeader = new Uint8Array(
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
);
const magicStreamCompressedHeader = new Uint8Array(
  LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES,
);
const magicRisuSaveHeader = new Uint8Array(RISU_SAVE_BLOCK_HEADER_BYTES);

async function checkCompressionStreams() {
  if (!CompressionStream) {
    const { makeCompressionStream } =
      await import("compression-streams-polyfill/ponyfill");
    //@ts-expect-error polyfill CompressionStream type is incompatible with globalThis.CompressionStream
    globalThis.CompressionStream = makeCompressionStream(TransformStream);
  }
  if (!DecompressionStream) {
    const { makeDecompressionStream } =
      await import("compression-streams-polyfill/ponyfill");
    //@ts-expect-error polyfill DecompressionStream type is incompatible with globalThis.DecompressionStream
    globalThis.DecompressionStream = makeDecompressionStream(TransformStream);
  }
}

export function encodeRisuSaveLegacy(
  data: any,
  compression: "noCompression" | "compression" = "noCompression",
) {
  let encoded: Uint8Array = packr.encode(data);
  if (compression === "compression") {
    encoded = fflate.compressSync(encoded);
    const result = new Uint8Array(
      encoded.length + magicCompressedHeader.length,
    );
    result.set(magicCompressedHeader, 0);
    result.set(encoded, magicCompressedHeader.length);
    return result;
  } else {
    const result = new Uint8Array(encoded.length + magicHeader.length);
    result.set(magicHeader, 0);
    result.set(encoded, magicHeader.length);
    return result;
  }
}

export async function encodeRisuSaveLegacyAsync(
  data: any,
  compression: "noCompression" | "compression" = "noCompression",
): Promise<Uint8Array> {
  let encoded: Uint8Array = packr.encode(data);
  if (compression === "compression") {
    const compressed = await new Promise<Uint8Array>((resolve, reject) => {
      fflate.compress(encoded, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
    const result = new Uint8Array(
      compressed.length + magicCompressedHeader.length,
    );
    result.set(magicCompressedHeader, 0);
    result.set(compressed, magicCompressedHeader.length);
    return result;
  } else {
    const result = new Uint8Array(encoded.length + magicHeader.length);
    result.set(magicHeader, 0);
    result.set(encoded, magicHeader.length);
    return result;
  }
}

export type toSaveType = {
  character: string[];
  chat: [string, string][];
  botPreset: boolean;
  modules: boolean;
  loadouts: boolean;
  plugins: boolean;
  pluginCustomStorage: boolean;
};

enum RisuSaveType {
  CONFIG = 0,
  ROOT = 1,
  CHARACTER_WITH_CHAT = 2,
  CHAT = 3,
  BOTPRESET = 4,
  MODULES = 5,
  REMOTE = 6,
  CHARACTER_WITHOUT_CHAT = 7,
  ROOT_COMPONENT = 8,
  PLUGINS = 9,
  LOADOUTS = 10,
  PLUGIN_STORAGE = 11,
}

const risuSaveCacheForage = localforage.createInstance({
  name: "risuSaveCache",
});

export class RisuSaveDecoder {
  async decode(data: Uint8Array): Promise<PortableDatabase> {
    const blocks: {
      name: string;
      type: RisuSaveType;
      compression: boolean;
      content: string | Uint8Array;
      load?: () => Promise<{
        type: RisuSaveType;
        content: string | Uint8Array;
      } | null>;
    }[] = [];
    let offset = magicRisuSaveHeader.length;
    let db: PortableDatabase = {} as PortableDatabase;
    const loadedBlocks = new Set<string>();
    while (offset < data.length) {
      try {
        const type = data[offset];
        const compression = data[offset + 1] === 1;
        offset += 2;

        const nameLength = data[offset];
        offset += 1;
        const name = new TextDecoder().decode(
          data.subarray(offset, offset + nameLength),
        );
        offset += nameLength;

        if (offset + 4 > data.length) break;
        const length = new DataView(
          data.buffer,
          data.byteOffset + offset,
          4,
        ).getUint32(0, true);
        offset += 4;
        if (length > data.length - offset) break;

        const blockData = data.subarray(offset, offset + length);
        offset += length;

        loadedBlocks.add(name);
        blocks.push({
          name,
          type,
          compression,
          content: blockData,
        });
      } catch (error) {
        continue;
      }
    }
    // Index byte views first so directory resolution sees every local block.
    // Decompress and parse only the current block, never all source strings.
    const releaseBlock = (index: number) => {
      if (blocks[index]) {
        blocks[index] = undefined as any;
      }
    };
    let directory: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const key = i;
      const block = blocks[key];
      if (!block) continue;
      try {
        if (block.load) {
          const loaded = await block.load();
          block.load = undefined;
          if (!loaded) continue;
          block.type = loaded.type;
          block.content = loaded.content;
        }
        let content: string;
        if (typeof block.content === "string") {
          content = block.content;
        } else if (block.compression) {
          await checkCompressionStreams();
          const cs = new DecompressionStream("gzip");
          const writer = cs.writable.getWriter();
          // Start consuming before awaiting writes to respect stream backpressure.
          const text = new Response(cs.readable).text();
          try {
            await Promise.all([
              writer.write(block.content as any).then(() => writer.close()),
              text,
            ]);
          } catch (error) {
            // Directory entries can recover corrupt compressed local blocks.
            loadedBlocks.delete(block.name);
            continue;
          }
          content = await text;
        } else {
          content = new TextDecoder().decode(block.content);
        }
        const parsed =
          block.type === RisuSaveType.CONFIG ? undefined : JSON.parse(content);
        content = "";
        block.content = "";
        switch (block.type) {
          case RisuSaveType.ROOT: {
            const rootData = parsed;
            releaseBlock(key);
            for (const rootKey in rootData) {
              if (!db[rootKey] && !rootKey.startsWith("__")) {
                db[rootKey] = rootData[rootKey];
              }
              if (rootKey === "__directory") {
                directory = rootData[rootKey];
                for (const dirKey of directory) {
                  blocks.push({
                    name: dirKey,
                    type: RisuSaveType.CONFIG,
                    compression: false,
                    content: "",
                    load: async () => {
                      if (loadedBlocks.has(dirKey)) return null;
                      const dirData: {
                        type: RisuSaveType;
                        data: string;
                        name: string;
                      } = (await risuSaveCacheForage.getItem(
                        `risuSaveBlock_${dirKey}`,
                      )) as any;

                      if (dirData) {
                        loadedBlocks.add(dirKey);
                        return {
                          type: dirData.type,
                          content: dirData.data,
                        };
                      }
                      return null;
                    },
                  });
                }
              }
            }
            break;
          }
          case RisuSaveType.CHARACTER_WITH_CHAT:
          case RisuSaveType.CHARACTER_WITHOUT_CHAT: {
            db.characters ??= [];
            db.characters.push(parsed);
            releaseBlock(key);
            break;
          }
          case RisuSaveType.BOTPRESET: {
            db.botPresets = parsed;
            releaseBlock(key);
            break;
          }
          case RisuSaveType.MODULES: {
            db.modules = parsed;
            releaseBlock(key);
            break;
          }
          case RisuSaveType.CONFIG: {
            //ignore for now
            releaseBlock(key);
            break;
          }
          case RisuSaveType.PLUGINS: {
            db.plugins = parsed;
            releaseBlock(key);
            break;
          }
          case RisuSaveType.LOADOUTS: {
            db.loadouts = parsed;
            releaseBlock(key);
            break;
          }
          case RisuSaveType.PLUGIN_STORAGE: {
            db.pluginCustomStorage = parsed;
            releaseBlock(key);
            break;
          }
          case RisuSaveType.REMOTE: {
            const remoteInfo: {
              v: number;
              type: RisuSaveType;
              name: string;
            } = parsed;
            const fileName = `remotes/${remoteInfo.name}.local.bin`;
            blocks.push({
              name: remoteInfo.name,
              type: remoteInfo.type,
              compression: false,
              content: "",
              load: async () => {
                let remoteData: Uint8Array | null = null;
                if (isTauri) {
                  try {
                    if (
                      await exists(fileName, { baseDir: BaseDirectory.AppData })
                    ) {
                      remoteData = await readFile(fileName, {
                        baseDir: BaseDirectory.AppData,
                      });
                    }
                  } catch (error) {
                    console.error(
                      `Error reading remote file ${fileName} in Tauri:`,
                      error,
                    );
                  }
                } else {
                  const stored = await forageStorage.getItem(fileName);
                  if (stored) {
                    remoteData = stored as Uint8Array;
                  }
                }

                if (!remoteData) {
                  console.warn(`Remote file ${fileName} not found.`);
                  return null;
                }
                return { type: remoteInfo.type, content: remoteData };
              },
            });
            releaseBlock(key);
            break;
          }
          case RisuSaveType.ROOT_COMPONENT: {
            const componentData: {
              data: any;
              key: string;
            } = parsed;
            db[componentData.key] = componentData.data;
            releaseBlock(key);
            break;
          }
          default: {
            console.warn(
              `Not Implemented RisuSaveType: ${block.type} for ${block.name}`,
            );
            releaseBlock(key);
          }
        }
      } catch (error) {
        console.error(`Error processing block ${block?.name ?? i}:`, error);

        if (block?.type === RisuSaveType.ROOT) {
          throw new Error(
            "Failed to decode root block, cannot proceed with decoding RisuSave data",
          );
        }
      } finally {
        releaseBlock(key);
      }
    }
    //to fix botpreset bugs
    if (!Array.isArray(db.botPresets) || db.botPresets.length === 0) {
      db.botPresets = [presetTemplate];
      db.botPresetsId = 0;
    }
    blocks.length = 0;
    return db;
  }
}

export async function decodeRisuSave(data: Uint8Array) {
  try {
    const header = checkHeader(data);
    switch (header) {
      case "compressed":
        data = data.subarray(magicCompressedHeader.length);
        return decode(fflate.decompressSync(data));
      case "raw":
        data = data.subarray(magicHeader.length);
        return unpackr.decode(data);
      case "stream": {
        await checkCompressionStreams();
        data = data.subarray(magicStreamCompressedHeader.length);
        const cs = new DecompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(data as any);
        writer.close();
        const buf = await new Response(cs.readable).arrayBuffer();
        return unpackr.decode(new Uint8Array(buf));
      }
      case "risusave": {
        const decoder = new RisuSaveDecoder();
        return await decoder.decode(data);
      }
    }
    return unpackr.decode(data);
  } catch (error) {
    console.error("Error decoding RisuSave data:", error);
    try {
      console.log("risudecode");
      const risuSaveHeader = new Uint8Array(
        Buffer.from("\u0000\u0000RISU", "utf-8"),
      );
      const realData = data.subarray(risuSaveHeader.length);
      const dec = unpackr.decode(realData);
      return dec;
    } catch (error) {
      const buf = fflate.decompressSync(data);
      try {
        return JSON.parse(new TextDecoder().decode(buf));
      } catch (error) {
        return unpackr.decode(buf);
      }
    }
  }
}

function checkHeader(data: Uint8Array) {
  let header: "none" | "compressed" | "raw" | "stream" | "risusave" = "raw";

  if (data.length < magicHeader.length) {
    return false;
  }

  for (let i = 0; i < magicHeader.length; i++) {
    if (data[i] !== magicHeader[i]) {
      header = "none";
      break;
    }
  }

  if (header === "none") {
    header = "compressed";
    for (let i = 0; i < magicCompressedHeader.length; i++) {
      if (data[i] !== magicCompressedHeader[i]) {
        header = "none";
        break;
      }
    }
  }

  if (header === "none") {
    header = "stream";
    for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
      if (data[i] !== magicStreamCompressedHeader[i]) {
        header = "none";
        break;
      }
    }
  }

  if (header === "none") {
    header = "risusave";
    for (let i = 0; i < magicRisuSaveHeader.length; i++) {
      if (data[i] !== magicRisuSaveHeader[i]) {
        header = "none";
        break;
      }
    }
  }

  // All bytes matched
  return header;
}
