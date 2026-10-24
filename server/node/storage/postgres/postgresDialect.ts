"use strict";

/**
 * PostgreSQL dialect: `UNNEST` bulk inserts, `ON CONFLICT` upserts, `USING`
 * deletes. The statement shapes are the ones `postgresStorage.ts` already
 * emitted, moved here so the shared modules can call them.
 */

import type { SqlDialect, SqlRow } from "../sqlDialect.ts";
import { sqlBatches, sqlStringLiteral, writableTable } from "../sqlDialect.ts";
import type { SqlColumnSpec, SqlColumnType } from "../sqlTables.ts";
import { sqlTable } from "../sqlTables.ts";

/** The subset of a `pg` client the dialect needs. */
export type PgDialectClient = {
  query<TRow = SqlRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
};

/** Neutral type → PostgreSQL cast name used by `UNNEST`. */
const PG_COLUMN_TYPES: Record<SqlColumnType, string> = {
  text: "text",
  key: "text",
  int: "integer",
  bigint: "bigint",
  float: "double precision",
  bool: "boolean",
  json: "jsonb",
  binary: "bytea",
  timestamp: "timestamptz",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes `schema.table` (or a bare table) and rejects anything else. */
function quoteTable(table: string): string {
  const parts = table.split(".");
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new Error(`Unsafe SQL identifier: ${table}`);
  }
  return parts.map((part) => `"${part}"`).join(".");
}

function quote(column: string): string {
  if (!IDENTIFIER.test(column)) {
    throw new Error(`Unsafe SQL identifier: ${column}`);
  }
  return `"${column}"`;
}

/** Column-major parameter batches, JSON already serialized for `jsonb`. */
function columnBatches(
  columns: readonly SqlColumnSpec[],
  rows: readonly SqlRow[],
): readonly unknown[][] {
  return columns.map(([column, type]) => {
    const values: unknown[] = new Array(rows.length);
    for (let index = 0; index < rows.length; index++) {
      const value = rows[index][column];
      values[index] =
        type === "json"
          ? value === undefined || value === null
            ? null
            : JSON.stringify(value)
          : (value ?? null);
    }
    return values;
  });
}

/** `ON CONFLICT (key) DO UPDATE … WHERE IS DISTINCT FROM` clause. */
function buildUpsertClause(
  table: string,
  keyColumns: readonly string[],
  valueColumns: readonly string[],
  touch: boolean,
): string {
  const keyList = keyColumns.map((column) => quote(column)).join(", ");
  if (valueColumns.length === 0) {
    return `ON CONFLICT (${keyList}) DO NOTHING`;
  }
  const quotedTable = quoteTable(table);
  const sets = valueColumns.map(
    (column) => `${quote(column)} = EXCLUDED.${quote(column)}`,
  );
  if (touch) sets.push('"updated_at" = NOW()');
  const left = valueColumns.map((c) => `${quotedTable}.${quote(c)}`).join(", ");
  const right = valueColumns.map((c) => `EXCLUDED.${quote(c)}`).join(", ");
  return `ON CONFLICT (${keyList}) DO UPDATE SET
        ${sets.join(", ")}
        WHERE (${left}) IS DISTINCT FROM (${right})`;
}

/** PostgreSQL implementation of the dialect vocabulary. */
export class PostgresDialect implements SqlDialect {
  readonly client: PgDialectClient;

  constructor(client: PgDialectClient) {
    this.client = client;
  }

  private async insert(
    table: string,
    rows: readonly SqlRow[],
    suffix: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const { columns } = writableTable(table);
    const names = columns.map(([column]) => column);
    const placeholders = columns
      .map(([, type], index) => `$${index + 1}::${PG_COLUMN_TYPES[type]}[]`)
      .join(", ");
    const statement = `INSERT INTO ${quoteTable(table)} (${names
      .map(quote)
      .join(", ")})
         SELECT * FROM UNNEST(${placeholders}) AS item(${names
           .map(quote)
           .join(", ")})
         ${suffix}`;
    // One column-major batch at a time keeps large restores flat in memory.
    for (const batch of sqlBatches(rows)) {
      await this.client.query(statement, columnBatches(columns, batch));
    }
  }

  async insertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    await this.insert(table, rows, "");
  }

  async upsertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    const spec = sqlTable(table);
    if (!spec.key || spec.key.length === 0) {
      await this.insertRows(table, rows);
      return;
    }
    const { columns } = writableTable(table);
    const valueColumns = columns
      .map(([column]) => column)
      .filter((column) => !spec.key!.includes(column));
    await this.insert(
      table,
      rows,
      buildUpsertClause(table, spec.key, valueColumns, Boolean(spec.touch)),
    );
  }

  async deleteByKeys(
    table: string,
    keyColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (rows.length === 0 || keyColumns.length === 0) return;
    const { columns } = writableTable(table);
    const types = keyColumns.map(
      (column) =>
        PG_COLUMN_TYPES[
          (columns.find(([name]) => name === column)?.[1] ??
            "key") as SqlColumnType
        ],
    );
    for (const batch of sqlBatches(rows)) {
      const params = keyColumns.map((_column, index) =>
        batch.map((row) => row[index] ?? null),
      );
      const unnests = keyColumns
        .map((_column, index) => `$${index + 1}::${types[index]}[]`)
        .join(", ");
      const alias = keyColumns.map((column) => quote(column)).join(", ");
      const conditions = keyColumns
        .map((column) => `target.${quote(column)} = spec.${quote(column)}`)
        .join(" AND ");
      await this.client.query(
        `DELETE FROM ${quoteTable(table)} AS target
             USING UNNEST(${unnests}) AS spec(${alias})
             WHERE ${conditions}`,
        params,
      );
    }
  }

  async prunePositions(
    table: string,
    ownerColumn: string,
    specs: readonly { ownerId: string; length: number; subKind?: string }[],
    subKindColumn?: string | null,
  ): Promise<void> {
    if (specs.length === 0) return;
    const quotedTable = quoteTable(table);
    const owner = quote(ownerColumn);
    for (const batch of sqlBatches(specs)) {
      const owners = batch.map((item) => item.ownerId);
      const lengths = batch.map((item) => item.length);
      if (subKindColumn) {
        const subKinds = batch.map((item) => item.subKind ?? null);
        await this.client.query(
          `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(owner_id, sub_kind, target_len)
             WHERE target.${owner} = spec.owner_id
               AND target.${quote(subKindColumn)} = spec.sub_kind
               AND target."position" >= spec.target_len`,
          [owners, subKinds, lengths],
        );
      } else {
        await this.client.query(
          `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::integer[]) AS spec(owner_id, target_len)
             WHERE target.${owner} = spec.owner_id
               AND target."position" >= spec.target_len`,
          [owners, lengths],
        );
      }
    }
  }

  async bumpPositions(table: string, amount: number): Promise<void> {
    await this.client.query(
      `UPDATE ${quoteTable(table)} SET position = position + $1`,
      [amount],
    );
  }

  async setPositions(
    table: string,
    idColumn: string,
    ids: readonly string[],
  ): Promise<void> {
    for (let position = 0; position < ids.length; position++) {
      await this.client.query(
        `UPDATE ${quoteTable(table)} SET position = $1 WHERE ${quote(idColumn)} = $2`,
        [position, ids[position]],
      );
    }
  }

  async selectOrdered(table: string): Promise<SqlRow[]> {
    const spec = sqlTable(table);
    const exclude = spec.excludeOnSnapshot;
    const where = exclude
      ? ` WHERE ${quote(exclude.column)} NOT IN (${exclude.values
          .map(sqlStringLiteral)
          .join(", ")})`
      : "";
    const order =
      spec.orderBy.length > 0
        ? ` ORDER BY ${spec.orderBy.map(quote).join(", ")}`
        : "";
    const result = await this.client.query<SqlRow>(
      `SELECT * FROM ${quoteTable(table)}${where}${order}`,
    );
    return result.rows;
  }

  async selectByKey(
    table: string,
    column: string,
    value: string,
  ): Promise<SqlRow[]> {
    const spec = sqlTable(table);
    const order =
      spec.orderBy.length > 0
        ? ` ORDER BY ${spec.orderBy.map(quote).join(", ")}`
        : "";
    const result = await this.client.query<SqlRow>(
      `SELECT * FROM ${quoteTable(table)} WHERE ${quote(column)} = $1${order}`,
      [value],
    );
    return result.rows;
  }

  async countRows(table: string): Promise<number> {
    const result = await this.client.query<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteTable(table)}`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
