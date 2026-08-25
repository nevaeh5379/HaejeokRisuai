import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { forageStorage, getFileSrc } from "./globalApi.svelte";
import { NodeStorage } from "./storage/nodeStorage";
import { getMimeType } from "./media/mimeType";

// Character images can be multi-megabyte blobs. Keep Map compatibility for the
// existing UI while bounding the number of decoded/object-URL resources retained
// as users browse through many characters.
class CharacterImageCache extends Map<string, string> {
  private pinnedKeys = new Map<string, number>();

  private isFullResolutionKey(key: string): boolean {
    return !key.startsWith("thumb_") && !key.startsWith("display_");
  }

  private isPinned(key: string): boolean {
    return (this.pinnedKeys.get(key) ?? 0) > 0;
  }

  pin(key: string): void {
    this.pinnedKeys.set(key, (this.pinnedKeys.get(key) ?? 0) + 1);
  }

  unpin(key: string): void {
    const count = this.pinnedKeys.get(key) ?? 0;
    if (count <= 1) this.pinnedKeys.delete(key);
    else this.pinnedKeys.set(key, count - 1);
    this.trim();
  }

  private revokeIfUnused(value: string): void {
    if (!value.startsWith("blob:")) return;
    for (const other of super.values()) {
      if (other === value) return;
    }
    if (
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(value);
    }
  }

  override get(key: string): string | undefined {
    const value = super.get(key);
    if (value === undefined) return undefined;
    // Promote on access so frequently revisited avatars survive eviction.
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: string, value: string): this {
    const previous = super.get(key);
    if (previous !== undefined) {
      super.delete(key);
      if (previous !== value) this.revokeIfUnused(previous);
    }
    super.set(key, value);
    this.trim();
    return this;
  }

  override delete(key: string): boolean {
    const value = super.get(key);
    if (value === undefined) return false;
    const deleted = super.delete(key);
    if (deleted) this.revokeIfUnused(value);
    return deleted;
  }

  override clear(): void {
    const urls = new Set(
      [...super.values()].filter((value) => value.startsWith("blob:")),
    );
    super.clear();
    this.pinnedKeys.clear();
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const url of urls) URL.revokeObjectURL(url);
    }
  }

  private trim(): void {
    const maxEntries = settingsStore.state.lowSpecMode ? 32 : 128;
    const maxFullResolution = settingsStore.state.lowSpecMode ? 4 : 12;
    // Pinned entries are the currently rendered working set. They must not consume
    // the disposable full-resolution LRU budget, otherwise any newly loaded preview
    // can be inserted and immediately revoked while the UI is still using its URL.
    let evictableFullResolutionCount = 0;
    for (const key of super.keys()) {
      if (this.isFullResolutionKey(key) && !this.isPinned(key)) {
        evictableFullResolutionCount += 1;
      }
    }
    if (evictableFullResolutionCount > maxFullResolution) {
      for (const key of [...super.keys()]) {
        if (!this.isFullResolutionKey(key) || this.isPinned(key)) continue;
        this.delete(key);
        evictableFullResolutionCount -= 1;
        if (evictableFullResolutionCount <= maxFullResolution) break;
      }
    }
    while (this.size > maxEntries) {
      const oldest = [...super.keys()].find((key) => !this.isPinned(key));
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}

export const fullImageBlobCache = new CharacterImageCache();
const characterImagePreloads = new Map<string, Promise<void>>();

export function pinCharacterImageCache(key: string): void {
  fullImageBlobCache.pin(key);
}

export function unpinCharacterImageCache(key: string): void {
  fullImageBlobCache.unpin(key);
}

export function releaseCharacterImageCache(prefix: string): void {
  for (const key of [...fullImageBlobCache.keys()]) {
    if (key.startsWith(prefix)) fullImageBlobCache.delete(key);
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
  })().catch(() => undefined);

  characterImagePreloads.set(loc, preload);
  void preload.finally(() => {
    if (characterImagePreloads.get(loc) === preload) {
      characterImagePreloads.delete(loc);
    }
  });
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

  const fileSource = await getFileSrc(loc, {
    ...options,
    // Character images already live in persistent asset storage. Do not copy
    // multi-megabyte avatars into Service Worker CacheStorage again during
    // navigation; keep the decoded/object URL in the bounded memory cache.
    transient: true,
  });
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
  const size = options.size ?? (options.thumbnail ? "thumb" : "full");
  const wantsOriginal =
    size === "full" &&
    options.thumbnail !== true &&
    options.width === undefined &&
    options.height === undefined;

  if (!wantsOriginal) {
    return getCharImagesBatch(locs, options);
  }

  const result = new Map<string, string>();
  await Promise.all(
    locs.map(async (loc) => {
      if (!loc) return;
      if (settingsStore.state.hideAllImages) {
        result.set(loc, "/none.webp");
        return;
      }
      if (/^(https?:|data:|blob:|\/)/i.test(loc)) {
        result.set(loc, loc);
        return;
      }
      try {
        const src = await getFileSrc(loc);
        result.set(loc, src || "/none.webp");
      } catch (error) {
        console.error("Failed to load original asset", error);
        result.set(loc, "/none.webp");
      }
    }),
  );
  return result;
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
        const src = await getFileSrc(loc, {
          thumbnail:
            options.thumbnail === true || options.size === "thumb",
          transient: true,
        });
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
