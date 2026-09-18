import {
  BaseDirectory,
  mkdir,
  open as openFile,
  readFile,
  writeFile,
} from "@tauri-apps/plugin-fs";
import localforage from "localforage";
import {
  alertError,
  alertNormal,
  alertNormalWait,
  alertStore,
  alertMd,
  alertConfirm,
  alertProgress as showProgressAlert,
  alertClear,
} from "../alert";
import { LocalWriter, forageStorage } from "../globalApi.svelte";
import { isCapacitor, isNodeServer, isTauri } from "src/ts/platform";
import {
  decodeRisuSave,
  encodeRisuSaveLegacyAsync,
} from "../storage/backup/risuSave";
import { normalizeDatabaseDefaults } from "../storage/database/databaseDefaults";
import type {
  CanonicalDatabase,
  Database,
  LegacyPersonaMirrorKey,
  PortableDatabase,
} from "../storage/database/schema";

import { relaunch } from "@tauri-apps/plugin-process";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { decryptBuffer, encryptBuffer, sleep } from "../util";
import { hubURL } from "../characterCards";
import { language } from "src/lang";
import {
  collectColdStorageBackupPayloads,
  confirmIncompleteColdStorageOperation,
  coldStorageHeader,
  getColdStorageBackupKey,
  getColdStorageBackupName,
  getColdStorageItem,
  isColdStorageBackupData,
  listColdDataKeys,
  setColdStorageItem,
} from "../process/coldstorage.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { flushDurableStores } from "../stores/domain/flushDurableStores";
import { NodeStorage } from "../storage/files/nodeStorage";
import {
  getSqlBranchStorage,
  getSqlStorage,
} from "../storage/sql/sqlStorageFactory";
import {
  decryptLegacyAccountBackup,
  fetchLegacyBackupKey,
} from "./legacyBackupEncryption";
import {
  decryptStreamingBackupEntry,
  encryptStreamingBackupEntry,
  isStreamingBackupEncryptedEntry,
  STREAMING_BACKUP_ENCRYPTION_FORMAT,
} from "./streamingBackupEncryption";
import { runExclusiveLocalBackupOperation } from "./localBackupOperationGate";
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
  attachPortableDatabaseBranchGraphs,
  expandPortableDatabaseBranchGraphsForCompatibility,
  loadPortableBranchGraphForExport,
  preparePortableDatabaseForBranchRestore,
} from "@risuai/backup-core/portableBranches.cjs";
import { restorePortableDatabaseBranchGraphs } from "../storage/sql/portableBranchRestore";
import {
  decodeInlayAssetBackup,
  encodeInlayAssetBackup,
  listInlayAssets,
  setInlayAsset,
} from "../process/files/inlays";
import {
  exportPortableDatabaseStream,
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PortableDatabaseStreamCollector,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
} from "../storage/backup/portableDatabaseStream";
import type { StorageSyncSqlRecord } from "../storage/runtime/storageSyncSource";
import {
  normalizeLocalBackupPerformance,
  type LocalBackupPerformanceSettings,
} from "../storage/backup/localBackupPerformance";

const alertProgress = (
  msg: string,
  progress: number | string,
  stepState?: { steps: string[]; currentStep: number },
) => showProgressAlert(msg, progress, "backup", stepState);

type LocalBackupProgressStage =
  | "selectingDestination"
  | "preparing"
  | "database"
  | "coldStorage"
  | "assets"
  | "inlays"
  | "finalizing";

const LOCAL_BACKUP_PROGRESS_STAGE_ORDER: LocalBackupProgressStage[] = [
  "selectingDestination",
  "preparing",
  "database",
  "coldStorage",
  "assets",
  "inlays",
  "finalizing",
];

const LOCAL_BACKUP_PROGRESS_RANGES: Record<
  LocalBackupProgressStage,
  readonly [number, number]
> = {
  selectingDestination: [0, 2],
  preparing: [2, 5],
  database: [5, 60],
  coldStorage: [60, 68],
  assets: [68, 92],
  inlays: [92, 97],
  finalizing: [97, 100],
};

function localBackupProgressLabel(stage: LocalBackupProgressStage): string {
  switch (stage) {
    case "selectingDestination":
      return language.localBackupProgressSelectingDestination;
    case "preparing":
      return language.localBackupProgressPreparing;
    case "database":
      return language.localBackupProgressDatabase;
    case "coldStorage":
      return language.localBackupProgressColdStorage;
    case "assets":
      return language.localBackupProgressAssets;
    case "inlays":
      return language.localBackupProgressInlays;
    case "finalizing":
      return language.localBackupProgressFinalizing;
  }
}

function reportLocalBackupProgress(
  stage: LocalBackupProgressStage,
  options: {
    current?: number;
    total?: number;
    detail?: string;
    percent?: number;
  } = {},
) {
  const [start, end] = LOCAL_BACKUP_PROGRESS_RANGES[stage];
  const total = Math.max(0, Math.floor(options.total ?? 0));
  const current = Math.max(0, Math.min(total, Math.floor(options.current ?? 0)));
  const ratio = total > 0 ? current / total : 0;
  const percent = options.percent ?? start + (end - start) * ratio;
  const count = total > 0 ? ` (${current} / ${total})` : "";
  const detail = options.detail ? `\n${options.detail}` : "";
  alertProgress(
    `${localBackupProgressLabel(stage)}${count}${detail}`,
    percent,
    {
      steps: LOCAL_BACKUP_PROGRESS_STAGE_ORDER.map(localBackupProgressLabel),
      currentStep: LOCAL_BACKUP_PROGRESS_STAGE_ORDER.indexOf(stage),
    },
  );
}

type LocalBackupRestoreStage =
  | "selectingSource"
  | "reading"
  | "database"
  | "branches"
  | "finalizing";

const LOCAL_BACKUP_RESTORE_STAGE_ORDER: LocalBackupRestoreStage[] = [
  "selectingSource",
  "reading",
  "database",
  "branches",
  "finalizing",
];

const LOCAL_BACKUP_RESTORE_RANGES: Record<
  LocalBackupRestoreStage,
  readonly [number, number]
> = {
  selectingSource: [0, 2],
  reading: [2, 90],
  database: [90, 98],
  branches: [98, 99.5],
  finalizing: [99.5, 100],
};

function localBackupRestoreLabel(stage: LocalBackupRestoreStage): string {
  switch (stage) {
    case "selectingSource":
      return language.localBackupRestoreSelectingSource;
    case "reading":
      return language.localBackupRestoreReading;
    case "database":
      return language.localBackupRestoreDatabase;
    case "branches":
      return language.localBackupRestoreBranches;
    case "finalizing":
      return language.localBackupRestoreFinalizing;
  }
}

function reportLocalBackupRestoreProgress(
  stage: LocalBackupRestoreStage,
  options: {
    current?: number;
    total?: number;
    percent?: number;
  } = {},
) {
  const [start, end] = LOCAL_BACKUP_RESTORE_RANGES[stage];
  const total = Math.max(0, Math.floor(options.total ?? 0));
  const current = Math.max(0, Math.min(total, Math.floor(options.current ?? 0)));
  const ratio = total > 0 ? current / total : 0;
  const percent = options.percent ?? start + (end - start) * ratio;
  const count = total > 0 ? ` (${current} / ${total})` : "";
  alertProgress(
    `${localBackupRestoreLabel(stage)}${count}`,
    percent,
    {
      steps: LOCAL_BACKUP_RESTORE_STAGE_ORDER.map(localBackupRestoreLabel),
      currentStep: LOCAL_BACKUP_RESTORE_STAGE_ORDER.indexOf(stage),
    },
  );
}

function getLocalBackupPerformance(): LocalBackupPerformanceSettings {
  return normalizeLocalBackupPerformance(settingsStore.state);
}

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
  if (mode !== "compatible") return cleanDb;
  const expanded = expandPortableDatabaseBranchGraphsForCompatibility(cleanDb);
  return makeLegacyCompatibleDatabase(expanded, coldStorageValues);
}

async function initializeLocalBackupWriter(
  writer: LocalWriter,
  partial = false,
  mode: LocalBackupMode = "native",
) {
  const performance = getLocalBackupPerformance();
  writer.setBufferSize(performance.writerBufferKiB * 1024);
  reportLocalBackupProgress("selectingDestination", { percent: 1 });
  const dateStr = new Date().toISOString().slice(0, 10);
  const defaultName = partial
    ? `haejeokrisu_partial_backup_${dateStr}`
    : mode === "compatible"
      ? `risu_compatible_backup_${dateStr}`
      : `haejeokrisu_backup_${dateStr}`;
  const initialized = await writer.init(defaultName, ["bin", "risubackup"]);
  if (initialized) reportLocalBackupProgress("preparing", { percent: 2 });
  return initialized;
}

const INLAY_BACKUP_PREFIX = "inlay_";
const INLAY_BACKUP_SUFFIX = ".risuinlay";

function getInlayBackupEntryName(id: string) {
  return `${INLAY_BACKUP_PREFIX}${id}${INLAY_BACKUP_SUFFIX}`;
}

async function writeLocalBackupInlays(writer: LocalWriter) {
  const inlays = await listInlayAssets();
  const updateInterval = getLocalBackupPerformance().progressUpdateMs;
  let lastUiUpdate = 0;
  for (let index = 0; index < inlays.length; index++) {
    const [id, asset] = inlays[index];
    const name = getInlayBackupEntryName(id);
    if (getInlayBackupKey(name) !== id) {
      console.warn(`Skipping inlay with unsupported backup key: ${id}`);
      continue;
    }
    const now = Date.now();
    if (
      index === 0 ||
      index === inlays.length - 1 ||
      now - lastUiUpdate >= updateInterval
    ) {
      lastUiUpdate = now;
      reportLocalBackupProgress("inlays", {
        current: index + 1,
        total: inlays.length,
      });
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
  // Inlays are persisted on the server permanently since the remote inlay
  // storage landed; this restage only re-exports what listInlayAssets still
  // reports (local cache misses are resolved from the server by the inlay
  // layer itself), so existing server keys are simply rewritten with the
  // same payload.
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

type NodeServerBackupMode = LocalBackupMode | "partial";

async function saveNodeLocalBackupStream(mode: NodeServerBackupMode) {
  await forageStorage.Init();
  if (!(forageStorage.realStorage instanceof NodeStorage)) {
    throw new Error("Node local backup requires NodeStorage");
  }
  const nodeStorage = forageStorage.realStorage;
  const performance = getLocalBackupPerformance();
  if (mode === "native") {
    reportLocalBackupProgress("preparing", { percent: 3 });
    await stageNodeInlaysForBackup(nodeStorage);
  }
  try {
    const auth = await nodeStorage.getCachedAuth();
    reportLocalBackupProgress("preparing", { percent: 4 });
    const jobQuery = new URLSearchParams({
      mode,
      pageSize: String(performance.databasePageRecords),
      fragmentRecords: String(performance.fragmentRecords),
    });
    const response = await fetch(
      `/api/local-backup/export/jobs?${jobQuery.toString()}`,
      {
        method: "POST",
        headers: { "risu-auth": auth },
      },
    );
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
    let keepPolling = true;
    const progressPolling = (async () => {
      while (keepPolling) {
        try {
          const progressResponse = await fetch(
            `/api/local-backup/export/jobs/${encodeURIComponent(body.id!)}/progress`,
            { headers: { "risu-auth": auth } },
          );
          const progressBody = (await progressResponse
            .json()
            .catch(() => null)) as {
            status?: string;
            progress?: {
              stage?: LocalBackupProgressStage;
              current?: number;
              total?: number;
            };
          } | null;
          const progress = progressBody?.progress;
          if (
            progressResponse.ok &&
            progress?.stage &&
            progress.stage in LOCAL_BACKUP_PROGRESS_RANGES
          ) {
            reportLocalBackupProgress(progress.stage, {
              current: progress.current,
              total: progress.total,
            });
          }
          if (
            progressBody?.status === "complete" ||
            progressBody?.status === "error"
          ) {
            break;
          }
        } catch {
          // The completion request remains authoritative. A transient status
          // polling failure must not abort the actual browser download.
        }
        await sleep(performance.progressUpdateMs);
      }
    })();
    const anchor = document.createElement("a");
    anchor.href = `/api/local-backup/export/${encodeURIComponent(body.id)}?auth=${encodeURIComponent(auth)}`;
    const dateStr = new Date().toISOString().slice(0, 10);
    anchor.download =
      mode === "compatible"
        ? `risu_compatible_backup_${dateStr}.risubackup`
        : mode === "partial"
          ? `haejeokrisu_partial_backup_${dateStr}.risubackup`
          : `haejeokrisu_backup_${dateStr}.risubackup`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    reportLocalBackupProgress("database", { percent: 5 });
    const completed = await completion;
    keepPolling = false;
    await progressPolling;
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
    reportLocalBackupProgress("finalizing", { percent: 100 });
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

type BackupDatabaseDraft = CanonicalDatabase &
  Partial<Pick<Database, LegacyPersonaMirrorKey>> &
  Partial<Pick<PortableDatabase, "botPresets" | "botPresetsId">>;

async function loadFullSqlBackupSnapshot(
  onProgress?: (msg: string) => void,
): Promise<BackupDatabaseDraft> {
  const storage = await getSqlStorage();
  if (!storage.isEnabled()) {
    const ok = await storage.init();
    if (!ok || !storage.isEnabled()) {
      throw new Error("Failed to initialize SQL storage for backup snapshot");
    }
  }

  onProgress?.("Reading database snapshot");
  const loaded = await storage.exportDatabaseSnapshot();
  if (!loaded?.database) {
    throw new Error(
      "SQL storage returned an uninitialized or empty database snapshot",
    );
  }
  return loaded.database;
}

function normalizeBackupSnapshot(db: BackupDatabaseDraft): PortableDatabase {
  db.pluginCustomStorage ??= {};
  if (!db.personas || db.personas.length === 0) {
    db.personas = [
      {
        name: db.username ?? "User",
        icon: db.userIcon ?? "",
        personaPrompt: db.personaPrompt ?? "",
        note: db.userNote ?? "",
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
    !Number.isInteger(db.selectedPersona) ||
    !db.personas[db.selectedPersona]
  ) {
    db.selectedPersona = 0;
  }

  const activePersona = db.personas[db.selectedPersona];
  db.username = activePersona.name;
  db.userIcon = activePersona.icon;
  db.userNote = activePersona.note ?? "";
  db.personaPrompt = activePersona.personaPrompt;
  db.botPresets ??= [];
  db.botPresetsId ??= 0;
  return db as PortableDatabase;
}

export async function createBackupDatabaseSnapshot(
  onProgress?: (msg: string) => void,
): Promise<PortableDatabase> {
  await flushDurableStores();

  const db = await loadFullSqlBackupSnapshot(onProgress);

  ensureAllDomains(db);

  const normalized = normalizeBackupSnapshot(db);
  const branchStorage = await getSqlBranchStorage();
  return (await attachPortableDatabaseBranchGraphs(
    normalized,
    async (chatId) => {
      const graph = await branchStorage.loadChatBranchGraph(chatId);
      if (graph.branches.length <= 1) return graph;
      return loadPortableBranchGraphForExport(
        chatId,
        async () => graph,
        (id, branchId) =>
          branchStorage.loadBranchMessages(id, branchId, { mode: "full" }),
      );
    },
  )) as PortableDatabase;
}

import {
  collectAllDomainAssets,
  ensureAllDomains,
  type BackupAssetScope,
} from "../storage/database/domainRegistry.svelte";

type BackupAssetInfo = { charName: string; assetName: string };

interface LocalBackupExportOptions {
  mode: LocalBackupMode;
  partial: boolean;
  assetScope: BackupAssetScope;
  accountReadDelayMs: number;
  encryptAccountBackup: boolean;
}

function buildBackupAssetMap(
  db: PortableDatabase,
  scope: BackupAssetScope,
): Map<string, BackupAssetInfo> {
  return collectAllDomainAssets(db, scope);
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

type NodeBackupAssetStorage = Pick<NodeStorage, "keys" | "streamItems">;
type StreamingBackupWriter = Pick<LocalWriter, "startBackup" | "write">;
type NodeBackupAssetStreamOptions = Parameters<NodeStorage["streamItems"]>[3];

export async function createNodeBackupAssetRequest(
  storage: Pick<NodeBackupAssetStorage, "keys">,
  scope: BackupAssetScope,
  assetMap: Map<string, BackupAssetInfo>,
): Promise<{ keys: string[]; options?: NodeBackupAssetStreamOptions }> {
  if (scope === "all") {
    return { keys: [], options: { prefix: "assets/" } };
  }

  const keys = await storage.keys("assets/");
  return {
    keys: keys.filter((key) => isEssentialBackupAsset(assetMap, key)),
  };
}

export async function streamNodeBackupAssets(
  storage: NodeBackupAssetStorage,
  writer: StreamingBackupWriter,
  keys: string[],
  onProgress?: Parameters<NodeStorage["streamItems"]>[2],
  options?: NodeBackupAssetStreamOptions,
): Promise<{ writtenKeys: string[]; missingKeys: string[] }> {
  const writtenKeys = new Set<string>();

  await storage.streamItems(
    keys,
    {
      async onFileStart(name, size) {
        writtenKeys.add(name);
        await writer.startBackup(name, size);
      },
      async onFileChunk(_name, chunk) {
        await writer.write(chunk);
      },
    },
    onProgress,
    options,
  );

  return {
    writtenKeys: [...writtenKeys],
    missingKeys: keys.filter((key) => !writtenKeys.has(key)),
  };
}

type BackupAssetKeyStorage = Pick<
  typeof forageStorage,
  "keys" | "listAssetKeys"
>;

export async function listBackupAssetKeys(
  storage: BackupAssetKeyStorage = forageStorage,
  useRecursiveListing = isTauri,
): Promise<string[]> {
  if (useRecursiveListing) {
    return await storage.listAssetKeys("assets/");
  }
  return (await storage.keys()).filter((key) => key?.startsWith("assets/"));
}

function reportBackupAssetProgress(
  current: number,
  total: number,
) {
  reportLocalBackupProgress("assets", { current, total });
}

async function writeLocalBackupAssets(
  writer: LocalWriter,
  db: PortableDatabase,
  options: LocalBackupExportOptions,
  precomputedAssetMap?: Map<string, BackupAssetInfo>,
): Promise<{
  missingAssets: string[];
  assetMap: Map<string, BackupAssetInfo>;
}> {
  const assetMap =
    precomputedAssetMap ?? buildBackupAssetMap(db, options.assetScope);
  const missingAssets: string[] = [];
  reportLocalBackupProgress("assets");
  await sleep(0);
  let lastUiUpdate = 0;
  const updateInterval = getLocalBackupPerformance().progressUpdateMs;

  await forageStorage.Init();
  const nodeStorage =
    forageStorage.realStorage instanceof NodeStorage
      ? forageStorage.realStorage
      : null;

  if (nodeStorage) {
    reportLocalBackupProgress("assets");
    await sleep(10);
    const request = await createNodeBackupAssetRequest(
      nodeStorage,
      options.assetScope,
      assetMap,
    );

    const streamed = await streamNodeBackupAssets(
      nodeStorage,
      writer,
      request.keys,
      (progress) => {
        const current = Math.min(
          progress.completedFiles + (progress.currentFile ? 1 : 0),
          progress.totalFiles,
        );
        reportBackupAssetProgress(
          current,
          progress.totalFiles,
        );
      },
      request.options,
    );
    missingAssets.push(...streamed.missingKeys);
    return { missingAssets, assetMap };
  }

  let keys = await listBackupAssetKeys();
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
      reportBackupAssetProgress(current, keys.length);
      await sleep(0);
    }
    return { missingAssets, assetMap };
  }

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const now = Date.now();
    if (
      now - lastUiUpdate >= updateInterval ||
      index === 0 ||
      index === keys.length - 1
    ) {
      lastUiUpdate = now;
      reportBackupAssetProgress(index + 1, keys.length);
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

async function collectBackupColdStorage(db: PortableDatabase) {
  reportLocalBackupProgress("coldStorage");
  await sleep(10);
  const coldStoragePayloads = await collectColdStorageBackupPayloads(
    db,
    (current, total) => {
      reportLocalBackupProgress("coldStorage", { current, total });
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
) {
  const total = coldStoragePayloads.payloads.length;
  for (let index = 0; index < total; index++) {
    const payload = coldStoragePayloads.payloads[index];
    reportLocalBackupProgress("coldStorage", {
      current: index + 1,
      total,
    });
    await sleep(0);
    await writer.writeBackup(payload.backupName, payload.encoded);
  }
}

interface StreamingBackupInventory {
  assetMap: Map<string, BackupAssetInfo>;
  referencedColdStorageKeys: Set<string>;
  exportedColdStorageKeys: Set<string>;
  unavailableColdStorageKeys: Set<string>;
  chatOwners: Map<string, string>;
  coldStorageCharacters: Map<
    string,
    {
      chaId: string;
      name: string;
      coldstorage?: string;
      coldStoragedChats?: string[];
      chats: Array<{ message: Array<{ data: string }> }>;
    }
  >;
}

function createStreamingBackupInventory(): StreamingBackupInventory {
  return {
    assetMap: new Map(),
    referencedColdStorageKeys: new Set(),
    exportedColdStorageKeys: new Set(),
    unavailableColdStorageKeys: new Set(),
    chatOwners: new Map(),
    coldStorageCharacters: new Map(),
  };
}

function collectStreamingBackupRecord(
  inventory: StreamingBackupInventory,
  record: Exclude<StorageSyncSqlRecord, { type: "cold-storage" }>,
  scope: BackupAssetScope,
) {
  const addAsset = (key: unknown, category: string, name: string) => {
    if (typeof key === "string" && key.length > 0) {
      inventory.assetMap.set(key, { charName: category, assetName: name });
    }
  };

  if (record.type === "setting") {
    if (record.key === "personas" && Array.isArray(record.value)) {
      for (const persona of record.value) {
        addAsset(persona?.icon, "Persona", `${persona?.name ?? "User"} Icon`);
      }
    } else if (record.key === "userIcon") {
      addAsset(record.value, "User Settings", "User Icon");
    } else if (record.key === "customBackground") {
      addAsset(record.value, "User Settings", "Custom Background");
    } else if (
      scope === "essential" &&
      record.key === "characterOrder" &&
      Array.isArray(record.value)
    ) {
      for (const item of record.value) {
        if (!item || typeof item === "string") continue;
        addAsset(item.img, "Folder", `${item.name ?? "Folder"} Folder Image`);
        addAsset(
          item.imgFile,
          "Folder",
          `${item.name ?? "Folder"} Folder Image File`,
        );
      }
    }
    return;
  }

  if (record.type === "module") {
    const mod = record.data as any;
    const moduleName = mod?.name ?? "Unknown Module";
    addAsset(mod?.icon, "Module", `${moduleName} Icon`);
    if (scope === "all") {
      for (const asset of mod?.assets ?? []) {
        addAsset(
          asset?.[1],
          "Module",
          `${moduleName} - ${asset?.[0] ?? "Asset"}`,
        );
      }
    }
    return;
  }

  if (record.type === "preset") {
    if (scope === "essential") {
      const preset = record.data as any;
      addAsset(
        preset?.image,
        "Preset",
        `${preset?.name ?? "Preset"} Preset Image`,
      );
    }
    return;
  }

  if (record.type === "character") {
    const character = { ...(record.data as any), chaId: record.id };
    const characterName = character.name ?? "Unknown Character";
    addAsset(
      character.image,
      characterName,
      scope === "essential" ? "Profile Image" : "Main Image",
    );
    if (scope === "all") {
      for (const emotion of character.emotionImages ?? []) {
        addAsset(emotion?.[1], characterName, emotion?.[0] ?? "Emotion");
      }
      if (character.type !== "group") {
        for (const asset of character.additionalAssets ?? []) {
          addAsset(asset?.[1], characterName, asset?.[0] ?? "Asset");
        }
        for (const [name, key] of Object.entries(character.vits?.files ?? {})) {
          addAsset(key, characterName, name);
        }
        for (const asset of character.ccAssets ?? []) {
          addAsset(asset?.uri, characterName, asset?.name ?? "Asset");
        }
      }
    }

    const coldstorage =
      typeof character.coldstorage === "string"
        ? character.coldstorage
        : undefined;
    const coldStoragedChats = Array.isArray(character.coldStoragedChats)
      ? character.coldStoragedChats.filter(
          (key: unknown): key is string => typeof key === "string",
        )
      : [];
    if (coldstorage) inventory.referencedColdStorageKeys.add(coldstorage);
    for (const key of coldStoragedChats) {
      inventory.referencedColdStorageKeys.add(key);
    }
    inventory.coldStorageCharacters.set(character.chaId, {
      chaId: character.chaId,
      name: characterName,
      coldstorage,
      coldStoragedChats,
      chats: [],
    });
    return;
  }

  if (record.type === "chat") {
    inventory.chatOwners.set(record.id, record.characterId);
    return;
  }

  if (record.type === "message" && record.position === 0) {
    const firstMessage = record.data as any;
    if (
      typeof firstMessage?.data === "string" &&
      firstMessage.data.startsWith(coldStorageHeader)
    ) {
      const key = firstMessage.data.slice(coldStorageHeader.length);
      if (key) inventory.referencedColdStorageKeys.add(key);
      const ownerId = inventory.chatOwners.get(record.chatId);
      const character = ownerId
        ? inventory.coldStorageCharacters.get(ownerId)
        : undefined;
      if (character) {
        character.chats.push({ message: [{ data: firstMessage.data }] });
      }
    }
  }
}

async function writeStreamingColdStorage(
  inventory: StreamingBackupInventory,
): Promise<boolean> {
  reportLocalBackupProgress("coldStorage", { percent: 67 });
  for (const key of inventory.referencedColdStorageKeys) {
    if (!inventory.exportedColdStorageKeys.has(key)) {
      inventory.unavailableColdStorageKeys.add(key);
    }
  }
  return await confirmIncompleteColdStorageOperation(
    {
      characters: [...inventory.coldStorageCharacters.values()] as any,
    },
    inventory.unavailableColdStorageKeys,
    "backup",
  );
}

function streamingRecordEntryName(index: number) {
  return `${PORTABLE_DATABASE_STREAM_PREFIX}${String(index).padStart(12, "0")}.risudat`;
}

async function encodeStreamingDatabaseValue(
  value: PortableDatabaseStreamFragment | PortableDatabaseStreamManifest,
  entryName: string,
  encryptionKey?: string,
) {
  let encoded = await encodeRisuSaveLegacyAsync(value, "compression");
  if (encryptionKey) {
    encoded = await encryptStreamingBackupEntry(
      encoded,
      encryptionKey,
      entryName,
    );
  }
  return encoded;
}

async function prepareStreamingBackupEncryption(
  writer: LocalWriter,
  options: LocalBackupExportOptions,
): Promise<string | undefined> {
  if (
    !options.encryptAccountBackup ||
    !forageStorage.isAccount ||
    !location.origin.endsWith("risuai.xyz")
  ) {
    return undefined;
  }
  const time = Date.now();
  const key = (
    await (await fetch(`https://sv.risuai.xyz/cryptokey?key=${time}`)).json()
  ).key;
  await writer.writeBackup(
    "encryption.risudat",
    new TextEncoder().encode(
      JSON.stringify({
        time,
        type: "account",
        databaseEncryption: STREAMING_BACKUP_ENCRYPTION_FORMAT,
      }),
    ),
  );
  return key;
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
  if (options.mode === "native") {
    await saveStreamingLocalBackupWithOptions(options);
    return;
  }

  const writer = new LocalWriter();
  if (
    !(await initializeLocalBackupWriter(writer, options.partial, options.mode))
  ) {
    alertClear();
    return;
  }

  reportLocalBackupProgress("preparing", { percent: 3 });
  await sleep(10);
  const db = await createBackupDatabaseSnapshot((msg) => {
    reportLocalBackupProgress("database", { detail: msg, percent: 5 });
  });
  const coldStoragePayloads = await collectBackupColdStorage(db);
  if (!coldStoragePayloads) {
    alertClear();
    return;
  }

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
  reportLocalBackupProgress("database", { percent: 55 });
  let dbData = await encodeRisuSaveLegacyAsync(cleanDb, "compression");

  if (
    options.encryptAccountBackup &&
    forageStorage.isAccount &&
    location.origin.endsWith("risuai.xyz")
  ) {
    reportLocalBackupProgress("database", { percent: 58 });
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

  reportLocalBackupProgress("database", { percent: 59 });
  await sleep(10);
  await writer.writeBackup("database.risudat", dbData);
  reportLocalBackupProgress("database", { percent: 60 });

  await writeBackupColdStorage(writer, coldStoragePayloads);
  const { missingAssets, assetMap } = await writeLocalBackupAssets(
    writer,
    db,
    options,
  );

  reportLocalBackupProgress("finalizing", { percent: 100 });
  await sleep(10);
  await writer.close();
  showMissingBackupAssets(missingAssets, assetMap, options.partial);
}

async function saveStreamingLocalBackupWithOptions(
  options: LocalBackupExportOptions,
) {
  await flushDurableStores();
  const storage = await getSqlStorage();
  if (!storage.isEnabled()) {
    const initialized = await storage.init();
    if (!initialized || !storage.isEnabled()) {
      throw new Error("Failed to initialize SQL storage for streaming backup");
    }
  }

  const writer = new LocalWriter();
  if (
    !(await initializeLocalBackupWriter(writer, options.partial, options.mode))
  ) {
    alertClear();
    return;
  }

  const inventory = createStreamingBackupInventory();
  const performance = getLocalBackupPerformance();
  const encryptionKey = await prepareStreamingBackupEncryption(writer, options);
  let manifest: PortableDatabaseStreamManifest;
  let lastProgressUpdate = 0;
  try {
    manifest = await exportPortableDatabaseStream(
      storage,
      {
        async writeFragment(fragment) {
          const entryName = streamingRecordEntryName(fragment.index);
          const encoded = await encodeStreamingDatabaseValue(
            fragment,
            entryName,
            encryptionKey,
          );
          await writer.writeBackup(entryName, encoded);
        },
        async writeColdStorage(key, value) {
          if (!isColdStorageBackupData(value)) {
            inventory.unavailableColdStorageKeys.add(key);
            return;
          }
          inventory.exportedColdStorageKeys.add(key);
          await writer.writeBackup(
            getColdStorageBackupName(key),
            new TextEncoder().encode(JSON.stringify(value)),
          );
        },
        onRecord(record) {
          collectStreamingBackupRecord(inventory, record, options.assetScope);
        },
        onProgress({ current, total }) {
          const now = Date.now();
          if (
            current !== total &&
            now - lastProgressUpdate < performance.progressUpdateMs
          ) {
            return;
          }
          lastProgressUpdate = now;
          reportLocalBackupProgress("database", { current, total });
        }
      },
      {
        pageSize: performance.databasePageRecords,
        fragmentRecords: performance.fragmentRecords,
      },
    );

    if (!(await writeStreamingColdStorage(inventory))) {
      await writer.close();
      alertClear();
      return;
    }

    const { missingAssets, assetMap } = await writeLocalBackupAssets(
      writer,
      // Asset selection has already been reduced to its bounded key map.
      {} as PortableDatabase,
      options,
      inventory.assetMap,
    );
    if (!options.partial) await writeLocalBackupInlays(writer);

    reportLocalBackupProgress("finalizing", { percent: 98 });
    await writer.writeBackup(
      PORTABLE_DATABASE_STREAM_MANIFEST,
      await encodeStreamingDatabaseValue(
        manifest,
        PORTABLE_DATABASE_STREAM_MANIFEST,
        encryptionKey,
      ),
    );
    await writer.close();
    showMissingBackupAssets(missingAssets, assetMap, options.partial);
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

export async function SaveLocalBackup(mode: LocalBackupMode = "native") {
  try {
    await runExclusiveLocalBackupOperation("save", async () => {
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
    await runExclusiveLocalBackupOperation("partial-save", async () => {
      if (isNodeServer && !forageStorage.isAccount) {
        await flushDurableStores();
        await saveNodeLocalBackupStream("partial");
        return;
      }
      await saveLocalBackupWithOptions({
        mode: "native",
        partial: true,
        assetScope: "essential",
        accountReadDelayMs: 100,
        encryptAccountBackup: false,
      });
    });
  } catch (error) {
    console.error("SavePartialLocalBackup failed:", error);
    alertError(error);
  }
}

export type InlayRestoreResult =
  | { status: "restored" }
  | { status: "invalid"; error: unknown }
  | { status: "storage-error"; error: unknown };

export async function restoreInlayBackupEntry(
  inlayKey: string,
  data: Uint8Array,
  dependencies: {
    decode?: typeof decodeInlayAssetBackup;
    write?: typeof setInlayAsset;
  } = {},
): Promise<InlayRestoreResult> {
  const decode = dependencies.decode ?? decodeInlayAssetBackup;
  const write = dependencies.write ?? setInlayAsset;
  let asset: ReturnType<typeof decodeInlayAssetBackup>;

  try {
    asset = decode(data);
  } catch (error) {
    return { status: "invalid", error };
  }

  try {
    await write(inlayKey, asset);
  } catch (error) {
    return { status: "storage-error", error };
  }

  return { status: "restored" };
}

async function restoreLocalBackupSourceUnlocked(
  file: LocalBackupSource,
  parserProgress: { start: number; end: number } = { start: 2, end: 90 },
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
  let streamCollector: PortableDatabaseStreamCollector | null = null;
  let streamingDecryptionKey: Promise<string> | null = null;
  const restoredColdStorageKeys = new Set<string>();
  const useNodeBulkRestore = isNodeServer && !forageStorage.isAccount;
  const pendingNodeAssets = new Map<string, Uint8Array>();
  const nodeBulkMaxFiles = 64;
  const nodeBulkMaxBytes = 64 * 1024 * 1024;
  let pendingNodeAssetBytes = 0;
  let entriesRestored = 0;
  let entriesWritten = 0;
  const invalidInlayEntries: string[] = [];
  const failedInlayWrites: string[] = [];
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
      const classification = classifyBackupEntry(name);
      if (classification.kind === "databaseStream") {
        let encoded = data;
        if (encryptionMeta.type === "account" && encryptionMeta.time) {
          streamingDecryptionKey ??= fetchLegacyBackupKey(encryptionMeta.time);
          const key = await streamingDecryptionKey;
          encoded = isStreamingBackupEncryptedEntry(encoded)
            ? await decryptStreamingBackupEntry(encoded, key, name)
            : new Uint8Array(await decryptBuffer(encoded, key));
        }
        const value = await decodeRisuSave(encoded);
        streamCollector ??= new PortableDatabaseStreamCollector();
        if (name === PORTABLE_DATABASE_STREAM_MANIFEST) {
          streamCollector.setManifest(value as PortableDatabaseStreamManifest);
        } else {
          streamCollector.addFragment(value as PortableDatabaseStreamFragment);
        }
        entriesRestored++;
        currentEntryName = "";
        return;
      }

      const inlayKey = getInlayBackupKey(name);
      if (inlayKey) {
        const result = await restoreInlayBackupEntry(inlayKey, data);
        entriesRestored++;
        if (result.status === "restored") {
          entriesWritten++;
        } else if (result.status === "invalid") {
          invalidInlayEntries.push(inlayKey);
          console.warn(
            `Skipping invalid inlay item ${inlayKey}:`,
            result.error,
          );
        } else {
          failedInlayWrites.push(inlayKey);
          console.error(
            `Failed to store inlay item ${inlayKey}:`,
            result.error,
          );
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
        reportLocalBackupRestoreProgress("reading", { percent: readPercent });
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
    reportLocalBackupRestoreProgress("reading", { percent: 90 });
    const flushed = await flushTauriAssets();
    if (flushed) entriesWritten += flushed;
  }

  if (useNodeBulkRestore && pendingNodeAssets.size > 0) {
    reportLocalBackupRestoreProgress("reading", { percent: 90 });
    const flushed = await flushNodeAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (useBrowserBulkRestore && pendingBrowserAssets.size > 0) {
    reportLocalBackupRestoreProgress("reading", { percent: 90 });
    const flushed = await flushBrowserAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (failedInlayWrites.length > 0) {
    throw new Error(
      `Failed to restore ${failedInlayWrites.length} inlay item(s) because local storage writes failed. ` +
        `The database replacement was not applied. First failed item: ${failedInlayWrites[0]}`,
    );
  }

  if (invalidInlayEntries.length > 0) {
    await alertNormalWait(
      `This backup contains ${invalidInlayEntries.length} invalid inlay item(s). ` +
        "Those items will be skipped, but the database restore can continue.",
    );
  }

  if (streamCollector) {
    if (pendingDatabase || decodedDatabase) {
      throw new Error("Backup mixes legacy and streaming database formats");
    }
    decodedDatabase = streamCollector.finish() as Database;
    streamCollector = null;
  }

  if (!pendingDatabase && !decodedDatabase) {
    throw new Error("Backup does not contain a database entry");
  }

  const databaseByteLength = pendingDatabase?.byteLength ?? 0;
  let db: Uint8Array | null = pendingDatabase;
  pendingDatabase = null;
  if (db && encryptionMeta.type === "account" && encryptionMeta.time) {
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
  if (ignoredExtensionEntries > 0) {
    console.info(
      `[LocalBackupRestore] Skipped ${ignoredExtensionEntries} unsupported extension entries`,
    );
  }
  reportLocalBackupRestoreProgress("database", { percent: 90 });
  const decodedDb =
    decodedDatabase ?? ((await decodeRisuSave(db as Uint8Array)) as Database);
  const prepared = preparePortableDatabaseForBranchRestore(
    normalizeBackupSnapshot(decodedDb as BackupDatabaseDraft),
  );
  const dbData = prepared.database as Database;
  const portableBranchGraphs = prepared.branchGraphs;
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

  reportLocalBackupRestoreProgress("database", { percent: 91 });
  const storage = await getSqlStorage();
  await storage.replaceDatabase(dbData, (_step, syncProgress) => {
    const ratio =
      syncProgress === undefined ? 0 : Math.max(0, Math.min(1, syncProgress));
    reportLocalBackupRestoreProgress("database", {
      percent: 91 + ratio * 7,
    });
  });
  if (Object.keys(portableBranchGraphs).length > 0) {
    reportLocalBackupRestoreProgress("branches", { percent: 98 });
    await restorePortableDatabaseBranchGraphs(
      await getSqlBranchStorage(),
      portableBranchGraphs,
    );
  }
  reportLocalBackupRestoreProgress("finalizing", { percent: 100 });

  const completionMessage =
    invalidInlayEntries.length > 0
      ? `Success, but skipped ${invalidInlayEntries.length} invalid inlay item(s). Refreshing your app.`
      : "Success, Refreshing your app.";

  if (isTauri) {
    alertStore.set({
      type: "wait",
      msg: completionMessage,
    });
    await relaunch();
  } else {
    await storage.close?.();
    alertStore.set({
      type: "wait",
      msg: completionMessage,
    });
    const cleanUrl = new URL(location.href);
    cleanUrl.search = "";
    location.replace(cleanUrl);
  }

  alertNormal(
    invalidInlayEntries.length > 0
      ? `Success, but skipped ${invalidInlayEntries.length} invalid inlay item(s).`
      : "Success",
  );
}

async function runLocalBackupRestore<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return await runExclusiveLocalBackupOperation("restore", async () => {
    await flushDurableStores();
    return await operation();
  });
}

async function restoreLocalBackupSource(
  file: LocalBackupSource,
  parserProgress: { start: number; end: number } = { start: 2, end: 90 },
) {
  reportLocalBackupRestoreProgress("reading", { percent: parserProgress.start });
  return await runLocalBackupRestore(() =>
    restoreLocalBackupSourceUnlocked(file, parserProgress),
  );
}

export async function restoreLocalBackupFile(file: File) {
  await restoreLocalBackupSource(file);
}

async function loadCapacitorLocalBackupUnlocked() {
  if (!nativeBackup) throw new Error("Native backup importer is unavailable");
  reportLocalBackupRestoreProgress("selectingSource", { percent: 0 });
  const progressListener = await nativeBackup.addListener(
    "importProgress",
    (event) => {
      const bytesRead = Math.max(0, event.bytesRead ?? 0);
      const totalBytes = Math.max(0, event.totalBytes ?? 0);
      let percent =
        totalBytes > 0
          ? 2 + Math.min(43, Math.floor((bytesRead / totalBytes) * 43))
          : 2;

      if (event.stage === "committing") {
        const processed = Math.max(0, event.assetsProcessed ?? 0);
        const total = Math.max(0, event.totalAssets ?? 0);
        percent = total > 0 ? 45 + Math.floor((processed / total) * 4) : 47;
      } else if (event.stage === "complete") {
        percent = 50;
      }
      reportLocalBackupRestoreProgress("reading", { percent });
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
    reportLocalBackupRestoreProgress("reading", { percent: 50 });
    await restoreLocalBackupSourceUnlocked(
      createNativeImportSource(nativeBackup, id, size),
      { start: 50, end: 90 },
    );
  } finally {
    await nativeBackup.closeImport({ id }).catch(() => {});
  }
}

async function loadTauriLocalBackupUnlocked() {
  reportLocalBackupRestoreProgress("selectingSource", { percent: 0 });
  const selected = await openDialog({
    multiple: false,
    filters: [
      {
        name: "RisuAI local backup",
        extensions: ["bin", "risubackup"],
      },
    ],
  });
  if (selected === null) {
    alertClear();
    return;
  }

  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) {
    alertClear();
    return;
  }
  reportLocalBackupRestoreProgress("reading", { percent: 2 });
  const source = await createTauriImportSource(path);
  await restoreLocalBackupSourceUnlocked(source);
}

export async function LoadLocalBackup() {
  try {
    if (isCapacitor) {
      await runLocalBackupRestore(loadCapacitorLocalBackupUnlocked);
      return;
    }
    if (isTauri) {
      await runLocalBackupRestore(loadTauriLocalBackupUnlocked);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.risubackup";
    input.addEventListener(
      "cancel",
      () => {
        input.remove();
        alertClear();
      },
      { once: true },
    );
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        input.remove();
        alertClear();
        return;
      }
      const file = input.files[0];
      input.remove();
      reportLocalBackupRestoreProgress("reading", { percent: 2 });
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
    reportLocalBackupRestoreProgress("selectingSource", { percent: 0 });
    input.click();
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : `${error}`;
    alertError(
      `Failed to load local backup: ${detail}\nCheck the server console or logs for details.`,
    );
  }
}
