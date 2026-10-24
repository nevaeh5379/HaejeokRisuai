"use strict";

/**
 * Azure SQL dialect: `OPENJSON(@bulkPayload)` bulk inserts, `MERGE … USING
 * (OPENJSON)` upserts and `DELETE … INNER JOIN OPENJSON` keyed deletes. The
 * statement shapes come from `azureStorage.ts`; only the column/type source
 * changed from hand-written arrays to the shared table spec.
 */

import type { SqlDialect, SqlRow } from "../sqlDialect.ts";
import { sqlBatches, sqlStringLiteral, writableTable } from "../sqlDialect.ts";
import type { SqlColumnSpec, SqlColumnType } from "../sqlTables.ts";
import { sqlTable } from "../sqlTables.ts";
import { loadMssql } from "../../util/runtimeModules.ts";

const sql: typeof import("mssql") = await loadMssql();

/** Pool or transaction, matching what the driver already holds. */
export type AzureDialectTarget =
  import("mssql").ConnectionPool | import("mssql").Transaction;

/**
 * Neutral type → `OPENJSON … WITH` declaration.
 *
 * The `WITH` clause types the JSON payload, not the destination column, so
 * every string kind stays `NVARCHAR(MAX)`: a short `NVARCHAR(n)` there would
 * truncate longer values before the insert checks the real column.
 */
const OPENJSON_TYPES: Record<SqlColumnType, string> = {
  text: "NVARCHAR(MAX)",
  key: "NVARCHAR(MAX)",
  int: "INT",
  bigint: "BIGINT",
  float: "FLOAT",
  bool: "BIT",
  json: "NVARCHAR(MAX)",
  binary: "NVARCHAR(MAX)",
  timestamp: "DATETIMEOFFSET",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes `schema.table` the way the driver already did. */
function quoteTable(table: string): string {
  const parts = table.split(".");
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new Error(`Unsafe SQL identifier: ${table}`);
  }
  return parts.map((part) => `[${part}]`).join(".");
}

function quote(column: string): string {
  if (!IDENTIFIER.test(column)) {
    throw new Error(`Unsafe SQL identifier: ${column}`);
  }
  return `[${column}]`;
}

/** Column value as it travels inside the JSON payload. */
function payloadValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** `OPENJSON` payload column definitions and their `SELECT` projections. */
function openJsonColumns(columns: readonly SqlColumnSpec[]): {
  definitions: string[];
  projections: string[];
} {
  const definitions: string[] = [];
  const projections: string[] = [];
  for (const [column, type] of columns) {
    definitions.push(`[${column}] ${OPENJSON_TYPES[type]} '$.${column}'`);
    projections.push(
      type === "binary"
        ? `CASE WHEN [${column}] IS NOT NULL THEN CONVERT(VARBINARY(MAX), [${column}], 2) ELSE NULL END AS [${column}]`
        : `[${column}]`,
    );
  }
  return { definitions, projections };
}

/** Azure SQL implementation of the dialect vocabulary. */
export class AzureDialect implements SqlDialect {
  readonly target: AzureDialectTarget;

  constructor(target: AzureDialectTarget) {
    this.target = target;
  }

  private request(): import("mssql").Request {
    return "request" in this.target
      ? this.target.request()
      : new sql.Request(this.target);
  }

  private async insert(
    table: string,
    rows: readonly SqlRow[],
    merge: boolean,
  ): Promise<void> {
    if (rows.length === 0) return;
    const { spec, columns } = writableTable(table);
    const names = columns.map(([column]) => column);
    const { definitions, projections } = openJsonColumns(columns);
    const mergeKeys = merge && spec.key ? [...spec.key] : null;

    for (const batch of sqlBatches(rows)) {
      const payload = batch.map((row) => {
        const item: Record<string, unknown> = {};
        for (const [column] of columns) {
          item[column] = payloadValue(row[column]);
        }
        return item;
      });
      const request = this.request();
      request.input(
        "bulkPayload",
        sql.NVarChar(sql.MAX),
        JSON.stringify(payload),
      );
      const source = `(
                    SELECT ${projections.join(", ")}
                    FROM OPENJSON(@bulkPayload)
                    WITH (
                        ${definitions.join(",\n                        ")}
                    )
                )`;

      if (mergeKeys && mergeKeys.length > 0) {
        const match = mergeKeys
          .map((column) => `target.[${column}] = source.[${column}]`)
          .join(" AND ");
        const nonKeys = names.filter((column) => !mergeKeys.includes(column));
        const update =
          nonKeys.length > 0
            ? `WHEN MATCHED THEN UPDATE SET ${nonKeys
                .map((column) => `[${column}] = source.[${column}]`)
                .join(", ")}`
            : `WHEN MATCHED THEN UPDATE SET target.[${mergeKeys[0]}] = source.[${mergeKeys[0]}]`;
        await request.query(`
                MERGE INTO ${quoteTable(table)} AS target
                USING ${source} AS source
                ON ${match}
                ${update}
                WHEN NOT MATCHED THEN
                    INSERT (${names.map(quote).join(", ")})
                    VALUES (${names.map((column) => `source.[${column}]`).join(", ")});
            `);
      } else {
        await request.query(`
                INSERT INTO ${quoteTable(table)} (${names.map(quote).join(", ")})
                SELECT ${projections.join(", ")}
                FROM OPENJSON(@bulkPayload)
                WITH (
                    ${definitions.join(",\n                    ")}
                );
            `);
      }
    }
  }

  async insertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    await this.insert(table, rows, false);
  }

  async upsertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    await this.insert(table, rows, true);
  }

  async deleteByKeys(
    table: string,
    keyColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (rows.length === 0 || keyColumns.length === 0) return;
    const { columns } = writableTable(table);
    const withClause = keyColumns
      .map((column) => {
        const type = columns.find(([name]) => name === column)?.[1] ?? "key";
        return `${column} ${OPENJSON_TYPES[type as SqlColumnType]} '$.${column}'`;
      })
      .join(", ");
    const join = keyColumns
      .map((column) => `targetRows.[${column}] = src.[${column}]`)
      .join(" AND ");
    const request = this.request();
    request.input(
      "keyPayload",
      sql.NVarChar(sql.MAX),
      JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(
            keyColumns.map((column, index) => [column, row[index] ?? null]),
          ),
        ),
      ),
    );
    await request.query(`DELETE targetRows FROM ${quoteTable(table)} targetRows
                    INNER JOIN OPENJSON(@keyPayload) WITH (
                        ${withClause}
                    ) src ON ${join};`);
  }

  async prunePositions(
    table: string,
    ownerColumn: string,
    specs: readonly { ownerId: string; length: number; subKind?: string }[],
    subKindColumn?: string | null,
  ): Promise<void> {
    if (specs.length === 0) return;
    const withClause = [
      `${ownerColumn} NVARCHAR(450) '$.ownerId'`,
      `target_len INT '$.length'`,
      ...(subKindColumn ? [`${subKindColumn} NVARCHAR(450) '$.subKind'`] : []),
    ].join(", ");
    const subKindMatch = subKindColumn
      ? ` AND targetRows.[${subKindColumn}] = src.[${subKindColumn}]`
      : "";
    for (const batch of sqlBatches(specs)) {
      const request = this.request();
      request.input(
        "pruneSpec",
        sql.NVarChar(sql.MAX),
        JSON.stringify(
          batch.map((item) => ({
            ownerId: item.ownerId,
            length: item.length,
            ...(subKindColumn ? { subKind: item.subKind ?? null } : {}),
          })),
        ),
      );
      await request.query(`DELETE targetRows FROM ${quoteTable(table)} targetRows
                    INNER JOIN OPENJSON(@pruneSpec) WITH (
                        ${withClause}
                    ) src ON targetRows.[${ownerColumn}] = src.[${ownerColumn}]${subKindMatch}
                    WHERE targetRows.[position] >= src.target_len;`);
    }
  }

  async bumpPositions(table: string, amount: number): Promise<void> {
    const request = this.request();
    request.input("bumpAmount", sql.Int, amount);
    await request.query(
      `UPDATE ${quoteTable(table)} SET [position] = [position] + @bumpAmount;`,
    );
  }

  async setPositions(
    table: string,
    idColumn: string,
    ids: readonly string[],
  ): Promise<void> {
    for (let position = 0; position < ids.length; position++) {
      const request = this.request();
      request.input("position", sql.Int, position);
      request.input("positionId", sql.NVarChar(450), ids[position]);
      await request.query(
        `UPDATE ${quoteTable(table)} SET [position] = @position WHERE ${quote(idColumn)} = @positionId;`,
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
    const result = await this.request().query<SqlRow>(
      `SELECT * FROM ${quoteTable(table)}${where}${order}`,
    );
    return result.recordset ?? [];
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
    const request = this.request();
    request.input("filterValue", sql.NVarChar(450), value);
    const result = await request.query<SqlRow>(
      `SELECT * FROM ${quoteTable(table)} WHERE ${quote(column)} = @filterValue${order}`,
    );
    return result.recordset ?? [];
  }

  async countRows(table: string): Promise<number> {
    const result = await this.request().query<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM ${quoteTable(table)}`,
    );
    return Number(result.recordset?.[0]?.total ?? 0);
  }
}
