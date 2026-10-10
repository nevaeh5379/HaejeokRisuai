import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
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

/**
 * Stores an inlay using either strict durable writes or the legacy best-effort remote cache path.
 *
 * 한국어: 엄격한 영구 저장 또는 기존 원격 캐시 방식으로 인레이를 저장하는 함수.
 *
 * @param id - Inlay ID referenced by message tokens. / 메시지 토큰에서 참조할 인레이 ID.
 * @param asset - Media metadata and content. / 미디어 메타데이터·내용.
 * @param durable - Requires remote storage or persistent local cache to succeed before returning. / 반환 전에 원격 저장·로컬 영구 캐시 성공을 요구할지 여부.
 * @remarks
 * Durable illustration saves propagate failures so an unsaved image cannot replace the old token.
 * 한국어: 삽화 영구 저장 실패를 호출부에 전달해 저장되지 않은 그림으로 기존 토큰을 교체하는 상황을 방지.
 */
async function writeInlayStorage(
  id: string,
  asset: InlayAsset,
  durable = false,
) {
  if (durable) {
    const storage = await getRemoteNodeStorage();
    if (storage) {
      await putRemoteInlayAsset(id, asset);
      await writeCachedInlay(id, asset);
    } else {
      await writeCachedInlay(id, asset, true);
    }
    return;
  }
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
    throw new Error(
      "Inlay server storage is only available on the node server",
    );
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

/**
 * Decodes image bytes and delegates resizing, PNG encoding and storage to the browser inlay writer.
 *
 * 한국어: 이미지 바이트를 해석하고 크기 조절·PNG 변환·저장을 브라우저 인레이 작성기로 넘기는 함수.
 *
 * @param data - Source image bytes. / 원본 이미지 바이트.
 * @param arg - Optional name, source extension, ID and durable-save requirement. / 선택적 이름·원본 확장자·ID·영구 저장 요구 설정.
 * @returns Saved inlay ID. / 저장된 인레이 ID.
 */
export async function writeInlayImageFromBytes(
  data: Uint8Array,
  arg: { name?: string; ext?: string; id?: string; durable?: boolean } = {},
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

/**
 * Scales an image to at most 1024 squared pixels, encodes PNG and saves it as an inlay.
 *
 * 한국어: 이미지를 최대 1024×1024 픽셀 수로 줄이고 PNG로 변환해 인레이로 저장하는 함수.
 *
 * @param imgObj - Loaded or loading image element. / 로딩 중이거나 로딩된 이미지 요소.
 * @param arg - Optional name, extension, ID and durable-save requirement. / 선택적 이름·확장자·ID·영구 저장 요구 설정.
 * @returns Saved inlay ID after the selected storage path succeeds. / 선택한 저장 경로 성공 후 인레이 ID.
 * @remarks
 * Releases event handlers and canvas backing memory even when decoding or persistence fails.
 * 한국어: 이미지 해석·저장 실패 시에도 이벤트 핸들러·캔버스 메모리를 해제.
 */
export async function writeInlayImage(
  imgObj: HTMLImageElement,
  arg: { name?: string; ext?: string; id?: string; durable?: boolean } = {},
) {
  let drawHeight = 0;
  let drawWidth = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is unavailable");
  }
  try {
    await new Promise((resolve, reject) => {
      /**
       * Validates decoded dimensions and draws the aspect-preserving inlay-sized image.
       *
       * 한국어: 해석된 크기를 검증하고 비율을 유지한 인레이 크기로 그림을 그리는 함수.
       */
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
      imgObj.onerror = () =>
        reject(new Error("Failed to load image for inlay"));
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

    await writeInlayStorage(
      imgid,
      {
        name: arg.name ?? imgid,
        data: imageBlob,
        ext: "png",
        height: drawHeight,
        width: drawWidth,
        type: "image",
      },
      arg.durable,
    );
    return `${imgid}`;
  } finally {
    imgObj.onload = imgObj.onerror = null;
    canvas.width = canvas.height = 0;
  }
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
  return getModelInfo(presetStore.state.aiModel).flags.includes(
    LLMFlags.hasImageInput,
  );
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
