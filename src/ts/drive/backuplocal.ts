import {
  BaseDirectory,
  mkdir,
  open as openFile,
  readFile,
  readDir,
  writeFile,
} from "@tauri-apps/plugin-fs";
import localforage from "localforage";
import {
  alertError,
  alertNormal,
  alertStore,
  alertMd,
  alertConfirm,
  alertProgress as showProgressAlert,
  alertClear,
} from "../alert";
import { LocalWriter, forageStorage } from "../globalApi.svelte";
import { isCapacitor, isNodeServer, isTauri } from "src/ts/platform";
import { decodeRisuSave, encodeRisuSaveLegacyAsync } from "../storage/risuSave";
import { normalizeDatabaseDefaults } from "../storage/databaseDefaults";
import type { Database, PortableDatabase } from "../storage/schema";

import { relaunch } from "@tauri-apps/plugin-process";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { decryptBuffer, encryptBuffer, sleep } from "../util";
import { hubURL } from "../characterCards";
import { language } from "src/lang";
import {
  collectColdStorageBackupPayloads,
  confirmIncompleteColdStorageOperation,
  getColdStorageBackupKey,
  getColdStorageItem,
  isColdStorageBackupData,
  listColdDataKeys,
  setColdStorageItem,
} from "../process/coldstorage.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { createDatabaseSnapshot } from "../storage/databaseSnapshot";
import { NodeStorage } from "../storage/nodeStorage";
import { getSqlStorage } from "../storage/sqlStorageFactory";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { decryptLegacyAccountBackup } from "./legacyBackupEncryption";
import {
  makeLegacyCompatibleDatabase,
  type ColdStorageValueMap,
} from "../backupCompatibility";

import { registerPlugin } from "@capacitor/core";
import { Buffer } from "buffer";
import {
  classifyBackupEntry,
  getInlayBackupKey,
} from "@risuai/backup-core/entryPolicy.cjs";
import {
  decodeInlayAssetBackup,
  encodeInlayAssetBackup,
  listInlayAssets,
  setInlayAsset,
} from "../process/files/inlays";

const alertProgress = (msg: string, progress: number | string) =>
  showProgressAlert(msg, progress, "backup");

interface NativeBackupPlugin {
  openImport(): Promise<{
    cancelled?: boolean;
    id?: string;
    size?: number;
    assetsWritten?: number;
    ignoredEntries?: number;
    raw?: boolean;
  }>;
  readImportChunk(options: {
    id: string;
    offset: number;
    length: number;
  }): Promise<{ data: string; bytesRead: number; eof: boolean }>;
  closeImport(options: { id: string }): Promise<void>;
  addListener(
    eventName: "importProgress",
    listener: (event: NativeImportProgress) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

interface NativeImportProgress {
  stage: "extracting" | "committing" | "fallback" | "complete";
  bytesRead?: number;
  totalBytes?: number;
  assetsProcessed?: number;
  totalAssets?: number;
}

interface LocalBackupSource {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const NATIVE_IMPORT_CHUNK_SIZE = 512 * 1024;

/**
 * Exposes the native import staging file as a pull-based stream. Keeping the
 * data in Android's cache directory avoids retaining a second complete backup
 * in the WebView as Base64 strings, ArrayBuffers, and Blob parts.
 */
export function createNativeImportSource(
  plugin: Pick<NativeBackupPlugin, "readImportChunk">,
  id: string,
  size: number,
): LocalBackupSource {
  const normalizedSize = Math.max(0, Math.floor(size));

  const readChunk = async (offset: number) => {
    const requested = Math.min(
      NATIVE_IMPORT_CHUNK_SIZE,
      normalizedSize - offset,
    );
    const chunk = await plugin.readImportChunk({
      id,
      offset,
      length: requested,
    });
    if (chunk.bytesRead < 0 || chunk.bytesRead > requested) {
      throw new Error("Native backup importer returned an invalid chunk size");
    }
    if (chunk.bytesRead === 0 && !chunk.eof) {
      throw new Error("Native backup importer stopped before reaching the end");
    }
    const decoded = chunk.data
      ? new Uint8Array(Buffer.from(chunk.data, "base64"))
      : new Uint8Array();
    if (decoded.byteLength !== chunk.bytesRead) {
      throw new Error("Native backup importer returned an incomplete chunk");
    }
    return { ...chunk, decoded };
  };

  return {
    size: normalizedSize,
    stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (offset >= normalizedSize) {
            controller.close();
            return;
          }
          try {
            const chunk = await readChunk(offset);
            offset += chunk.bytesRead;
            if (chunk.decoded.byteLength > 0) controller.enqueue(chunk.decoded);
            if (chunk.eof || offset >= normalizedSize) controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
    async arrayBuffer() {
      const output = new Uint8Array(normalizedSize);
      let offset = 0;
      while (offset < normalizedSize) {
        const chunk = await readChunk(offset);
        output.set(chunk.decoded, offset);
        offset += chunk.bytesRead;
        if (chunk.eof) break;
      }
      if (offset !== normalizedSize) {
        throw new Error(
          "Native backup importer ended before the declared size",
        );
      }
      return output.buffer;
    },
  };
}

const TAURI_IMPORT_CHUNK_SIZE = 4 * 1024 * 1024;

async function createTauriImportSource(
  path: string,
): Promise<LocalBackupSource> {
  const metadataHandle = await openFile(path, { read: true });
  let size = 0;
  try {
    size = Math.max(0, Number((await metadataHandle.stat()).size) || 0);
  } finally {
    await metadataHandle.close();
  }

  return {
    size,
    stream() {
      const handlePromise = openFile(path, { read: true });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await (await handlePromise).close();
        } catch {}
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const handle = await handlePromise;
            const buffer = new Uint8Array(TAURI_IMPORT_CHUNK_SIZE);
            const bytesRead = await handle.read(buffer);
            if (bytesRead === null) {
              await close();
              controller.close();
              return;
            }
            if (bytesRead <= 0)
              throw new Error("Tauri backup importer stopped before EOF");
            controller.enqueue(buffer.subarray(0, bytesRead));
          } catch (error) {
            await close();
            controller.error(error);
          }
        },
        async cancel() {
          await close();
        },
      });
    },
    async arrayBuffer() {
      const output = new Uint8Array(size);
      const handle = await openFile(path, { read: true });
      let offset = 0;
      try {
        while (offset < size) {
          const bytesRead = await handle.read(
            output.subarray(
              offset,
              Math.min(size, offset + TAURI_IMPORT_CHUNK_SIZE),
            ),
          );
          if (bytesRead === null) break;
          if (bytesRead <= 0)
            throw new Error("Tauri backup importer stopped before EOF");
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      if (offset !== size)
        throw new Error("Tauri backup importer ended before the declared size");
      return output.buffer;
    },
  };
}

const nativeBackup = isCapacitor
  ? registerPlugin<NativeBackupPlugin>("NativeBackup")
  : undefined;

export async function ensureTauriBackupAssetsDirectory(
  mkdirFn: typeof mkdir = mkdir,
) {
  await mkdirFn("assets", {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
}

export function normalizeLocalBackupAssetPath(name: string) {
  const normalizedName = name.replace(/\\/g, "/");
  const segments = normalizedName.split("/");

  while (segments[0] === "assets") {
    segments.shift();
  }

  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid backup asset path: ${name}`);
  }

  return `assets/${segments.join("/")}`;
}

export type LocalBackupMode = "native" | "compatible";

export function buildPortableLocalBackupDatabase(
  db: PortableDatabase,
  mode: LocalBackupMode,
  coldStorageValues?: ColdStorageValueMap,
): Record<string, any> {
  const cleanDb: Record<string, any> = {};
  for (const [key, value] of Object.entries(db)) {
    if (
      key === "account" ||
      typeof value === "function" ||
      (mode === "compatible" && key === "moduleFolders")
    )
      continue;
    cleanDb[key] = value;
  }
  cleanDb.pluginCustomStorage ??= {};
  return mode === "compatible"
    ? makeLegacyCompatibleDatabase(cleanDb, coldStorageValues)
    : cleanDb;
}

function formatBackupElapsed(startedAt: number) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000),
  );
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function initializeLocalBackupWriter(
  writer: LocalWriter,
  partial = false,
  mode: LocalBackupMode = "native",
) {
  const label = partial
    ? "Saving partial local backup..."
    : mode === "compatible"
      ? "Saving compatible local backup..."
      : "Saving HaejeokRisuAI local backup...";
  const startedAt = Date.now();
  const waitingDetail =
    isTauri || isCapacitor
      ? "Waiting for the system Save dialog. Choose a file or cancel to continue."
      : "Preparing the browser download stream.";
  const update = () =>
    alertProgress(
      `${label} (Selecting destination)\n${waitingDetail}\nElapsed: ${formatBackupElapsed(startedAt)}`,
      1,
    );
  update();
  const timer = setInterval(update, 1000);
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = partial
      ? `haejeokrisu_partial_backup_${dateStr}`
      : mode === "compatible"
        ? `risu_compatible_backup_${dateStr}`
        : `haejeokrisu_backup_${dateStr}`;
    const initialized = await writer.init(defaultName, ["bin", "risubackup"]);
    if (initialized) {
      alertProgress(`${label} (Destination ready; preparing asset list)`, 2);
    }
    return initialized;
  } finally {
    clearInterval(timer);
  }
}

const INLAY_BACKUP_PREFIX = "inlay_";
const INLAY_BACKUP_SUFFIX = ".risuinlay";

function getInlayBackupEntryName(id: string) {
  return `${INLAY_BACKUP_PREFIX}${id}${INLAY_BACKUP_SUFFIX}`;
}

async function writeLocalBackupInlays(writer: LocalWriter, label: string) {
  const inlays = await listInlayAssets();
  for (let index = 0; index < inlays.length; index++) {
    const [id, asset] = inlays[index];
    const name = getInlayBackupEntryName(id);
    if (getInlayBackupKey(name) !== id) {
      console.warn(`Skipping inlay with unsupported backup key: ${id}`);
      continue;
    }
    if (index === 0 || index === inlays.length - 1 || index % 8 === 0) {
      alertProgress(`${label} (Saving inlays ${index + 1} / ${inlays.length})`, 88);
      await sleep(0);
    }
    await writer.writeBackup(name, await encodeInlayAssetBackup(asset));
  }
}

async function clearNodeBackupInlayStage(storage: NodeStorage) {
  const keys = (await storage.keys(INLAY_BACKUP_PREFIX)).filter(
    (key) => getInlayBackupKey(key) !== null,
  );
  if (keys.length > 0) await storage.removeItem(keys);
}

async function stageNodeInlaysForBackup(storage: NodeStorage) {
  await clearNodeBackupInlayStage(storage);
  const inlays = await listInlayAssets();
  let batch = new Map<string, Uint8Array>();
  let batchBytes = 0;
  const flush = async () => {
    if (batch.size === 0) return;
    await storage.setItems(batch);
    batch = new Map();
    batchBytes = 0;
  };
  for (const [id, asset] of inlays) {
    const name = getInlayBackupEntryName(id);
    if (getInlayBackupKey(name) !== id) continue;
    const encoded = await encodeInlayAssetBackup(asset);
    batch.set(name, encoded);
    batchBytes += encoded.byteLength;
    if (batch.size >= 32 || batchBytes >= 32 * 1024 * 1024) await flush();
  }
  await flush();
}

async function saveNodeLocalBackupStream(mode: LocalBackupMode) {
  await forageStorage.Init();
  if (!(forageStorage.realStorage instanceof NodeStorage)) {
    throw new Error("Node local backup requires NodeStorage");
  }
  const nodeStorage = forageStorage.realStorage;
  if (mode === "native") {
    alertProgress("Saving HaejeokRisuAI local backup... (Staging inlays)", 1);
    await stageNodeInlaysForBackup(nodeStorage);
  }
  try {
    const auth = await nodeStorage.getCachedAuth();
    alertProgress(
    mode === "compatible"
      ? "Saving compatible local backup... (Starting server stream)"
      : "Saving HaejeokRisuAI local backup... (Starting server stream)",
    1,
  );
  const response = await fetch(`/api/local-backup/export/jobs?mode=${mode}`, {
    method: "POST",
    headers: { "risu-auth": auth },
  });
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.id) {
    throw new Error(
      body?.error ?? `Local backup export failed (${response.status})`,
    );
  }
  const completion = fetch(
    `/api/local-backup/export/jobs/${encodeURIComponent(body.id)}`,
    {
      headers: { "risu-auth": auth },
    },
  );
  const anchor = document.createElement("a");
  anchor.href = `/api/local-backup/export/${encodeURIComponent(body.id)}?auth=${encodeURIComponent(auth)}`;
  const dateStr = new Date().toISOString().slice(0, 10);
  anchor.download =
    mode === "compatible"
      ? `risu_compatible_backup_${dateStr}.risubackup`
      : `haejeokrisu_backup_${dateStr}.risubackup`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  alertProgress(
    "Saving local backup... (Server is streaming directly to the download)",
    50,
  );
  const completed = await completion;
  const completedBody = (await completed.json().catch(() => null)) as {
    status?: string;
    error?: string;
  } | null;
  if (!completed.ok || completedBody?.status !== "complete") {
    throw new Error(
      completedBody?.error ??
        `Local backup download failed (${completed.status})`,
    );
  }
    alertNormal("Success");
  } finally {
    if (mode === "native") {
      try {
        await clearNodeBackupInlayStage(nodeStorage);
      } catch (error) {
        console.warn("Failed to clean staged backup inlays:", error);
      }
    }
  }
}

async function loadFullSqlBackupSnapshot(
  onProgress?: (msg: string) => void,
): Promise<PortableDatabase | null> {
  try {
    const storage = await getSqlStorage();
    if (!(await storage.init())) return null;

    const startedAt = Date.now();
    const update = () =>
      onProgress?.(
        `Loading full database snapshot (elapsed ${formatBackupElapsed(startedAt)})`,
      );
    update();
    const timer = setInterval(update, 1000);
    try {
      const loaded = await storage.loadDatabase({ shallow: false });
      if (loaded?.status !== "ready" || !loaded.database) return null;
      return loaded.database as PortableDatabase;
    } finally {
      clearInterval(timer);
    }
  } catch (error) {
    console.warn(
      "Full SQL backup snapshot failed; falling back to entity loading:",
      error,
    );
    return null;
  }
}

async function loadFallbackBackupSnapshot(
  onProgress?: (msg: string) => void,
): Promise<PortableDatabase> {
  onProgress?.("Loading database from storage...");
  await settingsStore.ensureDeferredLoaded();
  // $state.snapshot already returns a detached deep copy of the reactive
  // tree, so a second structuredClone here doubled the peak memory of the
  // backup path (the dominant cost on 4GB Android devices) for no benefit.
  const snapshot = createDatabaseSnapshot() as PortableDatabase;

  try {
    const storage = await getSqlStorage();
    if (!storage.isEnabled()) return snapshot;
    const total = snapshot.characters?.length ?? 0;
    for (let index = 0; index < total; index++) {
      const shell = snapshot.characters[index];
      if (!shell?.chaId) continue;
      onProgress?.(`Loading character chats (${index + 1} / ${total})`);
      const fullCharacter = await storage.loadCharacter(shell.chaId);
      if (fullCharacter) snapshot.characters[index] = fullCharacter;
      const character = snapshot.characters[index];
      for (
        let chatIndex = 0;
        chatIndex < (character.chats?.length ?? 0);
        chatIndex++
      ) {
        const chat = character.chats[chatIndex];
        if (!chat?.id) continue;
        const fullChat = await storage.loadChat(chat.id);
        if (fullChat) character.chats[chatIndex] = fullChat;
      }
    }
  } catch (error) {
    console.warn(
      "Backup entity fallback could not fully hydrate SQL data:",
      error,
    );
  }
  return snapshot;
}

function normalizeBackupSnapshot(db: PortableDatabase): void {
  db.pluginCustomStorage ??= {};
  if (!db.personas || db.personas.length === 0) {
    db.personas = [
      {
        name: db.username || "User",
        icon: db.userIcon || "",
        personaPrompt: "",
        note: db.userNote || "",
        largePortrait: false,
      },
    ];
  } else {
    for (const persona of db.personas) {
      if (persona) persona.largePortrait ??= false;
    }
  }
  if (
    typeof db.selectedPersona !== "number" ||
    db.selectedPersona < 0 ||
    db.selectedPersona >= db.personas.length
  ) {
    db.selectedPersona = 0;
  }
}

async function flushDurableStores(): Promise<void> {
  await Promise.all([
    characterStore.flush(),
    settingsStore.flush(),
    messageStore.flush(),
  ]);
  if (
    characterStore.hasPendingWrites() ||
    settingsStore.hasPendingWrites() ||
    messageStore.hasPendingWrites()
  ) {
    throw new Error("Cannot create a backup while database writes are pending");
  }
}

export async function createBackupDatabaseSnapshot(
  onProgress?: (msg: string) => void,
): Promise<PortableDatabase> {
  await flushDurableStores();

  const db =
    (await loadFullSqlBackupSnapshot(onProgress)) ??
    (await loadFallbackBackupSnapshot(onProgress));

  db.botPresets = (await presetStore.loadAll()).map(
    ({ id: _id, ...preset }) => preset,
  );
  db.botPresetsId = presetStore.activeIndex;

  try {
    const storage = await getSqlStorage();
    if (
      storage.isEnabled() &&
      (!db.pluginCustomStorage ||
        Object.keys(db.pluginCustomStorage).length === 0)
    ) {
      const pluginStorage = await storage.loadPluginCustomStorage();
      if (pluginStorage && Object.keys(pluginStorage).length > 0) {
        db.pluginCustomStorage = pluginStorage;
      }
    }
  } catch {}

  normalizeBackupSnapshot(db);
  return db;
}

type BackupAssetScope = "all" | "essential";
type BackupAssetInfo = { charName: string; assetName: string };

interface LocalBackupExportOptions {
  mode: LocalBackupMode;
  partial: boolean;
  assetScope: BackupAssetScope;
  accountReadDelayMs: number;
  encryptAccountBackup: boolean;
}

function backupLabel(partial: boolean) {
  return partial ? "Saving partial local backup..." : "Saving local backup...";
}

function addBackupAsset(
  map: Map<string, BackupAssetInfo>,
  key: string | undefined,
  charName: string,
  assetName: string,
) {
  if (key) map.set(key, { charName, assetName });
}

function buildBackupAssetMap(
  db: PortableDatabase,
  scope: BackupAssetScope,
): Map<string, BackupAssetInfo> {
  const assets = new Map<string, BackupAssetInfo>();
  for (const char of db.characters ?? []) {
    if (!char) continue;
    const charName = char.name ?? "Unknown Character";
    addBackupAsset(
      assets,
      char.image,
      charName,
      scope === "essential" ? "Profile Image" : "Main Image",
    );
    if (scope === "essential") continue;

    for (const emotion of char.emotionImages ?? []) {
      if (emotion?.[1])
        addBackupAsset(assets, emotion[1], charName, emotion[0]);
    }
    if (char.type === "group") continue;
    for (const asset of char.additionalAssets ?? []) {
      if (asset?.[1]) addBackupAsset(assets, asset[1], charName, asset[0]);
    }
    for (const [name, key] of Object.entries(char.vits?.files ?? {})) {
      if (key) addBackupAsset(assets, key, charName, name);
    }
    for (const asset of char.ccAssets ?? []) {
      if (asset?.uri) addBackupAsset(assets, asset.uri, charName, asset.name);
    }
  }

  addBackupAsset(assets, db.userIcon, "User Settings", "User Icon");
  addBackupAsset(
    assets,
    db.customBackground,
    "User Settings",
    "Custom Background",
  );
  for (const persona of db.personas ?? []) {
    if (persona?.icon) {
      addBackupAsset(assets, persona.icon, "Persona", `${persona.name} Icon`);
    }
  }

  if (scope === "essential") {
    for (const item of db.characterOrder ?? []) {
      if (typeof item === "string") continue;
      addBackupAsset(assets, item.img, "Folder", `${item.name} Folder Image`);
      addBackupAsset(
        assets,
        item.imgFile,
        "Folder",
        `${item.name} Folder Image File`,
      );
    }
    for (const preset of db.botPresets ?? []) {
      if (preset?.image) {
        addBackupAsset(
          assets,
          preset.image,
          "Preset",
          `${preset.name} Preset Image`,
        );
      }
    }
  }
  return assets;
}

function findBackupAssetInfo(
  assetMap: Map<string, BackupAssetInfo>,
  key: string,
) {
  return (
    assetMap.get(key) ??
    assetMap.get(key.replace(/^assets\//, "")) ??
    assetMap.get(`assets/${key}`)
  );
}

function isEssentialBackupAsset(
  assetMap: Map<string, BackupAssetInfo>,
  key: string,
) {
  if (!key.endsWith(".png")) return false;
  return Boolean(findBackupAssetInfo(assetMap, key));
}

function reportBackupAssetProgress(
  label: string,
  current: number,
  total: number,
  key: string,
  assetMap: Map<string, BackupAssetInfo>,
  missingCount: number,
) {
  const percent = total > 0 ? (current / total) * 80 : 80;
  const info = findBackupAssetInfo(assetMap, key);
  let message = `${label} (${current} / ${total})`;
  message += info ? `\n${info.charName} - ${info.assetName}` : `\n${key}`;
  if (missingCount > 0) {
    message += `\n(Skipped ${missingCount} missing assets)`;
  }
  alertProgress(message, percent);
}

async function writeLocalBackupAssets(
  writer: LocalWriter,
  db: PortableDatabase,
  options: LocalBackupExportOptions,
): Promise<{
  missingAssets: string[];
  assetMap: Map<string, BackupAssetInfo>;
}> {
  const label = backupLabel(options.partial);
  const assetMap = buildBackupAssetMap(db, options.assetScope);
  const missingAssets: string[] = [];
  let lastUiUpdate = 0;

  if (isTauri) {
    alertProgress(`${label} (Scanning assets)`, 0);
    await sleep(10);
    await ensureTauriBackupAssetsDirectory();
    let assets = (
      await readDir("assets", { baseDir: BaseDirectory.AppData })
    ).filter((asset) => asset.isFile && Boolean(asset.name));
    if (options.assetScope === "essential") {
      assets = assets.filter((asset) =>
        isEssentialBackupAsset(assetMap, asset.name ?? ""),
      );
    }

    for (let index = 0; index < assets.length; index++) {
      const key = assets[index].name;
      if (!key) continue;
      const now = Date.now();
      if (
        now - lastUiUpdate > 30 ||
        index === 0 ||
        index === assets.length - 1
      ) {
        lastUiUpdate = now;
        reportBackupAssetProgress(
          label,
          index + 1,
          assets.length,
          key,
          assetMap,
          missingAssets.length,
        );
        await sleep(0);
      }
      const data = await readFile(`assets/${key}`, {
        baseDir: BaseDirectory.AppData,
      });
      if (data) await writer.writeBackup(key, data);
      else missingAssets.push(key);
    }
    return { missingAssets, assetMap };
  }

  let keys = (await forageStorage.keys()).filter((key) =>
    key?.startsWith("assets/"),
  );
  if (options.assetScope === "essential") {
    keys = keys.filter((key) => isEssentialBackupAsset(assetMap, key));
  }

  if (
    isCapacitor &&
    !forageStorage.isAccount &&
    writer.supportsNativeAssetTransfer()
  ) {
    const batchSize = 128;
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      const batch = keys.slice(offset, offset + batchSize);
      const result = await writer.writeNativeAssets(batch);
      missingAssets.push(...result.missing);
      const current = Math.min(offset + batch.length, keys.length);
      const key = batch[batch.length - 1] ?? "";
      reportBackupAssetProgress(
        label,
        current,
        keys.length,
        key,
        assetMap,
        missingAssets.length,
      );
      await sleep(0);
    }
    return { missingAssets, assetMap };
  }

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const now = Date.now();
    if (now - lastUiUpdate > 30 || index === 0 || index === keys.length - 1) {
      lastUiUpdate = now;
      reportBackupAssetProgress(
        label,
        index + 1,
        keys.length,
        key,
        assetMap,
        missingAssets.length,
      );
      await sleep(0);
    }

    let data: Uint8Array | undefined;
    let isCached = false;
    if (forageStorage.isAccount) {
      if (settingsStore.state.skipSavingAssetsOnWebSync) continue;
      const cached = (await localforage.getItem(key)) as ArrayBuffer;
      if (cached) {
        isCached = true;
        data = new Uint8Array(cached);
      }
    }
    if (!data) {
      data = (await forageStorage.getItem(key)) as unknown as Uint8Array;
    }
    if (data) await writer.writeBackup(key, data);
    else missingAssets.push(key);
    if (forageStorage.isAccount && !isCached) {
      await sleep(options.accountReadDelayMs);
    }
  }
  return { missingAssets, assetMap };
}

async function collectBackupColdStorage(db: PortableDatabase, label: string) {
  alertProgress(`${label} (Checking cold storage)`, 0);
  await sleep(10);
  const coldStoragePayloads = await collectColdStorageBackupPayloads(
    db,
    (current, total, key) => {
      const item = key ? `\nCurrent item: ${key}` : "";
      alertProgress(
        `${label} (Checking cold storage ${current} / ${total})${item}`,
        0,
      );
    },
  );
  const unavailableKeys = [
    ...coldStoragePayloads.missingKeys,
    ...coldStoragePayloads.invalidKeys,
  ];
  const confirmed = await confirmIncompleteColdStorageOperation(
    db,
    unavailableKeys,
    "backup",
  );
  return confirmed ? coldStoragePayloads : null;
}

async function writeBackupColdStorage(
  writer: LocalWriter,
  coldStoragePayloads: Awaited<
    ReturnType<typeof collectColdStorageBackupPayloads>
  >,
  label: string,
) {
  const total = coldStoragePayloads.payloads.length;
  for (let index = 0; index < total; index++) {
    const payload = coldStoragePayloads.payloads[index];
    const percent = total > 0 ? 80 + ((index + 1) / total) * 10 : 80;
    let message = `${label} cold data... (${index + 1} / ${total})`;
    if (payload.backupName) message += `\n${payload.backupName}`;
    alertProgress(message, percent);
    await sleep(0);
    await writer.writeBackup(payload.backupName, payload.encoded);
  }
}

function showMissingBackupAssets(
  missingAssets: string[],
  assetMap: Map<string, BackupAssetInfo>,
  partial: boolean,
) {
  if (missingAssets.length === 0) {
    alertNormal("Success");
    return;
  }
  let message = partial
    ? "Partial backup successful, but the following profile images were missing and skipped:\n\n"
    : "Backup Successful, but the following assets were missing and skipped:\n\n";
  for (const key of missingAssets) {
    const info = findBackupAssetInfo(assetMap, key);
    message += info
      ? `* **${info.assetName}** (from *${info.charName}*)  \n  *File: ${key}*\n`
      : `* **Unknown Asset**  \n  *File: ${key}*\n`;
  }
  alertMd(message);
}

async function saveLocalBackupWithOptions(options: LocalBackupExportOptions) {
  const label = backupLabel(options.partial);
  alertProgress(`${label} (Preparing database)`, 0);
  await sleep(10);
  const db = await createBackupDatabaseSnapshot((msg) => {
    alertProgress(`${label} (${msg})`, 0);
  });
  const coldStoragePayloads = await collectBackupColdStorage(db, label);
  if (!coldStoragePayloads) {
    alertClear();
    return;
  }

  const writer = new LocalWriter();
  if (
    !(await initializeLocalBackupWriter(writer, options.partial, options.mode))
  ) {
    alertClear();
    return;
  }

  const { missingAssets, assetMap } = await writeLocalBackupAssets(
    writer,
    db,
    options,
  );
  if (options.mode === "native" && !options.partial) {
    await writeLocalBackupInlays(writer, label);
  }
  await writeBackupColdStorage(writer, coldStoragePayloads, label);

  alertProgress(`${label} (Compressing database)`, 92);
  await sleep(30);
  const coldStorageValues = new Map(
    coldStoragePayloads.payloads.map(
      (payload) => [payload.key, payload.value] as const,
    ),
  );
  const cleanDb = buildPortableLocalBackupDatabase(
    db,
    options.mode,
    coldStorageValues,
  );
  let dbData = await encodeRisuSaveLegacyAsync(cleanDb, "compression");

  if (
    options.encryptAccountBackup &&
    forageStorage.isAccount &&
    location.origin.endsWith("risuai.xyz")
  ) {
    alertProgress(`${label} (Encrypting database)`, 96);
    await sleep(20);
    const time = Date.now();
    const key = (
      await (await fetch(`https://sv.risuai.xyz/cryptokey?key=${time}`)).json()
    ).key;
    dbData = new Uint8Array(await encryptBuffer(dbData, key));
    await writer.writeBackup(
      "encryption.risudat",
      new TextEncoder().encode(JSON.stringify({ time, type: "account" })),
    );
  }

  alertProgress(`${label} (Writing database)`, 98);
  await sleep(10);
  await writer.writeBackup("database.risudat", dbData);
  alertProgress(`${label} (Finalizing)`, 100);
  await sleep(10);
  await writer.close();
  showMissingBackupAssets(missingAssets, assetMap, options.partial);
}

export async function SaveLocalBackup(mode: LocalBackupMode = "native") {
  try {
    if (isNodeServer && !forageStorage.isAccount) {
      await flushDurableStores();
      await saveNodeLocalBackupStream(mode);
      return;
    }
    await saveLocalBackupWithOptions({
      mode,
      partial: false,
      assetScope: "all",
      accountReadDelayMs: 1000,
      encryptAccountBackup: true,
    });
  } catch (error) {
    console.error("SaveLocalBackup failed:", error);
    alertError(error);
  }
}

/** Save a native backup containing only the essential visual assets. */
export async function SavePartialLocalBackup() {
  try {
    if (!(await alertConfirm(language.partialBackupFirstConfirm))) return;
    if (!(await alertConfirm(language.partialBackupSecondConfirm))) return;
    await saveLocalBackupWithOptions({
      mode: "native",
      partial: true,
      assetScope: "essential",
      accountReadDelayMs: 100,
      encryptAccountBackup: false,
    });
  } catch (error) {
    console.error("SavePartialLocalBackup failed:", error);
    alertError(error);
  }
}

async function restoreLocalBackupSource(
  file: LocalBackupSource,
  parserProgress: { start: number; end: number } = { start: 0, end: 90 },
) {
  const textDecoder = new TextDecoder();
  const encryptionMeta: {
    type: "none" | "account";
    time?: number;
  } = {
    type: "none",
  };

  let pendingDatabase: Uint8Array | null = null;
  let decodedDatabase: Database | null = null;
  const restoredColdStorageKeys = new Set<string>();
  const useNodeBulkRestore = isNodeServer && !forageStorage.isAccount;
  const pendingNodeAssets = new Map<string, Uint8Array>();
  const nodeBulkMaxFiles = 64;
  const nodeBulkMaxBytes = 64 * 1024 * 1024;
  let pendingNodeAssetBytes = 0;
  let entriesRestored = 0;
  let entriesWritten = 0;
  let failedInlayEntries = 0;
  let currentEntryName = "";
  let bytesRead = 0;
  const useTauriBulkRestore = isTauri;
  let pendingTauriAssets = new Map<string, Uint8Array>();
  const tauriAssetDirectories = new Set<string>();
  const tauriBulkMaxFiles = 128;
  const tauriBulkMaxBytes = 64 * 1024 * 1024;
  const tauriBulkWriteConcurrency = 8;
  let pendingTauriAssetBytes = 0;

  const flushTauriAssets = async (): Promise<number> => {
    if (pendingTauriAssets.size === 0) return 0;
    const entries = Array.from(pendingTauriAssets);
    pendingTauriAssets = new Map();
    pendingTauriAssetBytes = 0;

    const directories = new Set(
      entries.map(([assetPath]) =>
        assetPath.slice(0, assetPath.lastIndexOf("/")),
      ),
    );
    await Promise.all(
      Array.from(directories)
        .filter((directory) => !tauriAssetDirectories.has(directory))
        .map(async (directory) => {
          await mkdir(directory, {
            baseDir: BaseDirectory.AppData,
            recursive: true,
          });
          tauriAssetDirectories.add(directory);
        }),
    );

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(tauriBulkWriteConcurrency, entries.length) },
      async () => {
        while (cursor < entries.length) {
          const [assetPath, data] = entries[cursor++];
          await writeFile(assetPath, data, { baseDir: BaseDirectory.AppData });
        }
      },
    );
    await Promise.all(workers);
    return entries.length;
  };

  const flushNodeAssets = async (): Promise<number> => {
    if (pendingNodeAssets.size === 0) {
      return 0;
    }
    const count = pendingNodeAssets.size;
    await (forageStorage.realStorage as NodeStorage).setItems(
      pendingNodeAssets,
    );
    pendingNodeAssets.clear();
    pendingNodeAssetBytes = 0;
    return count;
  };

  // Browser storage (IndexedDB/localForage) has no bulk API, but writing
  // assets one-by-one serializes every IndexedDB transaction and makes
  // restoring large backups extremely slow. Batch them instead and write
  // each batch in a single IndexedDB transaction when possible.
  const useBrowserBulkRestore = !isTauri && !useNodeBulkRestore;
  let pendingBrowserAssets = new Map<string, Uint8Array>();
  const browserBulkMaxFiles = 256;
  const browserBulkMaxBytes = 64 * 1024 * 1024;
  const browserBulkWriteConcurrency = 8;
  let pendingBrowserAssetBytes = 0;

  /**
   * Reuse localForage's own IndexedDB connection so restored assets land in
   * exactly the same database/store localForage reads from. Returns null when
   * the active driver is not IndexedDB (e.g. WebSQL/localStorage fallback).
   */
  const getLocalForageIdb = async (): Promise<{
    db: IDBDatabase;
    storeName: string;
  } | null> => {
    try {
      const storage = forageStorage.realStorage as any;
      if (typeof storage?.ready !== "function") return null;
      await storage.ready();
      const dbInfo = storage._dbInfo;
      if (!dbInfo?.db || !dbInfo.storeName) return null;
      return { db: dbInfo.db, storeName: dbInfo.storeName };
    } catch {
      return null;
    }
  };

  const writeBrowserAssetBatchWithLocalForage = async (
    entries: Array<[string, Uint8Array]>,
  ) => {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(browserBulkWriteConcurrency, entries.length) },
      async () => {
        while (cursor < entries.length) {
          const [key, data] = entries[cursor++];
          await forageStorage.setItem(key, data);
        }
      },
    );
    await Promise.all(workers);
  };

  const flushBrowserAssets = async (): Promise<number> => {
    if (pendingBrowserAssets.size === 0) {
      return 0;
    }
    const count = pendingBrowserAssets.size;
    const entries = Array.from(pendingBrowserAssets);
    pendingBrowserAssets = new Map();
    pendingBrowserAssetBytes = 0;

    try {
      const idb = await getLocalForageIdb();
      if (idb) {
        await new Promise<void>((resolve, reject) => {
          const tx = idb.db.transaction(idb.storeName, "readwrite");
          const store = tx.objectStore(idb.storeName);
          for (const [key, data] of entries) {
            store.put(data, key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(tx.error ?? new Error("IndexedDB bulk write failed"));
          tx.onabort = () =>
            reject(tx.error ?? new Error("IndexedDB bulk write aborted"));
        });
        return count;
      }
    } catch (error) {
      console.warn(
        "IndexedDB bulk asset write failed, falling back to per-item writes:",
        error,
      );
    }

    await writeBrowserAssetBatchWithLocalForage(entries);
    return count;
  };

  const restoreBackupEntry = async (name: string, data: Uint8Array) => {
    currentEntryName = name;
    if (name === "encryption.risudat") {
      let meta: typeof encryptionMeta;
      try {
        meta = JSON.parse(textDecoder.decode(data));
      } catch (error) {
        console.error("Failed to parse encryption metadata:", error);
        throw new Error(
          "This backup is encrypted, but its encryption metadata is invalid.",
        );
      }

      if (
        meta.type !== "account" ||
        typeof meta.time !== "number" ||
        !Number.isFinite(meta.time) ||
        meta.time <= 0
      ) {
        throw new Error(
          "This backup is encrypted, but its encryption metadata is incomplete.",
        );
      }
      encryptionMeta.type = "account";
      encryptionMeta.time = meta.time;
    } else if (name === "database.risudat") {
      pendingDatabase = data;
    } else {
      const inlayKey = getInlayBackupKey(name);
      if (inlayKey) {
        try {
          await setInlayAsset(inlayKey, decodeInlayAssetBackup(data));
          entriesWritten++;
        } catch (e) {
          failedInlayEntries++;
          console.error(`Failed to restore inlay item ${inlayKey}:`, e);
        } finally {
          // This counter represents parsed entries, not only successful writes.
          // Keep progress accounting correct even when a corrupt inlay is skipped.
          entriesRestored++;
        }
        currentEntryName = "";
        return;
      }

      const coldStorageKey = getColdStorageBackupKey(name);
      let handledAsColdStorage = false;

      if (coldStorageKey) {
        handledAsColdStorage = true;
        try {
          const jsonData = JSON.parse(textDecoder.decode(data));

          if (isColdStorageBackupData(jsonData)) {
            if (await setColdStorageItem(coldStorageKey, jsonData)) {
              restoredColdStorageKeys.add(coldStorageKey);
            } else {
              console.error(
                `Failed to restore cold storage item ${coldStorageKey}`,
              );
            }
          } else {
            console.warn(`Skipping invalid cold storage backup item ${name}`);
          }
        } catch (e) {
          console.error(
            `Failed to parse cold storage item ${coldStorageKey}:`,
            e,
          );
        }
      }

      if (!handledAsColdStorage) {
        const assetPath = normalizeLocalBackupAssetPath(name);
        if (useTauriBulkRestore) {
          const previous = pendingTauriAssets.get(assetPath);
          if (previous) pendingTauriAssetBytes -= previous.byteLength;
          pendingTauriAssets.set(assetPath, data);
          pendingTauriAssetBytes += data.byteLength;

          if (
            pendingTauriAssets.size >= tauriBulkMaxFiles ||
            pendingTauriAssetBytes >= tauriBulkMaxBytes
          ) {
            const flushed = await flushTauriAssets();
            if (flushed) entriesWritten += flushed;
          }
        } else if (useNodeBulkRestore) {
          const key = assetPath;
          const previous = pendingNodeAssets.get(key);
          if (previous) {
            pendingNodeAssetBytes -= previous.byteLength;
          }
          pendingNodeAssets.set(key, data);
          pendingNodeAssetBytes += data.byteLength;

          if (
            pendingNodeAssets.size >= nodeBulkMaxFiles ||
            pendingNodeAssetBytes >= nodeBulkMaxBytes
          ) {
            const flushed = await flushNodeAssets();
            if (flushed) {
              entriesWritten += flushed;
            }
          }
        } else {
          const key = assetPath;
          const previous = pendingBrowserAssets.get(key);
          if (previous) {
            pendingBrowserAssetBytes -= previous.byteLength;
          }
          pendingBrowserAssets.set(key, data);
          pendingBrowserAssetBytes += data.byteLength;

          if (
            pendingBrowserAssets.size >= browserBulkMaxFiles ||
            pendingBrowserAssetBytes >= browserBulkMaxBytes
          ) {
            const flushed = await flushBrowserAssets();
            if (flushed) {
              entriesWritten += flushed;
            }
          }
        }
      }
    }

    entriesRestored++;
    currentEntryName = "";
  };

  let ignoredExtensionEntries = 0;
  try {
    const reader = file.stream().getReader();
    let lastUiUpdate = 0;
    type BackupParserPhase = "nameLength" | "name" | "dataLength" | "data";
    let parserPhase: BackupParserPhase = "nameLength";
    const lengthBuffer = new Uint8Array(4);
    let lengthOffset = 0;
    let entryNameBuffer = new Uint8Array();
    let entryNameOffset = 0;
    let entryName = "";
    let entryDataLength = 0;
    let entryDataReceived = 0;
    let entryDataBuffer: Uint8Array | null = new Uint8Array();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.length;
      const now = Date.now();
      if (now - lastUiUpdate > 30) {
        lastUiUpdate = now;
        const readPercent =
          file.size === 0
            ? parserProgress.end
            : Math.floor(
                parserProgress.start +
                  (bytesRead / file.size) *
                    (parserProgress.end - parserProgress.start),
              );
        let message = `Parsing backup... (${readPercent}%) (${entriesRestored} entries parsed`;
        const isBulkRestore =
          useTauriBulkRestore || useNodeBulkRestore || useBrowserBulkRestore;
        if (isBulkRestore && entriesWritten > 0) {
          message += `, ${entriesWritten} written`;
        }
        message += ")";
        if (currentEntryName) {
          message += `\n${currentEntryName}`;
        }
        alertProgress(message, readPercent);
      }

      let chunkOffset = 0;
      while (chunkOffset < value.length) {
        if (parserPhase === "nameLength" || parserPhase === "dataLength") {
          const copyLength = Math.min(
            lengthBuffer.length - lengthOffset,
            value.length - chunkOffset,
          );
          lengthBuffer.set(
            value.subarray(chunkOffset, chunkOffset + copyLength),
            lengthOffset,
          );
          lengthOffset += copyLength;
          chunkOffset += copyLength;
          if (lengthOffset < lengthBuffer.length) {
            continue;
          }

          const length = new DataView(lengthBuffer.buffer).getUint32(0, true);
          lengthOffset = 0;

          if (parserPhase === "nameLength") {
            if (length === 0 || length > 1024 * 1024) {
              throw new Error("Invalid backup entry name length");
            }
            entryNameBuffer = new Uint8Array(length);
            entryNameOffset = 0;
            parserPhase = "name";
          } else {
            if (length > file.size) {
              throw new Error("Invalid backup entry data length");
            }
            entryDataLength = length;
            entryDataReceived = 0;
            const classification = classifyBackupEntry(entryName);
            if (classification.kind === "invalid") {
              throw new Error(`Invalid backup entry path: ${entryName}`);
            }
            if (classification.kind === "extension") {
              entryDataBuffer = null;
              ignoredExtensionEntries++;
              console.info(
                `Skipping unsupported backup extension entry: ${entryName}`,
              );
            } else {
              entryDataBuffer = new Uint8Array(length);
            }
            parserPhase = "data";

            if (entryDataLength === 0) {
              if (entryDataBuffer !== null) {
                await restoreBackupEntry(entryName, new Uint8Array());
              }
              entryName = "";
              parserPhase = "nameLength";
            }
          }
          continue;
        }

        if (parserPhase === "name") {
          const copyLength = Math.min(
            entryNameBuffer.length - entryNameOffset,
            value.length - chunkOffset,
          );
          entryNameBuffer.set(
            value.subarray(chunkOffset, chunkOffset + copyLength),
            entryNameOffset,
          );
          entryNameOffset += copyLength;
          chunkOffset += copyLength;

          if (entryNameOffset === entryNameBuffer.length) {
            entryName = textDecoder.decode(entryNameBuffer);
            parserPhase = "dataLength";
          }
          continue;
        }

        const copyLength = Math.min(
          entryDataLength - entryDataReceived,
          value.length - chunkOffset,
        );
        if (entryDataBuffer !== null) {
          entryDataBuffer.set(
            value.subarray(chunkOffset, chunkOffset + copyLength),
            entryDataReceived,
          );
        }
        entryDataReceived += copyLength;
        chunkOffset += copyLength;

        if (entryDataReceived === entryDataLength) {
          if (entryDataBuffer !== null) {
            await restoreBackupEntry(entryName, entryDataBuffer);
          }
          entryName = "";
          entryDataBuffer = new Uint8Array();
          parserPhase = "nameLength";
        }
      }
    }

    if (parserPhase !== "nameLength" || lengthOffset !== 0) {
      throw new Error("Backup file ended with an incomplete entry");
    }
  } catch (streamErr) {
    // If chunked container failed, try fallback for raw database.bin
    console.warn(
      "Stream backup container parsing failed, trying raw database.bin fallback:",
      streamErr,
    );
    try {
      const buffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(buffer);
      const rawDb = await decodeRisuSave(rawBytes);
      if (!rawDb || typeof rawDb !== "object") {
        throw streamErr;
      }
      pendingDatabase = rawBytes;
      decodedDatabase = rawDb as Database;
    } catch {
      throw streamErr;
    }
  }

  if (useTauriBulkRestore && pendingTauriAssets.size > 0) {
    alertProgress(
      `Flushing remaining assets... (${pendingTauriAssets.size} files)`,
      90,
    );
    const flushed = await flushTauriAssets();
    if (flushed) entriesWritten += flushed;
  }

  if (useNodeBulkRestore && pendingNodeAssets.size > 0) {
    alertProgress(
      `Flushing remaining assets... (${pendingNodeAssets.size} files)`,
      90,
    );
    const flushed = await flushNodeAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (useBrowserBulkRestore && pendingBrowserAssets.size > 0) {
    alertProgress(
      `Flushing remaining assets... (${pendingBrowserAssets.size} files)`,
      90,
    );
    const flushed = await flushBrowserAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (!pendingDatabase) {
    throw new Error("Backup does not contain a database entry");
  }

  const databaseByteLength = pendingDatabase.byteLength;
  let db: Uint8Array | null = pendingDatabase;
  pendingDatabase = null;
  if (encryptionMeta.type === "account" && encryptionMeta.time) {
    try {
      db = await decryptLegacyAccountBackup(
        db,
        encryptionMeta.time,
        decryptBuffer,
      );
    } catch (error) {
      console.error("Failed to decrypt database backup:", error);
      const detail = error instanceof Error ? error.message : `${error}`;
      throw new Error(
        `This backup is encrypted and could not be decrypted. ${detail}`,
      );
    }
  }
  const restoreWarnings: string[] = [];
  if (ignoredExtensionEntries > 0) {
    restoreWarnings.push(
      `Skipped ${ignoredExtensionEntries} unsupported fork extension entries.`,
    );
  }
  if (failedInlayEntries > 0) {
    restoreWarnings.push(
      `Skipped ${failedInlayEntries} corrupt inlay entr${failedInlayEntries === 1 ? "y" : "ies"}.`,
    );
  }
  alertProgress(
    restoreWarnings.length > 0
      ? `Decoding database...\n${restoreWarnings.join("\n")}`
      : "Decoding database...",
    91,
  );
  const dbData = decodedDatabase ?? ((await decodeRisuSave(db)) as Database);
  db = null;
  console.info("[LocalBackupRestore] Decoded database summary", {
    databaseBytes: databaseByteLength,
    characters: Array.isArray(dbData.characters)
      ? dbData.characters.length
      : null,
    personas: Array.isArray(dbData.personas) ? dbData.personas.length : null,
    modules: Array.isArray(dbData.modules) ? dbData.modules.length : null,
    botPresets: Array.isArray(
      (dbData as Database & Partial<PortableDatabase>).botPresets,
    )
      ? (dbData as Database & Partial<PortableDatabase>).botPresets!.length
      : null,
    promptTemplate: Array.isArray(dbData.promptTemplate)
      ? dbData.promptTemplate.length
      : null,
  });
  normalizeDatabaseDefaults(dbData);
  dbData.pluginCustomStorage ??= {};
  const missingColdStorageKeys: string[] = [];
  for (const key of await listColdDataKeys(dbData)) {
    if (restoredColdStorageKeys.has(key)) {
      continue;
    }
    const existingColdStorage = await getColdStorageItem(key);
    if (!isColdStorageBackupData(existingColdStorage)) {
      missingColdStorageKeys.push(key);
    }
  }
  if (
    !(await confirmIncompleteColdStorageOperation(
      dbData,
      missingColdStorageKeys,
      "restore",
    ))
  ) {
    return;
  }

  const totalChars = dbData.characters?.length ?? 0;
  let totalChats = 0;
  for (const c of dbData.characters ?? []) {
    totalChats += c.chats?.length ?? 0;
  }
  const baseMsg = `Syncing SQL (${totalChars} characters, ${totalChats} chats)`;
  alertProgress(`${baseMsg}...`, 92);
  const storage = await getSqlStorage();
  await storage.replaceDatabase(dbData, (step, syncProgress) => {
    const ratio =
      syncProgress === undefined ? 0 : Math.max(0, Math.min(1, syncProgress));
    const progress = 92 + ratio * 8;
    const sqlPercent = Math.round(ratio * 100);
    alertProgress(`${baseMsg}\n${step}\nSQL restore: ${sqlPercent}%`, progress);
  });

  if (isTauri) {
    await relaunch();
    alertStore.set({
      type: "wait",
      msg: "Success, Refreshing your app.",
    });
  } else {
    location.search = "";
    alertStore.set({
      type: "wait",
      msg: "Success, Refreshing your app.",
    });
    location.reload();
  }

  alertNormal("Success");
}

export async function restoreLocalBackupFile(file: File) {
  await restoreLocalBackupSource(file);
}

async function loadCapacitorLocalBackup() {
  if (!nativeBackup) throw new Error("Native backup importer is unavailable");
  alertProgress(
    "Opening local backup...\nChoose a backup file in the Android file picker.",
    0,
  );
  const progressListener = await nativeBackup.addListener(
    "importProgress",
    (event) => {
      const bytesRead = Math.max(0, event.bytesRead ?? 0);
      const totalBytes = Math.max(0, event.totalBytes ?? 0);
      const readPercent =
        totalBytes > 0
          ? Math.min(45, Math.floor((bytesRead / totalBytes) * 45))
          : 0;
      const byteDetail =
        totalBytes > 0
          ? `${(bytesRead / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
          : `${(bytesRead / 1024 / 1024).toFixed(1)} MB`;

      if (event.stage === "committing") {
        const processed = Math.max(0, event.assetsProcessed ?? 0);
        const total = Math.max(0, event.totalAssets ?? 0);
        const percent =
          total > 0 ? 45 + Math.floor((processed / total) * 4) : 47;
        alertProgress(
          `Installing restored assets... (${processed} / ${total})`,
          percent,
        );
      } else if (event.stage === "fallback") {
        alertProgress(
          `Reading legacy database backup...\n${byteDetail}`,
          readPercent,
        );
      } else if (event.stage === "complete") {
        alertProgress("Native backup extraction complete.", 50);
      } else {
        const assets = Math.max(0, event.assetsProcessed ?? 0);
        alertProgress(
          `Reading and extracting backup...\n${byteDetail}\n${assets} assets found`,
          readPercent,
        );
      }
    },
  );
  let selected: Awaited<ReturnType<NativeBackupPlugin["openImport"]>>;
  try {
    selected = await nativeBackup.openImport();
  } finally {
    await progressListener.remove().catch(() => {});
  }
  if (selected.cancelled) {
    alertClear();
    return;
  }
  if (!selected.id)
    throw new Error("Native backup import session was not created");

  const id = selected.id;
  try {
    const size = Math.max(0, selected.size ?? 0);
    const ignoredEntries = Math.max(0, selected.ignoredEntries ?? 0);
    alertProgress(
      `Native extraction complete (${selected.assetsWritten ?? 0} assets).${
        ignoredEntries > 0
          ? ` Skipped ${ignoredEntries} unsupported fork extension entries.`
          : ""
      } Streaming database data...`,
      50,
    );
    await restoreLocalBackupSource(
      createNativeImportSource(nativeBackup, id, size),
      { start: 50, end: 90 },
    );
  } finally {
    await nativeBackup.closeImport({ id }).catch(() => {});
  }
}

async function loadTauriLocalBackup() {
  const selected = await openDialog({
    multiple: false,
    filters: [
      {
        name: "RisuAI local backup",
        extensions: ["bin", "risubackup"],
      },
    ],
  });
  if (selected === null) return;

  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return;
  alertProgress("Opening local backup...", 0);
  const source = await createTauriImportSource(path);
  await restoreLocalBackupSource(source);
}

export async function LoadLocalBackup() {
  try {
    if (isCapacitor) {
      await loadCapacitorLocalBackup();
      return;
    }
    if (isTauri) {
      await loadTauriLocalBackup();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.risubackup";
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        input.remove();
        return;
      }
      const file = input.files[0];
      input.remove();
      try {
        await restoreLocalBackupFile(file);
      } catch (error) {
        console.error(error);
        const detail = error instanceof Error ? error.message : `${error}`;
        alertError(
          `Failed to load local backup: ${detail}\nCheck the server console or logs for details.`,
        );
      }
    };
    input.click();
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : `${error}`;
    alertError(
      `Failed to load local backup: ${detail}\nCheck the server console or logs for details.`,
    );
  }
}
