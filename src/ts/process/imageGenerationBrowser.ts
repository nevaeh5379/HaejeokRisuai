import type {
  ImageGenerationRuntime,
  ImageGenerationSettings,
} from "@risuai/protocol/dist/imageGeneration.mjs";
import {
  IMAGE_GENERATION_SETTING_KEYS,
  getComfyGenerationConfig,
} from "@risuai/protocol/dist/imageGeneration.mjs";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { PRESET_STORE_SETTING_KEYS } from "../storage/sql/sqlDeferredSettings";
import { fetchNative, globalFetch, readImage } from "../globalApi.svelte";
import { processZip } from "./processzip";
import { safeStructuredClone } from "../polyfill";

/**
 * Copies only image-provider settings from their owning global or preset stores.
 *
 * 한국어: 범용·프리셋 저장소 중 실제 소유 저장소에서 이미지 제공자 설정만 복사하는 함수.
 *
 * @returns A detached settings snapshot for one generation request. / 생성 요청 하나에 사용할 독립 설정 사본.
 */
export function getImageGenerationSettings(): ImageGenerationSettings {
  const presetKeys = new Set<string>(PRESET_STORE_SETTING_KEYS);
  return Object.fromEntries(
    IMAGE_GENERATION_SETTING_KEYS.map((key) => [
      key,
      safeStructuredClone(
        key === "comfyConfig"
          ? getComfyGenerationConfig(settingsStore.state.comfyConfig)
          : presetKeys.has(key)
            ? presetStore.state[key]
            : settingsStore.state[key],
      ),
    ]),
  ) as unknown as ImageGenerationSettings;
}

/**
 * Connects the shared image core to app HTTP, stored images, ZIP decoding and canvas processing.
 *
 * 한국어: 공통 이미지 로직을 앱 HTTP·저장 이미지·ZIP 해석·캔버스 처리에 연결하는 어댑터.
 */
export const browserImageRuntime: ImageGenerationRuntime = {
  /**
   * Routes JSON provider requests through the app's platform-aware transport.
   *
   * 한국어: JSON 제공자 요청을 앱의 플랫폼별 전송 경로로 보내는 함수.
   */
  fetchJson: (url, options) =>
    globalFetch(url, options as Parameters<typeof globalFetch>[1]),
  /**
   * Uses raw browser fetch for multipart bodies and app native transport otherwise.
   *
   * 한국어: 멀티파트 본문은 브라우저 원시 fetch로, 나머지는 앱 네이티브 전송으로 보내는 함수.
   *
   * @remarks
   * Stability multipart bodies cannot be encoded by the native JSON transport.
   * 한국어: 네이티브 JSON 전송에서 인코딩할 수 없는 Stability 멀티파트 요청을 위한 분기.
   */
  fetchNative: (url, options) =>
    options?.body instanceof FormData
      ? fetch(url, options)
      : fetchNative(url, options as Parameters<typeof fetchNative>[1]),
  readImage,
  unzipImage: processZip,
  /**
   * Fits a base64 reference into a black 1472-square PNG and releases canvas/image resources.
   *
   * 한국어: Base64 참조 그림을 검은 1472 정사각 PNG에 맞추고 이미지·캔버스 자원을 해제하는 함수.
   *
   * @param base64 - Reference bytes without the data URL prefix. / 데이터 URL 접두사를 제외한 참조 바이트.
   * @returns Resized PNG bytes in base64, or an empty string for empty input. / 크기를 조정한 PNG의 Base64 또는 빈 입력이면 빈 문자열.
   */
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
