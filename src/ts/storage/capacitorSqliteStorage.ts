import { NativeSqliteStorageBase } from "./nativeSqliteStorageBase";
import type { ISqlStorage } from "./ISqlStorage";
import { isCapacitor } from "../platform";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  buildSqlReplaceRootCommit,
  iterateSqlReplaceEntityCommits,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import { applySqliteCommit, countSqliteCommitStatements } from "./sqliteCommit";
import type { SqliteTransactionStatement } from "./sqliteStorageUtils";
import type { Database as DatabaseType } from "./schema";
import { CapacitorSqliteRestoreStream } from "./capacitorSqliteRestoreStream";
import {
  nativeSqlite,
  type NativeSqlitePlugin,
} from "./capacitorNativeSqlite";

// The Android native backend applies connection-local PRAGMAs itself. Keep
// those out of the shared DDL script and send the remaining statements through
// the same native transaction API used by normal commits.
const capacitorSchemaStatements = sqliteSchemaSql
  .replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys)\s*=.*?;\s*$/gim, "")
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

/**
 * Capacitor native SQLite storage backend for Android/iOS builds.
 *
 * Uses RisuAI's native Android SQLite plugin. One native SQLiteDatabase owner
 * serves normal reads/writes and the OOM-safe streaming restore path.
 */
export class CapacitorSqliteStorage
  extends NativeSqliteStorageBase
  implements ISqlStorage
{
  readonly backendKind = "capacitor-sqlite" as const;

  private dbOpen = false;

  constructor(private readonly plugin: NativeSqlitePlugin = nativeSqlite) {
    super();
  }
  protected readonly backendName = "CapacitorSqliteStorage";

  protected isPlatformAvailable(): boolean {
    return isCapacitor;
  }

  protected async openBackend(): Promise<void> {
    await this.plugin.open({ database: "risuai-local" });
    this.dbOpen = true;
  }

  protected async applySchema(): Promise<void> {
    if (!this.dbOpen) throw new Error("Database not opened");
    await this.runNativeTransaction(null, async (execute) => {
      for (const sql of capacitorSchemaStatements) await execute(sql);
    });
  }

  protected async cleanupBackend(): Promise<void> {
    try {
      if (this.dbOpen) await this.plugin.close();
    } finally {
      this.dbOpen = false;
    }
  }

  // ── Low-level helpers ───────────────────────────────────────────────

  protected isStorageReady(): boolean {
    return this.dbOpen;
  }

  protected async selectRows<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T[]> {
    if (!this.dbOpen) throw new Error("Database not opened");
    const result = await this.plugin.query({ sql, bind });
    return (result.values ?? []) as T[];
  }

  protected override async selectRowSets(
    queries: SqliteTransactionStatement[],
  ): Promise<Record<string, unknown>[][]> {
    if (!this.dbOpen) throw new Error("Database not opened");
    const result = await this.plugin.queryBatch({ queries });
    return result.results ?? [];
  }

  protected async executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteTransactionStatement[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void> {
    const total = statements.length;
    const progressInterval = Math.max(1, Math.floor(total / 100));
    onProgress?.(0, total);
    let completed = 0;
    await this.runNativeTransaction(expectedRevision, async (execute) => {
      for (const statement of statements) {
        await execute(statement.sql, statement.bind ?? []);
        completed++;
        if (completed === total || completed % progressInterval === 0) {
          onProgress?.(completed, total);
        }
      }
    });
  }

  /**
   * Each db.run() call is a full JS↔native bridge round trip, so large
   * commits (e.g. a 100-message save) previously cost 100+ sequential
   * round trips. Buffers statements and flushes them in chunks through
   * executeSet(), which executes the whole chunk inside one bridge call.
   * All statements still run inside the caller's single SQLite
   * transaction, so atomicity and ordering are unchanged.
   */
  private static readonly BATCH_MAX_STATEMENTS = 48;
  private static readonly BATCH_MAX_PAYLOAD_CHARS = 256 * 1024;

  private async runNativeTransaction<T>(
    expectedRevision: number | null,
    task: (
      execute: (sql: string, bind?: unknown[]) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.dbOpen) throw new Error("SQLite storage is not enabled");
    const transaction = await this.plugin.beginTransaction({ expectedRevision });
    let pendingBatch: SqliteTransactionStatement[] = [];
    let batchPayloadChars = 0;
    const flushBatch = async () => {
      if (pendingBatch.length === 0) return;
      const chunk = pendingBatch;
      pendingBatch = [];
      batchPayloadChars = 0;
      await this.plugin.executeBatch({
        id: transaction.id,
        statements: chunk,
      });
    };
    try {
      const execute = async (sql: string, bind: unknown[] = []) => {
        let bindChars = 0;
        for (const value of bind) {
          if (typeof value === "string") bindChars += value.length;
        }
        pendingBatch.push({ sql, bind });
        batchPayloadChars += sql.length + bindChars;
        if (
          pendingBatch.length >= CapacitorSqliteStorage.BATCH_MAX_STATEMENTS ||
          batchPayloadChars >= CapacitorSqliteStorage.BATCH_MAX_PAYLOAD_CHARS
        ) {
          await flushBatch();
        }
      };
      const result = await task(execute);
      await flushBatch();
      await this.plugin.commitTransaction({ id: transaction.id });
      return result;
    } catch (error) {
      pendingBatch = [];
      batchPayloadChars = 0;
      try {
        await this.plugin.rollbackTransaction({ id: transaction.id });
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  protected createRestoreStream() {
    return new CapacitorSqliteRestoreStream(this.plugin);
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
      for (const batch of iterateSqlReplaceEntityCommits(
        database,
        currentRevision,
      )) {
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
      if (
        !force &&
        now - lastReportAt < 50 &&
        progress - lastProgress < 0.0025
      ) {
        return;
      }
      lastReportAt = now;
      lastProgress = progress;
      const label =
        phase === "streaming"
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
      for (const batch of iterateSqlReplaceEntityCommits(
        database,
        currentRevision,
      )) {
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
   * Normal commits and whole-database restores share the same native SQLite
   * backend. Restore keeps its streaming transport so giant bind payloads never
   * become one org.json JSONStringer allocation.
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
    const action =
      commit.action || (commit.replaceAll ? "replace-all" : "sync");
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
