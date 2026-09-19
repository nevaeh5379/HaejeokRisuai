import {
  parsePortableDatabaseStreamFragmentName,
  PORTABLE_DATABASE_STREAM_MANIFEST,
} from "../streamFormat";
import type {
  StagedBackupContainer,
  StagedBackupEntry,
} from "./importStagingStore";

export type BackupImportDatabaseMode = "legacy" | "stream";

export interface BackupImportPlan {
  databaseMode: BackupImportDatabaseMode;
  legacyDatabase?: StagedBackupEntry;
  streamFragments: StagedBackupEntry[];
  streamManifest?: StagedBackupEntry;
  coldStorage: StagedBackupEntry[];
  assets: StagedBackupEntry[];
  inlays: StagedBackupEntry[];
  ignoredExtensionEntries: number;
  bytesRead: number;
}

export class BackupImportPlanError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_database"
      | "mixed_database_formats"
      | "duplicate_entry"
      | "missing_stream_manifest"
      | "duplicate_stream_manifest"
      | "invalid_stream_fragment_order" = "missing_database",
  ) {
    super(message);
    this.name = "BackupImportPlanError";
  }
}

export function buildBackupImportPlan(
  staged: StagedBackupContainer,
): BackupImportPlan {
  const names = new Set<string>();
  const legacy: StagedBackupEntry[] = [];
  const fragments: Array<{ index: number; entry: StagedBackupEntry }> = [];
  const manifests: StagedBackupEntry[] = [];
  const coldStorage: StagedBackupEntry[] = [];
  const assets: StagedBackupEntry[] = [];
  const inlays: StagedBackupEntry[] = [];

  for (const entry of staged.entries) {
    if (names.has(entry.name)) {
      throw new BackupImportPlanError(
        `Backup contains duplicate entry '${entry.name}'`,
        "duplicate_entry",
      );
    }
    names.add(entry.name);

    switch (entry.kind) {
      case "database":
        legacy.push(entry);
        break;
      case "databaseStream": {
        if (entry.name === PORTABLE_DATABASE_STREAM_MANIFEST) {
          manifests.push(entry);
          break;
        }
        const index = parsePortableDatabaseStreamFragmentName(entry.name);
        if (index === null) {
          throw new BackupImportPlanError(
            `Invalid database stream fragment '${entry.name}'`,
            "invalid_stream_fragment_order",
          );
        }
        fragments.push({ index, entry });
        break;
      }
      case "coldStorage":
        coldStorage.push(entry);
        break;
      case "asset":
        assets.push(entry);
        break;
      case "inlay":
        inlays.push(entry);
        break;
    }
  }

  if (legacy.length > 1) {
    throw new BackupImportPlanError(
      "Backup contains more than one legacy database entry",
      "duplicate_entry",
    );
  }
  if (legacy.length > 0 && (fragments.length > 0 || manifests.length > 0)) {
    throw new BackupImportPlanError(
      "Backup mixes legacy and streaming database formats",
      "mixed_database_formats",
    );
  }
  if (legacy.length === 0 && fragments.length === 0 && manifests.length === 0) {
    throw new BackupImportPlanError(
      "Backup does not contain a database entry",
      "missing_database",
    );
  }

  if (legacy.length > 0) {
    return {
      databaseMode: "legacy",
      legacyDatabase: legacy[0],
      streamFragments: [],
      coldStorage,
      assets,
      inlays,
      ignoredExtensionEntries: staged.ignoredExtensionEntries,
      bytesRead: staged.bytesRead,
    };
  }

  if (manifests.length === 0) {
    throw new BackupImportPlanError(
      "Streaming backup manifest is missing",
      "missing_stream_manifest",
    );
  }
  if (manifests.length > 1) {
    throw new BackupImportPlanError(
      "Backup contains more than one streaming manifest",
      "duplicate_stream_manifest",
    );
  }

  fragments.sort((a, b) => a.index - b.index);
  for (let position = 0; position < fragments.length; position++) {
    const expected = position + 1;
    if (fragments[position].index !== expected) {
      throw new BackupImportPlanError(
        `Streaming backup fragment order is incomplete; expected ${expected}, got ${fragments[position].index}`,
        "invalid_stream_fragment_order",
      );
    }
  }

  return {
    databaseMode: "stream",
    streamFragments: fragments.map(({ entry }) => entry),
    streamManifest: manifests[0],
    coldStorage,
    assets,
    inlays,
    ignoredExtensionEntries: staged.ignoredExtensionEntries,
    bytesRead: staged.bytesRead,
  };
}
