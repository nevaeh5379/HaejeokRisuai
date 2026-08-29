import { isCapacitor } from "../platform";
import { LoadingStatusState } from "../stores.svelte";
import {
  getPreparedNativeThumbnailSrc,
  prepareNativeThumbnails,
} from "../globalApi.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

const startupThumbnailWarmers: HTMLImageElement[] = [];

/**
 * Android sidebar icons use persistent 128px native thumbnails. Build any
 * missing ones while the startup screen is still visible so opening the
 * sidebar never has to compete with decode/resize/WebP work.
 */
export async function prepareAndroidCharacterThumbnails() {
  if (!isCapacitor) return;

  const keys = new Set<string>();
  const addImage = (value: unknown) => {
    if (
      typeof value === "string" &&
      /\.(?:png|jpe?g|webp|avif|heic|heif|bmp)$/i.test(value)
    ) {
      keys.add(value);
    }
  };

  const imageByCharacterId = new Map(
    (characterStore.characters ?? []).map(
      (character) => [character?.chaId, character?.image] as const,
    ),
  );
  for (const item of settingsStore.state.characterOrder ?? []) {
    if (typeof item === "string") {
      addImage(imageByCharacterId.get(item));
    } else if (item && typeof item === "object") {
      addImage((item as any).imgFile);
      for (const id of (item as any).data ?? [])
        addImage(imageByCharacterId.get(id));
    }
  }
  for (const character of characterStore.characters ?? [])
    addImage(character?.image);

  const images = [...keys];
  if (images.length === 0) return;

  const batchSize = 64;
  let created = 0;
  let cached = 0;
  let missing = 0;
  let failed = 0;
  for (let offset = 0; offset < images.length; offset += batchSize) {
    const batch = images.slice(offset, offset + batchSize);
    LoadingStatusState.text = `Preparing Character Thumbnails... ${offset}/${images.length}`;
    try {
      const result = await prepareNativeThumbnails(batch, 128, 128);
      created += result.created;
      cached += result.cached;
      missing += result.missing;
      failed += result.failed;
    } catch (error) {
      console.warn("[Startup] Failed to prepare native thumbnail batch", error);
      failed += batch.length;
    }
  }
  LoadingStatusState.text = `Preparing Character Thumbnails... ${images.length}/${images.length}`;

  if (typeof Image !== "undefined") {
    LoadingStatusState.text = "Warming Character Icons...";
    startupThumbnailWarmers.length = 0;
    await Promise.all(
      images.slice(0, 16).map(async (loc) => {
        const src = getPreparedNativeThumbnailSrc(loc);
        if (!src) return;
        const image = new Image();
        image.decoding = "async";
        image.src = src;
        startupThumbnailWarmers.push(image);
        try {
          await image.decode();
        } catch {
          // A missing/corrupt icon falls back through the normal lazy path later.
        }
      }),
    );
  }

  console.info("[Startup] Android character thumbnails ready", {
    total: images.length,
    created,
    cached,
    missing,
    failed,
  });
}
