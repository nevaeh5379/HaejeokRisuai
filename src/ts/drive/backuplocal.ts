import {
  BaseDirectory,
  mkdir,
  open as openFile,
  readFile,
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
  getColdStorageBackupKey,
  getColdStorageBackupName,
  getColdStorageItem,
  isColdStorageBackupData,
  listColdDataKeys,
  setColdStorageItem,
  type ColdStorageBackupPayload,
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
  decodeStreamingBackupValue,
  encodeStreamingBackupValue,
  STREAMING_BACKUP_ENCRYPTION_FORMAT,
  type StreamingBackupValueDecodeOptions,
} from "./streamingBackupEncryption";
import { runExclusiveLocalBackupOperation } from "./localBackupOperationGate";
import {
  isNodeRealtimeConnected,
  subscribeNodeBackupProgress,
} from "../process/nodeRealtimeBackupProgress";
import {
  compatibilityOptions,
  type ColdStorageValueMap,
} from "../backupCompatibility";

import { registerPlugin } from "@capacitor/core";
import { Buffer } from "buffer";
import {
  getInlayBackupKey,
  INLAY_BACKUP_PREFIX,
  LEGACY_DATABASE_ENTRY_NAME,
  ACCOUNT_ENCRYPTION_ENTRY_NAME,
  normalizeBackupAssetPath,
} from "@risuai/backup-core/entryPolicy";
import {
  createEncodedBackupSource,
  createImportCommit,
  createSequentialFileBackupSource,
  streamBackupResponse,
  type LocalBackupSource,
} from "@risuai/backup-core/importSource";
import { type LocalBackupMode as BackupCoreLocalBackupMode } from "@risuai/backup-core/api";
import {
  exportNativeBackupAssets,
  exportStoredBackupAssets,
  formatMissingBackupAssets,
  selectBackupAssetKeys,
  type BackupAssetExportProgress,
} from "@risuai/backup-core/assetExport";
import {
  prepareColdStorageBackup,
  writeColdStorageBackup,
  type ColdStorageBackupCollection,
} from "@risuai/backup-core/coldStorageExport";
import { prepareAccountBackupEncryption } from "@risuai/backup-core/exportEncryption";
import { createLocalBackupExportMetadata } from "@risuai/backup-core/exportPlan";
import {
  createNodeBackupAssetRequest,
  streamNodeBackupAssets,
} from "@risuai/backup-core/node/exportAssets";
import {
  attachPortableDatabaseBranchGraphs,
  loadPortableBranchGraphForExport,
  preparePortableDatabaseForBranchRestore,
} from "@risuai/backup-core/portableBranches";
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
  portableDatabaseStreamFragmentName,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
} from "../storage/backup/portableDatabaseStream";
import {
  hasPortableDatabaseStreamRestore,
  type PortableDatabaseStreamRestoreSession,
} from "../storage/backup/portableDatabaseStreamRestore";
import {
  normalizeLocalBackupPerformance,
  type LocalBackupPerformanceSettings,
} from "../storage/backup/localBackupPerformance";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["risuai", "backup"]);

const {
  exportProgress: reportLocalBackupProgress,
  restoreProgress: reportLocalBackupRestoreProgress,
} = createLocalBackupProgressReporters((message, progress, stepState): void => {
  showProgressAlert(message, progress, "backup", stepState);
});

function getLocalBackupPerformance(): LocalBackupPerformanceSettings {
  return normalizeLocalBackupPerformance(settingsStore.state);
}

interface NativeBackupPlugin {
  openImport(options?: { raw?: boolean }): Promise<{
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
  commitImport(options: { id: string }): Promise<void>;
  closeImport(options: { id: string }): Promise<void>;
  addListener(
    eventName: "importProgress",
    listener: (event: NativeImportProgress) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

interface NativeImportProgress {
  stage: "extracting" | "committing" | "fallback" | "staging" | "complete";
  bytesRead?: number;
  totalBytes?: number;
  assetsProcessed?: number;
  totalAssets?: number;
}

interface LocalBackupRestoreOptions {
  beforeDatabaseApply?: () => Promise<void>;
}

const NATIVE_IMPORT_CHUNK_SIZE = 512 * 1024;

/**
 * Builds a once-only native asset commit callback for one import session.
 * A successful commit is remembered, so repeated calls are no-ops and the
 * staged assets are never double-committed. Until it succeeds, the next
 * call retries the commit, because a failed commit must not permanently
 * block the restore.
 */
export function createNativeAssetCommit(
  plugin: Pick<NativeBackupPlugin, "commitImport">,
  id: string,
): () => Promise<void> {
  return createImportCommit(plugin, id);
}

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
  return createEncodedBackupSource(plugin, id, size, {
    chunkSize: NATIVE_IMPORT_CHUNK_SIZE,
    decode(data: string): Uint8Array {
      return new Uint8Array(Buffer.from(data, "base64"));
    },
    importerLabel: "Native backup importer",
  });
}

const TAURI_IMPORT_CHUNK_SIZE = 4 * 1024 * 1024;

async function createTauriImportSource(
  path: string,
): Promise<LocalBackupSource> {
  const metadataHandle: Awaited<ReturnType<typeof openFile>> = await openFile(
    path,
    { read: true },
  );
  let size: number = 0;
  try {
    size = Math.max(0, Number((await metadataHandle.stat()).size) || 0);
  } finally {
    await metadataHandle.close();
  }
  return createSequentialFileBackupSource(
    size,
    async (): Promise<Awaited<ReturnType<typeof openFile>>> =>
      await openFile(path, { read: true }),
    {
      chunkSize: TAURI_IMPORT_CHUNK_SIZE,
      importerLabel: "Tauri backup importer",
    },
  );
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

export const normalizeLocalBackupAssetPath = normalizeBackupAssetPath;

export type LocalBackupMode = Exclude<BackupCoreLocalBackupMode, "partial">;

export function buildPortableLocalBackupDatabase(
  db: PortableDatabase,
  mode: LocalBackupMode,
  coldStorageValues?: ColdStorageValueMap,
): Record<string, any> {
  return buildPortableLocalBackupDatabaseCore(
    db as Record<string, any>,
    mode,
    coldStorageValues,
    { compatibility: compatibilityOptions },
  );
}

async function initializeLocalBackupWriter(
  writer: LocalWriter,
  partial = false,
  mode: LocalBackupMode = "native",
) {
  const performance = getLocalBackupPerformance();
  writer.setBufferSize(performance.writerBufferKiB * 1024);
  reportLocalBackupProgress("selectingDestination", { percent: 1 });
  const backupMode = partial ? "partial" : mode;
  const { baseName } = createLocalBackupExportMetadata(backupMode);
  const initialized = await writer.init(baseName, ["bin", "risubackup"]);
  if (initialized) reportLocalBackupProgress("preparing", { percent: 2 });
  return initialized;
}

type LocalBackupInlayEntries = Awaited<ReturnType<typeof listInlayAssets>>;
type LocalBackupInlayAsset = LocalBackupInlayEntries[number][1];

async function writeLocalBackupInlays(writer: LocalWriter): Promise<void> {
  const inlays: LocalBackupInlayEntries = await listInlayAssets();
  const updateInterval: number = getLocalBackupPerformance().progressUpdateMs;
  let lastUiUpdate: number = 0;
  await streamBackupInlays({
    entries: inlays,
    async encode(asset: LocalBackupInlayAsset): Promise<Uint8Array> {
      return await encodeInlayAssetBackup(asset);
    },
    async write(name: string, data: Uint8Array): Promise<void> {
      await writer.writeBackup(name, data);
    },
    async onProgress(current: number, total: number): Promise<void> {
      const now: number = Date.now();
      if (
        current === 1 ||
        current === total ||
        now - lastUiUpdate >= updateInterval
      ) {
        lastUiUpdate = now;
        reportLocalBackupProgress("inlays", { current, total });
        await sleep(0);
      }
    },
    onUnsupportedKey(id: string): void {
      console.warn(`Skipping inlay with unsupported backup key: ${id}`);
    },
  });
}

async function clearNodeBackupInlayStage(storage: NodeStorage): Promise<void> {
  const keys: string[] = (await storage.keys(INLAY_BACKUP_PREFIX)).filter(
    (key: string): boolean => getInlayBackupKey(key) !== null,
  );
  if (keys.length > 0) await storage.removeItem(keys);
}

async function stageNodeInlaysForBackup(storage: NodeStorage): Promise<void> {
  // Inlays are persisted on the server permanently since the remote inlay
  // storage landed; this restage only re-exports what listInlayAssets still
  // reports (local cache misses are resolved from the server by the inlay
  // layer itself), so existing server keys are simply rewritten with the
  // same payload.
  await clearNodeBackupInlayStage(storage);
  const inlays: LocalBackupInlayEntries = await listInlayAssets();
  const batchWriter: BoundedAssetBatchWriter = new BoundedAssetBatchWriter(
    32,
    32 * 1024 * 1024,
    async (entries: RestoredAssetBatch): Promise<void> => {
      await storage.setItems(entries);
    },
  );
  await streamBackupInlays({
    entries: inlays,
    async encode(asset: LocalBackupInlayAsset): Promise<Uint8Array> {
      return await encodeInlayAssetBackup(asset);
    },
    async write(name: string, data: Uint8Array): Promise<void> {
      await batchWriter.add(name, data);
    },
  });
  await batchWriter.flush();
}

type NodeServerBackupMode = LocalBackupMode | "partial";

export function usesRemoteBackupApi(storage: unknown): storage is NodeStorage {
  return storage instanceof NodeStorage;
}

export function selectLocalBackupAssetRestoreMode(
  storage: unknown,
  tauri = isTauri,
): "node" | "tauri" | "browser" {
  if (usesRemoteBackupApi(storage)) return "node";
  return tauri ? "tauri" : "browser";
}

export const streamRemoteBackupResponse: typeof streamBackupResponse =
  streamBackupResponse;

async function saveNodeLocalBackupStream(mode: NodeServerBackupMode) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  logger.info("node-stream.start {mode}", { mode, elapsedMs: elapsed() });
  await forageStorage.Init();
  if (!(forageStorage.realStorage instanceof NodeStorage)) {
    logger.error("node-stream.storage-mismatch", {
      actualStorage: forageStorage.realStorage?.constructor?.name ?? "null",
      elapsedMs: elapsed(),
    });
    throw new Error("Node local backup requires NodeStorage");
  }
  const nodeStorage = forageStorage.realStorage;
  const performance = getLocalBackupPerformance();
  logger.debug("node-stream.performance", {
    databasePageRecords: performance.databasePageRecords,
    fragmentRecords: performance.fragmentRecords,
    writerBufferKiB: performance.writerBufferKiB,
    progressUpdateMs: performance.progressUpdateMs,
  });
  let nativeWriter: LocalWriter | null = null;
  if (isTauri || isCapacitor) {
    nativeWriter = new LocalWriter();
    nativeWriter.setBufferSize(performance.writerBufferKiB * 1024);
    reportLocalBackupProgress("selectingDestination", { percent: 1 });
    const { baseName } = createLocalBackupExportMetadata(mode);
    logger.info("node-stream.writer-init {baseName}", {
      baseName,
      elapsedMs: elapsed(),
    });
    if (!(await nativeWriter.init(baseName, ["risubackup"]))) {
      // Quiet-failure suspect #1: the native document picker was cancelled
      // (either by the system on cold start or by the user). The progress UI
      // was already shown, so alertClear() makes it vanish silently.
      logger.warn("node-stream.writer-cancelled {platform}", {
        platform: isCapacitor ? "capacitor" : "tauri",
        elapsedMs: elapsed(),
      });
      alertClear();
      return;
    }
    logger.info("node-stream.writer-opened", { elapsedMs: elapsed() });
  }
  try {
    if (mode === "native") {
      reportLocalBackupProgress("preparing", { percent: 3 });
      logger.info("node-stream.staging-inlays", { elapsedMs: elapsed() });
      await stageNodeInlaysForBackup(nodeStorage);
    }
    reportLocalBackupProgress("preparing", { percent: 4 });
    logger.info("node-stream.creating-export-job", {
      elapsedMs: elapsed(),
    });
    const job = await nodeStorage.backup.createExportJob({
      mode,
      pageSize: performance.databasePageRecords,
      fragmentRecords: performance.fragmentRecords,
    });
    logger.info("node-stream.export-job-created {jobId}", {
      jobId: job.id,
      elapsedMs: elapsed(),
    });
    let keepPolling = true;
    const progressPolling = (async () => {
      while (keepPolling) {
        try {
          const state = await nodeStorage.backup.getExportProgress(job.id);
          const progress = state.progress;
          if (progress?.stage) {
            reportLocalBackupProgress(progress.stage, {
              current: progress.current,
              total: progress.total,
            });
          }
          const logInfo = {
            status: state.status,
            stage: progress?.stage ?? "none",
            elapsedMs: elapsed(),
          };
          const message = "node-stream.poll-final-state";

          switch (state.status) {
            case "complete":
              logger.info(message, logInfo);
              break;
            case "error":
              logger.error(message, logInfo);
              break;
          }
        } catch (error) {
          // The completion request remains authoritative. A transient status
          // polling failure must not abort the actual browser download.
          logger.warn("node-stream.poll-error", {
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: elapsed(),
          });
        }
        await sleep(performance.progressUpdateMs);
      }
    })();
    try {
      let completion: Awaited<
        ReturnType<typeof nodeStorage.backup.waitForExport>
      >;
      if (nativeWriter) {
        logger.info("node-stream.opening-export-stream {jobId}", {
          jobId: job.id,
          elapsedMs: elapsed(),
        });
        const response = await nodeStorage.backup.openExportStream(job.id);
        reportLocalBackupProgress("database", { percent: 5 });
        await streamRemoteBackupResponse(response, nativeWriter);
        logger.info("node-stream.download-streamed", {
          elapsedMs: elapsed(),
        });
        await nativeWriter.close();
        nativeWriter = null;
        logger.info("node-stream.writer-closed", { elapsedMs: elapsed() });
        completion = await nodeStorage.backup.waitForExport(job.id);
      } else {
        const anchor = document.createElement("a");
        anchor.href = await nodeStorage.backup.getExportDownloadUrl(job.id);
        anchor.download = createLocalBackupExportMetadata(mode).filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        reportLocalBackupProgress("database", { percent: 5 });
        logger.info("node-stream.anchor-download-clicked", {
          elapsedMs: elapsed(),
        });
        completion = await nodeStorage.backup.waitForExport(job.id);
      }
      if (completion.status !== "complete") {
        logger.error("node-stream.export-failed {reason}", {
          reason: completion.error ?? "unknown",
          elapsedMs: elapsed(),
        });
        throw new Error(completion.error ?? "Local backup download failed");
      }
      logger.info("node-stream.complete", { elapsedMs: elapsed() });
      reportLocalBackupProgress("finalizing", { percent: 100 });
      alertNormal("Success");
    } finally {
      keepPolling = false;
      await progressPolling;
    }
  } catch (error) {
    logger.error("node-stream.failed {error}", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: elapsed(),
    });
    throw error;
  } finally {
    if (nativeWriter) {
      await nativeWriter.close().catch(() => {});
    }
    if (mode === "native") {
      try {
        await clearNodeBackupInlayStage(nodeStorage);
        logger.info("node-stream.inlay-stage-cleared", {
          elapsedMs: elapsed(),
        });
      } catch (error) {
        console.warn("Failed to clean staged backup inlays:", error);
        logger.warn("node-stream.inlay-stage-clear-failed", {
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: elapsed(),
        });
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

export async function createBackupDatabaseSnapshot(
  onProgress?: (msg: string) => void,
): Promise<PortableDatabase> {
  await flushDurableStores();

  const db = await loadFullSqlBackupSnapshot(onProgress);

  ensureAllDomains(db);

  const normalized = normalizePortableBackupSnapshot(db) as PortableDatabase;
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
} from "../storage/database/domainRegistry.svelte";
import {
  type BackupAssetInfo,
  type BackupAssetMap,
  type BackupAssetScope,
} from "@risuai/backup-core/assetScope";
import { StreamingBackupExportInventory } from "@risuai/backup-core/streamInventory";
import {
  buildPortableLocalBackupDatabase as buildPortableLocalBackupDatabaseCore,
  normalizePortableBackupSnapshot,
} from "@risuai/backup-core/databasePreparation";
import {
  restoreInlayBackupEntry as restoreInlayBackupEntryCore,
  type InlayRestoreDecode,
  type InlayRestoreResult,
  type InlayRestoreWrite,
} from "@risuai/backup-core/inlayRestore";
import { streamBackupInlays } from "@risuai/backup-core/inlayExport";
import {
  BoundedAssetBatchWriter,
  type RestoredAssetBatch,
} from "@risuai/backup-core/restoreBatch";
import {
  restoreBackupArchive,
  type BackupArchiveEncryptionState,
  type BackupArchiveReadProgress,
  type RestoredBackupArchive,
} from "@risuai/backup-core/restoreArchive";
import { createLocalBackupAssetBatchWriter } from "./localBackupAssetRestore";
import {
  createNodeLocalBackupRestoreProgressReporter,
  createLocalBackupProgressReporters,
  formatBackupBytes,
  formatLocalBackupReadProgress,
  type NodeLocalBackupRestoreProgressReporter,
} from "./localBackupProgress";

interface LocalBackupExportOptions {
  mode: LocalBackupMode;
  partial: boolean;
  assetScope: BackupAssetScope;
  accountReadDelayMs: number;
  encryptAccountBackup: boolean;
}

export { createNodeBackupAssetRequest, streamNodeBackupAssets };

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

function reportBackupAssetProgress(current: number, total: number): void {
  reportLocalBackupProgress("assets", { current, total });
}

async function writeLocalBackupAssets(
  writer: LocalWriter,
  db: PortableDatabase,
  options: LocalBackupExportOptions,
  precomputedAssetMap?: BackupAssetMap,
): Promise<{
  missingAssets: string[];
  assetMap: BackupAssetMap;
}> {
  const assetMap =
    precomputedAssetMap ?? collectAllDomainAssets(db, options.assetScope);
  const missingAssets: string[] = [];
  reportLocalBackupProgress("assets");
  await sleep(0);
  const updateInterval: number = getLocalBackupPerformance().progressUpdateMs;

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
        reportBackupAssetProgress(current, progress.totalFiles);
      },
      request.options,
    );
    missingAssets.push(...streamed.missingKeys);
    return { missingAssets, assetMap };
  }

  const listedKeys: string[] = await listBackupAssetKeys();
  const keys: string[] = selectBackupAssetKeys(
    listedKeys,
    options.assetScope,
    assetMap,
  );

  if (
    isCapacitor &&
    !forageStorage.isAccount &&
    writer.supportsNativeAssetTransfer()
  ) {
    missingAssets.push(
      ...(await exportNativeBackupAssets({
        keys,
        writeBatch: async (batch: string[]): Promise<{ missing: string[] }> =>
          await writer.writeNativeAssets(batch),
        onProgress(progress: BackupAssetExportProgress): void {
          reportBackupAssetProgress(progress.current, progress.total);
        },
        yieldControl: async (): Promise<void> => {
          await sleep(0);
        },
      })),
    );
    return { missingAssets, assetMap };
  }

  if (
    forageStorage.isAccount &&
    settingsStore.state.skipSavingAssetsOnWebSync
  ) {
    return { missingAssets, assetMap };
  }
  missingAssets.push(
    ...(await exportStoredBackupAssets({
      keys,
      async read(key: string): Promise<Uint8Array | undefined> {
        const value: unknown = await forageStorage.getItem(key);
        return value ? (value as Uint8Array) : undefined;
      },
      async write(key: string, data: Uint8Array): Promise<void> {
        await writer.writeBackup(key, data);
      },
      readCached: forageStorage.isAccount
        ? async (key: string): Promise<Uint8Array | undefined> => {
            const cached: ArrayBuffer | null =
              await localforage.getItem<ArrayBuffer>(key);
            return cached ? new Uint8Array(cached) : undefined;
          }
        : undefined,
      onProgress(progress: BackupAssetExportProgress): void {
        reportBackupAssetProgress(progress.current, progress.total);
      },
      yieldControl: async (): Promise<void> => {
        await sleep(0);
      },
      delay: async (milliseconds: number): Promise<void> => {
        await sleep(milliseconds);
      },
      delayAfterUncachedMs: forageStorage.isAccount
        ? options.accountReadDelayMs
        : 0,
      progressUpdateMs: updateInterval,
    })),
  );
  return { missingAssets, assetMap };
}

async function collectBackupColdStorage(
  db: PortableDatabase,
): Promise<ColdStorageBackupCollection<ColdStorageBackupPayload> | null> {
  return await prepareColdStorageBackup({
    database: db,
    collect: async (
      onProgress,
    ): Promise<ColdStorageBackupCollection<ColdStorageBackupPayload>> =>
      await collectColdStorageBackupPayloads(db, onProgress),
    confirm: async (
      database: PortableDatabase,
      unavailableKeys: readonly string[],
    ): Promise<boolean> =>
      await confirmIncompleteColdStorageOperation(
        database,
        unavailableKeys,
        "backup",
      ),
    onProgress(current: number, total: number): void {
      reportLocalBackupProgress("coldStorage", { current, total });
    },
    yieldControl: async (): Promise<void> => {
      await sleep(10);
    },
  });
}

async function writeBackupColdStorage(
  writer: LocalWriter,
  coldStoragePayloads: ColdStorageBackupCollection<ColdStorageBackupPayload>,
): Promise<void> {
  await writeColdStorageBackup({
    payloads: coldStoragePayloads.payloads,
    name: (payload: ColdStorageBackupPayload): string => payload.backupName,
    encode: (payload: ColdStorageBackupPayload): Uint8Array => payload.encoded,
    write: async (name: string, data: Uint8Array): Promise<void> =>
      await writer.writeBackup(name, data),
    onProgress(current: number, total: number): void {
      reportLocalBackupProgress("coldStorage", { current, total });
    },
    yieldControl: async (): Promise<void> => {
      await sleep(0);
    },
  });
}

async function writeStreamingColdStorage(
  inventory: StreamingBackupExportInventory,
): Promise<boolean> {
  reportLocalBackupProgress("coldStorage", { percent: 67 });
  const unavailableKeys: ReadonlySet<string> =
    inventory.finalizeUnavailableColdStorageKeys();
  return await confirmIncompleteColdStorageOperation(
    {
      characters: [...inventory.coldStorageCharacters.values()],
    },
    unavailableKeys,
    "backup",
  );
}

async function encodeStreamingDatabaseValue(
  value: PortableDatabaseStreamFragment | PortableDatabaseStreamManifest,
  entryName: string,
  encryptionKey?: string,
): Promise<Uint8Array> {
  return await encodeStreamingBackupValue(
    value,
    entryName,
    async (data: unknown): Promise<Uint8Array> =>
      await encodeRisuSaveLegacyAsync(data, "compression"),
    encryptionKey,
  );
}

async function requestAccountBackupEncryptionKey(
  time: number,
): Promise<unknown> {
  const response: Response = await fetch(
    `https://sv.risuai.xyz/cryptokey?key=${time}`,
  );
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null && "key" in payload
    ? payload.key
    : undefined;
}

function showMissingBackupAssets(
  missingAssets: string[],
  assetMap: BackupAssetMap,
  partial: boolean,
): void {
  const result = formatMissingBackupAssets(missingAssets, assetMap, partial);
  if (result.success) {
    alertNormal("Success");
    return;
  }
  alertMd(result.message ?? "Backup completed with missing assets.");
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
    const key: string | undefined = await prepareAccountBackupEncryption({
      enabled: true,
      metadataEntryName: ACCOUNT_ENCRYPTION_ENTRY_NAME,
      requestKey: requestAccountBackupEncryptionKey,
      write: async (name: string, data: Uint8Array): Promise<void> =>
        await writer.writeBackup(name, data),
    });
    if (!key) throw new Error("Account backup encryption key is unavailable");
    dbData = new Uint8Array(await encryptBuffer(dbData, key));
  }

  reportLocalBackupProgress("database", { percent: 59 });
  await sleep(10);
  await writer.writeBackup(LEGACY_DATABASE_ENTRY_NAME, dbData);
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

  const inventory: StreamingBackupExportInventory =
    new StreamingBackupExportInventory(options.assetScope);
  const performance = getLocalBackupPerformance();
  const encryptionKey: string | undefined =
    await prepareAccountBackupEncryption({
      enabled:
        options.encryptAccountBackup &&
        forageStorage.isAccount &&
        location.origin.endsWith("risuai.xyz"),
      metadataEntryName: ACCOUNT_ENCRYPTION_ENTRY_NAME,
      requestKey: requestAccountBackupEncryptionKey,
      write: async (name: string, data: Uint8Array): Promise<void> =>
        await writer.writeBackup(name, data),
      databaseEncryption: STREAMING_BACKUP_ENCRYPTION_FORMAT,
    });
  let manifest: PortableDatabaseStreamManifest;
  let lastProgressUpdate = 0;
  try {
    manifest = await exportPortableDatabaseStream(
      storage,
      {
        async writeFragment(fragment) {
          const entryName = portableDatabaseStreamFragmentName(fragment.index);
          const encoded = await encodeStreamingDatabaseValue(
            fragment,
            entryName,
            encryptionKey,
          );
          await writer.writeBackup(entryName, encoded);
        },
        async writeColdStorage(key, value) {
          if (!isColdStorageBackupData(value)) {
            inventory.markColdStorageUnavailable(key);
            return;
          }
          inventory.markColdStorageExported(key);
          await writer.writeBackup(
            getColdStorageBackupName(key),
            new TextEncoder().encode(JSON.stringify(value)),
          );
        },
        onRecord(record) {
          inventory.collect(record);
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
        },
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
  const startedAt = Date.now();
  logger.info("save.start {mode}", { mode });
  try {
    await runExclusiveLocalBackupOperation("save", async () => {
      if (usesRemoteBackupApi(forageStorage.realStorage)) {
        logger.info("save.route {route}", { route: "node" });
        await flushDurableStores();
        await saveNodeLocalBackupStream(mode);
        return;
      }
      logger.info("save.route {route}", { route: "local" });
      await saveLocalBackupWithOptions({
        mode,
        partial: false,
        assetScope: "all",
        accountReadDelayMs: 1000,
        encryptAccountBackup: true,
      });
    });
    logger.info("save.complete", {
      mode,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("save.failed {error}", {
      mode,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    console.error("SaveLocalBackup failed:", error);
    alertError(error);
  }
}

/** Save a native backup containing only the essential visual assets. */
export async function SavePartialLocalBackup() {
  const startedAt = Date.now();
  logger.info("partial-save.start");
  try {
    if (!(await alertConfirm(language.partialBackupFirstConfirm))) {
      logger.info("partial-save.cancelled {at}", { at: "confirm-1" });
      return;
    }
    if (!(await alertConfirm(language.partialBackupSecondConfirm))) {
      logger.info("partial-save.cancelled {at}", { at: "confirm-2" });
      return;
    }
    await runExclusiveLocalBackupOperation("partial-save", async () => {
      if (usesRemoteBackupApi(forageStorage.realStorage)) {
        logger.info("partial-save.route {route}", { route: "node" });
        await flushDurableStores();
        await saveNodeLocalBackupStream("partial");
        return;
      }
      logger.info("partial-save.route {route}", { route: "local" });
      await saveLocalBackupWithOptions({
        mode: "native",
        partial: true,
        assetScope: "essential",
        accountReadDelayMs: 100,
        encryptAccountBackup: false,
      });
    });
    logger.info("partial-save.complete", {
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("partial-save.failed {error}", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    console.error("SavePartialLocalBackup failed:", error);
    alertError(error);
  }
}

export type { InlayRestoreResult } from "@risuai/backup-core/inlayRestore";

export async function restoreInlayBackupEntry(
  inlayKey: string,
  data: Uint8Array,
  dependencies: {
    decode?: typeof decodeInlayAssetBackup;
    write?: typeof setInlayAsset;
  } = {},
): Promise<InlayRestoreResult> {
  const decode: InlayRestoreDecode =
    dependencies.decode ?? decodeInlayAssetBackup;
  const write: InlayRestoreWrite = dependencies.write ?? setInlayAsset;
  return restoreInlayBackupEntryCore(inlayKey, data, { decode, write });
}

async function restoreLocalBackupSourceUnlocked(
  file: LocalBackupSource,
  parserProgress: { start: number; end: number } = { start: 2, end: 90 },
  options: LocalBackupRestoreOptions = {},
): Promise<void> {
  let streamingRestoreStorage: Awaited<
    ReturnType<typeof getSqlStorage>
  > | null = null;
  let streamingDecryptionKey: Promise<string> | null = null;
  let streamingRestoreFinished: boolean = false;
  let lastUiUpdate: number = 0;
  const assetBatchWriter: BoundedAssetBatchWriter =
    createLocalBackupAssetBatchWriter(
      selectLocalBackupAssetRestoreMode(forageStorage.realStorage),
    );
  let restoredArchive: RestoredBackupArchive<PortableDatabaseStreamRestoreSession> | null =
    null;

  try {
    restoredArchive = await restoreBackupArchive({
      source: file,
      async createStreamSink(): Promise<PortableDatabaseStreamRestoreSession | null> {
        const storage: Awaited<ReturnType<typeof getSqlStorage>> =
          await getSqlStorage();
        if (!hasPortableDatabaseStreamRestore(storage)) return null;
        streamingRestoreStorage = storage;
        return await storage.beginPortableDatabaseStreamRestore();
      },
      async decodeStreamValue(
        data: Uint8Array,
        entryName: string,
        encryption: BackupArchiveEncryptionState,
      ): Promise<unknown> {
        let decodeOptions: StreamingBackupValueDecodeOptions | undefined;
        if (encryption.type === "account" && encryption.time) {
          streamingDecryptionKey ??= fetchLegacyBackupKey(encryption.time);
          decodeOptions = {
            secret: await streamingDecryptionKey,
            async decryptLegacy(
              encrypted: Uint8Array,
              secret: string,
            ): Promise<Uint8Array> {
              return new Uint8Array(await decryptBuffer(encrypted, secret));
            },
          };
        }
        return await decodeStreamingBackupValue(
          data,
          entryName,
          async (encoded: Uint8Array): Promise<unknown> =>
            await decodeRisuSave(encoded),
          decodeOptions,
        );
      },
      decodeRawDatabase: async (data: Uint8Array): Promise<unknown> =>
        await decodeRisuSave(data),
      restoreInlay: restoreInlayBackupEntry,
      async restoreColdStorage(key: string, value: unknown): Promise<boolean> {
        const restored: boolean = await setColdStorageItem(key, value);
        if (!restored) {
          console.error(`Failed to restore cold storage item ${key}`);
        }
        return restored;
      },
      async restoreAsset(path: string, data: Uint8Array): Promise<void> {
        await assetBatchWriter.add(path, data);
      },
      async flushAssets(): Promise<void> {
        if (assetBatchWriter.size === 0) return;
        reportLocalBackupRestoreProgress("reading", { percent: 90 });
        await assetBatchWriter.flush();
      },
      onProgress(progress: BackupArchiveReadProgress): void {
        const now: number = Date.now();
        if (now - lastUiUpdate <= 30) return;
        lastUiUpdate = now;
        const readPercent: number =
          progress.totalBytes === 0
            ? parserProgress.end
            : parserProgress.start +
              (progress.totalBytesRead / progress.totalBytes) *
                (parserProgress.end - parserProgress.start);
        reportLocalBackupRestoreProgress("reading", {
          percent: readPercent,
          detail: formatLocalBackupReadProgress(
            progress.entryName,
            progress.totalBytesRead,
            progress.totalBytes,
          ),
        });
      },
      onEncryptionParseError(error: unknown): void {
        console.error("Failed to parse encryption metadata:", error);
      },
      onInvalidInlay(key: string, error: unknown): void {
        console.warn(`Skipping invalid inlay item ${key}:`, error);
      },
      onInlayStorageError(key: string, error: unknown): void {
        console.error(`Failed to store inlay item ${key}:`, error);
      },
      onInvalidColdStorage(_key: string, entryName: string): void {
        console.warn(`Skipping invalid cold storage backup item ${entryName}`);
      },
      onColdStorageParseError(
        key: string,
        _entryName: string,
        error: unknown,
      ): void {
        console.error(`Failed to parse cold storage item ${key}:`, error);
      },
      onExtensionEntry(name: string): void {
        console.info(`Skipping unsupported backup extension entry: ${name}`);
      },
      onContainerFallback(error: unknown): void {
        streamingRestoreStorage = null;
        console.warn(
          "Stream backup container parsing failed, trying raw database.bin fallback:",
          error,
        );
      },
    });

    let pendingDatabase: Uint8Array | null = restoredArchive.pendingDatabase;
    let decodedDatabase: object | null = restoredArchive.decodedDatabase;
    const streamRestore = restoredArchive.streamRestore;
    const streamingColdStorage = restoredArchive.streamingColdStorage;
    const restoredColdStorageKeys = restoredArchive.restoredColdStorageKeys;
    const invalidInlayEntries: string[] = restoredArchive.invalidInlayEntries;
    const ignoredExtensionEntries: number =
      restoredArchive.ignoredExtensionEntries;
    const encryptionMeta: BackupArchiveEncryptionState =
      restoredArchive.encryption;

    if (invalidInlayEntries.length > 0) {
      await alertNormalWait(
        `This backup contains ${invalidInlayEntries.length} invalid inlay item(s). ` +
          "Those items will be skipped, but the database restore can continue.",
      );
    }

    let storage = streamingRestoreStorage ?? (await getSqlStorage());

    const streamingRestoreSession: PortableDatabaseStreamRestoreSession | null =
      streamRestore.sink;
    if (streamingRestoreSession) {
      if (pendingDatabase || decodedDatabase) {
        throw new Error("Backup mixes legacy and streaming database formats");
      }
      const streamingManifest: PortableDatabaseStreamManifest | null =
        streamRestore.manifest;
      if (!streamingManifest) {
        throw new Error("Streaming database manifest is missing");
      }

      const missingColdStorageKeys: string[] = [];
      for (const key of streamingColdStorage.referencedColdStorageKeys) {
        if (restoredColdStorageKeys.has(key)) continue;
        const existingColdStorage = await getColdStorageItem(key);
        if (!isColdStorageBackupData(existingColdStorage)) {
          missingColdStorageKeys.push(key);
        }
      }
      if (
        !(await confirmIncompleteColdStorageOperation(
          {
            characters: [
              ...streamingColdStorage.coldStorageCharacters.values(),
            ],
          },
          missingColdStorageKeys,
          "restore",
        ))
      ) {
        return;
      }

      if (ignoredExtensionEntries > 0) {
        console.info(
          `[LocalBackupRestore] Skipped ${ignoredExtensionEntries} unsupported extension entries`,
        );
      }
      reportLocalBackupRestoreProgress("database", { percent: 97 });
      reportLocalBackupRestoreProgress("branches", { percent: 98 });
      await options.beforeDatabaseApply?.();
      await streamingRestoreSession.finish(streamingManifest);
      streamingRestoreFinished = true;
      reportLocalBackupRestoreProgress("branches", { percent: 99.5 });
    } else {
      const collectedDatabase: Record<string, unknown> | null =
        streamRestore.finishCollected();
      if (collectedDatabase) {
        if (pendingDatabase || decodedDatabase) {
          throw new Error("Backup mixes legacy and streaming database formats");
        }
        decodedDatabase = collectedDatabase;
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
      const decodedDb: object =
        decodedDatabase ??
        ((await decodeRisuSave(db as Uint8Array)) as Database);
      const prepared = preparePortableDatabaseForBranchRestore(
        normalizePortableBackupSnapshot(decodedDb as BackupDatabaseDraft),
      );
      const dbData = prepared.database as Database;
      const portableBranchGraphs = prepared.branchGraphs;
      db = null;
      console.info("[LocalBackupRestore] Decoded database summary", {
        databaseBytes: databaseByteLength,
        characters: Array.isArray(dbData.characters)
          ? dbData.characters.length
          : null,
        personas: Array.isArray(dbData.personas)
          ? dbData.personas.length
          : null,
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
        if (restoredColdStorageKeys.has(key)) continue;
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
      storage = await getSqlStorage();
      await options.beforeDatabaseApply?.();
      await storage.replaceDatabase(dbData, (_step, syncProgress) => {
        const ratio =
          syncProgress === undefined
            ? 0
            : Math.max(0, Math.min(1, syncProgress));
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
  } finally {
    const unfinishedStreamingSession: PortableDatabaseStreamRestoreSession | null =
      restoredArchive?.streamRestore.sink ?? null;
    if (unfinishedStreamingSession && !streamingRestoreFinished) {
      await unfinishedStreamingSession.abort().catch((): void => {});
    }
  }
}

async function runLocalBackupRestore<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return await runExclusiveLocalBackupOperation("restore", async () => {
    await flushDurableStores();
    return await operation();
  });
}

async function restoreNodeLocalBackupSourceUnlocked(
  file: LocalBackupSource,
  uploadStart = 2,
  directFile?: Blob,
) {
  await forageStorage.Init();
  if (!(forageStorage.realStorage instanceof NodeStorage)) {
    throw new Error("Node local backup restore requires NodeStorage");
  }

  const nodeStorage = forageStorage.realStorage;
  const performance = getLocalBackupPerformance();
  const job = await nodeStorage.backup.createImportJob();
  let keepPolling = true;
  const progressReporter: NodeLocalBackupRestoreProgressReporter =
    createNodeLocalBackupRestoreProgressReporter(
      (message, progress, stepState): void => {
        showProgressAlert(message, progress, "backup", stepState);
      },
      uploadStart,
    );
  progressReporter.start(file.size);

  const applyRemoteProgress = (
    state: Awaited<ReturnType<typeof nodeStorage.backup.getImportProgress>>,
  ): void => {
    if (
      directFile &&
      (state.progress?.stage === "uploading" ||
        state.progress?.stage === "reading")
    ) {
      progressReporter.updateUpload(
        state.progress.current ?? 0,
        state.progress.total ?? file.size,
      );
    }
    progressReporter.updateRemote(state.progress, state.status);
  };
  const unsubscribeProgress = subscribeNodeBackupProgress(job.id, (state) =>
    applyRemoteProgress(state),
  );

  // A browser File can be streamed by the user agent in one request without
  // materializing it. Native/Tauri sources retain resumable bounded requests.
  const upload = directFile
    ? nodeStorage.backup.uploadImportFile(job.id, directFile, job.uploadToken)
    : nodeStorage.backup.uploadImportStream(job.id, file.stream(), file.size, {
        onProgress: (state) =>
          progressReporter.updateUpload(state.receivedBytes, state.totalBytes),
      });
  const polling = (async () => {
    while (keepPolling) {
      if (!isNodeRealtimeConnected()) {
        try {
          const state = await nodeStorage.backup.getImportProgress(job.id);
          applyRemoteProgress(state);
          if (state.status === "complete" || state.status === "error") break;
        } catch {
          // The upload request remains authoritative. Fallback polling is
          // best-effort and must not abort a valid restore.
        }
      }
      await sleep(
        isNodeRealtimeConnected()
          ? Math.max(1_000, performance.progressUpdateMs)
          : performance.progressUpdateMs,
      );
    }
  })();

  let completed: Awaited<typeof upload>;
  try {
    completed = await upload;
  } finally {
    keepPolling = false;
    await polling;
    unsubscribeProgress();
  }
  if (completed.status !== "complete") {
    throw new Error(completed.error ?? "Local backup import failed");
  }

  progressReporter.complete();
  const storage = await getSqlStorage();
  await storage.close?.();
  alertStore.set({
    type: "wait",
    msg: "Success, Refreshing your app.",
  });
  const cleanUrl = new URL(location.href);
  cleanUrl.search = "";
  location.replace(cleanUrl);
}

async function restoreLocalBackupSource(
  file: LocalBackupSource,
  parserProgress: { start: number; end: number } = { start: 2, end: 90 },
) {
  reportLocalBackupRestoreProgress("reading", {
    percent: parserProgress.start,
  });
  return await runLocalBackupRestore(() =>
    restoreLocalBackupSourceUnlocked(file, parserProgress),
  );
}

export async function restoreLocalBackupFile(file: File) {
  if (usesRemoteBackupApi(forageStorage.realStorage)) {
    await runLocalBackupRestore(() =>
      restoreNodeLocalBackupSourceUnlocked(file, 2, file),
    );
    return;
  }
  await restoreLocalBackupSource(file);
}

async function loadCapacitorLocalBackupUnlocked(): Promise<void> {
  if (!nativeBackup) throw new Error("Native backup importer is unavailable");
  const remote: boolean = usesRemoteBackupApi(forageStorage.realStorage);
  reportLocalBackupRestoreProgress("selectingSource", { percent: 0 });
  const progressListener: Awaited<
    ReturnType<NativeBackupPlugin["addListener"]>
  > = await nativeBackup.addListener(
    "importProgress",
    (event: NativeImportProgress): void => {
      const bytesRead: number = Math.max(0, event.bytesRead ?? 0);
      const totalBytes: number = Math.max(0, event.totalBytes ?? 0);
      const copySpan: number = remote ? 18 : 43;
      let percent: number =
        totalBytes > 0
          ? 2 +
            Math.min(copySpan, Math.floor((bytesRead / totalBytes) * copySpan))
          : 2;

      let detail: string =
        totalBytes > 0
          ? `${formatBackupBytes(bytesRead)} / ${formatBackupBytes(totalBytes)}`
          : bytesRead > 0
            ? formatBackupBytes(bytesRead)
            : "";
      if (!remote && event.stage === "committing") {
        const processed: number = Math.max(0, event.assetsProcessed ?? 0);
        const total: number = Math.max(0, event.totalAssets ?? 0);
        percent = total > 0 ? 45 + Math.floor((processed / total) * 4) : 47;
        detail =
          total > 0
            ? `${processed} / ${total} · ${language.localBackupRestoreReadingAssets}`
            : language.localBackupRestoreReadingAssets;
      } else if (event.stage === "complete") {
        percent = remote ? 20 : 50;
      }
      reportLocalBackupRestoreProgress("reading", { percent, detail });
    },
  );

  try {
    const selected: Awaited<ReturnType<NativeBackupPlugin["openImport"]>> =
      await nativeBackup.openImport(remote ? { raw: true } : undefined);
    if (selected.cancelled) {
      alertClear();
      return;
    }
    if (!selected.id)
      throw new Error("Native backup import session was not created");

    const id: string = selected.id;
    const commitNativeAssets: () => Promise<void> = createNativeAssetCommit(
      nativeBackup,
      id,
    );
    try {
      const size: number = Math.max(0, selected.size ?? 0);
      const source: LocalBackupSource = createNativeImportSource(
        nativeBackup,
        id,
        size,
      );
      if (remote) {
        reportLocalBackupRestoreProgress("reading", { percent: 20 });
        await restoreNodeLocalBackupSourceUnlocked(source, 20);
      } else {
        reportLocalBackupRestoreProgress("reading", { percent: 50 });
        await restoreLocalBackupSourceUnlocked(
          source,
          { start: 50, end: 90 },
          {
            beforeDatabaseApply: async (): Promise<void> => {
              await commitNativeAssets();
            },
          },
        );
      }
    } finally {
      await nativeBackup.closeImport({ id }).catch(() => {});
    }
  } finally {
    await progressListener.remove().catch(() => {});
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
  if (usesRemoteBackupApi(forageStorage.realStorage)) {
    await restoreNodeLocalBackupSourceUnlocked(source);
    return;
  }
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
