import localforage from "localforage";
import { isNodeServer } from "../../platform";
import { forageStorage } from "../../globalApi.svelte";
import { NodeStorage } from "../../storage/files/nodeStorage";
import { BoundedCache } from "../../memory/boundedCache";
import {
  decodeInlayAssetBackup,
  encodeInlayAssetBackup,
  type InlayAsset,
} from "./inlayCodec";

export const INLAY_BACKUP_PREFIX = "inlay_";
export const INLAY_BACKUP_SUFFIX = ".risuinlay";

export function getInlayServerKey(id: string) {
  return `${INLAY_BACKUP_PREFIX}${id}${INLAY_BACKUP_SUFFIX}`;
}

export function parseInlayServerKey(key: string): string | null {
  if (
    !key.startsWith(INLAY_BACKUP_PREFIX) ||
    !key.endsWith(INLAY_BACKUP_SUFFIX)
  ) {
    return null;
  }
  return key.slice(
    INLAY_BACKUP_PREFIX.length,
    key.length - INLAY_BACKUP_SUFFIX.length,
  );
}

const MAX_CACHE_BYTES = 128 * 1024 * 1024;

const cacheStorage = localforage.createInstance({
  name: "inlay",
  storeName: "inlay",
});

const memoryCache = new Map<string, InlayAsset>();
let memoryCacheWeight = 0;
const remoteReadInflight = new Map<string, Promise<InlayAsset | null>>();

function weighAsset(asset: InlayAsset): number {
  if (asset.data instanceof Blob) return Math.max(1, asset.data.size);
  return Math.max(1, asset.data.length);
}

function touchMemoryCache(id: string, asset: InlayAsset) {
  const existing = memoryCache.get(id);
  if (existing) {
    memoryCacheWeight -= weighAsset(existing);
  } else if (memoryCache.size >= 512) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = memoryCache.get(oldest)!;
      memoryCacheWeight -= weighAsset(evicted);
      memoryCache.delete(oldest);
    }
  }
  memoryCache.set(id, asset);
  memoryCacheWeight += weighAsset(asset);
}

function evictForCacheLimit(incomingWeight: number) {
  while (
    memoryCache.size > 0 &&
    memoryCacheWeight + incomingWeight > MAX_CACHE_BYTES
  ) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) return;
    const evicted = memoryCache.get(oldest)!;
    memoryCacheWeight -= weighAsset(evicted);
    memoryCache.delete(oldest);
  }
}

function rememberInCache(id: string, asset: InlayAsset) {
  const weight = weighAsset(asset);
  evictForCacheLimit(weight);
  touchMemoryCache(id, asset);
}

let remoteAvailable: boolean | null = null;

export async function getRemoteNodeStorage(): Promise<NodeStorage | null> {
  if (!isNodeServer) return null;
  if (remoteAvailable === false) return null;
  try {
    await forageStorage.Init();
    if (forageStorage.realStorage instanceof NodeStorage) {
      remoteAvailable = true;
      return forageStorage.realStorage;
    }
  } catch {
    // fall through
  }
  remoteAvailable = false;
  return null;
}

export function resetRemoteAvailability() {
  remoteAvailable = null;
}

export async function putRemoteInlayAsset(id: string, asset: InlayAsset) {
  const storage = await getRemoteNodeStorage();
  if (!storage) {
    throw new Error("Remote inlay storage is unavailable");
  }
  const encoded = await encodeInlayAssetBackup(asset);
  await storage.setItem(getInlayServerKey(id), encoded);
}

export async function fetchRemoteInlayAsset(
  id: string,
): Promise<InlayAsset | null> {
  const storage = await getRemoteNodeStorage();
  if (!storage) return null;

  const memory = memoryCache.get(id);
  if (memory) return memory;

  const inflight = remoteReadInflight.get(id);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const data = await storage.getItem(getInlayServerKey(id));
      if (!data || data.byteLength === 0) return null;
      const asset = decodeInlayAssetBackup(data);
      const memoryHit = memoryCache.get(id);
      if (!memoryHit) {
        rememberInCache(id, asset);
      }
      return asset;
    } finally {
      remoteReadInflight.delete(id);
    }
  })();
  remoteReadInflight.set(id, task);
  return task;
}

export async function listRemoteInlayIds(): Promise<string[]> {
  const storage = await getRemoteNodeStorage();
  if (!storage) return [];
  const keys = await storage.keys(INLAY_BACKUP_PREFIX);
  const ids: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const id = parseInlayServerKey(key);
    if (id !== null) ids.push(id);
  }
  return ids;
}

export async function removeRemoteInlayAsset(id: string) {
  const storage = await getRemoteNodeStorage();
  if (!storage) return;
  await storage.removeItem(getInlayServerKey(id));
  memoryCache.delete(id);
}

export async function clearInlayCache() {
  try {
    await cacheStorage.clear();
  } catch {}
  memoryCache.clear();
  memoryCacheWeight = 0;
}

export async function readCachedInlay(id: string): Promise<InlayAsset | null> {
  const memory = memoryCache.get(id);
  if (memory) return memory;
  const cached = await cacheStorage.getItem<InlayAsset | null>(id);
  if (cached) {
    rememberInCache(id, cached);
  }
  return cached;
}

export async function writeCachedInlay(id: string, asset: InlayAsset) {
  rememberInCache(id, asset);
  try {
    await cacheStorage.setItem(id, asset);
  } catch {}
}

export async function removeCachedInlay(id: string) {
  memoryCache.delete(id);
  try {
    await cacheStorage.removeItem(id);
  } catch {}
}

export async function listInlayCacheEntries(): Promise<[string, InlayAsset][]> {
  const entries: [string, InlayAsset][] = [];
  await cacheStorage.iterate<InlayAsset, void>((value, key) => {
    entries.push([key, value]);
  });
  return entries;
}
