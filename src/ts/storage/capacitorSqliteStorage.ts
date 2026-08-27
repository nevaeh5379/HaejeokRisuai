import { NativeSqliteStorageBase } from "./nativeSqliteStorageBase";
import type { ISqlStorage } from "./ISqlStorage";
import { isCapacitor } from "../platform";
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import { applySqliteCommit } from "./sqliteCommit";
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
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void> {
    const total = statements.length;
    const progressInterval = Math.max(1, Math.floor(total / 100));
    onProgress?.(0, total);
    await this.runNativeTransaction(expectedRevision, async (execute) => {
      for (const [index, statement] of statements.entries()) {
        await execute(statement.sql, statement.bind ?? []);
        const completed = index + 1;
        if (completed === total || completed % progressInterval === 0) {
          onProgress?.(completed, total);
        }
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

  /**
   * Capacitor crosses the WebView/native bridge for every SQLite statement.
   * Execute statements as applySqliteCommit produces them so a large restore
   * does not retain the complete flattened SQL statement list (and all bind
   * values) in WebView memory until the transaction begins.
   */
  protected override async commitInternal(
    commit: SqlCommit,
  ): Promise<SqlCommitResult> {
    if (!this._enabled || !this.isStorageReady()) {
      throw new Error("SQLite storage is not enabled");
    }
    const meta = await this.selectOne<{ revision: number }>(
      "SELECT revision FROM system_storage_meta WHERE singleton = 1",
    );
    const currentRevision = Number(meta?.revision) || 0;
    if (commit.baseRevision !== currentRevision) {
      throw new SqlRevisionConflictError(currentRevision);
    }
    await this.validatePresetCommit(commit);

    const revision = currentRevision + 1;
    const action = commit.action ||
      (commit.replaceAll ? "replace-all" : "sync");
    await this.runNativeTransaction(currentRevision, async (execute) => {
      if (commit.replaceAll) {
        await execute("DELETE FROM system_settings");
        await execute("DELETE FROM plugin_custom_storage");
        await execute("DELETE FROM characters");
      }
      await applySqliteCommit(commit, execute);
      await execute(
        "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
        [revision],
      );
      await execute(
        "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
        [revision, action],
      );
    });
    this.revision = revision;
    return { revision };
  }
}
