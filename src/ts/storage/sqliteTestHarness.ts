/**
 * Test-only harness for exercising the SQLite storage backends against a real
 * in-process `node:sqlite` database.
 *
 * The goal is behavioral parity testing: every backend must pass the same
 * contract suite, driven through its real production code path (RPC mock for
 * web, plugin-sql mock for Tauri, capacitor bridge mock for Capacitor) while
 * the underlying SQL actually executes against node:sqlite.
 *
 * A query log records every statement so contract tests can assert lazy
 * loading behavior ("did the shallow load avoid reading loreBook nodes?")
 * without depending on brittle query counts.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { vi } from "vitest";
import { WebSqliteStorage } from "./webSqliteStorage";
import { TauriSqliteStorage } from "./tauriSqliteStorage";
import { CapacitorSqliteStorage } from "./capacitorSqliteStorage";
import {
  flattenRelationalValue,
  rebuildRelationalValue,
  type RelationalNodeRow,
} from "./relationalNodeCodec";
import { rebuildMessageRows } from "./sqliteStorageUtils";

// Re-export so migrated suites keep working with a single import.
export { flattenRelationalValue, rebuildRelationalValue };
export type { RelationalNodeRow };

// ── Query log ────────────────────────────────────────────────────────

export class QueryLog {
  readonly entries: { kind: "select" | "run"; sql: string }[] = [];

  record(kind: "select" | "run", sql: string): void {
    this.entries.push({ kind, sql });
  }

  count(): number {
    return this.entries.length;
  }

  touching(fragment: string): number {
    return this.entries.filter((entry) => entry.sql.includes(fragment)).length;
  }

  where(predicate: (sql: string) => boolean): { kind: string; sql: string }[] {
    return this.entries.filter((entry) => predicate(entry.sql));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export type LoggedQuery = { kind: "select" | "run"; sql: string };

// ── Shared node:sqlite adapters ──────────────────────────────────────

class StatementAdapter {
  private params: unknown[] = [];
  private iterator: Iterator<Record<string, unknown>> | null = null;
  private current: Record<string, unknown> | null = null;
  private executed = false;
  readonly columnNames: string[];

  constructor(private readonly statement: StatementSync) {
    this.columnNames = statement.columns().map((column) => column.name);
  }

  bind(params: unknown[]) {
    this.params = params;
  }

  step(): boolean {
    if (this.columnNames.length === 0) {
      if (!this.executed) {
        this.statement.run(...(this.params as any[]));
        this.executed = true;
      }
      return false;
    }
    this.iterator ??= this.statement
      .iterate(...(this.params as any[]))
      [Symbol.iterator]();
    const next = this.iterator.next();
    if (next.done) return false;
    this.current = next.value as Record<string, unknown>;
    return true;
  }

  get(): unknown[] {
    return this.columnNames.map((name) => this.current?.[name]);
  }

  finalize() {}
}
export class NodeSqliteDatabase {
  private readonly statements = new Map<string, StatementAdapter>();

  constructor(
    readonly database: DatabaseSync,
    private readonly log: QueryLog,
  ) {}

  exec(sql: string) {
    this.log.record("run", sql);
    this.database.exec(sql);
  }

  prepare(sql: string) {
    let adapter = this.statements.get(sql);
    if (!adapter) {
      adapter = new StatementAdapter(this.database.prepare(sql));
      this.statements.set(sql, adapter);
    }
    return adapter;
  }

  close() {
    this.database.close();
  }

  selectRows(sql: string, bind: unknown[] = []): Record<string, unknown>[] {
    this.log.record("select", sql);
    const stmt = this.database.prepare(sql);
    try {
      // node:sqlite's all()/get() already return named row objects.
      return stmt.all(...(bind as any[])) as Record<string, unknown>[];
    } finally {
      (stmt as any).finalize?.();
    }
  }

  run(sql: string, bind: unknown[] = []): void {
    this.log.record("run", sql);
    if (bind.length === 0 && !sqlHasParameters(sql)) {
      this.database.exec(sql);
      return;
    }
    const stmt = this.database.prepare(sql);
    try {
      stmt.run(...(bind as any[]));
    } finally {
      (stmt as any).finalize?.();
    }
  }
}

function sqlHasParameters(sql: string): boolean {
  // Conservative check: statements like "BEGIN" / "COMMIT" have no params.
  return /\?|@|\$/.test(sql);
}

// ── Message row rebuild (mirrors webSqliteWorker) ────────────────────

export function rebuildMessagesFromRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rebuildMessageRows(rows) as unknown as Record<string, unknown>[];
}

// ── Web (Worker RPC) harness ─────────────────────────────────────────

/** In-process mock of the Worker RPC protocol used by WebSqliteStorage. */
export function makeWebStorage(database: DatabaseSync): WebSqliteStorage {
  const log = new QueryLog();
  const db = new NodeSqliteDatabase(database, log);

  const selectRows = (sql: string, bind: unknown[] = []) =>
    db.selectRows(sql, bind);

  const rpc = {
    init: async () => ({ enabled: true, revision: 0, vfs: null }),
    exec: async (sql: string, bind: unknown[] = []) => {
      db.run(sql, bind);
    },
    execBatch: async (statements: Array<{ sql: string; bind?: unknown[] }>) => {
      for (const statement of statements) {
        db.run(statement.sql, statement.bind ?? []);
      }
    },
    selectBatch: async (
      statements: Array<{
        sql: string;
        bind?: unknown[];
        transform?: "relational" | "messages";
      }>,
    ) =>
      statements.map(({ sql, bind = [], transform }) => {
        const rows = selectRows(sql, bind);
        if (transform === "relational") {
          return {
            value: rows.length
              ? rebuildRelationalValue(rows as RelationalNodeRow[])
              : undefined,
          };
        }
        if (transform === "messages") {
          return { value: rebuildMessagesFromRows(rows) };
        }
        return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
      }),
    select: async (sql: string, bind: unknown[] = []) => ({
      rows: selectRows(sql, bind),
      columns: [],
    }),
    selectOne: async (sql: string, bind: unknown[] = []) =>
      selectRows(sql, bind)[0] ?? null,
    close: async () => {
      db.close();
    },
    terminate: () => {},
  };

  const storage = new WebSqliteStorage();
  (storage as any).rpc = rpc;
  (storage as any)._enabled = true;
  (storage as any).initialized = true;
  (storage as any).__log = log;
  return storage;
}

// ── Tauri (plugin-sql) harness ───────────────────────────────────────

/**
 * Mocks @tauri-apps/plugin-sql's Database interface over a real node:sqlite
 * database, and mocks the `sqlite_execute_transaction` invoke used for
 * native transactions (BEGIN ... COMMIT with revision verification).
 */
export function makeTauriStorage(database: DatabaseSync): TauriSqliteStorage {
  const log = new QueryLog();
  const db = new NodeSqliteDatabase(database, log);

  const pluginDb = {
    path: "sqlite:test.db",
    close: async () => {
      /* tests keep the database open for inspection */
    },
    select: async <T>(sql: string, bind: unknown[] = []) =>
      db.selectRows(sql, bind) as any,
    execute: async (sql: string, bind: unknown[] = []) => {
      db.run(sql, bind);
      return { rowsAffected: 0 };
    },
  };

  const invoke = vi.fn(
    async (
      command: string,
      payload: {
        expectedRevision: number | null;
        statements: Array<{ sql: string; bind?: unknown[] }>;
      },
    ) => {
      if (command !== "sqlite_execute_transaction") {
        throw new Error(`Unexpected invoke: ${command}`);
      }
      // Mirror the Rust-side contract: verify revision inside a transaction,
      // run all statements, commit. Conflicts reject with the marker string.
      db.run("BEGIN IMMEDIATE");
      try {
        if (payload.expectedRevision !== null) {
          const meta = db.selectRows(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
          );
          const current = Number(meta[0]?.revision) || 0;
          if (current !== payload.expectedRevision) {
            throw new Error(`RISU_SQL_REVISION_CONFLICT:${current}`);
          }
        }
        for (const statement of payload.statements) {
          db.run(statement.sql, statement.bind ?? []);
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve original error.
        }
        throw error;
      }
    },
  );

  // The storage class imports `invoke` from @tauri-apps/api/core at module
  // scope, so existing suites rely on vi.mock in the test file. The harness
  // wires the mock directly onto the instance instead: `executeNativeTransaction`
  // calls `invoke(...)` through the module import, so we monkey-patch the
  // private method to route through our in-process implementation. This keeps
  // the SQL execution real while removing the Tauri runtime dependency.
  const storage = new TauriSqliteStorage();
  (storage as any).db = pluginDb;
  (storage as any).dbPath = "/tmp/test.db";
  (storage as any)._enabled = true;
  (storage as any).initialized = true;
  (storage as any).revision = 0;
  (storage as any).__invoke = invoke;
  (storage as any).__log = log;
  (storage as any).executeNativeTransaction = async (
    expectedRevision: number | null,
    statements: Array<{ sql: string; bind?: unknown[] }>,
  ) => {
    await invoke("sqlite_execute_transaction", {
      expectedRevision,
      statements,
    });
  };
  return storage;
}

// ── Capacitor harness ────────────────────────────────────────────────

/**
 * Mocks @capacitor-community/sqlite's SQLiteDBConnection over a real
 * node:sqlite database.
 */
export function makeCapacitorStorage(
  database: DatabaseSync,
): CapacitorSqliteStorage {
  const log = new QueryLog();
  const db = new NodeSqliteDatabase(database, log);
  let transactionActive = false;

  const bridge = {
    query: async (sql: string, bind: unknown[] = []) => {
      const rows = db.selectRows(sql, bind);
      return { values: rows };
    },
    run: async (sql: string, bind: unknown[] = []) => {
      db.run(sql, bind);
      return { changes: { changes: 0 } };
    },
    execute: async (sql: string) => {
      db.run(sql);
      return { changes: { changes: 0 } };
    },
    // Mirrors the real plugin's executeSet: one bridge call per statement
    // list, each entry { statement, values }.
    executeSet: async (set: { statement: string; values?: unknown[] }[]) => {
      for (const entry of set) {
        db.run(entry.statement, entry.values ?? []);
      }
      return { changes: { changes: 0 } };
    },
    beginTransaction: async () => {
      if (transactionActive) {
        throw new Error("Transaction already active");
      }
      transactionActive = true;
      db.run("BEGIN");
    },
    commitTransaction: async () => {
      transactionActive = false;
      db.run("COMMIT");
    },
    rollbackTransaction: async () => {
      transactionActive = false;
      db.run("ROLLBACK");
    },
    close: async () => {
      /* tests keep the database open for inspection */
    },
  };

  const storage = new CapacitorSqliteStorage();
  (storage as any).db = bridge;
  (storage as any).dbName = "risuai-local";
  (storage as any)._enabled = true;
  (storage as any).initialized = true;
  (storage as any).revision = 0;
  (storage as any).__log = log;
  (storage as any).createRestoreStream = () => {
    let statementCount = 0;
    let opened = false;
    let progress: ((completed: number) => void) | undefined;
    return {
      open: async (
        _expectedRevision: number,
        onProgress?: (completed: number) => void,
      ) => {
        if (opened) throw new Error("Restore stream already open");
        opened = true;
        progress = onProgress;
        await bridge.beginTransaction();
      },
      writeStatement: async (sql: string, bind: unknown[] = []) => {
        if (!opened) throw new Error("Restore stream is not open");
        db.run(sql, bind);
        statementCount++;
        progress?.(statementCount);
      },
      finish: async () => {
        await bridge.commitTransaction();
        opened = false;
        return statementCount;
      },
      abort: async () => {
        if (opened) await bridge.rollbackTransaction();
        opened = false;
      },
    };
  };
  return storage;
}

// ── Fixture seeding through the production path ──────────────────────

/**
 * Creates a storage instance over a fresh schema-initialized database.
 * Returns the storage plus its query log; tests seed data by calling the
 * production `replaceDatabase()` on the instance, which exercises the real
 * commit encoder, and inspect rows via the returned database handle.
 */
export function makeHarness<T>(
  make: (database: DatabaseSync) => T,
  schemaSql: string,
): {
  storage: T;
  database: DatabaseSync;
  queryLog: QueryLog;
} {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  const storage = make(database);
  return {
    storage,
    database,
    queryLog: (storage as any).__log as QueryLog,
  };
}

export { StatementAdapter };
