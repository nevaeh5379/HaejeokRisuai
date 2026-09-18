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

const COLD_STORAGE_RE =
  /^(?:coldstorage[\/_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;
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
  if (normalized === "database.risudat")
    return { kind: "database", normalized };
  if (
    normalized === "database.stream/manifest.risudat" ||
    /^database\.stream\/[0-9]{12}\.risudat$/.test(normalized)
  )
    return { kind: "databaseStream", normalized };
  if (normalized === "encryption.risudat")
    return { kind: "encryption", normalized };
  if (COLD_STORAGE_RE.test(normalized))
    return { kind: "coldStorage", normalized };
  if (INLAY_RE.test(normalized)) return { kind: "inlay", normalized };
  if (normalized.startsWith("assets/")) return { kind: "asset", normalized };
  if (!normalized.includes("/")) return { kind: "asset", normalized };
  return { kind: "extension", normalized };
}

function getColdStorageBackupKey(name: string): string | null {
  const normalized = normalizeBackupEntryName(name);
  if (!normalized) return null;
  const match = normalized.match(
    /^(?:coldstorage[\/_])?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/,
  );
  return match?.[1] ?? null;
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
