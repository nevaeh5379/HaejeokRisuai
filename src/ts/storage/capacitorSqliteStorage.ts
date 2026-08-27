import { NativeSqliteStorageBase } from "./nativeSqliteStorageBase";
import type { ISqlStorage } from "./ISqlStorage";
import { isCapacitor } from "../platform";
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import { SqlRevisionConflictError } from "./sqlCommit";
import type { SqliteTransactionStatement } from "./sqliteStorageUtils";

// @capacitor-community/sqlite routes PRAGMA statements that return rows through
// query()/rawQuery(). Passing them inside execute() makes Android reject the
// entire schema batch as a query. The native plugin already enables foreign
// keys when opening the database; WAL is an optional tuning pragma, so keep
// both out of the DDL batch while preserving the shared schema for Web/Tauri.
const capacitorSchemaSql = sqliteSchemaSql.replace(
  /^\s*PRAGMA\s+(?:journal_mode|foreign_keys)\s*=.*?;\s*$/gim,
  "",
);

/**
 * Capacitor native SQLite storage backend for Android/iOS builds.
 *
 * Uses @capacitor-community/sqlite so the database is an app-private native
 * SQLite file rather than browser IndexedDB/OPFS storage.
 */
export class CapacitorSqliteStorage extends NativeSqliteStorageBase
  implements ISqlStorage {
  readonly backendKind = "capacitor-sqlite" as const;

  private sqlite: SQLiteConnection | null = null;
  private db: SQLiteDBConnection | null = null;
  private dbName: string | null = null;
  protected readonly backendName = "CapacitorSqliteStorage";

  protected isPlatformAvailable(): boolean {
    return isCapacitor;
  }

  protected async openBackend(): Promise<void> {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
    this.dbName = "risuai-local";
    await this.sqlite.checkConnectionsConsistency();
    const existing = await this.sqlite.isConnection(this.dbName, false);
    this.db = existing.result
      ? await this.sqlite.retrieveConnection(this.dbName, false)
      : await this.sqlite.createConnection(
        this.dbName,
        false,
        "no-encryption",
        1,
        false,
      );
    await this.db.open();
  }

  protected async applySchema(): Promise<void> {
    if (!this.db) throw new Error("Database not opened");
    await this.db.execute(capacitorSchemaSql, false);
  }

  protected async cleanupBackend(): Promise<void> {
    try {
      if (this.db) await this.db.close();
    } finally {
      this.db = null;
      this.sqlite = null;
      this.dbName = null;
    }
  }

  // ── Low-level helpers ───────────────────────────────────────────────

  protected isStorageReady(): boolean {
    return !!this.db && !!this.dbName;
  }

  protected async selectRows<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T[]> {
    if (!this.db) throw new Error("Database not opened");
    const result = await this.db.query(sql, bind);
    return (result.values ?? []) as T[];
  }

  protected async executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteTransactionStatement[],
  ): Promise<void> {
    await this.runNativeTransaction(expectedRevision, async (execute) => {
      for (const statement of statements) {
        await execute(statement.sql, statement.bind ?? []);
      }
    });
  }

  private async runNativeTransaction<T>(
    expectedRevision: number | null,
    task: (
      execute: (sql: string, bind?: unknown[]) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.db || !this.dbName) {
      throw new Error("SQLite storage is not enabled");
    }
    await this.db.beginTransaction();
    try {
      if (expectedRevision !== null) {
        const meta = await this.selectOne<{ revision: number }>(
          "SELECT revision FROM system_storage_meta WHERE singleton = 1",
        );
        const currentRevision = Number(meta?.revision) || 0;
        if (currentRevision !== expectedRevision) {
          throw new SqlRevisionConflictError(currentRevision);
        }
      }
      const execute = async (sql: string, bind: unknown[] = []) => {
        await this.db!.run(sql, bind, false);
      };
      const result = await task(execute);
      await this.db.commitTransaction();
      return result;
    } catch (error) {
      try {
        await this.db.rollbackTransaction();
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }
}
