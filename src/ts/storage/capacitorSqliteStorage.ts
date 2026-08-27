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
  buildSqlReplaceRootCommit,
  iterateSqlReplaceEntityCommits,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import {
  applySqliteCommit,
  countSqliteCommitStatements,
} from "./sqliteCommit";
import type { SqliteTransactionStatement } from "./sqliteStorageUtils";
import type { Database as DatabaseType } from "./schema";
import { CapacitorSqliteRestoreStream } from "./capacitorSqliteRestoreStream";

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

  protected createRestoreStream() {
    return new CapacitorSqliteRestoreStream();
  }

  override async replaceDatabase(
    database: DatabaseType,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean> {
    onProgress?.("Building SQL restore plan...", 0.01);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const rootCommit = buildSqlReplaceRootCommit(database, this.revision);
    await this.writeQueue.run(async () => {
      if (!this._enabled || !this.isStorageReady()) {
        throw new Error("SQLite storage is not enabled");
      }
      const meta = await this.selectOne<{ revision: number }>(
        "SELECT revision FROM system_storage_meta WHERE singleton = 1",
      );
      const currentRevision = Number(meta?.revision) || 0;
      if (rootCommit.baseRevision !== currentRevision) {
        throw new SqlRevisionConflictError(currentRevision);
      }
      await this.validatePresetCommit(rootCommit);
      onProgress?.("Counting SQL operations...", 0.025);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let totalStatements =
        countSqliteCommitStatements(rootCommit) +
        (rootCommit.replaceAll ? 3 : 0) +
        2;
      for (const batch of iterateSqlReplaceEntityCommits(database, currentRevision)) {
        totalStatements += countSqliteCommitStatements(batch);
      }
      onProgress?.(
        `SQL restore plan ready (${totalStatements} statements)`,
        0.05,
      );
      await this.replaceDatabaseWithRestoreStream(
        database,
        rootCommit,
        currentRevision,
        totalStatements,
        onProgress,
      );
    });
    onProgress?.("Database sync complete", 1);
    return true;
  }

  private async replaceDatabaseWithRestoreStream(
    database: DatabaseType,
    rootCommit: SqlCommit,
    currentRevision: number,
    totalStatements: number,
    onProgress?: (status: string, progress?: number) => void,
  ) {
    const stream = this.createRestoreStream();
    const revision = currentRevision + 1;
    const action = rootCommit.action || "replace-all";
    const total = Math.max(1, totalStatements);
    let written = 0;
    let writingFraction = 0;
    let applied = 0;
    let appliedStage = "";
    let lastReportAt = 0;
    let lastProgress = 0.05;

    const report = (phase: "streaming" | "applying", force = false) => {
      const writeRatio = Math.min(1, (written + writingFraction) / total);
      const applyRatio = Math.min(1, applied / total);
      const progress = Math.max(
        lastProgress,
        Math.min(0.995, 0.05 + writeRatio * 0.45 + applyRatio * 0.5),
      );
      const now = Date.now();
      if (!force && now - lastReportAt < 50 && progress - lastProgress < 0.0025) {
        return;
      }
      lastReportAt = now;
      lastProgress = progress;
      const label = phase === "streaming"
        ? "Streaming SQL"
        : `Applying SQL${appliedStage ? ` · ${appliedStage}` : ""}`;
      const currentStatement =
        writingFraction > 0 && writingFraction < 1
          ? `, current statement ${Math.round(writingFraction * 100)}%`
          : "";
      onProgress?.(
        `${label} (${written}/${total} streamed, ${applied}/${total} applied${currentStatement})`,
        progress,
      );
    };

    const write = async (sql: string, bind: unknown[] = []) => {
      writingFraction = 0;
      await stream.writeStatement(sql, bind, (fraction) => {
        writingFraction = fraction;
        report("streaming");
      });
      written++;
      writingFraction = 0;
      report("streaming", written === total);
    };

    await stream.open(currentRevision, (completed, stage) => {
      applied = Math.max(applied, completed);
      if (stage) appliedStage = stage;
      report("applying", completed >= total || stage === "committing");
    });
    try {
      if (rootCommit.replaceAll) {
        await write("DELETE FROM system_settings");
        await write("DELETE FROM plugin_custom_storage");
        await write("DELETE FROM characters");
      }
      await applySqliteCommit(rootCommit, write);
      for (const batch of iterateSqlReplaceEntityCommits(database, currentRevision)) {
        await applySqliteCommit(batch, write);
      }
      await write(
        "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
        [revision],
      );
      await write(
        "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
        [revision, action],
      );
      const appliedResult = await stream.finish();
      applied = Math.max(applied, appliedResult);
      report("applying", true);
      if (appliedResult !== written) {
        throw new Error(
          `Native SQLite restore applied ${appliedResult}/${written} statements`,
        );
      }
      this.revision = revision;
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }

  /**
   * Normal Capacitor commits stay on the community SQLite bridge. Explicit
   * whole-database restores use the streaming JsonReader path above so giant
   * bind payloads never become one org.json JSONStringer allocation.
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
