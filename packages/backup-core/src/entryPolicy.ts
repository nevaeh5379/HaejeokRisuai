import { COLD_STORAGE_BACKUP_RE, getColdStorageBackupKey } from "./coldStorage";
import {
  parsePortableDatabaseStreamFragmentName,
  PORTABLE_DATABASE_STREAM_MANIFEST,
} from "./streamFormat";

export type BackupEntryKind =
  | "database"
  | "databaseStream"
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

export const LEGACY_DATABASE_ENTRY_NAME = "database.risudat";
export const ACCOUNT_ENCRYPTION_ENTRY_NAME = "encryption.risudat";
export const INLAY_BACKUP_PREFIX = "inlay_";
export const INLAY_BACKUP_SUFFIX = ".risuinlay";

const COLD_STORAGE_RE = COLD_STORAGE_BACKUP_RE;
const INLAY_RE =
  /^inlay_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.risuinlay$/;

function normalizeBackupEntryName(name: string): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return null;
  return normalized;
}

function classifyExactBackupEntry(normalized: string): BackupEntryKind | null {
  switch (normalized) {
    case LEGACY_DATABASE_ENTRY_NAME:
      return "database"
    case PORTABLE_DATABASE_STREAM_MANIFEST:
      return "databaseStream"
    case ACCOUNT_ENCRYPTION_ENTRY_NAME:
      return "encryption"
    default: return null;
  }
}

function classifyPatternBackupEntry(normalized: string): BackupEntryKind {
  if (parsePortableDatabaseStreamFragmentName(normalized) !== null)
    return "databaseStream"

  if (COLD_STORAGE_RE.test(normalized))
    return "coldStorage"

  if (INLAY_RE.test(normalized))
    return "inlay"

  if (normalized.startsWith("assets/") || !normalized.includes("/"))
    return "asset"

  return "extension"
}
function classifyBackupEntry(name: string): BackupEntryClassification {
  const normalized: string | null = normalizeBackupEntryName(name);
  if (!normalized) return { kind: "invalid" satisfies BackupEntryKind, normalized: null };

  const kind: BackupEntryKind = classifyExactBackupEntry(normalized) ?? classifyPatternBackupEntry(normalized)

  return {
    kind: kind,
    normalized: normalized
  } 
}

function normalizeBackupAssetPath(name: string): string {
  const normalizedName = name.replace(/\\/g, "/");
  const segments = normalizedName.split("/");

  while (segments[0] === "assets") {
    segments.shift();
  }

  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid backup asset path: ${name}`);
  }

  return `assets/${segments.join("/")}`;
}

function getInlayBackupName(id: string): string {
  return `${INLAY_BACKUP_PREFIX}${id}${INLAY_BACKUP_SUFFIX}`;
}

function getInlayBackupKey(name: string): string | null {
  const normalized = normalizeBackupEntryName(name);
  if (!normalized) return null;
  return INLAY_RE.exec(normalized)?.[1] ?? null;
}

export {
  COLD_STORAGE_RE,
  INLAY_RE,
  normalizeBackupEntryName,
  classifyBackupEntry,
  getColdStorageBackupKey,
  normalizeBackupAssetPath,
  getInlayBackupName,
  getInlayBackupKey,
};
