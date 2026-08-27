export type BackupEntryKind =
  | "database"
  | "encryption"
  | "coldStorage"
  | "asset"
  | "extension"
  | "invalid";

export interface BackupEntryClassification {
  kind: BackupEntryKind;
  normalized: string | null;
}

export const COLD_STORAGE_RE: RegExp;
export function normalizeBackupEntryName(name: string): string | null;
export function classifyBackupEntry(name: string): BackupEntryClassification;
