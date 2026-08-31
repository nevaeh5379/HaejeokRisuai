/**
 * Web Worker that hosts SQLite WASM with OPFS persistence.
 *
 * SQLite WASM's OPFS VFS can only be installed inside a Worker because
 * `FileSystemFileHandle.createSyncAccessHandle` is exclusively available
 * in Web Worker contexts.  The main thread posts high-level RPC requests
 * and this worker replies with the results.
 *
 * Message protocol (all messages carry `id` for correlation):
 *
 *   req: { id, type: "init" }
 *   res: { id, ok: true, result: { enabled, revision } }
 *   res: { id, ok: false, error }
 *
 *   req: { id, type: "exec", sql, bind? }
 *   res: { id, ok: true }
 *
 *   req: { id, type: "select", sql, bind? }
 *   res: { id, ok: true, result: { rows, columns } }
 *
 *   req: { id, type: "selectOne", sql, bind? }
 *   res: { id, ok: true, result: { row, columns } | null }
 *
 *   req: { id, type: "close" }
 *   res: { id, ok: true }
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import sqliteSchemaSql from "../sqlite-schema.sql?raw";
import {
  rebuildRelationalValue,
  decodedText,
  SQLITE_SCHEMA_VERSION,
  RELATIONAL_SCHEMA_LAYOUT,
  SqlSchemaResetRequiredError,
} from "../relationalNodeCodec";

interface SqliteStmt {
  bind: (params: unknown[]) => void;
  step: () => boolean;
  get: (ndx?: unknown[] | Record<string, unknown> | number) => unknown[] | unknown;
  getColumnNames: (tgt?: string[]) => string[];
  finalize: () => void;
}

interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStmt;
  close: () => void;
}

interface SahPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => SqliteDb;
  getFileNames: () => string[];
  importDb: (filename: string, data: Uint8Array | ArrayBuffer) => Promise<number>;
  reserveMinimumCapacity: (minimum: number) => Promise<number>;
  unlink: (filename: string) => boolean;
}

interface Sqlite3Module {
  oo1: {
    OpfsDb: new (filename: string, flags?: string) => SqliteDb;
    DB: new (filename: string, mode: string) => SqliteDb;
  };
  capi: {
    sqlite3_js_db_export: (database: SqliteDb) => Uint8Array;
  };
  installOpfsSAHPoolVfs?: (options?: {
    clearOnInit?: boolean;
    initialCapacity?: number;
    directory?: string;
    name?: string;
  }) => Promise<SahPoolUtil>;
  version: { libVersion: string };
}

const DB_FILE = "/risuai-local.sqlite3";
const SAH_POOL_DIRECTORY = "/.risuai-sahpool-v1";
const SAH_POOL_MARKER = ".risuai-sahpool-v1-migrated";
const SAH_POOL_CAPACITY = 8;

let db: SqliteDb | null = null;
let revision = 0;
let enabled = false;
let activeVfs: "opfs-sahpool" | "opfs" | null = null;

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("OPFS not available");
  }
  return navigator.storage.getDirectory();
}

async function opfsRootFileExists(filename: string): Promise<boolean> {
  try {
    const root = await getOpfsRoot();
    await root.getFileHandle(filename.replace(/^\/+/, ""), { create: false });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    throw error;
  }
}

async function writeSahMigrationMarker(): Promise<void> {
  const root = await getOpfsRoot();
  const handle = await root.getFileHandle(SAH_POOL_MARKER, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(
      JSON.stringify({
        vfs: "opfs-sahpool",
        database: DB_FILE,
        migratedAt: new Date().toISOString(),
      }),
    );
  } finally {
    await writable.close();
  }
}

function queryScalar(database: SqliteDb, sql: string): unknown {
  const stmt = database.prepare(sql);
  try {
    if (!stmt.step()) return undefined;
    return (stmt.get([]) as unknown[])[0];
  } finally {
    stmt.finalize();
  }
}

function validateDatabaseFile(database: SqliteDb): void {
  const quickCheck = String(queryScalar(database, "PRAGMA quick_check") ?? "");
  if (quickCheck !== "ok") {
    throw new Error(`SQLite quick_check failed after SAH migration: ${quickCheck}`);
  }
}

async function openPersistentDatabase(sqlite3: Sqlite3Module): Promise<SqliteDb> {
  if (typeof sqlite3.installOpfsSAHPoolVfs !== "function") {
    if (typeof sqlite3.oo1?.OpfsDb !== "function") throw new Error("OPFS not available");
    activeVfs = "opfs";
    return new sqlite3.oo1.OpfsDb(DB_FILE);
  }

  let pool: SahPoolUtil;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      directory: SAH_POOL_DIRECTORY,
      initialCapacity: SAH_POOL_CAPACITY,
    });
    await pool.reserveMinimumCapacity(SAH_POOL_CAPACITY);
  } catch (error) {
    // Never fall back to the legacy OPFS database here. Once migration has
    // completed that copy is intentionally stale, so doing so in a second tab
    // could silently fork user data. SAH-pool lock failures must remain errors.
    throw new Error(
      `Failed to acquire SQLite SAH pool. Close other RisuAI tabs and retry. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (pool.getFileNames().includes(DB_FILE)) {
    // Existing SAH databases are validated by the normal schema/version checks
    // below. A full quick_check on every startup scales with database size and
    // would turn normal launches into unnecessary OPFS reads.
    const existing = new pool.OpfsSAHPoolDb(DB_FILE);
    activeVfs = "opfs-sahpool";
    return existing;
  }

  if (await opfsRootFileExists(DB_FILE)) {
    let legacy: SqliteDb | null = new sqlite3.oo1.OpfsDb(DB_FILE);
    let exported: Uint8Array;
    try {
      // Fold any legacy WAL pages into the logical image before serialization.
      // sqlite3_js_db_export() serializes the live database through SQLite and
      // avoids depending on the physical OPFS/WAL file layout.
      try {
        legacy.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Serialization below is still the authoritative migration path.
      }
      exported = sqlite3.capi.sqlite3_js_db_export(legacy);
    } finally {
      legacy.close();
      legacy = null;
    }

    try {
      await pool.importDb(DB_FILE, exported);
      const migrated = new pool.OpfsSAHPoolDb(DB_FILE);
      try {
        validateDatabaseFile(migrated);
      } catch (error) {
        migrated.close();
        pool.unlink(DB_FILE);
        throw error;
      }
      activeVfs = "opfs-sahpool";
      try {
        await writeSahMigrationMarker();
      } catch (error) {
        console.warn("Failed to write SAH migration marker:", error);
      }
      return migrated;
    } catch (error) {
      pool.unlink(DB_FILE);
      throw new Error(
        `Failed to migrate browser SQLite database to SAH pool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const fresh = new pool.OpfsSAHPoolDb(DB_FILE);
  validateDatabaseFile(fresh);
  activeVfs = "opfs-sahpool";
  try {
    await writeSahMigrationMarker();
  } catch (error) {
    console.warn("Failed to write SAH migration marker:", error);
  }
  return fresh;
}

function selectRowsInternal(
  sql: string,
  bind: unknown[] = [],
): { rows: Record<string, unknown>[]; columns: string[] } {
  if (!db) throw new Error("Database not opened");
  const stmt = db.prepare(sql);
  try {
    if (bind.length > 0) stmt.bind(bind);
    const results: Record<string, unknown>[] = [];
    // Column metadata is stable for the lifetime of the prepared statement and
    // may be read before the first step. Avoid a JS↔WASM metadata call per row,
    // which is especially costly on large relational result sets in Firefox.
    const cols = stmt.getColumnNames([]);
    while (stmt.step()) {
      const row = stmt.get([]) as unknown[];
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      results.push(obj);
    }
    return { rows: results, columns: cols };
  } finally {
    stmt.finalize();
  }
}

function selectOneInternal(
  sql: string,
  bind: unknown[] = [],
): Record<string, unknown> | null {
  return selectRowsInternal(sql, bind).rows[0] ?? null;
}

function rebuildMessagesFromRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const nodeGroups = new Map<string, Record<string, unknown>[]>();
  const coreRows = new Map<string, Record<string, unknown>>();
  const orderedIds: string[] = [];
  for (const row of rows) {
    const id = String(row.message_id);
    if (!coreRows.has(id)) {
      coreRows.set(id, row);
      orderedIds.push(id);
    }
    if (row.node_id === null || row.node_id === undefined) continue;
    const nodes = nodeGroups.get(id) ?? [];
    nodes.push(row);
    nodeGroups.set(id, nodes);
  }
  return orderedIds.map((id) => {
    const core = coreRows.get(id)!;
    const nodes = nodeGroups.get(id);
    const rebuilt = nodes?.length ? rebuildRelationalValue(nodes) : {};
    const message =
      rebuilt && typeof rebuilt === "object"
        ? (rebuilt as Record<string, any>)
        : ({} as Record<string, any>);

    message.role = String(core.message_role ?? "char");
    if (!Object.prototype.hasOwnProperty.call(message, "data")) {
      message.data = decodedText(
        core.message_content_text as string | null,
        core.message_content_encoded as string | null,
      );
    }
    if (core.message_sender_name != null) {
      message.name = String(core.message_sender_name);
    } else {
      delete message.name;
    }
    if (core.message_sent_time != null) {
      message.time = Number(core.message_sent_time);
    } else {
      delete message.time;
    }
    message.chatId = id;

    if (
      core.message_generation_model != null ||
      core.message_input_tokens != null ||
      core.message_output_tokens != null
    ) {
      message.generationInfo ??= {};
      if (core.message_generation_model != null) {
        message.generationInfo.model = String(core.message_generation_model);
      }
      if (core.message_input_tokens != null) {
        message.generationInfo.inputTokens = Number(core.message_input_tokens);
      }
      if (core.message_output_tokens != null) {
        message.generationInfo.outputTokens = Number(core.message_output_tokens);
      }
    }
    return message;
  });
}

function runInternal(sql: string, bind: unknown[] = []): void {
  if (!db) throw new Error("Database not opened");
  if (bind.length === 0) {
    db.exec(sql);
  } else {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(bind);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }
}

async function handleInit(): Promise<{
  enabled: boolean;
  revision: number;
  vfs: "opfs-sahpool" | "opfs" | null;
}> {
  if (db && enabled) return { enabled, revision, vfs: activeVfs };
  try {
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Module;
    db = await openPersistentDatabase(sqlite3);
    // Check whether the schema has already been created (skip on first run).
    const existingMeta = selectRowsInternal(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_storage_meta'",
    ).rows;
    if (existingMeta.length) {
      const meta = selectOneInternal(
        "SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1",
      );
      if (
        Number(meta?.schema_version) !== SQLITE_SCHEMA_VERSION ||
        meta?.schema_layout !== RELATIONAL_SCHEMA_LAYOUT
      ) {
        throw new SqlSchemaResetRequiredError(
          meta?.schema_version,
          meta?.schema_layout,
        );
      }
    }
    // Apply schema — use multiple exec calls instead of one big exec to avoid
    // "Column index out of range" issues in SQLite WASM's exec() with complex
    // multi-statement SQL containing PRAGMAs.
    //
    // Do not force WAL for the SAH-pool VFS. The legacy OPFS backend's 1000-page
    // automatic WAL checkpoints can surface as multi-megabyte write bursts in
    // Firefox. SAH-pool imports explicitly disable WAL, so keep the default
    // rollback journal until a browser benchmark proves WAL is beneficial.
    if (activeVfs === "opfs") db.exec("PRAGMA journal_mode = WAL;");
    else db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("PRAGMA temp_store = MEMORY;");
    // SQLite defaults to roughly 2 MiB of page cache. Browser-side relational
    // commits can touch far more pages, so keep a larger on-demand cache to
    // reduce pager churn and mid-transaction page eviction without disabling
    // SQLite's normal cache-spill safety behavior.
    db.exec("PRAGMA cache_size = -16384;");
    db.exec("PRAGMA foreign_keys = ON;");
    // Execute the rest of the schema (CREATE TABLE / INDEX statements)
    const schemaStatements = sqliteSchemaSql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
    for (const stmt of schemaStatements) {
      db.exec(stmt + ";");
    }
    const rows = selectRowsInternal(
      "SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1",
    ).rows;
    if (rows.length > 0) revision = Number(rows[0].revision) || 0;
    enabled = true;
    return { enabled, revision, vfs: activeVfs };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Ignore cleanup failures and preserve the initialization error.
    }
    db = null;
    enabled = false;
    activeVfs = null;
    if (error instanceof SqlSchemaResetRequiredError) throw error;
    throw error;
  }
}

type ReqMsg =
  | { id: number; type: "init" }
  | { id: number; type: "exec"; sql: string; bind?: unknown[] }
  | {
      id: number;
      type: "execBatch";
      statements: { sql: string; bind?: unknown[] }[];
    }
  | {
      id: number;
      type: "selectBatch";
      statements: {
        sql: string;
        bind?: unknown[];
        transform?: "relational" | "messages";
      }[];
    }
  | { id: number; type: "select"; sql: string; bind?: unknown[] }
  | { id: number; type: "selectOne"; sql: string; bind?: unknown[] }
  | { id: number; type: "close" };

self.onmessage = async (e: MessageEvent<ReqMsg>) => {
  const msg = e.data;
  if (!msg || typeof msg.id !== "number") return;
  try {
    switch (msg.type) {
      case "init": {
        const result = await handleInit();
        (self as any).postMessage({ id: msg.id, ok: true, result });
        break;
      }
      case "exec": {
        runInternal(msg.sql, msg.bind ?? []);
        (self as any).postMessage({ id: msg.id, ok: true });
        break;
      }
      case "execBatch": {
        for (const statement of msg.statements) {
          runInternal(statement.sql, statement.bind ?? []);
        }
        (self as any).postMessage({ id: msg.id, ok: true });
        break;
      }
      case "selectBatch": {
        const result = msg.statements.map((statement) => {
          const selected = selectRowsInternal(statement.sql, statement.bind ?? []);
          if (statement.transform === "relational") {
            return {
              value: selected.rows.length
                ? rebuildRelationalValue(selected.rows)
                : undefined,
            };
          }
          if (statement.transform === "messages") {
            return { value: rebuildMessagesFromRows(selected.rows) };
          }
          return selected;
        });
        (self as any).postMessage({ id: msg.id, ok: true, result });
        break;
      }
      case "select": {
        const result = selectRowsInternal(msg.sql, msg.bind ?? []);
        (self as any).postMessage({ id: msg.id, ok: true, result });
        break;
      }
      case "selectOne": {
        const row = selectOneInternal(msg.sql, msg.bind ?? []);
        (self as any).postMessage({ id: msg.id, ok: true, result: row });
        break;
      }
      case "close": {
        try {
          db?.close();
        } catch {
          // Ignore close failures.
        }
        db = null;
        enabled = false;
        activeVfs = null;
        (self as any).postMessage({ id: msg.id, ok: true });
        break;
      }
      default: {
        (self as any).postMessage({
          id: (msg as ReqMsg).id,
          ok: false,
          error: `Unknown message type: ${(msg as any).type}`,
        });
      }
    }
  } catch (error) {
    (self as any).postMessage({
      id: msg.id,
      ok: false,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    });
  }
};