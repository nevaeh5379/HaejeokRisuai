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

/** A classification rule: either classifies a normalized name or defers. */
type EntryRule = (normalized: string) => BackupEntryClassification | null;
type ExactRuleFactory = (normalized: string) => BackupEntryClassification;

/**
 * Reserved entry names classified by exact normalized lookup. A Map keeps
 * entry names like `constructor` or `toString` out of the lookup chain.
 */
const EXACT_ENTRY_RULES: ReadonlyMap<string, ExactRuleFactory> = new Map<
  string,
  ExactRuleFactory
>([
  [
    LEGACY_DATABASE_ENTRY_NAME,
    (normalized) => ({ kind: "database", normalized }),
  ],
  [
    PORTABLE_DATABASE_STREAM_MANIFEST,
    (normalized) => ({
      kind: "databaseStream",
      normalized,
      stream: { type: "manifest" },
    }),
  ],
  [
    ACCOUNT_ENCRYPTION_ENTRY_NAME,
    (normalized) => ({ kind: "encryption", normalized }),
  ],
]);

/** Builds a rule that classifies regex-matching names by their captured key. */
const keyPatternRule =
  (
    regex: RegExp,
    classify: (normalized: string, key: string) => BackupEntryClassification,
  ): EntryRule =>
  (normalized) => {
    const key = regex.exec(normalized)?.[1];
    return key ? classify(normalized, key) : null;
  };

const assetRule = (normalized: string): BackupEntryClassification => ({
  kind: "asset",
  normalized,
  assetPath: normalizeBackupAssetPath(normalized),
});

/**
 * Ordered pattern rules; the first non-null result wins. Precedence:
 * numbered stream fragments, cold storage, inlays, assets. The trailing
 * extension fallback lives in classifyBackupEntry, not in this table.
 */
const PATTERN_ENTRY_RULES: readonly EntryRule[] = [
  (normalized) => {
    const index = parsePortableDatabaseStreamFragmentName(normalized);
    return index === null
      ? null
      : {
          kind: "databaseStream",
          normalized,
          stream: { type: "fragment", index },
        };
  },
  keyPatternRule(COLD_STORAGE_BACKUP_RE, (normalized, key) => ({
    kind: "coldStorage",
    normalized,
    key,
  })),
  keyPatternRule(INLAY_RE, (normalized, key) => ({
    kind: "inlay",
    normalized,
    key,
  })),
  (normalized) =>
    normalized.startsWith("assets/") || !normalized.includes("/")
      ? assetRule(normalized)
      : null,
];

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

  const exactRule = EXACT_ENTRY_RULES.get(normalized);
  if (exactRule) return exactRule(normalized);

  for (const patternRule of PATTERN_ENTRY_RULES) {
    const result = patternRule(normalized);
    if (result) return result;
  }
  return { kind: "extension", normalized };
}

export { COLD_STORAGE_BACKUP_RE as COLD_STORAGE_RE } from "./coldStorage";
export { getColdStorageBackupKey } from "./coldStorage";
export { normalizeBackupAssetPath, getInlayBackupName, getInlayBackupKey };
