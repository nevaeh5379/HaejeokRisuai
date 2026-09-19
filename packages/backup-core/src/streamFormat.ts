export const PORTABLE_DATABASE_STREAM_VERSION = 1 as const;
export const PORTABLE_DATABASE_STREAM_PREFIX = "database.stream/";
export const PORTABLE_DATABASE_STREAM_MANIFEST = `${PORTABLE_DATABASE_STREAM_PREFIX}manifest.risudat`;

export function portableDatabaseStreamFragmentName(index: number): string {
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new TypeError("Portable database fragment index must be positive");
  }
  return `${PORTABLE_DATABASE_STREAM_PREFIX}${String(index).padStart(12, "0")}.risudat`;
}
