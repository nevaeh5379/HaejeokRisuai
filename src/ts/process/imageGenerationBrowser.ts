import type {
  ImageGenerationRuntime,
  ImageGenerationSettings,
} from "@risuai/protocol/dist/imageGeneration.mjs";
import { IMAGE_GENERATION_SETTING_KEYS } from "@risuai/protocol/dist/imageGeneration.mjs";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { PRESET_STORE_SETTING_KEYS } from "../storage/sql/sqlDeferredSettings";
import { fetchNative, globalFetch, readImage } from "../globalApi.svelte";
import { processZip } from "./processzip";
import { safeStructuredClone } from "../polyfill";

export function getImageGenerationSettings(): ImageGenerationSettings {
  const presetKeys = new Set<string>(PRESET_STORE_SETTING_KEYS);
  return Object.fromEntries(
    IMAGE_GENERATION_SETTING_KEYS.map((key) => [
      key,
      safeStructuredClone(
        presetKeys.has(key) ? presetStore.state[key] : settingsStore.state[key],
      ),
    ]),
  ) as unknown as ImageGenerationSettings;
}

export const browserImageRuntime: ImageGenerationRuntime = {
  fetchJson: (url, options) =>
    globalFetch(url, options as Parameters<typeof globalFetch>[1]),
  // Stability uses multipart, which the native JSON transport cannot encode.
  fetchNative: (url, options) =>
    options?.body instanceof FormData
      ? fetch(url, options)
      : fetchNative(url, options as Parameters<typeof fetchNative>[1]),
  readImage,
  unzipImage: processZip,
  resizeReference: async (base64) => {
    if (!base64) return "";
    const img = new Image();
    const canvas = document.createElement("canvas");
    try {
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      canvas.width = canvas.height = 1472;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Image canvas is unavailable");
      const scale = Math.min(1472 / img.naturalWidth, 1472 / img.naturalHeight);
      const width = Math.floor(img.naturalWidth * scale),
        height = Math.floor(img.naturalHeight * scale);
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, 1472, 1472);
      ctx.drawImage(
        img,
        (1472 - width) / 2,
        (1472 - height) / 2,
        width,
        height,
      );
      return canvas.toDataURL("image/png").split(",")[1];
    } finally {
      img.src = "";
      canvas.width = canvas.height = 0;
    }
  },
};
