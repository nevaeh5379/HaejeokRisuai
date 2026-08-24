import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { forageStorage, getFileSrc } from "./globalApi.svelte";
import { NodeStorage } from "./storage/nodeStorage";
import { getMimeType } from "./media/mimeType";

// Global cache for character images across the application session
export const fullImageBlobCache = new Map<string, string>();
const characterImagePreloads = new Map<string, Promise<void>>();

export function releaseCharacterImageCache(prefix: string): void {
  const releasedUrls = new Set<string>();
  for (const [key, value] of fullImageBlobCache) {
    if (!key.startsWith(prefix)) continue;
    fullImageBlobCache.delete(key);
    if (value.startsWith("blob:")) releasedUrls.add(value);
  }

  for (const url of releasedUrls) {
    if (![...fullImageBlobCache.values()].includes(url)) {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Starts fetching and decoding a character image before a component needs it.
 * Keeping the Image instance inside the promise ensures the browser can reuse
 * the in-flight request when the same URL is applied to the chat avatar.
 */
export function preloadCharacterImage(loc: string): Promise<void> {
  if (
    !loc ||
    settingsStore.state.hideAllImages ||
    typeof Image === "undefined"
  ) {
    return Promise.resolve();
  }

  const existing = characterImagePreloads.get(loc);
  if (existing) return existing;

  const preload = (async () => {
    // Full-resolution card images can finish loading after the chat has
    // become interactive and then monopolize image decoding on older
    // mobile CPUs. Low-spec mode uses the same bounded thumbnail as the
    // chat message avatar, so warm that resource instead.
    const imageOptions = settingsStore.state.lowSpecMode
      ? { thumbnail: true }
      : undefined;
    const source = await getCharImage(loc, "plain", imageOptions);
    if (!source || source === "/none.webp") return;

    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.fetchPriority = "high";
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(`Failed to preload character image: ${loc}`));
      image.src = source;
    });
  })().catch(() => {
    characterImagePreloads.delete(loc);
  });

  characterImagePreloads.set(loc, preload);
  return preload;
}

export async function getCharImage(
  loc: string,
  type: "plain" | "css" | "contain" | "lgcss",
  options?: { thumbnail?: boolean },
) {
  if (settingsStore.state.hideAllImages)
    return type === "plain" ? "/none.webp" : "";
  if (!loc) return type === "css" ? "" : null;

  if (!options?.thumbnail && fullImageBlobCache.has(loc)) {
    const fileSource = fullImageBlobCache.get(loc)!;
    if (type === "plain") return fileSource;
    if (type === "css")
      return `background: url("${fileSource}");background-size: cover;`;
    if (type === "lgcss")
      return `background: url("${fileSource}");background-size: cover;height: 10.66rem;`;
    return `background: url("${fileSource}");background-size: contain;background-repeat: no-repeat;background-position: center;`;
  }

  const fileSource = await getFileSrc(loc, options);
  if (!options?.thumbnail && fileSource) {
    fullImageBlobCache.set(loc, fileSource);
  }
  if (type === "plain") return fileSource;
  if (type === "css")
    return `background: url("${fileSource}");background-size: cover;`;
  if (type === "lgcss")
    return `background: url("${fileSource}");background-size: cover;height: 10.66rem;`;
  return `background: url("${fileSource}");background-size: contain;background-repeat: no-repeat;background-position: center;`;
}

export interface CharImageOptions {
  size?: "display" | "thumb" | "full";
  thumbnail?: boolean;
  width?: number;
  height?: number;
}

const NODE_IMAGE_BATCH_SIZE = 48;

export async function getAssetsBatch(
  locs: string[],
  options: CharImageOptions = { size: "full" },
): Promise<Map<string, string>> {
  return getCharImagesBatch(locs, options);
}

export async function getCharImagesBatch(
  locs: string[],
  options: CharImageOptions = { size: "display" },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!locs || locs.length === 0) return result;
  if (settingsStore.state.hideAllImages) {
    for (const loc of locs) {
      result.set(loc, "/none.webp");
    }
    return result;
  }

  const sizeKey = options.size ?? (options.thumbnail ? "thumb" : "full");
  const uncachedLocs: string[] = [];
  for (const loc of locs) {
    if (!loc) continue;
    const cacheKey = `${sizeKey}_${loc}`;
    if (fullImageBlobCache.has(cacheKey)) {
      result.set(loc, fullImageBlobCache.get(cacheKey)!);
    } else {
      uncachedLocs.push(loc);
    }
  }

  if (uncachedLocs.length === 0) {
    return result;
  }
  const setMissing = (loc: string) => {
    const cacheKey = `${sizeKey}_${loc}`;
    fullImageBlobCache.set(cacheKey, "/none.webp");
    result.set(loc, "/none.webp");
  };

  // NodeStorage: use bounded POST /api/read-bulk batches. Never fall back to
  // one direct GET per image, since that can create hundreds of requests.
  if (forageStorage.realStorage instanceof NodeStorage) {
    const nodeStorage = forageStorage.realStorage as NodeStorage;
    try {
      const directLocs = uncachedLocs.filter((loc) =>
        /^(https?:|data:|blob:|\/)/i.test(loc),
      );
      const assetLocs = uncachedLocs.filter((loc) => !directLocs.includes(loc));

      if (assetLocs.length > 0) {
        const bulkOpts = {
          size: options.size,
          thumbnail: options.thumbnail,
          width:
            options.width ??
            (options.size === "display"
              ? 512
              : options.size === "thumb" || options.thumbnail
                ? 128
                : undefined),
          height:
            options.height ??
            (options.size === "display"
              ? 768
              : options.size === "thumb" || options.thumbnail
                ? 128
                : undefined),
        };
        for (
          let offset = 0;
          offset < assetLocs.length;
          offset += NODE_IMAGE_BATCH_SIZE
        ) {
          const batch = assetLocs.slice(offset, offset + NODE_IMAGE_BATCH_SIZE);
          try {
            const itemsMap = await nodeStorage.getItems(
              batch,
              undefined,
              bulkOpts,
            );
            for (const loc of batch) {
              const buf = itemsMap.get(loc);
              const cacheKey = `${sizeKey}_${loc}`;
              if (buf && buf.length > 0) {
                const mime =
                  options.size === "display" ||
                  options.size === "thumb" ||
                  options.thumbnail
                    ? "image/webp"
                    : getMimeType(loc);
                const blob = new Blob([buf as any], { type: mime });
                const blobUrl = URL.createObjectURL(blob);
                fullImageBlobCache.set(cacheKey, blobUrl);
                result.set(loc, blobUrl);
              } else {
                setMissing(loc);
              }
            }
          } catch (error) {
            console.error("Failed to load character image batch", error);
            for (const loc of batch) {
              setMissing(loc);
            }
          }
        }
      }

      for (const loc of directLocs) {
        const src = loc;
        const cacheKey = `${sizeKey}_${loc}`;
        fullImageBlobCache.set(cacheKey, src);
        result.set(loc, src);
      }
      return result;
    } catch (e) {
      console.error("Failed to batch load character images", e);
      for (const loc of uncachedLocs) {
        setMissing(loc);
      }
      return result;
    }
  }

  // Fallback for Tauri, Web, OPFS, etc.: load in parallel
  await Promise.all(
    uncachedLocs.map(async (loc) => {
      try {
        const src = await getFileSrc(loc, options);
        const cacheKey = `${sizeKey}_${loc}`;
        if (src) {
          fullImageBlobCache.set(cacheKey, src);
          result.set(loc, src);
        }
      } catch (err) {
        console.error(err);
      }
    }),
  );

  return result;
}
