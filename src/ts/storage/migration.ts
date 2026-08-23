import type { Database } from "./database.svelte";
import { decodeRisuSave } from "./risuSave";
import type { ISqlStorage } from "./ISqlStorage";
import { isTauri } from "../platform";
import { forageStorage } from "../globalApi.svelte";

/**
 * Checks for a legacy database.bin in local storage and offers migration
 * to the SQL backend. This is the *only* place that reads database.bin —
 * the rest of the app is SQL-only.
 *
 * Returns the migrated Database (if migration happened) or null.
 */
export async function checkAndMigrateLegacyDatabase(
  storage: ISqlStorage,
): Promise<Database | null> {
  let legacyBytes: Uint8Array | null = null;

  try {
    if (isTauri) {
      const { readFile, exists } = await import("@tauri-apps/plugin-fs");
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const appDir = await appDataDir();
      const dbPath = await join(appDir, "database/database.bin");
      if (await exists(dbPath)) {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const response = await fetch(convertFileSrc(dbPath));
        if (response.ok) {
          legacyBytes = new Uint8Array(await response.arrayBuffer());
        }
      }
    } else {
      // Web: check localForage / OPFS for legacy database.bin
      legacyBytes = (await forageStorage.getItem(
        "database/database.bin",
      )) as unknown as Uint8Array | null;
    }
  } catch (error) {
    console.error("Legacy database check failed:", error);
  }

  if (!legacyBytes || legacyBytes.length === 0) {
    return null;
  }

  // Decode legacy database
  let legacyDb: Database;
  try {
    legacyDb = await decodeRisuSave(legacyBytes);
  } catch (error) {
    console.error("Legacy database decode failed:", error);
    return null;
  }

  // Check if there's actual data to migrate
  if (!legacyDb.characters || legacyDb.characters.length === 0) {
    return null;
  }

  return legacyDb;
}

/**
 * Performs the full migration: replaces the SQL database with the legacy
 * data and marks the legacy file as migrated.
 */
export async function migrateLegacyDatabase(
  storage: ISqlStorage,
  legacyDb: Database,
  onProgress?: (status: string) => void,
): Promise<boolean> {
  try {
    onProgress?.("Migrating data to SQL storage...");
    await storage.replaceDatabase(legacyDb, onProgress);
    onProgress?.("Migration complete");

    // Mark legacy file as migrated (rename or remove)
    await markLegacyAsMigrated();

    return true;
  } catch (error) {
    console.error("Legacy migration failed:", error);
    return false;
  }
}

async function markLegacyAsMigrated(): Promise<void> {
  try {
    if (isTauri) {
      const { rename, exists } = await import("@tauri-apps/plugin-fs");
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const appDir = await appDataDir();
      const dbPath = await join(appDir, "database/database.bin");
      const migratedPath = await join(appDir, "database/database.bin.migrated");
      if (await exists(dbPath)) {
        await rename(dbPath, migratedPath);
      }
    } else {
      // Web: remove from localForage / OPFS
      const data = await forageStorage.getItem("database/database.bin");
      if (data) {
        await forageStorage.setItem(
          "database/database.bin.migrated",
          data as any,
        );
        await forageStorage.removeItem("database/database.bin");
      }
    }
  } catch (error) {
    console.error("Failed to mark legacy as migrated:", error);
  }
}
