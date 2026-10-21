import {
  COLD_STORAGE_BACKUP_RE,
  getColdStorageBackupKey,
} from "./coldStorage.ts";
import { Fragment, MANIFEST_NAME } from "./stream/databaseBackup.ts";

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
  if (typeof name !== "string" || name.length === 0) return null;
  const normalized = name.includes("\\") ? name.replaceAll("\\", "/") : name;
  const segments = normalized.split("/");
  if (segments.length === 0) return null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") {
      return null;
    }
  }
  return normalized;
}

function classifyExactBackupEntry(normalized: string): BackupEntryKind | null {
  switch (normalized) {
    case LEGACY_DATABASE_ENTRY_NAME:
      return "database";
    case MANIFEST_NAME:
      return "databaseStream";
    case ACCOUNT_ENCRYPTION_ENTRY_NAME:
      return "encryption";
    default:
      return null;
  }
}

function classifyPatternBackupEntry(normalized: string): BackupEntryKind {
  if (Fragment.parseName(normalized) !== null) return "databaseStream";
  if (COLD_STORAGE_RE.test(normalized)) return "coldStorage";
  if (INLAY_RE.test(normalized)) return "inlay";
  if (normalized.startsWith("assets/") || !normalized.includes("/"))
    return "asset";
  return "extension";
}

/**
 * Classifies a backup container entry name. Invalid names get
 * `kind: "invalid"` with a null normalized value; cold-storage, inlay, and
 * asset restore targets are resolved from the entry name on demand via
 * getColdStorageBackupKey, getInlayBackupKey, and normalizeBackupAssetPath.
 */
export function classifyBackupEntry(name: string): BackupEntryClassification {
  const normalized: string | null = normalizeBackupEntryName(name);
  if (!normalized) return { kind: "invalid", normalized: null };
  const kind: BackupEntryKind =
    classifyExactBackupEntry(normalized) ??
    classifyPatternBackupEntry(normalized);
  return { kind, normalized };
}

function normalizeBackupAssetPath(name: string): string {
  const normalizedName = name.includes("\\") ? name.replace(/\\/g, "/") : name;
  const segments = normalizedName.split("/");

  let startIndex = 0;
  while (startIndex < segments.length && segments[startIndex] === "assets") {
    startIndex++;
  }

  if (startIndex >= segments.length) {
    throw new Error(`Invalid backup asset path: ${name}`);
  }

  for (let i = startIndex; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid backup asset path: ${name}`);
    }
  }

  return startIndex === 0
    ? `assets/${segments.join("/")}`
    : `assets/${segments.slice(startIndex).join("/")}`;
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
  getColdStorageBackupKey,
  normalizeBackupAssetPath,
  getInlayBackupName,
  getInlayBackupKey,
};
