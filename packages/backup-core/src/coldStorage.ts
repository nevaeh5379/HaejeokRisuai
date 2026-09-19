export const COLD_STORAGE_HEADER = "\uEF01COLDSTORAGE\uEF01";

export function getColdStorageBackupName(key: string): string {
  return `coldstorage_${key}.json`;
}

export function isColdStorageBackupData(data: unknown): boolean {
  if (Array.isArray(data)) return true;
  return (
    !!data &&
    typeof data === "object" &&
    ("character" in data || "message" in data)
  );
}
