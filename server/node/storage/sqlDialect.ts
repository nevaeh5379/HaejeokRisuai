"use strict";

/**
 * The dialect vocabulary: the only place where a vendor's SQL is written.
 *
 * A dialect instance is bound to one already-open connection/transaction, so
 * transaction ownership, locking (`FOR UPDATE` / `WITH (UPDLOCK, HOLDLOCK)` /
 * `SET CONSTRAINTS ALL DEFERRED`) and progress reporting stay in the driver.
 * 트랜잭션 소유권·잠금·진행률은 드라이버에 남고, 방언 인스턴스는 이미 열린
 * 커넥션에 바인딩됩니다.
 *
 * Every method takes a logical table name from `sqlTables.ts` and row objects
 * keyed by canonical (PostgreSQL) column names.
 */

import type { SqlColumnSpec, SqlTableSpec } from "./sqlTables.ts";
import { sqlTable, sqlTableColumns } from "./sqlTables.ts";

/** A row as handed to a dialect; keys are canonical column names. */
export type SqlRow = Record<string, unknown>;

/** One "delete rows whose position >= length" instruction. */
export type PositionalPruneSpec = {
  readonly ownerId: string;
  readonly length: number;
  readonly subKind?: string;
};

/** Rows per statement batch; the value the drivers already used. */
export const SQL_BATCH_ROWS = Math.max(
  1,
  Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || "1000", 10) || 1000,
);

/** Chunks an array without copying the whole input. */
export function* sqlBatches<T>(
  rows: readonly T[],
  size: number = SQL_BATCH_ROWS,
): Generator<readonly T[]> {
  for (let start = 0; start < rows.length; start += size) {
    yield rows.slice(start, Math.min(rows.length, start + size));
  }
}

/** Resolves a table spec and asserts it is writable. */
export function writableTable(name: string): {
  spec: SqlTableSpec;
  columns: readonly SqlColumnSpec[];
} {
  const spec = sqlTable(name);
  return { spec, columns: sqlTableColumns(name) };
}

/** Escapes a string literal for a dialect that inlines fixed values. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Serializes a `json` value for dialects that store JSON as text. */
export function encodeJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

/**
 * The vendor-independent statements every driver needs.
 * 모든 메서드는 이미 열린 트랜잭션 안에서 호출됩니다.
 */
export interface SqlDialect {
  /** `INSERT` every row of a writable table. */
  insertRows(table: string, rows: readonly SqlRow[]): Promise<void>;
  /** `INSERT … ON CONFLICT/MERGE` on the spec key. Falls back to insert. */
  upsertRows(table: string, rows: readonly SqlRow[]): Promise<void>;
  /** Deletes rows matched by the given key tuples. */
  deleteByKeys(
    table: string,
    keyColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void>;
  /** Deletes rows whose `position` is at or past the owner's declared length. */
  prunePositions(
    table: string,
    ownerColumn: string,
    specs: readonly PositionalPruneSpec[],
    subKindColumn?: string | null,
  ): Promise<void>;
  /** `position = position + amount`, used before re-sequencing. */
  bumpPositions(table: string, amount: number): Promise<void>;
  /** Assigns `position = 0..n-1` following the given id order. */
  setPositions(
    table: string,
    idColumn: string,
    ids: readonly string[],
  ): Promise<void>;
  /** Reads a whole table in spec order (snapshot). */
  selectOrdered(table: string): Promise<SqlRow[]>;
  /** Reads the rows of one owner, in spec order. */
  selectByKey(table: string, column: string, value: string): Promise<SqlRow[]>;
  /** Exact row count of a table. */
  countRows(table: string): Promise<number>;
}
