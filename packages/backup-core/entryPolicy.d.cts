export type BackupEntryKind =
  | "database"
  | "encryption"
  | "coldStorage"
  | "inlay"
  | "asset"
  | "extension"
  | "invalid";

export interface BackupEntryClassification {
  kind: BackupEntryKind;
  normalized: string | null;
}

export const COLD_STORAGE_RE: RegExp;
export const INLAY_RE: RegExp;
export function normalizeBackupEntryName(name: string): string | null;
export function classifyBackupEntry(name: string): BackupEntryClassification;
export function getInlayBackupKey(name: string): string | null;
