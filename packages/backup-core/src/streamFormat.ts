import type { LegacyBackupSqlRecord } from "./legacyRecords";

export const PORTABLE_DATABASE_STREAM_VERSION = 1 as const;
export const PORTABLE_DATABASE_STREAM_PREFIX = "database.stream/";
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
