import type { LocalBackupMode, LocalBackupProgress } from "../api";
import { collectStreamedEssentialAssetKeys } from "../assetScope";
import { createLocalBackupExportPlan } from "../exportPlan";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import {
  streamBackupStorageEntries,
  streamColdStorageExportEntries,
  type LoadColdStorageExportValueResult,
  type OpenBackupStorageEntryResult,
} from "./exportEntries";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  type BackupEntrySource,
  type PortableDatabaseStreamManifest,
} from "./exportStream";

export interface LocalBackupArchiveStreamOptions {
  pageSize?: number;
  fragmentRecords?: number;
}

export interface PreparedCompatibleBackupDatabase {
  source: BackupEntrySource;
  size: number;
  coldStorageKeys: readonly string[];
  loadColdStorage(key: string): Promise<LoadColdStorageExportValueResult>;
}

export interface LocalBackupArchiveExportAdapter {
  onReady?(): Promise<void> | void;
  writeEntry(
    name: string,
    source: BackupEntrySource,
    size: number,
  ): Promise<void>;
  prepareCompatibleDatabase(): Promise<PreparedCompatibleBackupDatabase>;
  streamNativeDatabase(options: {
    pageSize?: number;
    fragmentRecords?: number;
    onRecord(record: LegacyBackupSqlRecord): void;
    onProgress(progress: LocalBackupProgress): void;
  }): Promise<PortableDatabaseStreamManifest>;
  listColdStorageKeys(): Promise<readonly string[]>;
  loadColdStorage(key: string): Promise<LoadColdStorageExportValueResult>;
  assertDatabaseRevision(revision: number): Promise<void>;
  listAssetKeys(): Promise<readonly string[]>;
  listInlayKeys(): Promise<readonly string[]>;
  openStorageEntry(key: string): Promise<OpenBackupStorageEntryResult>;
  encodeDatabase(value: unknown): Promise<Uint8Array>;
}

export interface StreamLocalBackupArchiveInput {
  mode: LocalBackupMode;
  streamOptions?: LocalBackupArchiveStreamOptions;
  adapter: LocalBackupArchiveExportAdapter;
  onProgress?: (progress: LocalBackupProgress) => void;
}

async function streamCompatibleBackup(
  input: StreamLocalBackupArchiveInput,
): Promise<void> {
  const { adapter } = input;
  const onProgress = input.onProgress ?? (() => {});
  onProgress({ stage: "database" });

  const prepared = await adapter.prepareCompatibleDatabase();
  const plan = createLocalBackupExportPlan({
    mode: "compatible",
    assetKeys: await adapter.listAssetKeys(),
  });
  await adapter.onReady?.();

  onProgress({ stage: "database", current: 1, total: 1 });
  await adapter.writeEntry("database.risudat", prepared.source, prepared.size);

  await streamColdStorageExportEntries({
    keys: prepared.coldStorageKeys,
    load: prepared.loadColdStorage,
    writeEntry: adapter.writeEntry,
    onProgress,
  });
  await streamBackupStorageEntries({
    stage: "assets",
    keys: plan.assetKeys,
    open: adapter.openStorageEntry,
    writeEntry: adapter.writeEntry,
    onProgress,
  });
  onProgress({ stage: "finalizing" });
}
async function streamNativeBackup(
  input: StreamLocalBackupArchiveInput,
): Promise<void> {
  const { adapter, mode } = input;
  const onProgress = input.onProgress ?? (() => {});
  const partial = mode === "partial";
  const essentialAssetKeys = new Set<string>();

  await adapter.onReady?.();
  const manifest = await adapter.streamNativeDatabase({
    ...input.streamOptions,
    onRecord(record) {
      if (partial) {
        collectStreamedEssentialAssetKeys(essentialAssetKeys, record);
      }
    },
    onProgress,
  });

  await streamColdStorageExportEntries({
    keys: await adapter.listColdStorageKeys(),
    load: adapter.loadColdStorage,
    writeEntry: adapter.writeEntry,
    onProgress,
  });
  await adapter.assertDatabaseRevision(manifest.revision);
  const plan = createLocalBackupExportPlan({
    mode,
    assetKeys: await adapter.listAssetKeys(),
    inlayKeys: partial ? [] : await adapter.listInlayKeys(),
    essentialAssetKeys,
  });

  await streamBackupStorageEntries({
    stage: "assets",
    keys: plan.assetKeys,
    open: adapter.openStorageEntry,
    writeEntry: adapter.writeEntry,
    onProgress,
  });
  await streamBackupStorageEntries({
    stage: "inlays",
    keys: plan.inlayKeys,
    open: adapter.openStorageEntry,
    writeEntry: adapter.writeEntry,
    onProgress,
  });

  onProgress({ stage: "finalizing" });
  const manifestData = await adapter.encodeDatabase(manifest);
  await adapter.writeEntry(
    PORTABLE_DATABASE_STREAM_MANIFEST,
    manifestData,
    manifestData.byteLength,
  );
}
export async function streamLocalBackupArchive(
  input: StreamLocalBackupArchiveInput,
): Promise<void> {
  if (input.mode === "compatible") {
    await streamCompatibleBackup(input);
    return;
  }
  await streamNativeBackup(input);
}
