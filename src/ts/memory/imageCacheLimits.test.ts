import { describe, expect, it, vi } from "vitest";
import { BoundedCache } from "./boundedCache";
import {
  getImageCacheLimit,
  normalizeImageCacheSettings,
  type ImageCacheSettings,
} from "./imageCacheLimits";

describe("image cache limits", () => {
  it.each([undefined, null, "4", NaN, Infinity, -Infinity, 0, -1])(
    "uses the higher default for invalid input %s",
    (value) =>
      expect(
        getImageCacheLimit(
          { assetCacheEntries: value } as ImageCacheSettings,
          "assetCacheEntries",
          true,
        ),
      ).toBe(64),
  );

  it("retains the raised mobile defaults and independently normalizes each limit", () => {
    const settings: ImageCacheSettings = {};
    normalizeImageCacheSettings(settings, true);
    expect(settings).toEqual({
      assetCacheEntries: 64,
      assetCacheSizeMB: 24,
      thumbnailCacheEntries: 192,
      thumbnailCacheSizeMB: 16,
      characterImageCacheEntries: 128,
      fullResolutionImageCacheEntries: 12,
      chatParserCacheEntries: 256,
    });
    expect(
      getImageCacheLimit({ assetCacheEntries: 80.9 }, "assetCacheEntries"),
    ).toBe(80);
    expect(
      getImageCacheLimit({ assetCacheSizeMB: 9999 }, "assetCacheSizeMB"),
    ).toBe(512);
    expect(
      getImageCacheLimit(
        { lowSpecMode: true },
        "fullResolutionImageCacheEntries",
      ),
    ).toBe(8);
    expect(
      getImageCacheLimit(
        { lowSpecMode: true },
        "chatParserCacheEntries",
      ),
    ).toBe(64);
    expect(
      getImageCacheLimit(
        { lowSpecMode: true, assetCacheEntries: 80 },
        "assetCacheEntries",
        true,
      ),
    ).toBe(80);
  });

  it("applies count and byte budgets dynamically while retaining bounded eviction", () => {
    const settings = { assetCacheEntries: 4, assetCacheSizeMB: 20 };
    const MB = 1024 * 1024;
    const onEvict = vi.fn();
    const cache = new BoundedCache<string, number>({
      maxEntries: () => getImageCacheLimit(settings, "assetCacheEntries"),
      maxWeight: () => getImageCacheLimit(settings, "assetCacheSizeMB") * MB,
      weigh: (bytes) => bytes,
      onEvict,
    });
    for (let i = 0; i < 5; i++) cache.set(String(i), MB);
    expect(cache.size).toBe(4);
    expect(cache.has("0")).toBe(false);
    cache.set("large", 18 * MB);
    expect(cache.weight).toBe(20 * MB);
    expect(cache.has("large")).toBe(true);
    settings.assetCacheSizeMB = 10;
    cache.set("latest", 2 * MB);
    expect(cache.weight).toBe(2 * MB);
    expect(cache.has("latest")).toBe(true);
    expect(onEvict).toHaveBeenCalledWith(18 * MB, "large");
  });
});
