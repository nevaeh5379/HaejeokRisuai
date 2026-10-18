import type { LegacyBackupSqlRecord } from "../legacyRecords.ts";

export const PREFIX = "database.stream/";
export const MAX_FRAGMENT_RECORDS = 256;
export const MANIFEST_NAME = `${PREFIX}manifest.risudat`;
export const DB_STREAM_VERSION = "1.1" as const;

export type BackupRecord = LegacyBackupSqlRecord;

export interface LegacyFragment {
  format: "risu-portable-database-fragment";
  version: 1;
  index: number;
  records: BackupRecord[];
}

export interface LegacyManifest {
  format: "risu-portable-database-stream";
  version: 1;
  complete: true;
  revision: number;
  totalFragments: number;
  totalRecords: number;
  counts: Manifest["counts"];
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
  version: typeof DB_STREAM_VERSION;
}

export interface ReadFragmentOptions {
  expectedIndex?: number;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const supportedRecordTypes: readonly BackupRecord["type"][] = [
  "meta",
  "author-note",
  "author-note-settings",
  "setting",
  "plugin-storage",
  "plugin",
  "module",
  "preset",
  "character",
  "chat",
  "branch",
  "active-branch",
  "message",
];

function validCounts(value: unknown): value is Manifest["counts"] {
  if (!object(value)) return false;
  for (const [type, count] of Object.entries(value)) {
    if (!nonNegativeInteger(count)) return false;
    if (
      !supportedRecordTypes.includes(type as BackupRecord["type"]) &&
      count !== 0
    )
      return false;
  }
  return true;
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
    if (!object(value)) return null;
    const batch = value;
    if (batch.format === "haejeok-stream-fragment") {
      // Version 1.1 belongs to the manifest; fragments carry no version field.
      if ("version" in batch) return null;
    } else if (batch.format === "risu-portable-database-fragment") {
      if (batch.version !== 1) return null;
    } else {
      return null;
    }
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
    // Normalize legacy envelopes without duplicating the bounded record array.
    return Fragment.create(batch.index, batch.records);
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
      version: DB_STREAM_VERSION,
    };
  },

  /** Restore consumers reconcile the summary with received records. */
  read(value: unknown): Manifest | null {
    if (!object(value)) return null;
    const summary = value;
    if (summary.format === "haejeok-stream-manifest") {
      if (summary.version !== DB_STREAM_VERSION) return null;
      if ("complete" in summary && summary.complete !== true) return null;
    } else if (summary.format === "risu-portable-database-stream") {
      if (summary.version !== 1 || summary.complete !== true) return null;
    } else {
      return null;
    }
    if (!nonNegativeInteger(summary.revision)) return null;
    if (
      !positiveInteger(summary.totalFragments) ||
      !positiveInteger(summary.totalRecords)
    )
      return null;
    if (!validCounts(summary.counts)) return null;
    return Manifest.create({
      revision: summary.revision,
      totalFragments: summary.totalFragments,
      totalRecords: summary.totalRecords,
      counts: summary.counts,
    });
  },
};
