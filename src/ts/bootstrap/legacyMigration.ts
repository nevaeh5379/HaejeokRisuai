import { alertConfirm, alertError, alertNormal } from "../alert";
import { language } from "../../lang";
import { LoadingStatusState } from "../stores.svelte";
import {
  checkAndMigrateLegacyDatabase,
  migrateLegacyDatabase,
} from "../storage/database/migration";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";

/**
 * If a legacy aggregate database exists, offers the user to migrate it into
 * the SQL backend. Reloading the startup snapshot afterwards is the
 * caller's job.
 */
export async function migrateLegacyDataIfNeeded(
  storage: ISqlStorage,
): Promise<void> {
  LoadingStatusState.text = "Checking for Legacy Data...";
  const legacyDb = await checkAndMigrateLegacyDatabase(storage);
  if (!legacyDb) {
    return;
  }
  const shouldMigrate = await alertConfirm(language.migrateLocalToSqlPrompt);
  if (!shouldMigrate) {
    return;
  }
  LoadingStatusState.text = "Migrating Local Data to SQL...";
  const success = await migrateLegacyDatabase(storage, legacyDb, (status) => {
    LoadingStatusState.text = status;
  });
  if (success) {
    alertNormal(language.migrateLocalToSqlSuccess);
  } else {
    alertError("Migration failed. Your legacy data is preserved.");
  }
}
