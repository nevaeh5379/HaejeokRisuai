import fileBufferUrl from "./rpack_map.bin?url";

let initPromise: Promise<void> | null = null;
let encodeMap: Uint8Array | null = null;
let decodeMap: Uint8Array | null = null;

export async function initRPack(): Promise<void> {
  if (encodeMap && decodeMap) return;
  if (!initPromise) {
    initPromise = (async () => {
      const response = await fetch(fileBufferUrl);
      const arrayBuffer = await response.arrayBuffer();
      const mapData = new Uint8Array(arrayBuffer);
      if (mapData.length < 512) {
        throw new Error(
          `Invalid RPack map data: expected at least 512 bytes, got ${mapData.length}`,
        );
      }
      encodeMap = mapData.slice(0, 256);
      decodeMap = mapData.slice(256, 512);
    })();
  }
  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

export async function encodeRPack(data: Uint8Array): Promise<Uint8Array> {
  await initRPack();
  const map = encodeMap!;
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = map[data[i]];
  }
  return result;
}

export async function decodeRPack(data: Uint8Array): Promise<Uint8Array> {
  await initRPack();
  const map = decodeMap!;
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = map[data[i]];
  }
  return result;
}

export function resetRPackForTesting(): void {
  initPromise = null;
  encodeMap = null;
  decodeMap = null;
}
