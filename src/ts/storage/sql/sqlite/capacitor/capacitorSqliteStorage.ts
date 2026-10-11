import * as authorNoteSql from "@risuai/protocol/src/authorNoteSql.ts";
import { NativeSqliteStorageBase } from "../nativeSqliteStorageBase";
import type { ISqlStorage } from "../../ISqlStorage";
import { isCapacitor } from "../../../../platform";
import sqliteSchemaSql from "@risuai/storage-sqlite/schema/schema.sql?raw";
import * as sqliteCommit from "@risuai/storage-sqlite/commit/apply";
import * as sqliteStatements from "@risuai/storage-sqlite/schema/statements";
import type { SqliteStatement } from "@risuai/storage-sqlite/types";
import {
  buildSqlReplaceRootCommit,
  iterateSqlReplaceEntityCommits,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "../../sqlCommit";
import type { Database as DatabaseType } from "../../../database/schema";
import { CapacitorSqliteRestoreStream } from "./capacitorSqliteRestoreStream";
import { nativeSqlite, type NativeSqlitePlugin } from "./capacitorNativeSqlite";
import { readSqliteQueryStream } from "./capacitorSqliteQueryStream";
import { createPortableDatabaseStreamSqliteSession } from "../portableDatabaseStreamSqliteRestore";
import type { PortableDatabaseStreamRestoreProgress } from "../../../backup/portableDatabaseStreamRestore";

// The Android native backend applies connection-local PRAGMAs itself. Keep
// those out of the shared DDL script and send the remaining statements through
// the same native transaction API used by normal commits.
const capacitorSchemaStatements = sqliteStatements
  .split(sqliteSchemaSql)
  .map((statement) => statement.trim())
  .filter(
    (statement) =>
      statement.length > 0 && !sqliteStatements.isPragma(statement),
  );

// Measure JSON escaping without creating a second, potentially huge string.
// Once over budget, an exact count is unnecessary: this statement is streamed.
function jsonStringChars(value: string, budget: number): number {
  if (value.length > budget) return budget + 1;
  let chars = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    )
      chars += 2;
    else if (code < 32) chars += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        chars += 2;
        index++;
      } else chars += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) chars += 6;
    else chars++;
    if (chars > budget) return budget + 1;
  }
  return chars;
}

function statementJsonChars(
  sql: string,
  bind: unknown[],
  budget: number,
): number {
  let chars = 18 + jsonStringChars(sql, budget); // {"sql":...,"bind":[...]}
  for (let index = 0; index < bind.length && chars <= budget; index++) {
    const value = bind[index];
    chars +=
      (index > 0 ? 1 : 0) +
      (typeof value === "string"
        ? jsonStringChars(value, budget - chars)
        : (JSON.stringify(value) ?? "null").length);
  }
  return chars;
}

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

  constructor(
    private readonly sqlitePlugin: NativeSqlitePlugin = nativeSqlite,
  ) {
    super();
  }
  protected readonly backendName = "CapacitorSqliteStorage";

  protected isPlatformAvailable(): boolean {
    return isCapacitor;
  }

  protected async openBackend(): Promise<void> {
    await this.sqlitePlugin.open({ database: "risuai-local" });
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
      if (this.dbOpen) await this.sqlitePlugin.close();
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
    const [rows] = await readSqliteQueryStream(this.sqlitePlugin, [
      { sql, bind },
    ]);
    return rows as T[];
  }

  protected override async selectRowSets(
    queries: SqliteStatement[],
  ): Promise<Record<string, unknown>[][]> {
    if (!this.dbOpen) throw new Error("Database not opened");
    return await readSqliteQueryStream(this.sqlitePlugin, queries);
  }

  protected async executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteStatement[],
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
   * executeBatch(), which executes the whole chunk inside one bridge call.
   * Oversized statements use bounded restore chunks in the same transaction.
   * All statements still run inside the caller's single SQLite
   * transaction, so atomicity and ordering are unchanged.
   */
  private static readonly BATCH_MAX_STATEMENTS = 48;
  private static readonly BATCH_MAX_PAYLOAD_CHARS = 256 * 1024;

  protected async runNativeTransaction<T>(
    expectedRevision: number | null,
    task: (
      execute: (sql: string, bind?: unknown[]) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.dbOpen) throw new Error("SQLite storage is not enabled");
    const transaction = await this.sqlitePlugin.beginTransaction({
      expectedRevision,
    });
    let pendingBatch: SqliteStatement[] = [];
    const emptyBatchChars = JSON.stringify({
      id: transaction.id,
      statements: [],
    }).length;
    let batchPayloadChars = emptyBatchChars;
    const flushBatch = async () => {
      if (pendingBatch.length === 0) return;
      const chunk = pendingBatch;
      pendingBatch = [];
      batchPayloadChars = emptyBatchChars;
      await this.sqlitePlugin.executeBatch({
        id: transaction.id,
        statements: chunk,
      });
    };
    try {
      const execute = async (sql: string, bind: unknown[] = []) => {
        const budget = CapacitorSqliteStorage.BATCH_MAX_PAYLOAD_CHARS;
        const chars = statementJsonChars(sql, bind, budget);
        if (emptyBatchChars + chars > budget) {
          await flushBatch();
          const stream = new CapacitorSqliteRestoreStream(this.sqlitePlugin);
          try {
            await stream.openTransaction(transaction.id);
            await stream.writeStatement(sql, bind);
            await stream.finish();
          } catch (error) {
            await stream.abort().catch(() => {});
            throw error;
          }
          return;
        }
        if (
          batchPayloadChars + chars + (pendingBatch.length > 0 ? 1 : 0) >
          budget
        ) {
          await flushBatch();
        }
        batchPayloadChars += chars + (pendingBatch.length > 0 ? 1 : 0);
        pendingBatch.push({ sql, bind });
        if (
          pendingBatch.length >= CapacitorSqliteStorage.BATCH_MAX_STATEMENTS ||
          batchPayloadChars >= CapacitorSqliteStorage.BATCH_MAX_PAYLOAD_CHARS
        ) {
          await flushBatch();
        }
      };
      const result = await task(execute);
      await flushBatch();
      await this.sqlitePlugin.commitTransaction({ id: transaction.id });
      return result;
    } catch (error) {
      pendingBatch = [];
      batchPayloadChars = 0;
      try {
        await this.sqlitePlugin.rollbackTransaction({ id: transaction.id });
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  protected createRestoreStream() {
    return new CapacitorSqliteRestoreStream(this.sqlitePlugin);
  }

  async beginPortableDatabaseStreamRestore(
    onProgress?: (progress: PortableDatabaseStreamRestoreProgress) => void,
  ) {
    if (!this._enabled && !(await this.init())) {
      throw new Error("SQLite storage is not enabled");
    }
    const baseRevision = this.revision;
    return await createPortableDatabaseStreamSqliteSession({
      baseRevision,
      onProgress,
      onCommitted: (revision) => {
        this.revision = revision;
      },
      runTransaction: (task) =>
        this.writeQueue.run(async () => {
          if (!this._enabled || !this.isStorageReady()) {
            throw new Error("SQLite storage is not enabled");
          }
          return await this.runNativeTransaction(baseRevision, task);
        }),
    });
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
        sqliteCommit.countStatements(rootCommit) +
        5 +
        (database.globalAuthorNotes?.filter((note) => note.id !== "__none__")
          .length ?? 0) +
        (rootCommit.replaceAll ? 3 : 0) +
        2;
      for (const batch of iterateSqlReplaceEntityCommits(
        database,
        currentRevision,
      )) {
        totalStatements += sqliteCommit.countStatements(batch);
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
      await authorNoteSql.applyAuthorNotes(
        { ...this.authorNoteDatabase(), execute: write },
        rootCommit.authorNotes,
      );
      await sqliteCommit.apply(rootCommit, write);
      for (const batch of iterateSqlReplaceEntityCommits(
        database,
        currentRevision,
      )) {
        await sqliteCommit.apply(batch, write);
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
    const receipt = await authorNoteSql.readAuthorNoteReceipt(
      this.authorNoteDatabase(),
      commit,
    );
    if (receipt) return receipt;
    if (commit.baseRevision !== currentRevision) {
      throw new SqlRevisionConflictError(currentRevision);
    }
    await this.prepareModuleCommit(commit);
    await this.validatePresetCommit(commit);

    const revision = currentRevision + 1;
    const action =
      commit.action || (commit.replaceAll ? "replace-all" : "sync");
    let authorNotes: Awaited<
      ReturnType<typeof authorNoteSql.applyAuthorNotes>
    > = [];
    await this.runNativeTransaction(currentRevision, async (execute) => {
      if (commit.replaceAll) {
        await execute("DELETE FROM system_settings");
        await execute("DELETE FROM plugin_custom_storage");
        await execute("DELETE FROM characters");
      }
      authorNotes = await authorNoteSql.applyAuthorNotes(
        { ...this.authorNoteDatabase(), execute },
        commit.authorNotes,
      );
      await sqliteCommit.apply(commit, execute);
      await execute(
        "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
        [revision],
      );
      await execute(
        "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
        [revision, action],
      );
      await authorNoteSql.writeAuthorNoteReceipt(
        { ...this.authorNoteDatabase(), execute },
        commit,
        {
          revision,
          authorNotes: authorNotes.map(({ id, contentHash, updatedAt }) => ({
            id,
            contentHash,
            updatedAt,
          })),
        },
      );
    });
    this.revision = revision;
    return {
      revision,
      ...(authorNotes.length
        ? {
            authorNotes: authorNotes.map(({ id, contentHash, updatedAt }) => ({
              id,
              contentHash,
              updatedAt,
            })),
          }
        : {}),
    };
  }
}
