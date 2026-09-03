import { NativeSqliteStorageBase } from "../nativeSqliteStorageBase";
import type { ISqlStorage } from "../../ISqlStorage";
import { isTauri } from "../../../../platform";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import sqliteSchemaSql from "../sqlite-schema.sql?raw";
import { splitSqliteStatements } from "../sqliteSchemaStatements";
import { SqlRevisionConflictError } from "../../sqlCommit";
import type { SqliteTransactionStatement } from "../sqliteStorageUtils";

type SqlDatabase = import("@tauri-apps/plugin-sql").default;

type SqliteTransactionProgressEvent = {
  transactionId: string;
  completed: number;
  total: number;
};

// Lazily imported to avoid loading the plugin in non-Tauri environments
let SQL: typeof import("@tauri-apps/plugin-sql") | null = null;

async function getSQL() {
  if (!SQL) {
    SQL = await import("@tauri-apps/plugin-sql");
  }
  return SQL;
}

/**
 * Tauri desktop SQLite storage backend.
 *
 * Uses @tauri-apps/plugin-sql (tauri-plugin-sql) to manage a SQLite
 * database file in the app data directory. The Rust plugin handles
 * the native sqlite3 connection; this class issues SQL via the JS API.
 */
export class TauriSqliteStorage
  extends NativeSqliteStorageBase
  implements ISqlStorage
{
  readonly backendKind = "tauri-sqlite" as const;

  private db: SqlDatabase | null = null;
  private dbPath: string | null = null;
  protected readonly backendName = "TauriSqliteStorage";

  protected isPlatformAvailable(): boolean {
    return isTauri;
  }

  protected async openBackend(): Promise<void> {
    const sql = await getSQL();
    const appDir = await appDataDir();
    this.dbPath = await join(appDir, "risuai-local.sqlite3");
    this.db = await sql.default.load(`sqlite:${this.dbPath}`);
  }

  protected async applySchema(): Promise<void> {
    if (!this.db) throw new Error("Database not opened");
    for (const statement of splitSqliteStatements(sqliteSchemaSql)) {
      await this.db.execute(statement);
    }
  }

  protected async cleanupBackend(): Promise<void> {
    try {
      if (this.db) await this.db.close(this.db.path);
    } finally {
      this.db = null;
      this.dbPath = null;
    }
  }

  // ── Low-level helpers ───────────────────────────────────────────────

  protected isStorageReady(): boolean {
    return !!this.db && !!this.dbPath;
  }

  protected async selectRows<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T[]> {
    if (!this.db) throw new Error("Database not opened");
    return this.db.select<T[]>(sql, bind);
  }

  protected async executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteTransactionStatement[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void> {
    if (!this.dbPath) throw new Error("SQLite storage is not enabled");
    const transactionId = onProgress
      ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      : undefined;
    const unlisten = transactionId
      ? await listen<SqliteTransactionProgressEvent>(
          "risu-sqlite-transaction-progress",
          ({ payload }) => {
            if (payload.transactionId === transactionId) {
              onProgress?.(payload.completed, payload.total);
            }
          },
        )
      : null;
    try {
      await invoke("sqlite_execute_transaction", {
        expectedRevision,
        statements,
        transactionId,
      });
    } catch (error) {
      const message = String(error);
      const marker = "RISU_SQL_REVISION_CONFLICT:";
      const markerIndex = message.indexOf(marker);
      if (markerIndex >= 0) {
        const currentRevision = Number(
          message.slice(markerIndex + marker.length),
        );
        if (Number.isFinite(currentRevision)) {
          throw new SqlRevisionConflictError(currentRevision);
        }
      }
      throw error;
    } finally {
      unlisten?.();
    }
  }
}
