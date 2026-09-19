export const COLD_STORAGE_HEADER = "\uEF01COLDSTORAGE\uEF01";
export const COLD_STORAGE_BACKUP_RE =
  /^(?:coldstorage[\\/_])?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/;

export function getColdStorageBackupName(key: string): string {
  return `coldstorage_${key}.json`;
}

export function getColdStorageBackupKey(name: string): string | null {
  const normalized = String(name).replace(/\\\\/g, "/");
  return COLD_STORAGE_BACKUP_RE.exec(normalized)?.[1] ?? null;
}

export function isColdStorageBackupData(data: unknown): boolean {
  if (Array.isArray(data)) return true;
  return (
    !!data &&
    typeof data === "object" &&
    ("character" in data || "message" in data)
  );
}
