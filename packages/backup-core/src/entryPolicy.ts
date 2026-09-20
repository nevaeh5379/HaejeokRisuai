import { COLD_STORAGE_BACKUP_RE } from "./coldStorage";
import {
  parsePortableDatabaseStreamFragmentName,
  PORTABLE_DATABASE_STREAM_MANIFEST,
} from "./streamFormat";

export const LEGACY_DATABASE_ENTRY_NAME = "database.risudat";
export const ACCOUNT_ENCRYPTION_ENTRY_NAME = "encryption.risudat";
export const INLAY_BACKUP_PREFIX = "inlay_";
export const INLAY_BACKUP_SUFFIX = ".risuinlay";

const INLAY_RE =
  /^inlay_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.risuinlay$/;

/**
 * Typed restore-target classification for a container entry. The name is
 * normalized exactly once; every variant carries the kind-specific metadata
 * needed to apply the entry without re-resolving keys or paths.
 */
export type BackupEntryClassification =
  | { kind: "database"; normalized: string }
  | {
      kind: "databaseStream";
      normalized: string;
      /** Manifest versus a numbered fragment, with its 1-based index. */
      stream: { type: "manifest" } | { type: "fragment"; index: number };
    }
  | { kind: "encryption"; normalized: string }
  | { kind: "coldStorage"; normalized: string; key: string }
  | { kind: "inlay"; normalized: string; key: string }
  | {
      kind: "asset";
      normalized: string;
      /** Canonical storage path, e.g. `assets/folder/image.png`. */
      assetPath: string;
    }
  | { kind: "extension"; normalized: string }
  | { kind: "invalid"; normalized: null };

export type BackupEntryKind = BackupEntryClassification["kind"];

export function normalizeBackupEntryName(name: string): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return normalized;
}

type ExactBackupEntryKind =
  | { kind: "database" }
  | { kind: "databaseStream"; stream: { type: "manifest" } }
  | { kind: "encryption" };

function classifyExactBackupEntry(
  normalized: string,
): ExactBackupEntryKind | null {
  switch (normalized) {
    case LEGACY_DATABASE_ENTRY_NAME:
      return { kind: "database" };
    case PORTABLE_DATABASE_STREAM_MANIFEST:
      return { kind: "databaseStream", stream: { type: "manifest" } };
    case ACCOUNT_ENCRYPTION_ENTRY_NAME:
      return { kind: "encryption" };
    default:
      return null;
  }
}

function classifyPatternBackupEntry(
  normalized: string,
): BackupEntryClassification {
  const fragmentIndex = parsePortableDatabaseStreamFragmentName(normalized);
  if (fragmentIndex !== null) {
    return {
      kind: "databaseStream",
      normalized,
      stream: { type: "fragment", index: fragmentIndex },
    };
  }

  const coldStorageKey = COLD_STORAGE_BACKUP_RE.exec(normalized)?.[1];
  if (coldStorageKey) {
    return { kind: "coldStorage", normalized, key: coldStorageKey };
  }

  const inlayKey = INLAY_RE.exec(normalized)?.[1];
  if (inlayKey) {
    return { kind: "inlay", normalized, key: inlayKey };
  }

  if (normalized.startsWith("assets/") || !normalized.includes("/")) {
    return {
      kind: "asset",
      normalized,
      assetPath: normalizeBackupAssetPath(normalized),
    };
  }

  return { kind: "extension", normalized };
}

/**
 * Classifies a backup container entry once, resolving every kind-specific
 * restore target (stream type/index, cold-storage key, inlay key, canonical
 * asset storage path) from a single normalization pass. Invalid names get
 * `kind: "invalid"` with a `null` normalized value; asset names whose
 * resolved path is unsafe throw, exactly like `normalizeBackupAssetPath`.
 */
export function classifyBackupEntry(name: string): BackupEntryClassification {
  const normalized = normalizeBackupEntryName(name);
  if (normalized === null) {
    return { kind: "invalid", normalized: null };
  }

  const exact = classifyExactBackupEntry(normalized);
  if (exact) {
    return { ...exact, normalized } as BackupEntryClassification;
  }

  return classifyPatternBackupEntry(normalized);
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

export { COLD_STORAGE_BACKUP_RE as COLD_STORAGE_RE } from "./coldStorage";
export { getColdStorageBackupKey } from "./coldStorage";
export { normalizeBackupAssetPath, getInlayBackupName, getInlayBackupKey };
