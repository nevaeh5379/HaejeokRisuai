import { alertError } from "../alert";
import { isCapacitor, isNodeServer, isTauri } from "../platform";
import { LoadingStatusState, sqlConfiguredStore } from "../stores.svelte";
import { getSqlStorage } from "../storage/sql/sqlStorageFactory";
import { setSqlRuntime } from "../storage/sql/sqlRuntime";
import {
  isNodeSqlStorageAdmin,
  type ISqlStorage,
} from "../storage/sql/ISqlStorage";

/**
 * Initialises the environment-appropriate SQL storage backend (open DB,
 * apply schema). Returns the initialised storage, or `null` when startup
 * must stop because either the Node SQL configuration UI gate is being
 * shown or the backend failed to initialise (the user has been alerted in
 * both cases).
 */
export async function initSqlStorageOrGate(): Promise<ISqlStorage | null> {
  LoadingStatusState.text = "Initialising Database...";
  const storage = await getSqlStorage();
  setSqlRuntime(storage);
  const ok = await storage.init();
  if (ok) {
    return storage;
  }
  // SQL backend could not be initialised.
  if (isNodeServer && isNodeSqlStorageAdmin(storage)) {
    // Node server: show SQL configuration UI
    sqlConfiguredStore.set(false);
    LoadingStatusState.text = "SQL storage not configured";
    // The SQL settings gate UI will be shown by the app
    // (loadedStore stays false → app blocked until configured)
    return null;
  }
  if (isTauri || isCapacitor) {
    const nativeError =
      typeof (storage as any).getLastInitError === "function"
        ? (storage as any).getLastInitError()
        : null;
    alertError(
      nativeError
        ? `Failed to initialize native SQLite storage: ${nativeError}`
        : "Failed to initialize native SQLite storage. Please check the application logs for details.",
    );
  } else {
    alertError(
      "This browser does not support SQLite WASM (OPFS required). Please use a modern browser.",
    );
  }
  return null;
}

/**
 * Node server: refresh the SQL configuration state after the startup
 * snapshot has been installed.
 */
export function reportNodeSqlConfigured(storage: ISqlStorage): void {
  if (isNodeServer && isNodeSqlStorageAdmin(storage)) {
    sqlConfiguredStore.set(storage.isEnabled());
  }
}
