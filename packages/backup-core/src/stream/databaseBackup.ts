import type { LegacyBackupSqlRecord } from "../legacyRecords.ts";

export const PREFIX = "database.stream/";
export const MAX_FRAGMENT_RECORDS = 256;
export const MANIFEST_NAME = `${PREFIX}manifest.risudat`;
export const DB_STREAM_VERSION: dbStreamVersion = "1.1";
type dbStreamVersion = "1.1"

export type BackupRecord = LegacyBackupSqlRecord;


export interface OldFragment {
  format: "risu-portable-database-fragment";
  index: number;
  records: BackupRecord[];
}

/** A bounded batch of records, not a complete database snapshot. */
export interface Fragment {
  format: "haejeok-stream-fragment";
  index: number;
  records: BackupRecord[];
}

/** The summary written after all database record batches. */
export interface Manifest {
  format: "haejeok-stream-manifest";
  revision: number;
  totalFragments: number;
  totalRecords: number;
  counts: Partial<Record<BackupRecord["type"], number>>;
  version: dbStreamVersion;
}

export interface ReadFragmentOptions {
  expectedIndex?: number;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export const Fragment = {
  name(index: number): string {
    if (!positiveInteger(index)) {
      throw new TypeError("Database backup fragment index must be positive");
    }
    return `${PREFIX}${String(index).padStart(12, "0")}.risudat`;
  },

  parseName(name: string): number | null {
    const match = /^database\.stream\/([0-9]{12})\.risudat$/.exec(name);
    if (!match) return null;
    const index = Number(match[1]);
    return positiveInteger(index) ? index : null;
  },

  /** Builds the envelope without copying record payloads. */
  create(index: number, records: BackupRecord[]): Fragment {
    if (!positiveInteger(index)) {
      throw new TypeError("Database backup fragment index must be positive");
    }
    if (records.length === 0 || records.length > MAX_FRAGMENT_RECORDS) {
      throw new TypeError("Database backup fragment record count is invalid");
    }
    return { format: "haejeok-stream-fragment", index, records };
  },

  /** Restore consumers validate individual records and sequencing. */
  read(
    value: unknown,
    { expectedIndex }: ReadFragmentOptions = {},
  ): Fragment | null {
    if (!value || typeof value !== "object") return null;
    const batch = value as Partial<Fragment>;
    if (batch.format !== "haejeok-stream-fragment"
      && String(batch.format) !== "risu-portable-database-fragment"

    ) return null;
    if (
      !positiveInteger(batch.index) ||
      (expectedIndex !== undefined && batch.index !== expectedIndex)
    )
      return null;
    if (
      !Array.isArray(batch.records) ||
      batch.records.length === 0 ||
      batch.records.length > MAX_FRAGMENT_RECORDS
    )
      return null;
    return value as Fragment;
  },
};

export const Manifest = {
  name: MANIFEST_NAME,

  create(
    summary: Pick<
      Manifest,
      "revision" | "totalFragments" | "totalRecords" | "counts"
    >,
  ): Manifest {
    return {
      format: "haejeok-stream-manifest",
      revision: summary.revision,
      totalFragments: summary.totalFragments,
      totalRecords: summary.totalRecords,
      counts: summary.counts,
      version: DB_STREAM_VERSION
    };
  },

  /** Restore consumers reconcile the summary with received records. */
  read(value: unknown): Manifest | null {
    if (!value || typeof value !== "object") return null;
    const summary = value as Partial<Manifest>;
    if (
      summary.format !== "haejeok-stream-manifest"
      && String(summary.format) !== "risu-portable-database-stream"
    )
      return null;
    if (!Number.isSafeInteger(summary.revision) || summary.revision < 0)
      return null;
    if (
      !positiveInteger(summary.totalFragments) ||
      !positiveInteger(summary.totalRecords)
    )
      return null;
    if (!summary.counts || typeof summary.counts !== "object") return null;
    return value as Manifest;
  },
};
