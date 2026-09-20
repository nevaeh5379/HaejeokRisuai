import type { LegacyBackupSqlRecord } from "./legacyRecords";

export const PORTABLE_DATABASE_STREAM_VERSION = 1 as const;
export const PORTABLE_DATABASE_STREAM_PREFIX = "database.stream/";
/**
 * Canonical upper bound of records per streamed fragment. Shared by the
 * export-side performance limits and the collector's fragment validation
 * so the two can never diverge.
 */
export const PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS = 256;
export const PORTABLE_DATABASE_STREAM_MANIFEST = `${PORTABLE_DATABASE_STREAM_PREFIX}manifest.risudat`;
const PORTABLE_DATABASE_STREAM_FRAGMENT_RE =
  /^database\.stream\/([0-9]{12})\.risudat$/;

export type PortableDatabaseStreamRecord = LegacyBackupSqlRecord;

export interface PortableDatabaseStreamFragment {
  format: "risu-portable-database-fragment";
  version: typeof PORTABLE_DATABASE_STREAM_VERSION;
  index: number;
  records: PortableDatabaseStreamRecord[];
}

export interface PortableDatabaseStreamManifest {
  format: "risu-portable-database-stream";
  version: typeof PORTABLE_DATABASE_STREAM_VERSION;
  revision: number;
  totalFragments: number;
  totalRecords: number;
  counts: Partial<Record<PortableDatabaseStreamRecord["type"], number>>;
  complete: true;
}

export function portableDatabaseStreamFragmentName(index: number): string {
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new TypeError("Portable database fragment index must be positive");
  }
  return `${PORTABLE_DATABASE_STREAM_PREFIX}${String(index).padStart(12, "0")}.risudat`;
}

export function parsePortableDatabaseStreamFragmentName(
  name: string,
): number | null {
  const match = PORTABLE_DATABASE_STREAM_FRAGMENT_RE.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

/**
 * Pure shape validation for a decoded streaming database manifest. Returns
 * null when the payload is not a manifest; callers keep their own error
 * messaging. Sequencing, duplicates, and aggregate counts are verified by
 * the consumers (collector, restore validators, import preparation).
 */
export function parsePortableDatabaseStreamManifest(
  data: unknown,
): PortableDatabaseStreamManifest | null {
  if (!data || typeof data !== "object") return null;
  const manifest: Partial<PortableDatabaseStreamManifest> =
    data as Partial<PortableDatabaseStreamManifest>;
  if (
    manifest.format !== "risu-portable-database-stream" ||
    manifest.version !== PORTABLE_DATABASE_STREAM_VERSION ||
    manifest.complete !== true ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Number.isSafeInteger(manifest.totalFragments) ||
    manifest.totalFragments <= 0 ||
    !Number.isSafeInteger(manifest.totalRecords) ||
    manifest.totalRecords <= 0 ||
    !manifest.counts ||
    typeof manifest.counts !== "object"
  ) {
    return null;
  }
  return data as PortableDatabaseStreamManifest;
}

/**
 * Pure shape validation for a decoded streaming database fragment. Returns
 * null when the payload is not a fragment; when `options.expectedIndex` is
 * provided the fragment index must match it. Callers keep their own error
 * messaging and sequencing state (duplicate and aggregate checks).
 */
/** Options for parsePortableDatabaseStreamFragment. */
export interface ParsePortableDatabaseStreamFragmentOptions {
  /** When provided, the fragment index must equal this value. */
  expectedIndex?: number;
}

export function parsePortableDatabaseStreamFragment(
  data: unknown,
  options: ParsePortableDatabaseStreamFragmentOptions = {},
): PortableDatabaseStreamFragment | null {
  if (!data || typeof data !== "object") return null;
  const fragment: Partial<PortableDatabaseStreamFragment> =
    data as Partial<PortableDatabaseStreamFragment>;
  if (
    fragment.format !== "risu-portable-database-fragment" ||
    fragment.version !== PORTABLE_DATABASE_STREAM_VERSION ||
    !Number.isSafeInteger(fragment.index) ||
    fragment.index <= 0 ||
    (options.expectedIndex !== undefined &&
      fragment.index !== options.expectedIndex) ||
    !Array.isArray(fragment.records) ||
    fragment.records.length === 0 ||
    fragment.records.length > PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS
  ) {
    return null;
  }
  return data as PortableDatabaseStreamFragment;
}
