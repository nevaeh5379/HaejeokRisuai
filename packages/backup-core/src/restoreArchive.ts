import {
  parseBufferedBackupContainer,
  type BackupContainerEntryInfo,
} from "./containerStream";
import type { BackupEntryClassification } from "./entryPolicy";
import {
  iterateLocalBackupSource,
  type LocalBackupSource,
} from "./importSource";
import type { InlayRestoreResult } from "./inlayRestore";
import {
  dispatchBackupRestoreEntry,
  type AccountBackupEncryptionMetadata,
} from "./restoreEntry";
import {
  collectStreamingInventoryRecord,
  createStreamingColdStorageInventory,
  type StreamingColdStorageInventory,
} from "./streamInventory";
import type {
  PortableDatabaseStreamFragment,
  PortableDatabaseStreamRecord,
} from "./streamFormat";
import {
  PortableDatabaseStreamRestoreCoordinator,
  type PortableDatabaseStreamFragmentSink,
} from "./streamRestore";

export interface AbortablePortableDatabaseStreamSink extends PortableDatabaseStreamFragmentSink {
  abort(): Promise<void>;
}

export interface BackupArchiveReadProgress {
  entryName: string;
  totalBytesRead: number;
  totalBytes: number;
}

export interface BackupArchiveEncryptionState {
  type: "none" | "account";
  time?: number;
}

export interface RestoreBackupArchiveOptions<
  TSink extends AbortablePortableDatabaseStreamSink,
> {
  source: LocalBackupSource;
  createStreamSink(): Promise<TSink | null>;
  decodeStreamValue(
    data: Uint8Array,
    entryName: string,
    encryption: BackupArchiveEncryptionState,
  ): Promise<unknown>;
  decodeRawDatabase(data: Uint8Array): Promise<unknown>;
  restoreInlay(key: string, data: Uint8Array): Promise<InlayRestoreResult>;
  restoreColdStorage(key: string, value: unknown): Promise<boolean>;
  restoreAsset(path: string, data: Uint8Array): Promise<void>;
  flushAssets(): Promise<void>;
  onProgress?(progress: BackupArchiveReadProgress): void;
  onEncryptionParseError?(error: unknown): void;
  onInvalidInlay?(key: string, error: unknown): void;
  onInlayStorageError?(key: string, error: unknown): void;
  onInvalidColdStorage?(key: string, entryName: string): void;
  onColdStorageParseError?(
    key: string,
    entryName: string,
    error: unknown,
  ): void;
  onExtensionEntry?(name: string): void;
  onContainerFallback?(error: unknown): void;
}

export interface RestoredBackupArchive<
  TSink extends AbortablePortableDatabaseStreamSink,
> {
  encryption: BackupArchiveEncryptionState;
  pendingDatabase: Uint8Array | null;
  decodedDatabase: object | null;
  streamRestore: PortableDatabaseStreamRestoreCoordinator<TSink>;
  streamingColdStorage: StreamingColdStorageInventory;
  restoredColdStorageKeys: Set<string>;
  invalidInlayEntries: string[];
  ignoredExtensionEntries: number;
}

/** Parses and stages one backup archive while persistence stays host-injected. */
export async function restoreBackupArchive<
  TSink extends AbortablePortableDatabaseStreamSink,
>(
  options: RestoreBackupArchiveOptions<TSink>,
): Promise<RestoredBackupArchive<TSink>> {
  const encryption: BackupArchiveEncryptionState = { type: "none" };
  let pendingDatabase: Uint8Array | null = null;
  let decodedDatabase: object | null = null;
  const streamingColdStorage: StreamingColdStorageInventory =
    createStreamingColdStorageInventory();
  const restoredColdStorageKeys: Set<string> = new Set<string>();
  const invalidInlayEntries: string[] = [];
  const failedInlayWrites: string[] = [];
  let ignoredExtensionEntries: number = 0;

  const streamRestore: PortableDatabaseStreamRestoreCoordinator<TSink> =
    new PortableDatabaseStreamRestoreCoordinator<TSink>({
      createSink: options.createStreamSink,
      onSinkFragment(fragment: PortableDatabaseStreamFragment): void {
        fragment.records.forEach(
          (record: PortableDatabaseStreamRecord): void => {
            collectStreamingInventoryRecord(streamingColdStorage, record);
          },
        );
      },
    });

  const restoreEntry = async (
    name: string,
    data: Uint8Array,
    classification: BackupEntryClassification,
  ): Promise<void> => {
    await dispatchBackupRestoreEntry(name, data, classification, {
      onEncryptionParseError: options.onEncryptionParseError,
      onEncryption(metadata: AccountBackupEncryptionMetadata): void {
        encryption.type = metadata.type;
        encryption.time = metadata.time;
      },
      onDatabase(databaseData: Uint8Array): void {
        pendingDatabase = databaseData;
      },
      async onDatabaseStream(
        normalizedName: string,
        streamData: Uint8Array,
      ): Promise<void> {
        const value: unknown = await options.decodeStreamValue(
          streamData,
          name,
          encryption,
        );
        await streamRestore.acceptEntry(normalizedName, value);
      },
      async onInlay(key: string, inlayData: Uint8Array): Promise<void> {
        const result: InlayRestoreResult = await options.restoreInlay(
          key,
          inlayData,
        );
        if (result.status === "invalid") {
          invalidInlayEntries.push(key);
          options.onInvalidInlay?.(key, result.error);
        } else if (result.status === "storage-error") {
          failedInlayWrites.push(key);
          options.onInlayStorageError?.(key, result.error);
        }
      },
      async onColdStorage(key: string, value: unknown): Promise<void> {
        if (await options.restoreColdStorage(key, value)) {
          restoredColdStorageKeys.add(key);
        }
      },
      onInvalidColdStorage: options.onInvalidColdStorage,
      onColdStorageParseError: options.onColdStorageParseError,
      onAsset: options.restoreAsset,
    });
  };

  let entryName: string = "";
  try {
    await parseBufferedBackupContainer(
      iterateLocalBackupSource(options.source),
      {
        onEntryStart(entry: BackupContainerEntryInfo): void {
          entryName = entry.name;
        },
        async onEntry(
          entry: BackupContainerEntryInfo,
          data: Uint8Array,
          classification: BackupEntryClassification,
        ): Promise<void> {
          await restoreEntry(entry.name, data, classification);
        },
        onEntryEnd(): void {
          entryName = "";
        },
        onExtensionEntry(entry: BackupContainerEntryInfo): void {
          ignoredExtensionEntries += 1;
          options.onExtensionEntry?.(entry.name);
        },
        onChunk(_chunk: Uint8Array, totalBytesRead: number): void {
          options.onProgress?.({
            entryName,
            totalBytesRead,
            totalBytes: options.source.size,
          });
        },
      },
      { maxNameBytes: 1024 * 1024, maxEntryBytes: options.source.size },
    );
  } catch (error: unknown) {
    const sink: TSink | null = streamRestore.sink;
    if (sink) await sink.abort().catch((): void => {});
    streamRestore.reset();
    options.onContainerFallback?.(error);
    try {
      const rawBytes: Uint8Array = new Uint8Array(
        await options.source.arrayBuffer(),
      );
      const rawDatabase: unknown = await options.decodeRawDatabase(rawBytes);
      if (!rawDatabase || typeof rawDatabase !== "object") throw error;
      pendingDatabase = rawBytes;
      decodedDatabase = rawDatabase;
    } catch {
      throw error;
    }
  }

  await options.flushAssets();
  if (failedInlayWrites.length > 0) {
    throw new Error(
      `Failed to restore ${failedInlayWrites.length} inlay item(s) because local storage writes failed. ` +
        `The database replacement was not applied. First failed item: ${failedInlayWrites[0]}`,
    );
  }

  return {
    encryption,
    pendingDatabase,
    decodedDatabase,
    streamRestore,
    streamingColdStorage,
    restoredColdStorageKeys,
    invalidInlayEntries,
    ignoredExtensionEntries,
  };
}
