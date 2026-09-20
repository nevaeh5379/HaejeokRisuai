import type { ISqlStorage } from "../sql/ISqlStorage";
import { iterateStorageSyncSqlRecords } from "../runtime/storageSyncSource";
import { stripLegacyBranchFields } from "@risuai/backup-core/portableBranches";
import {
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  portableDatabaseStreamFragmentName,
  type PortableDatabaseStreamFragment as CorePortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest as CorePortableDatabaseStreamManifest,
  type PortableDatabaseStreamRecord,
} from "@risuai/backup-core/streamFormat";
import {
  DEFAULT_LOCAL_BACKUP_PERFORMANCE,
  LOCAL_BACKUP_PERFORMANCE_LIMITS,
} from "./localBackupPerformance";
import { PortableDatabaseStreamCollector } from "@risuai/backup-core/streamCollector";
import {
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamManifest,
} from "@risuai/backup-core/streamFormat";

export {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamManifest,
  portableDatabaseStreamFragmentName,
  PortableDatabaseStreamCollector,
};
export const PORTABLE_DATABASE_STREAM_PAGE_SIZE =
  DEFAULT_LOCAL_BACKUP_PERFORMANCE.databasePageRecords;
export const PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS =
  DEFAULT_LOCAL_BACKUP_PERFORMANCE.fragmentRecords;

export type PortableDatabaseStreamPersistedRecord =
  PortableDatabaseStreamRecord;
export type PortableDatabaseStreamFragment = CorePortableDatabaseStreamFragment;
export type PortableDatabaseStreamManifest = CorePortableDatabaseStreamManifest;

type PersistedRecord = PortableDatabaseStreamPersistedRecord;
type PersistedRecordType = PersistedRecord["type"];

export interface PortableDatabaseStreamProgress {
  stage: string;
  current: number;
  total: number;
}

export interface PortableDatabaseStreamExportHooks {
  writeFragment(fragment: PortableDatabaseStreamFragment): Promise<void>;
  writeColdStorage(key: string, value: unknown): Promise<void>;
  onRecord?(record: PersistedRecord): void;
  onProgress?(progress: PortableDatabaseStreamProgress): void;
}

function increment(
  counts: Partial<Record<PersistedRecordType, number>>,
  type: PersistedRecordType,
) {
  counts[type] = (counts[type] ?? 0) + 1;
}

function shallowCloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Streamed chat record data must be an object");
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Reuses the storage-sync iterator shared by every SQL backend. It performs
 * authoritative revision checks and pages branch messages; the backup layer
 * only groups those bounded records into small container entries.
 */
export async function exportPortableDatabaseStream(
  storage: ISqlStorage,
  hooks: PortableDatabaseStreamExportHooks,
  options: { pageSize?: number; fragmentRecords?: number } = {},
): Promise<PortableDatabaseStreamManifest> {
  if (!storage.isEnabled()) {
    const initialized = await storage.init();
    if (!initialized || !storage.isEnabled()) {
      throw new Error("Failed to initialize SQL storage for streaming backup");
    }
  }
  const summary = await storage.getStorageSyncSummary();
  if (!summary?.initialized) {
    throw new Error("Cannot stream an empty database backup");
  }

  let fragmentIndex = 0;
  let totalRecords = 0;
  let fragmentRecords: PersistedRecord[] = [];
  const pageSize = Math.max(
    1,
    Math.min(
      500,
      Math.round(options.pageSize ?? PORTABLE_DATABASE_STREAM_PAGE_SIZE),
    ),
  );
  const fragmentRecordLimit = Math.max(
    1,
    Math.min(
      PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
      Math.round(
        options.fragmentRecords ?? PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS,
      ),
    ),
  );
  const counts: Partial<Record<PersistedRecordType, number>> = {};
  const flush = async () => {
    if (fragmentRecords.length === 0) return;
    const fragment: PortableDatabaseStreamFragment = {
      format: "risu-portable-database-fragment",
      version: PORTABLE_DATABASE_STREAM_VERSION,
      index: ++fragmentIndex,
      records: fragmentRecords,
    };
    fragmentRecords = [];
    await hooks.writeFragment(fragment);
  };

  for await (const record of iterateStorageSyncSqlRecords(storage, {
    expectedRevision: summary.revision,
    pageSize,
  })) {
    if (record.type === "cold-storage") {
      await hooks.writeColdStorage(record.key, record.value);
      continue;
    }
    increment(counts, record.type);
    totalRecords++;
    hooks.onRecord?.(record);
    fragmentRecords.push(
      record.type === "chat"
        ? {
            ...record,
            // Runtime chat documents carry activeBranchId from SQL hydration,
            // but the backup format keeps branch fields only in the graph.
            // stripLegacyBranchFields mutates, so clone before normalizing.
            data: stripLegacyBranchFields(
              shallowCloneRecord(record.data) as Record<string, unknown>,
            ),
          }
        : record,
    );
    if (fragmentRecords.length >= fragmentRecordLimit) {
      await flush();
    }
    hooks.onProgress?.({
      stage: record.type,
      current: totalRecords,
      total: summary.records.total,
    });
  }
  await flush();

  return {
    format: "risu-portable-database-stream",
    version: PORTABLE_DATABASE_STREAM_VERSION,
    revision: summary.revision,
    totalFragments: fragmentIndex,
    totalRecords,
    counts,
    complete: true,
  };
}
