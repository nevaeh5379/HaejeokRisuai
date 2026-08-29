import type { Database } from "./schema";
import { normalizeDatabaseDefaults } from "./databaseDefaults";
import { decodeRisuSave } from "../backup/risuSave";
import type { ISqlStorage } from "../sql/ISqlStorage";
import { isTauri } from "../../platform";
import { forageStorage } from "../../globalApi.svelte";

/**
 * Checks for a legacy database.bin in local storage and offers migration
 * to the SQL backend. This is the *only* place that reads database.bin —
 * the rest of the app is SQL-only.
 *
 * Returns the migrated Database (if migration happened) or null.
 */
export interface LegacyDatabaseStats {
  characterCount: number;
  chatCount: number;
  presetCount: number;
  moduleCount: number;
  username?: string;
}

export interface LegacyDatabaseInfo {
  source: 'local_file' | 'opfs' | 'uploaded';
  path?: string;
  size?: number;
  db: Database;
  stats: LegacyDatabaseStats;
}

export function extractDatabaseStats(legacyDb: Database): LegacyDatabaseStats {
  const characters = legacyDb.characters ?? [];
  let chatCount = 0;
  for (const c of characters) {
    chatCount += c.chats?.length ?? 0;
  }
  return {
    characterCount: characters.length,
    chatCount,
    presetCount: (legacyDb as any).botPresets?.length ?? 0,
    moduleCount: (legacyDb as any).modules?.length ?? 0,
    username: legacyDb.username,
  };
}

/**
 * Checks for a legacy database.bin in local storage and returns its info if found.
 */
export async function detectLocalLegacyDatabase(): Promise<LegacyDatabaseInfo | null> {
  let legacyBytes: Uint8Array | null = null;
  let detectedPath: string | undefined = undefined;
  let source: 'local_file' | 'opfs' = 'opfs';

  try {
    if (isTauri) {
      source = 'local_file';
      const { exists } = await import("@tauri-apps/plugin-fs");
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const appDir = await appDataDir();

      const candidatePaths = [
        await join(appDir, "database/database.bin"),
        await join(appDir, "save/database/database.bin"),
        await join(appDir, "save/database.bin"),
      ];

      for (const p of candidatePaths) {
        if (await exists(p)) {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          const response = await fetch(convertFileSrc(p));
          if (response.ok) {
            legacyBytes = new Uint8Array(await response.arrayBuffer());
            detectedPath = p;
            break;
          }
        }
      }
    } else {
      source = 'opfs';
      const candidates = [
        "database/database.bin",
        "save/database/database.bin",
        "save/database.bin",
      ];
      for (const key of candidates) {
        const item = (await forageStorage.getItem(key)) as unknown as Uint8Array | null;
        if (item && item.length > 0) {
          legacyBytes = item;
          detectedPath = key;
          break;
        }
      }
    }
  } catch (error) {
    console.error("Local legacy database detection failed:", error);
  }

  if (!legacyBytes || legacyBytes.length === 0) {
    return null;
  }

  return parseLegacyDatabaseBytes(legacyBytes, source, detectedPath);
}

/**
 * Parses raw bytes into a LegacyDatabaseInfo.
 */
export async function parseLegacyDatabaseBytes(
  bytes: Uint8Array,
  source: 'local_file' | 'opfs' | 'uploaded' = 'uploaded',
  path?: string,
): Promise<LegacyDatabaseInfo | null> {
  try {
    const legacyDb: Database = await decodeRisuSave(bytes);
    if (!legacyDb) return null;

    const stats = extractDatabaseStats(legacyDb);
    return {
      source,
      path,
      size: bytes.byteLength,
      db: legacyDb,
      stats,
    };
  } catch (error) {
    console.error("Failed to parse legacy database bytes:", error);
    return null;
  }
}

/**
 * Checks for a legacy database.bin in local storage and offers migration
 * to the SQL backend. This is called during bootstrap if SQL DB is empty.
 */
export async function checkAndMigrateLegacyDatabase(
  storage: ISqlStorage,
): Promise<Database | null> {
  const info = await detectLocalLegacyDatabase();
  if (!info || info.stats.characterCount === 0) {
    return null;
  }
  return info.db;
}

/**
 * Performs the full migration: replaces the SQL database with the legacy
 * data and marks the legacy file as migrated.
 */
export async function migrateLegacyDatabase(
  storage: ISqlStorage,
  legacyDb: Database,
  onProgress?: (status: string) => void,
  markMigrated = true,
): Promise<boolean> {
  try {
    onProgress?.("Migrating data to SQL storage...");
    normalizeDatabaseDefaults(legacyDb);
    legacyDb.pluginCustomStorage ??= {};
    const replaced = await storage.replaceDatabase(legacyDb, onProgress);
    if (!replaced) {
      throw new Error("SQL storage rejected the migrated database");
    }
    onProgress?.("Migration complete");

    if (markMigrated) {
      await markLegacyAsMigrated();
    }

    return true;
  } catch (error) {
    console.error("Legacy migration failed:", error);
    return false;
  }
}

export async function markLegacyAsMigrated(): Promise<void> {
  try {
    if (isTauri) {
      const { rename, exists } = await import("@tauri-apps/plugin-fs");
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const appDir = await appDataDir();
      const candidatePaths = [
        await join(appDir, "database/database.bin"),
        await join(appDir, "save/database/database.bin"),
        await join(appDir, "save/database.bin"),
      ];
      for (const dbPath of candidatePaths) {
        if (await exists(dbPath)) {
          await rename(dbPath, `${dbPath}.migrated`);
        }
      }
    } else {
      const candidates = [
        "database/database.bin",
        "save/database/database.bin",
        "save/database.bin",
      ];
      for (const key of candidates) {
        const data = await forageStorage.getItem(key);
        if (data) {
          await forageStorage.setItem(`${key}.migrated`, data as any);
          await forageStorage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.error("Failed to mark legacy as migrated:", error);
  }
}
