// Explicit counts/MB take precedence, including in low-spec mode, so the value
// shown in settings is the actual limit. Defaults retain the raised budgets.
export const IMAGE_CACHE_LIMITS = {
  assetCacheEntries: { standard: 128, mobile: 64, lowSpec: 32, max: 4096 },
  assetCacheSizeMB: { standard: 48, mobile: 24, lowSpec: 16, max: 512 },
  thumbnailCacheEntries: { standard: 192, mobile: 192, lowSpec: 48, max: 4096 },
  thumbnailCacheSizeMB: { standard: 16, mobile: 16, lowSpec: 6, max: 128 },
  characterImageCacheEntries: {
    standard: 256,
    mobile: 128,
    lowSpec: 64,
    max: 4096,
  },
  fullResolutionImageCacheEntries: {
    standard: 24,
    mobile: 12,
    lowSpec: 8,
    max: 128,
  },
} as const;

export type ImageCacheLimitKey = keyof typeof IMAGE_CACHE_LIMITS;
export type ImageCacheSettings = Partial<Record<ImageCacheLimitKey, number>> & {
  lowSpecMode?: boolean;
};

export const IMAGE_CACHE_LIMIT_KEYS = Object.keys(
  IMAGE_CACHE_LIMITS,
) as ImageCacheLimitKey[];

export function getImageCacheLimit(
  settings: ImageCacheSettings,
  key: ImageCacheLimitKey,
  mobile = false,
): number {
  const value = settings[key];
  const limits = IMAGE_CACHE_LIMITS[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return settings.lowSpecMode
      ? limits.lowSpec
      : mobile
        ? limits.mobile
        : limits.standard;
  }
  return Math.min(limits.max, Math.floor(value));
}

export function normalizeImageCacheSettings(
  settings: ImageCacheSettings,
  mobile = false,
): void {
  for (const key of IMAGE_CACHE_LIMIT_KEYS) {
    settings[key] = getImageCacheLimit(settings, key, mobile);
  }
}
