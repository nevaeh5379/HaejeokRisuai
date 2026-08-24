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
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  SQLITE_SCHEMA_VERSION,
  RELATIONAL_SCHEMA_LAYOUT,
  SqlSchemaResetRequiredError,
} from "./relationalNodeCodec";

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

interface Sqlite3Module {
  oo1: {
    OpfsDb: new (filename: string) => SqliteDb;
    DB: new (filename: string, mode: string) => SqliteDb;
  };
  version: { libVersion: string };
}

const DB_FILE = "/risuai-local.sqlite3";

let db: SqliteDb | null = null;
let revision = 0;
let enabled = false;

function selectRowsInternal(
  sql: string,
  bind: unknown[] = [],
): { rows: Record<string, unknown>[]; columns: string[] } {
  if (!db) throw new Error("Database not opened");
  const stmt = db.prepare(sql);
  try {
    if (bind.length > 0) stmt.bind(bind);
    const results: Record<string, unknown>[] = [];
    let cols: string[] = [];
    while (stmt.step()) {
      cols = stmt.getColumnNames([]);
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

async function handleInit(): Promise<{ enabled: boolean; revision: number }> {
  if (db && enabled) return { enabled, revision };
  try {
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Module;
    // After initialization, `sqlite3.opfs` (the internal utility namespace) is
    // deleted in non-test contexts.  The real indicator that OPFS is available
    // is whether `sqlite3.oo1.OpfsDb` was installed by `installOpfsVfs()`.
    if (typeof sqlite3.oo1?.OpfsDb !== "function")
      throw new Error("OPFS not available");
    db = new sqlite3.oo1.OpfsDb(DB_FILE);
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
    db.exec("PRAGMA journal_mode = WAL;");
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
    return { enabled, revision };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Ignore cleanup failures and preserve the initialization error.
    }
    db = null;
    enabled = false;
    if (error instanceof SqlSchemaResetRequiredError) throw error;
    throw error;
  }
}

type ReqMsg =
  | { id: number; type: "init" }
  | { id: number; type: "exec"; sql: string; bind?: unknown[] }
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