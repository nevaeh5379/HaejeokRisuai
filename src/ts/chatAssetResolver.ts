import { getModuleAssets } from "./process/modules";

export type ChatAssetTuple = [string, string, string];

type NormalizedAsset = {
  name: string;
  path: string;
};

export interface ChatAssetNameIndex {
  exact: Map<string, string>;
  sorted: NormalizedAsset[];
}

type AssetCharacter = {
  additionalAssets?: ChatAssetTuple[];
};

type ResolverCacheEntry = {
  additionalAssets: ChatAssetTuple[] | undefined;
  additionalAssetCount: number;
  expiresAt: number;
  index: ChatAssetNameIndex;
};

const CACHE_TTL_MS = 1500;
const resolverCache = new WeakMap<object, ResolverCacheEntry>();

export function createChatAssetNameIndex(
  assets: readonly ChatAssetTuple[],
): ChatAssetNameIndex {
  const normalized: NormalizedAsset[] = [];
  const exact = new Map<string, string>();
  for (const asset of assets) {
    const name = String(asset?.[0] ?? "").toLocaleLowerCase();
    const path = asset?.[1];
    if (!name || !path) continue;
    normalized.push({ name, path });
    exact.set(name, path);
  }
  normalized.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return { exact, sorted: normalized };
}

function lowerBoundByName(assets: readonly NormalizedAsset[], prefix: string): number {
  let lo = 0;
  let hi = assets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (assets[mid].name < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function resolveChatAssetFromIndex(
  index: ChatAssetNameIndex,
  rawName: string,
  distance: (left: string, right: string) => number,
): string | undefined {
  const name = rawName.toLocaleLowerCase();
  const exact = index.exact.get(name);
  if (exact) return exact;

  const extensionIndex = name.lastIndexOf(".");
  const prefix = extensionIndex > 0 ? name.substring(0, extensionIndex) : "";
  if (!prefix) return undefined;

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPath: string | undefined;
  for (
    let i = lowerBoundByName(index.sorted, prefix);
    i < index.sorted.length && index.sorted[i].name.startsWith(prefix);
    i++
  ) {
    const candidate = index.sorted[i];
    const candidateDistance = distance(name, candidate.name);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestPath = candidate.path;
    }
  }
  return bestPath;
}

export function resolveCurrentChatAsset(
  character: AssetCharacter,
  rawName: string,
  distance: (left: string, right: string) => number,
): string | undefined {
  if (!character || typeof character !== "object") return undefined;
  const now = Date.now();
  const additionalAssets = character.additionalAssets;
  const additionalAssetCount = additionalAssets?.length ?? 0;
  let cached = resolverCache.get(character as object);
  if (
    !cached ||
    cached.additionalAssets !== additionalAssets ||
    cached.additionalAssetCount !== additionalAssetCount ||
    cached.expiresAt <= now
  ) {
    const assets = getModuleAssets().concat(additionalAssets ?? []);
    cached = {
      additionalAssets,
      additionalAssetCount,
      expiresAt: now + CACHE_TTL_MS,
      index: createChatAssetNameIndex(assets),
    };
    resolverCache.set(character as object, cached);
  }
  return resolveChatAssetFromIndex(cached.index, rawName, distance);
}
