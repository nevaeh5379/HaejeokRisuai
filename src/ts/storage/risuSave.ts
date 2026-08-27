import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { Packr, Unpackr, decode } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { presetTemplate } from "./presetDefaults";
import type { Database, PortableDatabase } from "./schema";

import localforage from "localforage";
import { forageStorage } from "../globalApi.svelte";
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
const checkedRemoteExistence = new Set<string>();
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const magicCompressedHeader = new Uint8Array([
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8,
]);
const magicStreamCompressedHeader = new Uint8Array([
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9,
]);
const magicRisuSaveHeader = new TextEncoder().encode("RISUSAVE\0");

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
  private blocks: {
    name: string;
    type: RisuSaveType;
    compression: boolean;
    content: string;
  }[] = [];
  async decode(data: Uint8Array): Promise<PortableDatabase> {
    console.log("Decoding RisuSave data");
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

        const newArrayBuf = new ArrayBuffer(4);
        const lengthSubUint8Buf = data.slice(offset, offset + 4);
        new Uint8Array(newArrayBuf).set(lengthSubUint8Buf);
        const length = new Uint32Array(newArrayBuf)[0];
        offset += 4;

        let blockData = data.subarray(offset, offset + length);
        offset += length;

        if (compression) {
          //decode using DecompressionStream
          await checkCompressionStreams();
          const cs = new DecompressionStream("gzip");
          const writer = cs.writable.getWriter();
          writer.write(blockData as any);
          writer.close();
          const buf = await new Response(cs.readable).arrayBuffer();
          blockData = new Uint8Array(buf);
        }

        loadedBlocks.add(name);
        this.blocks.push({
          name,
          type,
          compression,
          content: new TextDecoder().decode(blockData),
        });
      } catch (error) {
        continue;
      }
    }
    console.log("blocks", this.blocks);
    let directory: string[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const key = i;
      try {
        switch (this.blocks[key].type) {
          case RisuSaveType.ROOT: {
            const rootData = JSON.parse(this.blocks[key].content);
            for (const rootKey in rootData) {
              if (!db[rootKey] && !rootKey.startsWith("__")) {
                db[rootKey] = rootData[rootKey];
              }
              if (rootKey === "__directory") {
                directory = rootData[rootKey];
                console.log("RisuSave directory:", directory);
                for (const dirKey of directory) {
                  if (!loadedBlocks.has(dirKey)) {
                    try {
                      console.log(
                        `Loading directory block ${dirKey} from cache`,
                      );
                      const dirData: {
                        type: RisuSaveType;
                        data: string;
                        name: string;
                      } = (await risuSaveCacheForage.getItem(
                        `risuSaveBlock_${dirKey}`,
                      )) as any;

                      if (dirData) {
                        this.blocks.push({
                          name: dirData.name,
                          type: dirData.type,
                          compression: false,
                          content: dirData.data,
                        });
                        loadedBlocks.add(dirKey);
                      }
                    } catch (error) {
                      console.error(
                        `Error loading directory block ${dirKey}:`,
                        error,
                      );
                    }
                  }
                }
              }
            }
            break;
          }
          case RisuSaveType.CHARACTER_WITH_CHAT:
          case RisuSaveType.CHARACTER_WITHOUT_CHAT: {
            db.characters ??= [];
            const character = JSON.parse(this.blocks[key].content);
            db.characters.push(character);
            break;
          }
          case RisuSaveType.BOTPRESET: {
            db.botPresets = JSON.parse(this.blocks[key].content);
            break;
          }
          case RisuSaveType.MODULES: {
            db.modules = JSON.parse(this.blocks[key].content);
            break;
          }
          case RisuSaveType.CONFIG: {
            //ignore for now
            break;
          }
          case RisuSaveType.PLUGINS: {
            db.plugins = JSON.parse(this.blocks[key].content);
            break;
          }
          case RisuSaveType.LOADOUTS: {
            db.loadouts = JSON.parse(this.blocks[key].content);
            break;
          }
          case RisuSaveType.PLUGIN_STORAGE: {
            db.pluginCustomStorage = JSON.parse(this.blocks[key].content);
            break;
          }
          case RisuSaveType.REMOTE: {
            const remoteInfo: {
              v: number;
              type: RisuSaveType;
              name: string;
            } = JSON.parse(this.blocks[key].content);
            const fileName = `remotes/${remoteInfo.name}.local.bin`;
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
              break;
            }
            const decoded = new TextDecoder().decode(remoteData);

            //add to blocks for further processing
            this.blocks.push({
              name: remoteInfo.name,
              type: remoteInfo.type,
              compression: false,
              content: decoded,
            });
            break;
          }
          case RisuSaveType.ROOT_COMPONENT: {
            const componentData: {
              data: any;
              key: string;
            } = JSON.parse(this.blocks[key].content);
            db[componentData.key] = componentData.data;
            break;
          }
          default: {
            console.warn(
              `Not Implemented RisuSaveType: ${this.blocks[key].type} for ${this.blocks[key].name}`,
            );
          }
        }
      } catch (error) {
        console.error(
          `Error processing block ${this.blocks[key].name}:`,
          error,
        );

        if (this.blocks[key].type === RisuSaveType.ROOT) {
          throw new Error(
            "Failed to decode root block, cannot proceed with decoding RisuSave data",
          );
        }
      }
    }
    //to fix botpreset bugs
    if (!Array.isArray(db.botPresets) || db.botPresets.length === 0) {
      db.botPresets = [presetTemplate];
      db.botPresetsId = 0;
    }
    console.log("Decoded RisuSave data", db);
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
      const buf = Buffer.from(fflate.decompressSync(Buffer.from(data)));
      try {
        return JSON.parse(buf.toString("utf-8"));
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
