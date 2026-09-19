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

const COLD_STORAGE_RE = COLD_STORAGE_BACKUP_RE;
const INLAY_RE =
  /^inlay_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.risuinlay$/;

function normalizeBackupEntryName(name: string): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.replace(/\\/g, "/");
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

function classifyBackupEntry(name: string): BackupEntryClassification {
  const normalized = normalizeBackupEntryName(name);
  if (!normalized) return { kind: "invalid", normalized: null };
  if (normalized === LEGACY_DATABASE_ENTRY_NAME)
    return { kind: "database", normalized };
  if (
    normalized === PORTABLE_DATABASE_STREAM_MANIFEST ||
    parsePortableDatabaseStreamFragmentName(normalized) !== null
  )
    return { kind: "databaseStream", normalized };
  if (normalized === ACCOUNT_ENCRYPTION_ENTRY_NAME)
    return { kind: "encryption", normalized };
  if (COLD_STORAGE_RE.test(normalized))
    return { kind: "coldStorage", normalized };
  if (INLAY_RE.test(normalized)) return { kind: "inlay", normalized };
  if (normalized.startsWith("assets/")) return { kind: "asset", normalized };
  if (!normalized.includes("/")) return { kind: "asset", normalized };
  return { kind: "extension", normalized };
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
  getInlayBackupKey,
};
