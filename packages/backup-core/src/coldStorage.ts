export const COLD_STORAGE_HEADER = "\uEF01COLDSTORAGE\uEF01";

export function isColdStorageBackupData(data: unknown): boolean {
  if (Array.isArray(data)) return true;
  return (
    !!data &&
    typeof data === "object" &&
    ("character" in data || "message" in data)
  );
}
