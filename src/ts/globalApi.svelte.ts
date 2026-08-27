import {
  writeFile,
  BaseDirectory,
  readFile,
  exists,
  mkdir,
  readDir,
  remove,
} from "@tauri-apps/plugin-fs";
import { changeFullscreen, checkNullish, sleep } from "./util";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import { appDataDir, join } from "@tauri-apps/api/path";
import { get } from "svelte/store";
import { open } from "@tauri-apps/plugin-shell";
import type { Database, character, groupChat } from "./storage/schema";
import { defaultSdDataFunc } from "./storage/presetDefaults";
import { appVer, appSubVer } from "./appVersion";
import { installDatabase } from "./storage/databaseLifecycle";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { checkRisuUpdate } from "./update";
import {
  MobileGUI,
  botMakerMode,
  selectedCharID,
  loadedStore,
  LoadingStatusState,
  ReloadGUIPointer,
  bodyIntercepterStore,
  saving,
} from "./stores.svelte";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { moduleStore } from "./stores/domain/moduleStore.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";
import {
  alertConfirm,
  alertError,
  alertMd,
  alertNormal,
  alertSelect,
  alertTOS,
  waitAlert,
} from "./alert";
import { hasher } from "./hash";
import {
  defaultJailbreak,
  defaultMainPrompt,
  oldJailbreak,
  oldMainPrompt,
} from "./storage/defaultPrompts";
import { decodeRisuSave, encodeRisuSaveLegacy } from "./storage/risuSave";
import { AutoStorage } from "./storage/autoStorage";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { initMobileGesture } from "./hotkey";
import { fetch as TauriHTTPFetch } from "@tauri-apps/plugin-http";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { isCapacitor, isTauri, isNodeServer } from "./platform";
import { isLocalNetworkUrl } from "./network/localNetwork";
import {
  decodeProxyJobWsChunk,
  formatProxyStreamErrorMessage,
  parseProxyJobWsEvent,
} from "./network/proxyJobWs";
import {
  DurableModelJobUnavailableError,
  fetchViaDurableModelJob,
  getDurableGenerationContext,
} from "./network/durableModelJobs";
import { getNodeServerProxyAuth, NodeStorage } from "./storage/nodeStorage";
import { generateClientThumbnail } from "./media/thumbnail";
import { getMimeType } from "./media/mimeType";
import { BoundedCache } from "./memory/boundedCache";
import { releaseInactiveChatMessages } from "./stores/domain/messageStore.svelte";

export const forageStorage = new AutoStorage();

interface NativeImagePlugin {
  readThumbnail(options: {
    key: string;
    maxWidth: number;
    maxHeight: number;
  }): Promise<{ path: string; bytes: number; mimeType: string }>;
  prepareThumbnails(options: {
    keys: string[];
    maxWidth: number;
    maxHeight: number;
  }): Promise<{
    total: number;
    created: number;
    cached: number;
    missing: number;
    failed: number;
    ready: string[];
  }>;
}

const nativeImage = isCapacitor
  ? registerPlugin<NativeImagePlugin>("NativeImage")
  : undefined;

const appWindow = isTauri ? getCurrentWebviewWindow() : null;

interface fetchLog {
  body: string;
  header: string;
  response: string;
  success: boolean;
  date: string;
  url: string;
  responseType?: string;
  chatId?: string;
  status?: number;
}

let fetchLog: fetchLog[] = [];

export async function downloadFile(
  name: string,
  dat: Uint8Array | ArrayBuffer | string,
) {
  if (typeof dat === "string") {
    dat = Buffer.from(dat, "utf-8");
  }
  const data = new Uint8Array(dat);
  const downloadURL = (data: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = data;
    a.download = fileName;
    document.body.appendChild(a);
    a.style.display = "none";
    a.click();
    a.remove();
  };

  if (isTauri) {
    await writeFile(name, data, { baseDir: BaseDirectory.Download });
  } else {
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    downloadURL(url, name);

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10000);
  }
}

let fileCache: {
  origin: string[];
  res: (Uint8Array | "loading" | "done")[];
} = {
  origin: [],
  res: [],
};

let pathCache: { [key: string]: string } = {};
let checkedPaths: string[] = [];

const revokeObjectUrl = (url: string) => {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
};
const tauriThumbnailUrls = new BoundedCache<string, string>({
  maxEntries: () => (settingsStore.state.lowSpecMode ? 24 : 96),
  onEvict: revokeObjectUrl,
});

/**
 * Gets the source URL of a file.
 *
 * @param {string} loc - The location of the file.
 * @returns {Promise<string>} - A promise that resolves to the source URL of the file.
 */
class ThumbnailBatchLoader {
  private cacheWeights = new Map<string, number>();
  private cache = new BoundedCache<string, string>({
    maxEntries: () => (settingsStore.state.lowSpecMode ? 24 : 96),
    maxWeight: () => (settingsStore.state.lowSpecMode ? 3 : 8) * 1024 * 1024,
    weigh: (_url, loc) => this.cacheWeights.get(loc) ?? 1,
    onEvict: (url, loc) => {
      this.cacheWeights.delete(loc);
      revokeObjectUrl(url);
    },
  });
  private pending = new Map<
    string,
    {
      promise: Promise<string>;
      resolve: (url: string) => void;
      reject: (err: any) => void;
    }
  >();
  private queue = new Set<string>();
  private flushScheduled = false;

  load(loc: string): Promise<string> {
    if (!loc || loc === "") return Promise.resolve("");

    // 1. Memory cache hit (instant)
    if (this.cache.has(loc)) {
      return Promise.resolve(this.cache.get(loc)!);
    }

    // 2. Already in-flight
    if (this.pending.has(loc)) {
      return this.pending.get(loc)!.promise;
    }

    // 3. Queue for batching
    let resolveFn!: (url: string) => void;
    let rejectFn!: (err: any) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.pending.set(loc, { promise, resolve: resolveFn, reject: rejectFn });
    this.queue.add(loc);
    this.scheduleFlush();

    return promise;
  }

  preload(keys: string[]) {
    const toLoad = keys.filter(
      (k) => k && !this.cache.has(k) && !this.pending.has(k),
    );
    if (toLoad.length === 0) return;

    for (const loc of toLoad) {
      let resolveFn!: (url: string) => void;
      let rejectFn!: (err: any) => void;
      const promise = new Promise<string>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      this.pending.set(loc, { promise, resolve: resolveFn, reject: rejectFn });
      this.queue.add(loc);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    // Debounce window (10ms) to coalesce all components mounting in this tick
    setTimeout(() => {
      this.flush();
    }, 10);
  }

  private async flush() {
    this.flushScheduled = false;
    if (this.queue.size === 0) return;

    const batchKeys = Array.from(this.queue);
    this.queue.clear();

    try {
      if (forageStorage.realStorage instanceof NodeStorage) {
        const nodeStorage = forageStorage.realStorage as NodeStorage;
        const maxBatchSize = 48;
        for (
          let offset = 0;
          offset < batchKeys.length;
          offset += maxBatchSize
        ) {
          const keys = batchKeys.slice(offset, offset + maxBatchSize);
          let results = new Map<string, Buffer>();
          try {
            results = await nodeStorage.getItems(keys, undefined, {
              thumbnail: true,
            });
          } catch (error) {
            console.error("Failed to load thumbnail batch", error);
          }

          for (const loc of keys) {
            const buf = results.get(loc);
            const pendingItem = this.pending.get(loc);
            if (buf && buf.length > 0) {
              const blob = new Blob([buf as any], { type: "image/webp" });
              const blobUrl = URL.createObjectURL(blob);
              this.cacheWeights.set(loc, buf.byteLength);
              this.cache.set(loc, blobUrl);
              pendingItem?.resolve(blobUrl);
            } else {
              this.cacheWeights.set(loc, 1);
              this.cache.set(loc, "/none.webp");
              pendingItem?.resolve("/none.webp");
            }
            this.pending.delete(loc);
          }
        }
      } else {
        for (const loc of batchKeys) {
          const pendingItem = this.pending.get(loc);
          this.pending.delete(loc);
          pendingItem?.resolve("");
        }
      }
    } catch (err) {
      for (const loc of batchKeys) {
        const pendingItem = this.pending.get(loc);
        this.pending.delete(loc);
        this.cacheWeights.set(loc, 1);
        this.cache.set(loc, "/none.webp");
        pendingItem?.resolve("/none.webp");
      }
    }
  }

  invalidate(loc?: string) {
    if (loc) {
      this.cache.delete(loc);
      this.pending.delete(loc);
      this.queue.delete(loc);
    } else {
      this.cache.clear();
      this.cacheWeights.clear();
      this.pending.clear();
      this.queue.clear();
    }
  }
}

export const thumbnailBatchLoader = new ThumbnailBatchLoader();
export function preloadThumbnails(keys: string[]) {
  thumbnailBatchLoader.preload(keys);
}

const preparedNativeThumbnailKeys = new Set<string>();

function nativeThumbnailCacheKey(loc: string, width: number, height: number) {
  return `${width}x${height}:${loc}`;
}

function encodeNativeAssetKey(loc: string) {
  return Buffer.from(loc, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function getPreparedNativeThumbnailSrc(
  loc: string,
  width = 128,
  height = 128,
): string | undefined {
  if (!isCapacitor || !preparedNativeThumbnailKeys.has(nativeThumbnailCacheKey(loc, width, height))) {
    return undefined;
  }
  return `/_risu_thumb_/${width}x${height}/${encodeNativeAssetKey(loc)}`;
}

export async function prepareNativeThumbnails(
  keys: string[],
  maxWidth = 128,
  maxHeight = 128,
) {
  if (!isCapacitor || !nativeImage || keys.length === 0) {
    return { total: 0, created: 0, cached: 0, missing: 0, failed: 0, ready: [] as string[] };
  }
  const result = await nativeImage.prepareThumbnails({ keys, maxWidth, maxHeight });
  for (const loc of result.ready) {
    preparedNativeThumbnailKeys.add(nativeThumbnailCacheKey(loc, maxWidth, maxHeight));
  }
  return result;
}

export function invalidateThumbnailCache(loc?: string) {
  thumbnailBatchLoader.invalidate(loc);
}

const registeredSwCaches = new Set<string>();
const browserAssetWeights = new Map<string, number>();
const browserAssetUrls = new BoundedCache<string, string>({
  maxEntries: () =>
    settingsStore.state.lowSpecMode ? 16 : isCapacitor ? 32 : 64,
  maxWeight: () =>
    (settingsStore.state.lowSpecMode ? 8 : isCapacitor ? 12 : 24) *
    1024 *
    1024,
  weigh: (_url, key) => browserAssetWeights.get(key) ?? 1,
  onEvict: (url, key) => {
    browserAssetWeights.delete(key);
    revokeObjectUrl(url);
  },
});

export async function getFileSrc(
  loc: string,
  options?: {
    thumbnail?: boolean;
    display?: boolean;
    transient?: boolean;
    width?: number;
    height?: number;
  },
) {
  if (!loc || loc === "") {
    return "";
  }
  const isThumb = options?.thumbnail ?? false;
  const isDisplay = options?.display ?? false;
  const resizeKey =
    isCapacitor &&
    (isThumb || isDisplay) &&
    (options?.width !== undefined || options?.height !== undefined)
      ? `_${options?.width ?? 0}x${options?.height ?? 0}`
      : "";
  const cacheVariantKey = isThumb
    ? `thumb${resizeKey}_${loc}`
    : isDisplay
      ? `display${resizeKey}_${loc}`
      : loc;
  if (isTauri) {
    if (loc.startsWith("assets")) {
      if (appDataDirPath === "") {
        appDataDirPath = await appDataDir();
      }
      const cached = isThumb ? tauriThumbnailUrls.get(loc) : pathCache[loc];
      if (cached) {
        return cached.startsWith("blob:") ? cached : convertFileSrc(cached);
      } else {
        const joined = await join(appDataDirPath, loc);
        if (isThumb) {
          try {
            const originalData = await readFile(joined);
            const thumbData = await generateClientThumbnail(originalData, 128);
            const blob = new Blob([thumbData as any], { type: "image/webp" });
            const url = URL.createObjectURL(blob);
            tauriThumbnailUrls.set(loc, url);
            return url;
          } catch (e) {
            tauriThumbnailUrls.set(loc, joined);
            return convertFileSrc(joined);
          }
        }
        pathCache[loc] = joined;
        return convertFileSrc(joined);
      }
    }
    return convertFileSrc(loc);
  }
  if (isNodeServer || forageStorage.realStorage instanceof NodeStorage) {
    if (isThumb) {
      return await thumbnailBatchLoader.load(loc);
    }
    const nodeStorage = forageStorage.realStorage as NodeStorage;
    return await nodeStorage.getDirectUrl(loc, options);
  }
  try {
    const cacheKey = cacheVariantKey;
    if (usingSw && !options?.transient) {
      const encoded = Buffer.from(cacheKey, "utf-8").toString("hex");
      if (registeredSwCaches.has(cacheKey)) {
        return "/sw/img/" + encoded;
      }
      let ind = fileCache.origin.indexOf(cacheKey);
      if (ind === -1) {
        ind = fileCache.origin.length;
        fileCache.origin.push(cacheKey);
        fileCache.res.push("loading");
        try {
          const raw = (await forageStorage.getItem(
            loc,
          )) as unknown as Uint8Array;
          let f: Uint8Array | null = raw;
          let contentType = isThumb ? "image/webp" : getMimeType(loc);
          if (isThumb && raw) {
            f = await generateClientThumbnail(raw, 128);
            contentType = "image/webp";
          }

          if (f) {
            await fetch("/sw/register/" + encoded, {
              method: "POST",
              headers: {
                "content-type": contentType,
              },
              body: f as any,
            });
            registeredSwCaches.add(cacheKey);
          }
          fileCache.res[ind] = "done";
          return "/sw/img/" + encoded;
        } catch (error) {}
      } else {
        const f = fileCache.res[ind];
        if (f === "loading") {
          while (fileCache.res[ind] === "loading") {
            await sleep(10);
          }
        }
        return "/sw/img/" + encoded;
      }
    } else {
      const cacheKey = cacheVariantKey;
      const cachedUrl = options?.transient
        ? undefined
        : browserAssetUrls.get(cacheKey);
      if (cachedUrl) return cachedUrl;
      const isNativeImageAsset =
        isCapacitor &&
        nativeImage &&
        /\.(?:png|jpe?g|webp|avif|heic|heif|bmp)$/i.test(loc);
      if (isNativeImageAsset && !isThumb && !isDisplay) {
        // Character assets are content-addressed. Serve originals from an app-owned
        // WebView route so we avoid one Capacitor bridge call per image and avoid
        // WebViewLocalServer's .bin MIME sniffing + Cache-Control: no-cache path.
        const url = `/_risu_asset_/${encodeNativeAssetKey(loc)}`;
        if (!options?.transient) {
          browserAssetWeights.set(cacheKey, 1);
          browserAssetUrls.set(cacheKey, url);
        }
        return url;
      }
      if (isNativeImageAsset && isThumb) {
        const width = options?.width ?? 128;
        const height = options?.height ?? 128;
        const preparedUrl = getPreparedNativeThumbnailSrc(loc, width, height);
        if (preparedUrl) {
          if (!options?.transient) {
            browserAssetWeights.set(cacheKey, 1);
            browserAssetUrls.set(cacheKey, preparedUrl);
          }
          return preparedUrl;
        }
      }
      if (isNativeImageAsset && (isThumb || isDisplay)) {
        try {
          const nativeResult = await nativeImage.readThumbnail({
            key: loc,
            maxWidth: options?.width ?? (isThumb ? 128 : 1024),
            maxHeight: options?.height ?? (isThumb ? 128 : 1536),
          });
          const url = Capacitor.convertFileSrc(nativeResult.path);
          if (!options?.transient) {
            browserAssetWeights.set(cacheKey, nativeResult.bytes);
            browserAssetUrls.set(cacheKey, url);
          }
          return url;
        } catch (error) {
          console.warn("Native image downsampling failed; using WebView fallback", error);
        }
      }
      const raw = (await forageStorage.getItem(loc)) as unknown as Uint8Array;
      if (!raw) return "";
      const data = isThumb ? await generateClientThumbnail(raw, 128) : raw;
      const mime = isThumb ? "image/webp" : getMimeType(loc);
      const url = URL.createObjectURL(new Blob([data as any], { type: mime }));
      if (!options?.transient) {
        browserAssetWeights.set(cacheKey, data.byteLength);
        browserAssetUrls.set(cacheKey, url);
      }
      return url;
    }
  } catch (error) {
    console.error(error);
    return "";
  }
}

let appDataDirPath = "";

/**
 * Reads an image file and returns its data.
 *
 * @param {string} data - The path to the image file.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the image file.
 */
export async function readImage(data: string) {
  if (isTauri) {
    if (data.startsWith("assets")) {
      if (appDataDirPath === "") {
        appDataDirPath = await appDataDir();
      }
      return await readFile(await join(appDataDirPath, data));
    }
    return await readFile(data);
  } else {
    return (await forageStorage.getItem(data)) as unknown as Uint8Array;
  }
}

/**
 * Saves an asset file with the given data, custom ID, and file name.
 *
 * @param {Uint8Array} data - The data of the asset file.
 * @param {string} [customId=''] - The custom ID for the asset file.
 * @param {string} [fileName=''] - The name of the asset file.
 * @returns {Promise<string>} - A promise that resolves to the path of the saved asset file.
 */
export async function saveAsset(
  data: Uint8Array,
  customId: string = "",
  fileName: string = "",
) {
  let id = "";
  if (customId !== "") {
    id = customId;
  } else {
    try {
      id = await hasher(data);
    } catch (error) {
      id = uuidv4();
    }
  }
  let fileExtension: string = "png";
  const nameSource = fileName || customId;
  if (nameSource && nameSource.includes(".")) {
    const ext = nameSource.split("?")[0].split(".").pop();
    if (ext) {
      fileExtension = ext;
    }
  }
  if (isTauri) {
    await writeFile(`assets/${id}.${fileExtension}`, data, {
      baseDir: BaseDirectory.AppData,
    });
    invalidateThumbnailCache(`assets/${id}.${fileExtension}`);
    return `assets/${id}.${fileExtension}`;
  } else {
    let form = `assets/${id}.${fileExtension}`;
    invalidateThumbnailCache(form);
    const replacer = await forageStorage.setItem(form, data);
    if (replacer) {
      invalidateThumbnailCache(replacer);
      return replacer;
    }
    return form;
  }
}

/**
 * Loads an asset file with the given ID.
 *
 * @param {string} id - The ID of the asset file to load.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the loaded asset file.
 */
export async function loadAsset(id: string) {
  if (isTauri) {
    return await readFile(id, { baseDir: BaseDirectory.AppData });
  } else {
    return (await forageStorage.getItem(id)) as unknown as Uint8Array;
  }
}

export { saving };

/**
 * Retrieves the database backups.
 *
 * @returns {Promise<number[]>} - A promise that resolves to an array of backup timestamps.
 */
export async function getDbBackups() {
  // SQL-only: return revision IDs from the SQL backend.
  // Legacy database.bin backups are no longer created or managed.
  try {
    const { getSqlStorage } = await import("./storage/sqlStorageFactory");
    const storage = await getSqlStorage();
    if (!storage.isEnabled()) {
      return [];
    }
    const revisions = await storage.listRevisions(20);
    return revisions.map((r) => r.id);
  } catch {
    return [];
  }
}

let usingSw = false;

export function setUsingSw(value: boolean) {
  usingSw = value;
}

/**
 * Retrieves fetch data for a given chat ID.
 *
 * @param {string} id - The chat ID to search for in the fetch log.
 * @returns {fetchLog | null} - The fetch log entry if found, otherwise null.
 */
export function getFetchData(id: string) {
  for (const log of fetchLog) {
    if (log.chatId === id) {
      return log;
    }
  }
  return null;
}

const knownHostes = ["localhost", "127.0.0.1", "0.0.0.0"];
const webLocalNetworkBlockedMessage =
  "웹에서는 사설망 직접 호출 불가. Tauri 또는 LAN Node self-host 사용";
const defaultProxyJobHeartbeatSec = 15;
const nodeProxy2Url = "/proxy2";

function buildTimeoutSignal(originalSignal?: AbortSignal, timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: originalSignal,
      cleanup: () => {
        /* no-op */
      },
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (originalSignal) {
    if (originalSignal.aborted) {
      controller.abort();
    } else {
      originalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      originalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Interface representing the arguments for the global fetch function.
 *
 * @interface GlobalFetchArgs
 * @property {boolean} [plainFetchForce] - Whether to force plain fetch.
 * @property {any} [body] - The body of the request.
 * @property {{ [key: string]: string }} [headers] - The headers of the request.
 * @property {boolean} [rawResponse] - Whether to return the raw response.
 * @property {'POST' | 'GET'} [method] - The HTTP method to use.
 * @property {AbortSignal} [abortSignal] - The abort signal to cancel the request.
 * @property {boolean} [useRisuToken] - Whether to use the Risu token.
 * @property {string} [chatId] - The chat ID associated with the request.
 */
export interface GlobalFetchArgs {
  plainFetchForce?: boolean;
  plainFetchDeforce?: boolean;
  body?: any;
  headers?: { [key: string]: string };
  rawResponse?: boolean;
  method?: "POST" | "GET";
  abortSignal?: AbortSignal;
  useRisuToken?: boolean;
  chatId?: string;
  interceptor?: string;
  requestTimeoutMs?: number;
  networkRoute?: "auto" | "local_network";
}

/**
 * Interface representing the result of the global fetch function.
 *
 * @interface GlobalFetchResult
 * @property {boolean} ok - Whether the request was successful.
 * @property {any} data - The data returned from the request.
 * @property {{ [key: string]: string }} headers - The headers returned from the request.
 */
interface GlobalFetchResult {
  ok: boolean;
  data: any;
  headers: { [key: string]: string };
  status: number;
}

/**
 * Adds a fetch log entry.
 *
 * @param {Object} arg - The arguments for the fetch log entry.
 * @param {any} arg.body - The body of the request.
 * @param {{ [key: string]: string }} [arg.headers] - The headers of the request.
 * @param {any} arg.response - The response from the request.
 * @param {boolean} arg.success - Whether the request was successful.
 * @param {string} arg.url - The URL of the request.
 * @param {string} [arg.resType] - The response type.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {number} - The index of the added fetch log entry.
 */
export function addFetchLog(arg: {
  body: any;
  headers?: { [key: string]: string };
  response: any;
  success: boolean;
  url: string;
  resType?: string;
  chatId?: string;
  status?: number;
}): number {
  fetchLog.unshift({
    body:
      typeof arg.body === "string"
        ? arg.body
        : JSON.stringify(arg.body, null, 2),
    header: JSON.stringify(arg.headers ?? {}, null, 2),
    response:
      typeof arg.response === "string"
        ? arg.response
        : JSON.stringify(arg.response, null, 2),
    responseType: arg.resType ?? "json",
    success: arg.success,
    date: new Date().toLocaleTimeString(),
    url: arg.url,
    chatId: arg.chatId,
    status: arg.status,
  });
  return 0;
}

/**
 * Performs a global fetch request.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} [arg={}] - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
export async function globalFetch(
  url: string,
  arg: GlobalFetchArgs = {},
): Promise<GlobalFetchResult> {
  try {
    const db = settingsStore.state;
    if (arg.abortSignal?.aborted) {
      return { ok: false, data: "aborted", headers: {}, status: 400 };
    }

    const urlHost = new URL(url).hostname;
    const useLocalNetworkRoute =
      arg.networkRoute === "local_network" && isLocalNetworkUrl(url);
    const forcePlainFetch =
      ((knownHostes.includes(urlHost) && !isTauri) ||
        db.usePlainFetch ||
        arg.plainFetchForce) &&
      !arg.plainFetchDeforce &&
      !useLocalNetworkRoute;

    if (useLocalNetworkRoute && !isTauri && !isCapacitor && !isNodeServer) {
      return {
        ok: false,
        headers: {},
        status: 400,
        data: webLocalNetworkBlockedMessage,
      };
    }

    if (
      knownHostes.includes(urlHost) &&
      !isTauri &&
      !isCapacitor &&
      !isNodeServer
    ) {
      return {
        ok: false,
        headers: {},
        status: 400,
        data: "You are trying local request on web version. This is not allowed due to browser security policy. Use the desktop version instead, or use a tunneling service like ngrok and set the CORS to allow all.",
      };
    }

    if (arg.interceptor) {
      for (const interceptor of bodyIntercepterStore) {
        try {
          arg.body =
            (await interceptor.callback(arg.body, arg.interceptor)) || arg.body;
        } catch (e) {
          console.error(e);
        }
      }
    }

    if (
      isNodeServer &&
      arg.chatId &&
      getDurableGenerationContext(arg.chatId) &&
      (arg.method ?? "POST") === "POST"
    ) {
      const durableBody =
        arg.body instanceof URLSearchParams
          ? arg.body.toString()
          : JSON.stringify(arg.body);
      try {
        const response = await fetchViaDurableModelJob(url, {
          body: durableBody,
          headers: arg.headers,
          method: "POST",
          signal: arg.abortSignal,
          requestTimeoutMs: arg.requestTimeoutMs,
          generationId: arg.chatId,
          interceptor: arg.interceptor,
        });
        const ok = response.ok;
        if (arg.rawResponse) {
          const data = new Uint8Array(await response.arrayBuffer());
          addFetchLogInGlobalFetch("Uint8Array Response", ok, url, arg, response.status);
          return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
        }
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
          return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
        } catch {
          addFetchLogInGlobalFetch(text, ok, url, arg, response.status);
          return { ok, data: text, headers: Object.fromEntries(response.headers), status: response.status };
        }
      } catch (error) {
        if (!(error instanceof DurableModelJobUnavailableError)) {
          return { ok: false, data: `${error}`, headers: {}, status: 409 };
        }
        console.warn("[ModelJob] durable transport unavailable; using the existing request path", error);
      }
    }

    const timeoutSignal = buildTimeoutSignal(
      arg.abortSignal,
      arg.requestTimeoutMs,
    );
    const requestArg =
      timeoutSignal.signal === arg.abortSignal
        ? arg
        : { ...arg, abortSignal: timeoutSignal.signal };

    try {
      if (useLocalNetworkRoute) {
        if (isTauri) {
          return await fetchWithTauri(url, requestArg);
        }
        if (isCapacitor) {
          return await fetchWithPlainFetch(url, requestArg);
        }
        return await fetchWithProxy(url, requestArg);
      }
      if (forcePlainFetch) {
        return await fetchWithPlainFetch(url, requestArg);
      }
      //userScriptFetch is provided by userscript
      if (window.userScriptFetch) {
        return await fetchWithUSFetch(url, requestArg);
      }
      if (isTauri) {
        return await fetchWithTauri(url, requestArg);
      }
      if (isNodeServer) {
        return await fetchWithProxy(url, requestArg);
      }
      return await fetchWithPlainFetch(url, requestArg);
    } finally {
      timeoutSignal.cleanup();
    }
  } catch (error) {
    console.error(error);
    return { ok: false, data: `${error}`, headers: {}, status: 400 };
  }
}

/**
 * Adds a fetch log entry in the global fetch log.
 *
 * @param {any} response - The response data.
 * @param {boolean} success - Indicates if the fetch was successful.
 * @param {string} url - The URL of the fetch request.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 */
function addFetchLogInGlobalFetch(
  response: any,
  success: boolean,
  url: string,
  arg: GlobalFetchArgs,
  status?: number,
) {
  try {
    fetchLog.unshift({
      body: JSON.stringify(arg.body, null, 2),
      header: JSON.stringify(arg.headers ?? {}, null, 2),
      response: JSON.stringify(response, null, 2),
      success: success,
      date: new Date().toLocaleTimeString(),
      url: url,
      chatId: arg.chatId,
      status: status,
    });
  } catch {
    fetchLog.unshift({
      body: JSON.stringify(arg.body, null, 2),
      header: JSON.stringify(arg.headers ?? {}, null, 2),
      response: `${response}`,
      success: success,
      date: new Date().toLocaleTimeString(),
      url: url,
      chatId: arg.chatId,
      status: status,
    });
  }

  if (fetchLog.length > 20) {
    fetchLog.pop();
  }
}

/**
 * Performs a fetch request using plain fetch.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithPlainFetch(
  url: string,
  arg: GlobalFetchArgs,
): Promise<GlobalFetchResult> {
  try {
    const headers = { "Content-Type": "application/json", ...arg.headers };
    const response = await fetch(new URL(url), {
      body: JSON.stringify(arg.body),
      headers,
      method: arg.method ?? "POST",
      signal: arg.abortSignal,
    });
    const data = arg.rawResponse
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json();
    const ok = response.ok && response.status >= 200 && response.status < 300;
    addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
    return {
      ok,
      data,
      headers: Object.fromEntries(response.headers),
      status: response.status,
    };
  } catch (error) {
    return { ok: false, data: `${error}`, headers: {}, status: 400 };
  }
}

/**
 * Performs a fetch request using userscript provided fetch.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithUSFetch(
  url: string,
  arg: GlobalFetchArgs,
): Promise<GlobalFetchResult> {
  try {
    const headers = { "Content-Type": "application/json", ...arg.headers };
    const response = await userScriptFetch(url, {
      body: JSON.stringify(arg.body),
      headers,
      method: arg.method ?? "POST",
      signal: arg.abortSignal,
    });
    const data = arg.rawResponse
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json();
    const ok = response.ok && response.status >= 200 && response.status < 300;
    addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
    return {
      ok,
      data,
      headers: Object.fromEntries(response.headers),
      status: response.status,
    };
  } catch (error) {
    return { ok: false, data: `${error}`, headers: {}, status: 400 };
  }
}

/**
 * Performs a fetch request using Tauri.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithTauri(
  url: string,
  arg: GlobalFetchArgs,
): Promise<GlobalFetchResult> {
  try {
    const headers = { "Content-Type": "application/json", ...arg.headers };
    const response = await TauriHTTPFetch(new URL(url), {
      body: JSON.stringify(arg.body),
      headers,
      method: arg.method ?? "POST",
      signal: arg.abortSignal,
    });
    const data = arg.rawResponse
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json();
    const ok = response.status >= 200 && response.status < 300;
    addFetchLogInGlobalFetch(data, ok, url, arg, response.status);
    return {
      ok,
      data,
      headers: Object.fromEntries(response.headers),
      status: response.status,
    };
  } catch (error) {
    return { ok: false, data: `${error}`, headers: {}, status: 400 };
  }
}

/**
 * Performs a fetch request using a proxy.
 *
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithProxy(
  url: string,
  arg: GlobalFetchArgs,
): Promise<GlobalFetchResult> {
  try {
    const furl = nodeProxy2Url;
    arg.headers ??= {};
    arg.headers["Content-Type"] ??=
      arg.body instanceof URLSearchParams
        ? "application/x-www-form-urlencoded"
        : "application/json";
    const nodeProxyAuth = isNodeServer ? await getNodeServerProxyAuth() : null;
    const headers = {
      "risu-header": encodeURIComponent(JSON.stringify(arg.headers)),
      "risu-url": encodeURIComponent(url),
      "Content-Type":
        arg.body instanceof URLSearchParams
          ? "application/x-www-form-urlencoded"
          : "application/json",
      ...(arg.useRisuToken && { "x-risu-tk": "use" }),
      ...(arg.requestTimeoutMs && {
        "risu-timeout-ms": Math.max(
          1,
          Math.floor(arg.requestTimeoutMs),
        ).toString(),
      }),
      ...(nodeProxyAuth && { "risu-auth": nodeProxyAuth }),
      ...(settingsStore.state.requestLocation && {
        "risu-location": settingsStore.state.requestLocation,
      }),
    };

    const body =
      arg.body instanceof URLSearchParams
        ? arg.body.toString()
        : JSON.stringify(arg.body);

    const response = await fetch(furl, {
      body,
      headers,
      method: arg.method ?? "POST",
      signal: arg.abortSignal,
    });
    const isSuccess =
      response.ok && response.status >= 200 && response.status < 300;

    if (arg.rawResponse) {
      const data = new Uint8Array(await response.arrayBuffer());
      addFetchLogInGlobalFetch(
        "Uint8Array Response",
        isSuccess,
        url,
        arg,
        response.status,
      );
      return {
        ok: isSuccess,
        data,
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    }

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      addFetchLogInGlobalFetch(data, isSuccess, url, arg, response.status);
      return {
        ok: isSuccess,
        data,
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    } catch (error) {
      const errorMsg = text.startsWith("<!DOCTYPE")
        ? "Responded HTML. Is your URL, API key, and password correct?"
        : text;
      addFetchLogInGlobalFetch(text, false, url, arg, response.status);
      return {
        ok: false,
        data: errorMsg,
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    }
  } catch (error) {
    return { ok: false, data: `${error}`, headers: {}, status: 400 };
  }
}

/**
 * Regular expression to match backslashes.
 *
 * @constant {RegExp}
 */
const re = /\\/g;

/**
 * Gets the basename of a given path.
 *
 * @param {string} data - The path to get the basename from.
 * @returns {string} - The basename of the path.
 */
export function getBasename(data: string) {
  const splited = data.replace(re, "/").split("/");
  const lasts = splited[splited.length - 1];
  return lasts;
}

export async function getUncleanables(
  db: Database,
  uptype: "basename" | "pure" = "basename",
  options?: { chars: (character | groupChat)[] },
) {
  let chars: (character | groupChat)[] = [];
  const sourceCharacters = options?.chars ?? db.characters;
  if (sourceCharacters) {
    for (let cha of sourceCharacters) {
      if (cha?.coldstorage) {
        const { getColdStorageItem } =
          await import("./process/coldstorage.svelte");
        const coldData = await getColdStorageItem(cha.coldstorage!);
        if (coldData?.character && coldData.character.chaId === cha.chaId) {
          cha = coldData.character;
        }
      }
      chars.push(cha);
    }
  }

  return getUncleanablesSync(db, uptype, { chars });
}

/**
 * Retrieves uncleanable resources from the database.
 *
 * @param {Database} db - The database to retrieve uncleanable resources from.
 * @param {'basename'|'pure'} [uptype='basename'] - The type of uncleanable resources to retrieve.
 * @returns {Promise<string[]>} - An array of uncleanable resources.
 */
export function getUncleanablesSync(
  db: Database,
  uptype: "basename" | "pure" = "basename",
  options?: {
    chars: (character | groupChat)[];
  },
) {
  const uncleanable = new Set<string>();

  /**
   * Adds a resource to the uncleanable list if it is not already included.
   *
   * @param {string} data - The resource to add.
   */
  function addUncleanable(data: string) {
    if (!data) {
      return;
    }
    if (data === "") {
      return;
    }
    const bn = uptype === "basename" ? getBasename(data) : data;
    uncleanable.add(bn);
  }

  addUncleanable(db.customBackground);
  addUncleanable(db.userIcon);
  const chars = options?.chars ?? db.characters;

  for (let cha of chars) {
    if (cha.image) {
      addUncleanable(cha.image);
    }
    if (cha.emotionImages) {
      for (const em of cha.emotionImages) {
        addUncleanable(em[1]);
      }
    }
    if (cha.type !== "group") {
      if (cha.additionalAssets) {
        for (const em of cha.additionalAssets) {
          addUncleanable(em[1]);
        }
      }
      if (cha.vits) {
        const keys = Object.keys(cha.vits.files);
        for (const key of keys) {
          const vit = cha.vits.files[key];
          addUncleanable(vit);
        }
      }
      if (cha.ccAssets) {
        for (const asset of cha.ccAssets) {
          addUncleanable(asset.uri);
        }
      }
    }
  }

  for (const module of db.modules ?? moduleStore.list) {
    const assets = module.assets;
    if (assets) {
      for (const asset of assets) {
        addUncleanable(asset[1]);
      }
    }
    if (module.icon) {
      addUncleanable(module.icon);
    }
  }

  if (db.personas) {
    db.personas.map((v) => {
      addUncleanable(v.icon);

      if (v.embeddedModule) {
        const assets = v.embeddedModule.assets;
        if (assets) {
          for (const asset of assets) {
            addUncleanable(asset[1]);
          }
        }
        if (v.embeddedModule.icon) {
          addUncleanable(v.embeddedModule.icon);
        }
      }
    });
  }

  if (db.characterOrder) {
    db.characterOrder.forEach((item) => {
      if (typeof item === "object" && "imgFile" in item) {
        addUncleanable(item.imgFile);
      }
    });
  }
  return Array.from(uncleanable);
}

/**
 * Replaces database resources with the provided replacer object.
 *
 * @param {Database} db - The database object containing resources to be replaced.
 * @param {{[key: string]: string}} replacer - An object mapping original resource keys to their replacements.
 * @returns {Database} - The updated database object with replaced resources.
 */
export function replaceDbResources(
  db: Database,
  replacer: { [key: string]: string },
): Database {
  /**
   * Replaces a given data string with its corresponding value from the replacer object.
   *
   * @param {string} data - The data string to be replaced.
   * @returns {string} - The replaced data string or the original data if no replacement is found.
   */
  function replaceData(data: string): string {
    if (!data) {
      return data;
    }
    return replacer[data] ?? data;
  }

  db.customBackground = replaceData(db.customBackground);
  db.userIcon = replaceData(db.userIcon);

  for (const cha of db.characters) {
    if (cha.image) {
      cha.image = replaceData(cha.image);
    }
    if (cha.emotionImages) {
      for (let i = 0; i < cha.emotionImages.length; i++) {
        cha.emotionImages[i][1] = replaceData(cha.emotionImages[i][1]);
      }
    }
    if (cha.type !== "group") {
      if (cha.additionalAssets) {
        for (let i = 0; i < cha.additionalAssets.length; i++) {
          cha.additionalAssets[i][1] = replaceData(cha.additionalAssets[i][1]);
        }
      }
    }
  }
  return db;
}

/**
 * Checks and updates the character order in the database.
 * Ensures that all characters are properly ordered and removes any invalid entries.
 */
export function checkCharOrder() {
  settingsStore.state.characterOrder = settingsStore.state.characterOrder ?? [];
  let ordered = [];
  for (let i = 0; i < settingsStore.state.characterOrder.length; i++) {
    const folder = settingsStore.state.characterOrder[i];
    if (typeof folder !== "string" && folder) {
      for (const f of folder.data) {
        ordered.push(f);
      }
    }
    if (typeof folder === "string") {
      ordered.push(folder);
    }
  }

  let charIdList: string[] = [];

  for (let i = 0; i < characterStore.characters.length; i++) {
    const char = characterStore.characters[i];
    const charId = char.chaId;
    if (!char.trashTime) {
      charIdList.push(charId);
    }
    if (!ordered.includes(charId)) {
      if (charId !== "§temp" && charId !== "§playground" && !char.trashTime) {
        settingsStore.state.characterOrder.push(charId);
      }
    }
  }

  for (let i = 0; i < settingsStore.state.characterOrder.length; i++) {
    const data = settingsStore.state.characterOrder[i];
    if (typeof data !== "string") {
      if (!data) {
        settingsStore.state.characterOrder.splice(i, 1);
        i--;
        continue;
      }
      if (data.data.length === 0) {
        settingsStore.state.characterOrder.splice(i, 1);
        i--;
        continue;
      }
      for (let i2 = 0; i2 < data.data.length; i2++) {
        const data2 = data.data[i2];
        if (!charIdList.includes(data2)) {
          data.data.splice(i2, 1);
          i2--;
        }
      }
      settingsStore.state.characterOrder[i] = data;
    } else {
      if (!charIdList.includes(data)) {
        settingsStore.state.characterOrder.splice(i, 1);
        i--;
      }
    }
  }
}

/**
 * Retrieves the request log as a formatted string.
 *
 * @returns {string} The formatted request log.
 */
export function getRequestLog() {
  let logString = "";
  const b = "\n\`\`\`json\n";
  const bend = "\n\`\`\`\n";

  for (const log of fetchLog) {
    logString +=
      `## ${log.date}\n\n* Request URL\n\n${b}${log.url}${bend}\n\n* Request Body\n\n${b}${log.body}${bend}\n\n* Request Header\n\n${b}${log.header}${bend}\n\n` +
      `* Response Body\n\n${b}${log.response}${bend}\n\n* Response Success\n\n${b}${log.success}${bend}\n\n`;
  }
  return logString;
}

/**
 * Retrieves the fetch logs array.
 *
 * @returns {fetchLog[]} The fetch logs array.
 */
export function getFetchLogs() {
  return fetchLog;
}

/**
 * Opens a URL in the appropriate environment.
 *
 * @param {string} url - The URL to open.
 */
export function openURL(url: string) {
  if (isTauri) {
    open(url);
  } else {
    window.open(url, "_blank");
  }
}

/**
 * Converts FormData to a URL-encoded string.
 *
 * @param {FormData} formData - The FormData to convert.
 * @returns {string} The URL-encoded string.
 */
function formDataToString(formData: FormData): string {
  const params: string[] = [];

  for (const [name, value] of formData.entries()) {
    params.push(
      `${encodeURIComponent(name)}=${encodeURIComponent(value.toString())}`,
    );
  }

  return params.join("&");
}

/**
 * A writer class for Tauri environment.
 */
export class TauriWriter {
  path: string;
  firstWrite: boolean = true;

  /**
   * Creates an instance of TauriWriter.
   *
   * @param {string} path - The file path to write to.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Writes data to the file.
   *
   * @param {Uint8Array} data - The data to write.
   */
  async write(data: Uint8Array) {
    await writeFile(this.path, data, {
      append: !this.firstWrite,
    });
    this.firstWrite = false;
  }

  /**
   * Closes the writer. (No operation for TauriWriter)
   */
  async close() {
    // do nothing
  }
}

interface StreamFileWriterPlugin {
  open(options: {
    fileName: string;
    mimeType: string;
  }): Promise<{ id?: string; cancelled?: boolean }>;
  write(options: { id: string; data: string }): Promise<void>;
  writeAssets(options: {
    id: string;
    keys: string[];
  }): Promise<{ written: number; missing: string[] }>;
  close(options: { id: string }): Promise<void>;
}

const capStreamFileWriter = isCapacitor
  ? registerPlugin<StreamFileWriterPlugin>("StreamFileWriter")
  : undefined;

class CapacitorWriter {
  constructor(private readonly id: string) {}

  async write(data: Uint8Array): Promise<void> {
    if (!capStreamFileWriter) throw new Error("Native file writer is unavailable");
    await capStreamFileWriter.write({
      id: this.id,
      data: Buffer.from(data).toString("base64"),
    });
  }

  async writeAssets(keys: string[]): Promise<{ written: number; missing: string[] }> {
    if (!capStreamFileWriter) throw new Error("Native file writer is unavailable");
    return await capStreamFileWriter.writeAssets({ id: this.id, keys });
  }

  async close(): Promise<void> {
    if (!capStreamFileWriter) return;
    await capStreamFileWriter.close({ id: this.id });
  }
}

/**
 * Class representing a local writer.
 */
export class LocalWriter {
  private tauriWriter: TauriWriter | null = null;
  private capacitorWriter: CapacitorWriter | null = null;
  private port: MessagePort | null = null;
  private bufferSize = 0;
  private buffer: Uint8Array | null = null;
  private bufferLength = 0;

  setBufferSize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error("Writer buffer size must be a positive integer");
    }
    if (this.bufferLength !== 0) {
      throw new Error(
        "Writer buffer size cannot be changed while data is buffered",
      );
    }
    this.bufferSize = size;
    this.buffer = null;
  }

  private async flushBuffer(): Promise<void> {
    if (!this.buffer || this.bufferLength === 0) {
      return;
    }

    const data =
      this.bufferLength === this.buffer.byteLength
        ? this.buffer
        : this.buffer.subarray(0, this.bufferLength);
    this.buffer = null;
    this.bufferLength = 0;

    if (this.tauriWriter) {
      await this.tauriWriter.write(data);
    } else if (this.capacitorWriter) {
      await this.capacitorWriter.write(data);
    } else if (this.port) {
      const buf = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
      this.port.postMessage(new Uint8Array(buf), [buf]);
    }
  }

  /**
   * Initializes the writer.
   *
   * @param {string} [name='Binary'] - The name of the file.
   * @param {string[]} [ext=['bin']] - The file extensions.
   * @returns {Promise<boolean>} - A promise that resolves to a boolean indicating success.
   */
  async init(name = "Binary", ext = ["bin"]): Promise<boolean> {
    const fileName = `${name}.${ext[0]}`;
    if (isTauri) {
      const filePath = await save({
        defaultPath: fileName,
        filters: [
          {
            name: name,
            extensions: ext,
          },
        ],
      });
      if (!filePath) {
        return false;
      }
      this.tauriWriter = new TauriWriter(filePath);
      return true;
    }

    if (isCapacitor) {
      if (!capStreamFileWriter) {
        throw new Error("Native file writer is unavailable");
      }
      const opened = await capStreamFileWriter.open({
        fileName,
        mimeType: "application/octet-stream",
      });
      if (opened.cancelled) return false;
      if (!opened.id) throw new Error("Native save destination is unavailable");
      this.capacitorWriter = new CapacitorWriter(opened.id);
      if (this.bufferSize === 0) this.setBufferSize(1024 * 1024);
      return true;
    }

    if (
      typeof navigator !== "undefined" &&
      navigator.serviceWorker?.controller
    ) {
      const id = uuidv4();
      const channel = new MessageChannel();

      navigator.serviceWorker.controller.postMessage(
        {
          type: "REGISTER_STREAM_DOWNLOAD",
          id,
          filename: fileName,
        },
        [channel.port2],
      );

      this.port = channel.port1;
      const a = document.createElement("a");
      a.href = `/sw/download?id=${id}`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    }

    throw new Error("Service Worker is not active for stream download");
  }

  supportsNativeAssetTransfer(): boolean {
    return this.capacitorWriter !== null;
  }

  async writeNativeAssets(
    keys: string[],
  ): Promise<{ written: number; missing: string[] }> {
    if (!this.capacitorWriter) {
      throw new Error("Native asset transfer is unavailable");
    }
    await this.flushBuffer();
    return await this.capacitorWriter.writeAssets(keys);
  }

  /**
   * Writes backup data to the file.
   *
   * @param {string} name - The name of the backup.
   * @param {Uint8Array} data - The data to write.
   */
  async writeBackup(name: string, data: Uint8Array): Promise<void> {
    await this.startBackup(name, data.byteLength);
    await this.write(data);
  }

  /**
   * Writes a backup entry header so its data can be streamed in chunks.
   */
  async startBackup(name: string, dataLength: number | bigint): Promise<void> {
    const normalizedLength =
      typeof dataLength === "bigint" ? dataLength : BigInt(dataLength);
    if (normalizedLength < 0n || normalizedLength > 0xffffffffn) {
      throw new Error(`Backup entry is too large: ${name}`);
    }
    const encodedName = new TextEncoder().encode(getBasename(name));
    const nameLength = new Uint32Array([encodedName.byteLength]);
    await this.write(new Uint8Array(nameLength.buffer));
    await this.write(encodedName);
    const encodedDataLength = new Uint32Array([Number(normalizedLength)]);
    await this.write(new Uint8Array(encodedDataLength.buffer));
  }

  /**
   * Writes data to the file.
   *
   * @param {Uint8Array} data - The data to write.
   */
  async write(data: Uint8Array): Promise<void> {
    if (this.bufferSize === 0) {
      if (this.tauriWriter) {
        await this.tauriWriter.write(data);
      } else if (this.capacitorWriter) {
        await this.capacitorWriter.write(data);
      } else if (this.port) {
        const buf = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );
        this.port.postMessage(new Uint8Array(buf), [buf]);
      }
      return;
    }

    let offset = 0;
    while (offset < data.byteLength) {
      if (!this.buffer) {
        this.buffer = new Uint8Array(this.bufferSize);
      }

      const writableLength = Math.min(
        this.bufferSize - this.bufferLength,
        data.byteLength - offset,
      );
      this.buffer.set(
        data.subarray(offset, offset + writableLength),
        this.bufferLength,
      );
      this.bufferLength += writableLength;
      offset += writableLength;

      if (this.bufferLength === this.bufferSize) {
        await this.flushBuffer();
      }
    }
  }

  /**
   * Closes the writer.
   */
  async close(): Promise<void> {
    await this.flushBuffer();
    if (this.tauriWriter) {
      await this.tauriWriter.close();
      this.tauriWriter = null;
    }
    if (this.capacitorWriter) {
      await this.capacitorWriter.close();
      this.capacitorWriter = null;
    }
    if (this.port) {
      this.port.postMessage({ done: true });
      this.port.close();
      this.port = null;
    }
  }
}

/**
 * Class representing a virtual writer.
 */
export class VirtualWriter {
  buf = new AppendableBuffer();

  /**
   * Writes data to the buffer.
   *
   * @param {Uint8Array} data - The data to write.
   */
  write(data: Uint8Array): void {
    this.buf.append(data);
  }

  /**
   * Closes the writer. (No operation for VirtualWriter)
   */
  close(): void {
    // do nothing
  }
}

/**
 * Index for fetch operations.
 * @type {number}
 */
let fetchIndex = 0;

/**
 * Stores native fetch data.
 * @type {{ [key: string]: StreamedFetchChunk[] }}
 */
let nativeFetchData: { [key: string]: StreamedFetchChunk[] } = {};

/**
 * Interface representing a streamed fetch chunk data.
 * @interface
 */
interface StreamedFetchChunkData {
  type: "chunk";
  body: string;
  id: string;
}

/**
 * Interface representing a streamed fetch header data.
 * @interface
 */
interface StreamedFetchHeaderData {
  type: "headers";
  body: { [key: string]: string };
  id: string;
  status: number;
}

/**
 * Interface representing a streamed fetch end data.
 * @interface
 */
interface StreamedFetchEndData {
  type: "end";
  id: string;
}

/**
 * Type representing a streamed fetch chunk.
 * @typedef {StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData} StreamedFetchChunk
 */
type StreamedFetchChunk =
  StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData;

/**
 * Interface representing a streamed fetch plugin.
 * @interface
 */
interface StreamedFetchPlugin {
  /**
   * Performs a streamed fetch operation.
   * @param {Object} options - The options for the fetch operation.
   * @param {string} options.id - The ID of the fetch operation.
   * @param {string} options.url - The URL to fetch.
   * @param {string} options.body - The body of the fetch request.
   * @param {{ [key: string]: string }} options.headers - The headers of the fetch request.
   * @returns {Promise<{ error: string, success: boolean }>} - The result of the fetch operation.
   */
  streamedFetch(options: {
    id: string;
    url: string;
    body: string;
    headers: { [key: string]: string };
    method: string;
    timeoutMs?: number;
  }): Promise<{ error: string; success: boolean }>;

  /**
   * Adds a listener for the specified event.
   * @param {string} eventName - The name of the event.
   * @param {(data: StreamedFetchChunk) => void} listenerFunc - The function to call when the event is triggered.
   */
  addListener(
    eventName: "streamed_fetch",
    listenerFunc: (data: StreamedFetchChunk) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Indicates whether streamed fetch listening is active.
 * @type {boolean}
 */
let streamedFetchListening = false;

/**
 * The streamed fetch plugin instance.
 * @type {StreamedFetchPlugin | undefined}
 */
let capStreamedFetch: StreamedFetchPlugin | undefined;

if (isTauri) {
  listen("streamed_fetch", (event) => {
    try {
      const parsed = JSON.parse(event.payload as string);
      const id = parsed.id;
      nativeFetchData[id]?.push(parsed);
    } catch (error) {
      console.error(error);
    }
  }).then(() => {
    streamedFetchListening = true;
  });
}

if (isCapacitor) {
  capStreamedFetch = registerPlugin<StreamedFetchPlugin>("StreamedFetch");
  capStreamedFetch
    .addListener("streamed_fetch", (event) => {
      nativeFetchData[event.id]?.push(event);
    })
    .then(() => {
      streamedFetchListening = true;
    })
    .catch((error) => {
      console.error("Failed to initialize Capacitor streamed fetch:", error);
    });
}

/**
 * A class to manage a buffer that can be appended to and deappended from.
 */
export class AppendableBuffer {
  deapended: number = 0;
  #buffer: Uint8Array;
  #byteLength: number = 0;

  /**
   * Creates an instance of AppendableBuffer.
   */
  constructor() {
    this.#buffer = new Uint8Array(128);
  }

  get buffer(): Uint8Array {
    return this.#buffer.slice(0, this.#byteLength);
  }

  /**
   * Appends data to the buffer.
   * @param {Uint8Array} data - The data to append.
   */
  append(data: Uint8Array) {
    // New way (faster)
    const requiredLength = this.#byteLength + data.length;
    if (this.#buffer.byteLength < requiredLength) {
      let newLength = this.#buffer.byteLength * 2;
      while (newLength < requiredLength) {
        newLength *= 2;
      }
      const newBuffer = new Uint8Array(newLength);
      newBuffer.set(this.#buffer);
      this.#buffer = newBuffer;
    }
    this.#buffer.set(data, this.#byteLength);
    this.#byteLength += data.length;
  }

  /**
   * Deappends a specified length from the buffer.
   * @param {number} length - The length to deappend.
   */
  deappend(length: number) {
    this.#buffer = this.#buffer.slice(length);
    this.deapended += length;
    this.#byteLength -= length;
  }

  /**
   * Slices the buffer from start to end.
   * @param {number} start - The start index.
   * @param {number} end - The end index.
   * @returns {Uint8Array} - The sliced buffer.
   */
  slice(start: number, end: number) {
    return this.buffer.slice(start - this.deapended, end - this.deapended);
  }

  /**
   * Gets the total length of the buffer including deappended length.
   * @returns {number} - The total length.
   */
  length() {
    return this.#byteLength + this.deapended;
  }

  /**
   * Clears the buffer.
   */
  clear() {
    this.#buffer = new Uint8Array(128);
    this.#byteLength = 0;
    this.deapended = 0;
  }
}

/**
 * Pipes the fetch log to a readable stream.
 * @param {number} fetchLogIndex - The index of the fetch log.
 * @param {ReadableStream<Uint8Array>} readableStream - The readable stream to pipe.
 * @returns {ReadableStream<Uint8Array>} - The new readable stream.
 */
const pipeFetchLog = (
  fetchLogIndex: number,
  readableStream: ReadableStream<Uint8Array>,
) => {
  const splited = readableStream.tee();

  (async () => {
    const text = await new Response(splited[0]).text();
    fetchLog[fetchLogIndex].response = text;
  })();

  return splited[1];
};

async function fetchViaProxyJobWs(
  url: string,
  arg: {
    body: Uint8Array;
    headers?: { [key: string]: string };
    method: "POST" | "GET" | "PUT" | "DELETE";
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    chatId?: string;
    fetchLogIndex?: number | null;
  },
): Promise<Response> {
  const auth = await getNodeServerProxyAuth();

  const requestSignal = arg.signal;
  let jobId = "";
  const createRes = await fetch("/proxy-stream-jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "risu-auth": auth,
    },
    body: JSON.stringify({
      url,
      method: arg.method,
      headers: arg.headers ?? {},
      bodyBase64: Buffer.from(arg.body).toString("base64"),
      timeoutMs: arg.requestTimeoutMs,
      heartbeatSec: defaultProxyJobHeartbeatSec,
    }),
    signal: requestSignal,
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(
      `Proxy stream job creation failed: ${createRes.status} ${errText}`,
    );
  }

  const created = (await createRes.json()) as { jobId?: string };
  if (!created.jobId) {
    throw new Error("Proxy stream job creation returned no jobId");
  }
  jobId = created.jobId;

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}`;

  let headersReady = false;
  let status = 200;
  let responseHeaders: HeadersInit = { "content-type": "text/event-stream" };
  let settled = false;
  let resolveHeaders: () => void = () => {};
  const waitHeaders = new Promise<void>((resolve) => {
    resolveHeaders = resolve;
  });
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const encoder = new TextEncoder();

  const ws = new WebSocket(wsUrl);
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      try {
        ws.close();
      } catch {
        // no-op
      }
    },
  });
  const pipedReadable =
    arg.fetchLogIndex != null
      ? pipeFetchLog(arg.fetchLogIndex, readable)
      : readable;

  const ensureHeadersReady = () => {
    if (!headersReady) {
      headersReady = true;
      resolveHeaders();
    }
  };

  const closeAndEnd = () => {
    if (settled) {
      return;
    }
    settled = true;
    if (streamController) {
      try {
        streamController.close();
      } catch {
        // no-op
      }
    }
    try {
      ws.close();
    } catch {
      // no-op
    }
  };

  ws.onmessage = (event) => {
    const parsed = parseProxyJobWsEvent(
      typeof event.data === "string" ? event.data : "",
    );
    if (!parsed || !streamController) {
      return;
    }
    switch (parsed.type) {
      case "job_accepted":
      case "ping":
        return;
      case "upstream_headers":
        status = parsed.status;
        responseHeaders = parsed.headers ?? {};
        ensureHeadersReady();
        return;
      case "chunk":
        ensureHeadersReady();
        streamController.enqueue(decodeProxyJobWsChunk(parsed.dataBase64));
        return;
      case "error": {
        status = parsed.status ?? 502;
        responseHeaders = { "content-type": "text/plain; charset=utf-8" };
        ensureHeadersReady();
        const msg = formatProxyStreamErrorMessage(
          parsed.status,
          parsed.message,
        );
        streamController.enqueue(encoder.encode(msg));
        closeAndEnd();
        return;
      }
      case "done":
        ensureHeadersReady();
        closeAndEnd();
        return;
    }
  };

  ws.onerror = () => {
    if (!streamController) {
      return;
    }
    status = 502;
    responseHeaders = { "content-type": "text/plain; charset=utf-8" };
    ensureHeadersReady();
    streamController.enqueue(encoder.encode("Proxy WebSocket stream error"));
    closeAndEnd();
  };

  ws.onclose = () => {
    if (!headersReady) {
      status = 502;
      responseHeaders = { "content-type": "text/plain; charset=utf-8" };
      ensureHeadersReady();
    }
    closeAndEnd();
  };

  const abortHandler = () => {
    status = 499;
    responseHeaders = { "content-type": "text/plain; charset=utf-8" };
    ensureHeadersReady();
    if (streamController && !settled) {
      streamController.enqueue(encoder.encode("Aborted"));
    }
    void fetch(`/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: {
        "risu-auth": auth,
      },
    }).catch(() => {});
    closeAndEnd();
  };
  if (requestSignal?.aborted) {
    abortHandler();
  } else {
    requestSignal?.addEventListener("abort", abortHandler, { once: true });
  }

  await waitHeaders;
  requestSignal?.removeEventListener("abort", abortHandler);
  return new Response(pipedReadable, {
    status,
    headers: new Headers(responseHeaders),
  });
}

/**
 * Fetches data from a given URL using native fetch or through a proxy.
 * @param {string} url - The URL to fetch data from.
 * @param {Object} arg - The arguments for the fetch request.
 * @param {string} arg.body - The body of the request.
 * @param {Object} [arg.headers] - The headers of the request.
 * @param {string} [arg.method="POST"] - The HTTP method of the request.
 * @param {AbortSignal} [arg.signal] - The signal to abort the request.
 * @param {boolean} [arg.useRisuTk] - Whether to use Risu token.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {Promise<Object>} - A promise that resolves to an object containing the response body, headers, and status.
 * @returns {ReadableStream<Uint8Array>} body - The response body as a readable stream.
 * @returns {Headers} headers - The response headers.
 * @returns {number} status - The response status code.
 * @throws {Error} - Throws an error if the request is aborted or if there is an error in the response.
 */
export async function fetchNative(
  url: string,
  arg: {
    body?: string | Uint8Array | ArrayBuffer;
    headers?: { [key: string]: string };
    method?: "POST" | "GET" | "PUT" | "DELETE";
    signal?: AbortSignal;
    useRisuTk?: boolean;
    chatId?: string;
    interceptor?: string;
    logFetch?: boolean;
    requestTimeoutMs?: number;
    networkRoute?: "auto" | "local_network";
  },
): Promise<Response> {
  const useInterceptor = !!arg.interceptor;
  console.log(arg.body, "body");
  if (
    arg.body === undefined &&
    (arg.method === "POST" || arg.method === "PUT")
  ) {
    throw new Error("Body is required for POST and PUT requests");
  }

  arg.method = arg.method ?? "POST";

  let headers = arg.headers ?? {};
  let realBody: Uint8Array;

  if (arg.method === "GET" || arg.method === "DELETE") {
    realBody = undefined;
  } else if (typeof arg.body === "string") {
    let body: string = arg.body;
    if (useInterceptor) {
      for (const interceptor of bodyIntercepterStore) {
        try {
          body = (await interceptor.callback(body, arg.interceptor)) || body;
        } catch (e) {
          console.error(e);
        }
      }
    }
    realBody = new TextEncoder().encode(body);
  } else if (arg.body instanceof Uint8Array) {
    realBody = arg.body;
  } else if (arg.body instanceof ArrayBuffer) {
    realBody = new Uint8Array(arg.body);
  } else {
    throw new Error("Invalid body type");
  }

  const useLocalNetworkRoute =
    arg.networkRoute === "local_network" && isLocalNetworkUrl(url);
  if (useLocalNetworkRoute && !isTauri && !isCapacitor && !isNodeServer) {
    throw new Error(webLocalNetworkBlockedMessage);
  }
  const throughProxy = isNodeServer && useLocalNetworkRoute;
  const shouldLogFetch = arg.logFetch ?? true;
  let fetchLogIndex: number | null = null;
  if (shouldLogFetch) {
    fetchLogIndex = addFetchLog({
      body: realBody ? new TextDecoder().decode(realBody) : "",
      headers: arg.headers,
      response: "Streamed Fetch",
      success: true,
      url: url,
      resType: "stream",
      chatId: arg.chatId,
    });
  }

  if (
    isNodeServer &&
    arg.method === "POST" &&
    arg.chatId &&
    getDurableGenerationContext(arg.chatId)
  ) {
    try {
      const durableResponse = await fetchViaDurableModelJob(url, {
        body: realBody ? new TextDecoder().decode(realBody) : "",
        headers,
        method: arg.method,
        signal: arg.signal,
        requestTimeoutMs: arg.requestTimeoutMs,
        generationId: arg.chatId,
        interceptor: arg.interceptor,
      });
      if (fetchLogIndex !== null && durableResponse.body) {
        return new Response(pipeFetchLog(fetchLogIndex, durableResponse.body), {
          headers: durableResponse.headers,
          status: durableResponse.status,
        });
      }
      return durableResponse;
    } catch (error) {
      if (!(error instanceof DurableModelJobUnavailableError)) throw error;
      console.warn("[ModelJob] durable transport unavailable; using the existing request path", error);
    }
  }

  const timeoutSignal = buildTimeoutSignal(arg.signal, arg.requestTimeoutMs);
  const requestSignal = timeoutSignal.signal;
  try {
    if (window.userScriptFetch && !throughProxy) {
      return await window.userScriptFetch(url, {
        body: realBody as any,
        headers: headers,
        method: arg.method,
        signal: requestSignal,
      });
    } else if (isTauri) {
      fetchIndex++;
      if (requestSignal && requestSignal.aborted) {
        throw new Error("aborted");
      }
      if (fetchIndex >= 100000) {
        fetchIndex = 0;
      }
      let fetchId = fetchIndex.toString().padStart(5, "0");
      nativeFetchData[fetchId] = [];
      let nativeFetchHead = 0;
      let resolved = false;

      let error = "";
      while (!streamedFetchListening) {
        await sleep(100);
      }
      if (isTauri) {
        invoke("streamed_fetch", {
          id: fetchId,
          url: url,
          headers: JSON.stringify(headers),
          body: realBody ? Buffer.from(realBody).toString("base64") : "",
          method: arg.method,
          timeout_secs: arg.requestTimeoutMs
            ? Math.max(1, Math.ceil(arg.requestTimeoutMs / 1000))
            : undefined,
        }).then((res) => {
          try {
            const parsedRes = JSON.parse(res as string);
            if (!parsedRes.success) {
              error = parsedRes.body;
              resolved = true;
            }
          } catch (e) {
            // Error properties (message/name/stack) are non-enumerable, so
            // JSON.stringify(e) returns "{}" and discards the real cause.
            error =
              e instanceof Error
                ? e.message || e.name || "streamed_fetch parse failed"
                : String(e);
            resolved = true;
          }
        });
      } else if (capStreamedFetch) {
        capStreamedFetch
          .streamedFetch({
            id: fetchId,
            url: url,
            headers: headers,
            body: realBody ? Buffer.from(realBody).toString("base64") : "",
            method: arg.method,
            timeoutMs: arg.requestTimeoutMs,
          })
          .then((res) => {
            if (!res.success) {
              error = res.error;
              resolved = true;
            }
          });
      }

      let resHeaders: { [key: string]: string } = null;
      let status = 400;

      const tauriReadableStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            while (
              !resolved ||
              nativeFetchHead < (nativeFetchData[fetchId]?.length ?? 0)
            ) {
              const queue = nativeFetchData[fetchId];
              if (queue && nativeFetchHead < queue.length) {
                const data = queue[nativeFetchHead++];
                if (data.type === "chunk") {
                  const chunk = Buffer.from(data.body, "base64");
                  controller.enqueue(chunk as unknown as Uint8Array);
                }
                if (data.type === "headers") {
                  resHeaders = data.body;
                  status = data.status;
                }
                if (data.type === "end") {
                  resolved = true;
                }

                // Array.shift() moves every remaining chunk on each read. Keep
                // a cursor instead and compact only occasionally so long native
                // streams remain amortized O(n) without retaining old chunks.
                if (nativeFetchHead >= 256 && nativeFetchHead * 2 >= queue.length) {
                  queue.splice(0, nativeFetchHead);
                  nativeFetchHead = 0;
                }
              }
              await sleep(10);
            }
            controller.close();
          } finally {
            // Completed request queues previously stayed in this process-wide
            // object forever, leaking one array per native fetch.
            delete nativeFetchData[fetchId];
          }
        },
      });

      let readableStream = tauriReadableStream;
      if (shouldLogFetch && fetchLogIndex !== null) {
        readableStream = pipeFetchLog(fetchLogIndex, tauriReadableStream);
      }

      while (resHeaders === null && !resolved) {
        await sleep(10);
      }

      if (resHeaders === null) {
        resHeaders = {};
      }

      if (error !== "") {
        throw new Error(error);
      }

      return new Response(readableStream, {
        headers: new Headers(resHeaders),
        status: status,
      });
    } else if (throughProxy) {
      const useProxyJobWs =
        isNodeServer &&
        arg.interceptor === "openai_streaming" &&
        arg.method === "POST" &&
        useLocalNetworkRoute;
      const nodeProxyAuth = isNodeServer
        ? await getNodeServerProxyAuth()
        : null;

      if (useProxyJobWs) {
        try {
          return await fetchViaProxyJobWs(url, {
            body: realBody,
            headers,
            method: arg.method,
            signal: requestSignal,
            requestTimeoutMs: arg.requestTimeoutMs,
            chatId: arg.chatId,
            fetchLogIndex,
          });
        } catch (wsErr) {
          console.warn("[ProxyJobWS] fallback to /proxy2 due to error:", wsErr);
        }
      }

      const r = await fetch(nodeProxy2Url, {
        body: realBody as any,
        headers: arg.useRisuTk
          ? {
              "risu-header": encodeURIComponent(JSON.stringify(headers)),
              "risu-url": encodeURIComponent(url),
              "Content-Type": "application/json",
              "x-risu-tk": "use",
              ...(arg.requestTimeoutMs && {
                "risu-timeout-ms": Math.max(
                  1,
                  Math.floor(arg.requestTimeoutMs),
                ).toString(),
              }),
              ...(nodeProxyAuth ? { "risu-auth": nodeProxyAuth } : {}),
              ...(settingsStore.state.requestLocation && {
                "risu-location": settingsStore.state.requestLocation,
              }),
            }
          : {
              "risu-header": encodeURIComponent(JSON.stringify(headers)),
              "risu-url": encodeURIComponent(url),
              "Content-Type": "application/json",
              ...(arg.requestTimeoutMs && {
                "risu-timeout-ms": Math.max(
                  1,
                  Math.floor(arg.requestTimeoutMs),
                ).toString(),
              }),
              ...(nodeProxyAuth ? { "risu-auth": nodeProxyAuth } : {}),
              ...(settingsStore.state.requestLocation && {
                "risu-location": settingsStore.state.requestLocation,
              }),
            },
        method: arg.method,
        signal: requestSignal,
      });

      return new Response(r.body, {
        headers: r.headers,
        status: r.status,
      });
    } else {
      return await fetch(url, {
        body: realBody as any,
        headers: headers,
        method: arg.method,
        signal: requestSignal,
      });
    }
  } finally {
    timeoutSignal.cleanup();
  }
}

/**
 * Converts a ReadableStream of Uint8Array to a text string.
 *
 * @param {ReadableStream<Uint8Array>} stream - The readable stream to convert.
 * @returns {Promise<string>} A promise that resolves to the text content of the stream.
 */
export function textifyReadableStream(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

/**
 * Toggles the fullscreen mode of the document.
 * If the document is currently in fullscreen mode, it exits fullscreen.
 * If the document is not in fullscreen mode, it requests fullscreen with navigation UI hidden.
 */
export function toggleFullscreen() {
  const fullscreenElement = document.fullscreenElement;
  fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen({
        navigationUI: "hide",
      });
}

/**
 * Removes non-Latin characters from a string, replaces multiple spaces with a single space, and trims the string.
 *
 * @param {string} data - The input string to be processed.
 * @returns {string} The processed string with non-Latin characters removed, multiple spaces replaced by a single space, and trimmed.
 */
export function trimNonLatin(data: string) {
  return data
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * A class that provides a blank writer implementation.
 *
 * This class is used to provide a no-op implementation of a writer, making it compatible with other writer interfaces.
 */
export class BlankWriter {
  constructor() {}

  /**
   * Initializes the writer.
   *
   * This method does nothing and is provided for compatibility with other writer interfaces.
   */
  async init() {
    //do nothing, just to make compatible with other writer
  }

  /**
   * Writes data to the writer.
   *
   * This method does nothing and is provided for compatibility with other writer interfaces.
   *
   * @param {string} key - The key associated with the data.
   * @param {Uint8Array|string} data - The data to be written.
   */
  async write(key: string, data: Uint8Array | string) {
    //do nothing, just to make compatible with other writer
  }

  /**
   * Ends the writing process.
   *
   * This method does nothing and is provided for compatibility with other writer interfaces.
   */
  async end() {
    //do nothing, just to make compatible with other writer
  }
}

export async function loadInternalBackup() {
  const keys = isTauri
    ? (await readDir("database", { baseDir: BaseDirectory.AppData })).map(
        (v) => {
          return v.name;
        },
      )
    : await forageStorage.keys();
  let internalBackups: string[] = [];
  for (const key of keys) {
    if (key.includes("dbbackup-")) {
      internalBackups.push(key);
    }
  }

  const selectOptions = [
    "Cancel",
    ...internalBackups.map((a) => {
      return new Date(
        parseInt(a.replace("database/dbbackup-", "").replace("dbbackup-", "")) *
          100,
      ).toLocaleString();
    }),
  ];

  const alertResult = parseInt(await alertSelect(selectOptions)) - 1;

  if (alertResult === -1) {
    return;
  }

  const selectedBackup = internalBackups[alertResult];

  const data = isTauri
    ? await readFile("database/" + selectedBackup, {
        baseDir: BaseDirectory.AppData,
      })
    : await forageStorage.getItem(selectedBackup);

  installDatabase(
    await decodeRisuSave(Buffer.from(data) as unknown as Uint8Array),
  );
  alertNormal("Loaded backup");
}

/**
 * A debugging class for performance measurement.
 */

export class PerformanceDebugger {
  kv: { [key: string]: number[] } = {};
  startTime: number;
  endTime: number;

  /**
   * Starts the timing measurement.
   */
  start() {
    this.startTime = performance.now();
  }

  /**
   * Ends the timing measurement and records the time difference.
   *
   * @param {string} key - The key to associate with the recorded time.
   */
  endAndRecord(key: string) {
    this.endTime = performance.now();
    if (!this.kv[key]) {
      this.kv[key] = [];
    }
    this.kv[key].push(this.endTime - this.startTime);
  }

  /**
   * Ends the timing measurement, records the time difference, and starts a new timing measurement.
   *
   * @param {string} key - The key to associate with the recorded time.
   */
  endAndRecordAndStart(key: string) {
    this.endAndRecord(key);
    this.start();
  }

  /**
   * Logs the average time for each key to the console.
   */
  log() {
    let table: { [key: string]: number } = {};

    for (const key in this.kv) {
      table[key] =
        this.kv[key].reduce((a, b) => a + b, 0) / this.kv[key].length;
    }

    console.table(table);
  }

  combine(other: PerformanceDebugger) {
    for (const key in other.kv) {
      if (!this.kv[key]) {
        this.kv[key] = [];
      }
      this.kv[key].push(...other.kv[key]);
    }
  }
}

export function getLanguageCodes() {
  let languageCodes: {
    code: string;
    name: string;
  }[] = [];

  for (let i = 0x41; i <= 0x5a; i++) {
    for (let j = 0x41; j <= 0x5a; j++) {
      languageCodes.push({
        code: String.fromCharCode(i) + String.fromCharCode(j),
        name: "",
      });
    }
  }

  languageCodes = languageCodes
    .map((v) => {
      return {
        code: v.code.toLocaleLowerCase(),
        name: new Intl.DisplayNames(
          [
            settingsStore.state.language === "cn"
              ? "zh"
              : settingsStore.state.language,
          ],
          {
            type: "language",
            fallback: "none",
          },
        ).of(v.code),
      };
    })
    .filter((a) => {
      return a.name;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return languageCodes;
}

export function getVersionString(): string {
  let versionString = appVer;
  if (appSubVer) {
    versionString += "-" + appSubVer;
  }
  if (window.location.hostname === "nightly.risuai.xyz") {
    versionString += " (Nightly)";
  }
  if (window.location.hostname === "stable.risuai.xyz") {
    versionString += " (Stable)";
  }
  return versionString;
}

export function toGetter<T extends object>(
  getterFn: () => T,
  args?: {
    //blocks this.children from being accessed
    restrictChildren: string[];
  },
): T {
  const dummyTarget = () => {};

  return new Proxy(dummyTarget, {
    get(target, prop, receiver) {
      const realInstance = getterFn();

      if (
        args?.restrictChildren &&
        args.restrictChildren.includes(prop as string)
      ) {
        throw new Error(`Access to property '${String(prop)}' is restricted`);
      }

      if (realInstance === null || realInstance === undefined) {
        return (realInstance as any)[prop];
      }

      const value = Reflect.get(realInstance as object, prop);

      if (typeof value === "function") {
        return value.bind(realInstance);
      }

      return value;
    },

    set(target, prop, value, receiver) {
      if (
        args?.restrictChildren &&
        args.restrictChildren.includes(prop as string)
      ) {
        throw new Error(`Access to property '${String(prop)}' is restricted`);
      }
      const realInstance = getterFn();
      return Reflect.set(realInstance as object, prop, value, receiver);
    },

    has(target, prop) {
      const realInstance = getterFn();
      return Reflect.has(realInstance as object, prop);
    },

    ownKeys(target) {
      const realInstance = getterFn();
      return Reflect.ownKeys(realInstance as object);
    },

    construct(target, argArray, newTarget) {
      const realInstance = getterFn() as any;
      return new realInstance(...argArray);
    },

    deleteProperty(target, prop) {
      const realInstance = getterFn();
      return Reflect.deleteProperty(realInstance as object, prop);
    },

    getPrototypeOf() {
      const realInstance = getterFn();
      return Reflect.getPrototypeOf(realInstance as object);
    },
  }) as unknown as T;
}

const countriesWithAiLaw = new Set<string>([
  // EU
  // AI Act
  // https://artificialintelligenceact.eu/

  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "EL",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",

  //China
  //Measures for Labeling of AI-Generated Synthetic Content
  // 关于印发《人工智能生成合成内容标识办法》的通知
  // https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
  "CN",

  //Although CN Law doesn't apply, just in case
  "HK",
  "MO",

  //TW isn't under mainland china jurisdiction
  //de facto, de jure in TW law, unlike HK and MO,
  //So we don't include it for now
  //"TW",

  // Republic of Korea
  // AI Basic Act
  // 인공지능 발전과 신뢰 기반 조성 등에 관한 기본법
  // https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%20%EB%B0%9C%EC%A0%84%EA%B3%BC%20%EC%8B%A0%EB%A2%B0%20%EA%B8%B0%EB%B0%98%20%EC%A1%B0%EC%84%B1%20%EB%93%B1%EC%97%90%20%EA%B4%80%ED%95%9C%20%EA%B8%B0%EB%B3%B8%EB%B2%95/(20676,20250121)
  "KR",

  // Vietnam
  // Digital Tech Law
  // Luật Công nghệ số
  "VN",
]);

export function aiLawApplies(): boolean {
  //TODO: implement actual logic
  //lets now assume it always applies
  //so we don't have legal issues later

  return true;
}

export function aiWatermarkingLawApplies(): boolean {
  //TODO: implement actual logic
  //lets now assume it is false for now,
  //becuase very few countries have it for now
  return false;
}

export const chatFoldedState = $state<{
  data: null | {
    targetCharacterId: string;
    targetChatId: string;
    targetMessageId: string;
  };
}>({
  data: null,
});

//Since its exported, we cannot use $derived here
export let chatFoldedStateMessageIndex = $state({
  index: -1,
});

$effect.root(() => {
  $effect(() => {
    if (!chatFoldedState.data) {
      return;
    }
    const char = characterStore.characters[characterStore.selectedId];
    if (!char || !char.chats) return;
    const chat = char.chats[char.chatPage];
    if (!chat) return;
    if (chatFoldedState.data.targetCharacterId !== char.chaId) {
      chatFoldedState.data = null;
    }
    if (chatFoldedState.data.targetChatId !== chat.id) {
      chatFoldedState.data = null;
    }
  });

  $effect(() => {
    if (chatFoldedState.data === null) {
      chatFoldedStateMessageIndex.index = -1;
      return;
    }
    const char = characterStore.characters[characterStore.selectedId];
    if (!char || !char.chats) return;
    const chat = char.chats[char.chatPage];
    if (!chat) return;
    const messageIndex = chat.message.findIndex((v) => {
      return chatFoldedState.data?.targetMessageId === v.chatId;
    });
    if (messageIndex === -1) {
      console.warn(
        "Target message for folding id" +
          chatFoldedState.data?.targetMessageId +
          " not found",
      );
      chatFoldedStateMessageIndex.index = -1;
      return;
    }
    chatFoldedStateMessageIndex.index = messageIndex;
  });
});

export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
  let targetMessageId = "";
  if (typeof targetMessageIdOrIndex === "number") {
    const char = characterStore.currentCharacter;
    const chat = char.chats[char.chatPage];
    const message = chat.message[targetMessageIdOrIndex];
    targetMessageId = message.chatId;
  } else {
    targetMessageId = targetMessageIdOrIndex;
  }
  const char = characterStore.currentCharacter;
  const chat = char.chats[char.chatPage];
  chatFoldedState.data = {
    targetCharacterId: char.chaId,
    targetChatId: chat.id,
    targetMessageId: targetMessageId,
  };
}

export function changeChatTo(IdOrIndex: string | number) {
  let index = -1;
  if (typeof IdOrIndex === "number") {
    index = IdOrIndex;
  }

  if (typeof IdOrIndex === "string") {
    const currentCharacter = characterStore.currentCharacter;
    index = currentCharacter.chats.findIndex((v) => {
      return v.id === IdOrIndex;
    });
  }

  if (index === -1) {
    return;
  }

  const nextChat = characterStore.characters[characterStore.selectedId]?.chats?.[index];
  if (characterStore.characters[characterStore.selectedId]) {
    characterStore.characters[characterStore.selectedId].chatPage = index;
  }
  ReloadGUIPointer.set(Math.random());
  releaseInactiveChatMessages(nextChat?.id);
}

export function createChatCopyName(
  originalName: string,
  type: "Copy" | "Branch",
): string {
  let name = originalName.replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, "").trim();
  let copyIndex = 1;
  let newName = `${name} (${type})`;
  const char = characterStore.currentCharacter;
  while (char.chats.find((v) => v.name === newName)) {
    copyIndex++;
    newName = `${name} (${type} ${copyIndex})`;
  }
  return newName;
}
