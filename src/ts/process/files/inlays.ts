import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { v4 } from "uuid";
import { getImageType } from "src/ts/media";

import { getModelInfo, LLMFlags, LLMFormat } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import {
  clearInlayCache,
  fetchRemoteInlayAsset,
  getRemoteNodeStorage,
  listInlayCacheEntries,
  listRemoteInlayIds,
  putRemoteInlayAsset,
  readCachedInlay,
  removeCachedInlay,
  removeRemoteInlayAsset,
  writeCachedInlay,
} from "./inlayRemote";

export type { InlayAsset } from "./inlayCodec";
import type { InlayAsset } from "./inlayCodec";

const inlayImageExts = ["jpg", "jpeg", "png", "gif", "webp", "avif"];

const inlayAudioExts = ["wav", "mp3", "ogg", "flac"];

const inlayVideoExts = ["webm", "mp4", "mkv"];

let remoteWriteFailed = false;

/** Clears the inlay remote-write circuit breaker (used by tests and after successful migrations). */
export function resetInlayRemoteWriteState() {
  remoteWriteFailed = false;
}

async function writeInlayStorage(id: string, asset: InlayAsset) {
  await writeCachedInlay(id, asset);
  try {
    const storage = await getRemoteNodeStorage();
    if (!storage) return;
    await putRemoteInlayAsset(id, asset);
    remoteWriteFailed = false;
  } catch (error) {
    if (!remoteWriteFailed) {
      console.warn(
        "Inlay server upload failed; keeping local cache only",
        error,
      );
    }
    remoteWriteFailed = true;
  }
}

export async function migrateLocalInlaysToServer(): Promise<{
  migrated: number;
  total: number;
  failed: number;
}> {
  const storage = await getRemoteNodeStorage();
  if (!storage) {
    throw new Error("Inlay server storage is only available on the node server");
  }
  const stored = await readAllCachedInlays();
  const remoteIds = new Set(await listRemoteInlayIds());
  let migrated = 0;
  let failed = 0;
  const total = stored.length;
  const pending = stored.filter(([id]) => !remoteIds.has(id));
  for (const [id, asset] of pending) {
    try {
      await putRemoteInlayAsset(id, asset);
      migrated++;
    } catch (error) {
      failed++;
      console.warn(`Failed to upload inlay ${id} to server`, error);
    }
  }
  if (migrated > 0 && failed === 0) {
    resetInlayRemoteWriteState();
  }
  return { migrated, total: pending.length, failed };
}

async function readAllCachedInlays(): Promise<[string, InlayAsset][]> {
  return listInlayCacheEntries();
}

export async function postInlayAsset(img: { name: string; data: Uint8Array }) {
  const extention = img.name.split(".").at(-1);

  if (inlayImageExts.includes(extention)) {
    return await writeInlayImageFromBytes(img.data, {
      name: img.name,
      ext: extention,
    });
  }

  if (inlayAudioExts.includes(extention)) {
    const audioBlob = new Blob([asBuffer(img.data)], {
      type: `audio/${extention}`,
    });
    const imgid = v4();

    await writeInlayStorage(imgid, {
      name: img.name,
      data: audioBlob,
      ext: extention,
      type: "audio",
    });

    return `${imgid}`;
  }

  if (inlayVideoExts.includes(extention)) {
    const videoBlob = new Blob([asBuffer(img.data)], {
      type: `video/${extention}`,
    });
    const imgid = v4();

    await writeInlayStorage(imgid, {
      name: img.name,
      data: videoBlob,
      ext: extention,
      type: "video",
    });

    return `${imgid}`;
  }

  return null;
}

export async function writeInlayImageFromBytes(
  data: Uint8Array,
  arg: { name?: string; ext?: string; id?: string } = {},
) {
  const imgObj = new Image();
  const ext = arg.ext ?? "png";
  const objectUrl = URL.createObjectURL(
    new Blob([asBuffer(data)], { type: `image/${ext}` }),
  );
  imgObj.src = objectUrl;
  try {
    return await writeInlayImage(imgObj, arg);
  } finally {
    imgObj.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

export async function writeInlayImage(
  imgObj: HTMLImageElement,
  arg: { name?: string; ext?: string; id?: string } = {},
) {
  let drawHeight = 0;
  let drawWidth = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is unavailable");
  }
  await new Promise((resolve, reject) => {
    const processImage = () => {
      drawHeight = imgObj.naturalHeight;
      drawWidth = imgObj.naturalWidth;
      if (drawWidth <= 0 || drawHeight <= 0) {
        reject(new Error("Failed to load image for inlay"));
        return;
      }

      //resize image to fit inlay, if total pixels exceed 1024*1024
      const maxPixels = 1024 * 1024;
      const currentPixels = drawHeight * drawWidth;

      if (currentPixels > maxPixels) {
        const scaleFactor = Math.sqrt(maxPixels / currentPixels);
        drawWidth = Math.floor(drawWidth * scaleFactor);
        drawHeight = Math.floor(drawHeight * scaleFactor);
      }

      canvas.width = drawWidth;
      canvas.height = drawHeight;
      ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight);
      resolve(null);
    };

    if (imgObj.complete) {
      processImage();
      return;
    }

    imgObj.onload = processImage;
    imgObj.onerror = () => reject(new Error("Failed to load image for inlay"));
  });
  const imageBlob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to encode inlay image"));
      }
    }, "image/png"),
  );

  const imgid = arg.id ?? v4();

  await writeInlayStorage(imgid, {
    name: arg.name ?? imgid,
    data: imageBlob,
    ext: "png",
    height: drawHeight,
    width: drawWidth,
    type: "image",
  });

  return `${imgid}`;
}

export type InlaySignature = {
  signatures: {
    type: "function" | "text";
    content: string;
  }[];
  sourceFormat: LLMFormat;
  source: string;
};

export async function saveInlayedSignature(
  sigid: string,
  signature: InlaySignature,
) {
  await writeInlayStorage(sigid, {
    name: sigid,
    data: JSON.stringify(signature),
    ext: "json",
    type: "signature",
  } satisfies InlayAsset);
  return sigid;
}

function base64ToBlob(b64: string): Blob {
  const separatorIndex = b64.indexOf(",");
  if (separatorIndex === -1) {
    throw new Error("Invalid base64 data URI");
  }
  const header = b64.slice(0, separatorIndex);
  const byteString = atob(b64.slice(separatorIndex + 1));
  const mimeString = header.split(":")[1]?.split(";")[0] ?? "";

  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  return new Promise<string>((resolve, reject) => {
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
  });
}

// Returns with base64 data URI
export async function getInlayAsset(id: string) {
  const img = await getInlayStorageItem(id);
  if (img === null) {
    return null;
  }

  let data: string;
  if (img.data instanceof Blob) {
    data = await blobToBase64(img.data);
  } else {
    data = img.data as string;
  }

  return { ...img, data };
}

// Returns media data as Blob; signature data remains text.
export async function getInlayAssetBlob(id: string) {
  const img = await getInlayStorageItem(id);
  if (img === null) {
    return null;
  }

  if (img.type === "signature") {
    return img;
  }

  let data: Blob;
  if (typeof img.data === "string") {
    if (!img.data.startsWith("data:")) {
      throw new Error(`Invalid inlay data URI: ${id}`);
    }
    // Migrate legacy data URI to Blob
    data = base64ToBlob(img.data);
    await setInlayAsset(id, { ...img, data });
  } else {
    data = img.data;
  }

  return { ...img, data };
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
  const localEntries = await readAllCachedInlays();
  const remoteStorage = await getRemoteNodeStorage();
  if (!remoteStorage) {
    return localEntries;
  }

  const results: [id: string, InlayAsset][] = [];
  const seen = new Set<string>();
  for (const [id, asset] of localEntries) {
    seen.add(id);
    results.push([id, asset]);
  }
  try {
    const remoteIds = await listRemoteInlayIds();
    for (const id of remoteIds) {
      if (seen.has(id)) continue;
      const asset = await fetchRemoteInlayAsset(id);
      if (asset) results.push([id, asset]);
    }
  } catch (error) {
    console.warn("Failed to list remote inlays", error);
  }

  return results;
}

export async function setInlayAsset(id: string, img: InlayAsset) {
  await writeInlayStorage(id, img);
}

export { encodeInlayAssetBackup, decodeInlayAssetBackup } from "./inlayCodec";

export async function removeInlayAsset(id: string) {
  await removeCachedInlay(id);
  try {
    await removeRemoteInlayAsset(id);
  } catch (error) {
    console.warn(`Failed to remove inlay ${id} from server`, error);
  }
}

async function getInlayStorageItem(id: string): Promise<InlayAsset | null> {
  const cached = await readCachedInlay(id);
  if (cached !== null) {
    return cached;
  }
  try {
    return await fetchRemoteInlayAsset(id);
  } catch (error) {
    console.warn(`Failed to fetch inlay ${id} from server`, error);
    return null;
  }
}

export { clearInlayCache };

export function supportsInlayImage() {
  const db = settingsStore.state;
  return getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput);
}

export async function reencodeImage(img: Uint8Array) {
  if (getImageType(img) === "PNG") {
    return img;
  }
  const canvas = document.createElement("canvas");
  const imgObj = new Image();
  const objectUrl = URL.createObjectURL(
    new Blob([asBuffer(img)], { type: `image/png` }),
  );
  imgObj.src = objectUrl;
  try {
    await imgObj.decode();
    let drawHeight = imgObj.height;
    let drawWidth = imgObj.width;
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight);
    const b64 = canvas.toDataURL("image/png").split(",")[1];
    return Buffer.from(b64, "base64");
  } finally {
    imgObj.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}
