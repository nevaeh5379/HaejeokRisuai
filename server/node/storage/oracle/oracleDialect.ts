"use strict";

/**
 * Oracle dialect.
 *
 * Oracle is the dialect that needs the most translation, and all of it is
 * collected here: flat table names (`chat.messages` → `chat_messages`),
 * reserved-word column renames (`key` → `key_value`), CLOB/BLOB binding with
 * the ORA-24816 ordering rule, `MERGE INTO` upserts and `executeMany` batches.
 * The statement shapes and workarounds are the ones `oracleStorage.ts` already
 * used; only the column/type source changed from per-table maps to the shared
 * spec.
 */

import type { SqlDialect, SqlRow } from "../sqlDialect.ts";
import {
  SQL_BATCH_ROWS,
  encodeJsonValue,
  sqlStringLiteral,
  writableTable,
} from "../sqlDialect.ts";
import type { SqlColumnSpec, SqlColumnType } from "../sqlTables.ts";
import { sqlTable } from "../sqlTables.ts";
import { loadOracle } from "../../util/runtimeModules.ts";

/** Structural stand-in for the untyped `oracledb` module. */
export type OracleModule = typeof import("oracledb");

/** Minimal connection surface the dialect uses. */
export type OracleDialectConnection = {
  execute: (sql: string, binds?: unknown, options?: unknown) => Promise<any>;
  executeMany: (
    sql: string,
    binds: readonly unknown[],
    options?: unknown,
  ) => Promise<any>;
};

/** A LOB locator as oracledb hands it back. */
type OracleLob = {
  getData?: () => Promise<unknown>;
  on?: (event: string, handler: (chunk: any) => void) => void;
  setEncoding?: (encoding: string) => void;
};

const oracledb: OracleModule = await loadOracle();

/** Logical `schema.table` → flat Oracle table name. */
const SCHEMA_PREFIX_MAP: ReadonlyArray<readonly [string, string]> = [
  ["system.", "system_"],
  ["character.", "character_"],
  ["chat.", "chat_"],
  ["cold.", "cold_"],
];

/** Oracle physical column name → canonical (PostgreSQL) column name. */
const ORACLE_TO_CANONICAL: Readonly<Record<string, string>> = {
  key_value: "key",
  comment_text: "comment",
  lore_mode: "mode",
  primarykey: "primary_key",
  format_val: "format",
  control_flag: "control",
  shift_flag: "shift",
  alt_flag: "alt",
  sequence_num: "sequence",
};

/**
 * Canonical → Oracle physical column names, per table.
 *
 * The renames are not global: `system.settings` keeps `key` while
 * `chat.attributes` stores it as `key_value`, so the map has to be scoped by
 * table. Derived from the three schema files (see the conformance test).
 * 예약어 회피 리네임은 테이블별입니다. `system.settings`는 `key`를 그대로 쓰고
 * `chat.attributes`만 `key_value`를 씁니다.
 */
const COLUMN_RENAMES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "system.audit_log": { sequence: "sequence_num" },
  "system.global_lore_entries": {
    primary_key: "primarykey",
    comment: "comment_text",
    mode: "lore_mode",
  },
  "system.hotkeys": {
    key: "key_value",
    control: "control_flag",
    shift: "shift_flag",
    alt: "alt_flag",
  },
  "system.custom_models": { format: "format_val" },
  "system.loadout_variables": { key: "key_value" },
  "system.additional_parameters": { key: "key_value" },
  "character.attributes": { key: "key_value" },
  "character.scripts": { comment: "comment_text" },
  "character.sd_data": { key: "key_value" },
  "character.lore_entries": {
    primary_key: "primarykey",
    comment: "comment_text",
    mode: "lore_mode",
  },
  "chat.attributes": { key: "key_value" },
  "chat.script_state": { key: "key_value" },
  "chat.lore_entries": {
    primary_key: "primarykey",
    comment: "comment_text",
    mode: "lore_mode",
  },
  "chat.message_attributes": { key: "key_value" },
  "cold.archive_attributes": { key: "key_value" },
  "cold.character_scripts": { comment: "comment_text" },
  "cold.character_sd_data": { key: "key_value" },
  "cold.character_lore_entries": {
    primary_key: "primarykey",
    comment: "comment_text",
    mode: "lore_mode",
  },
  "cold.chat_attributes": { key: "key_value" },
  "cold.chat_script_state": { key: "key_value" },
  "cold.chat_lore_entries": {
    primary_key: "primarykey",
    comment: "comment_text",
    mode: "lore_mode",
  },
  "cold.message_attributes": { key: "key_value" },
};

/**
 * Read hints for tables whose LOB columns the spec does not declare yet.
 *
 * `selectOrdered` needs to know which columns arrive as CLOB/BLOB locators;
 * `oracledb` already fetches them as strings/buffers globally, so this is the
 * safety net and the place the write path's neutral types will replace it.
 * 스펙에 컬럼이 선언되지 않은 테이블의 LOB 컬럼 목록입니다.
 */
const LOB_COLUMNS: Readonly<
  Record<string, { text?: readonly string[]; binary?: readonly string[] }>
> = {
  "system.settings": { text: ["text_val"] },
  "system.setting_values": {
    text: [
      "member_key",
      "encoded_member_key",
      "text_value",
      "encoded_text_value",
    ],
  },
  "system.module_values": {
    text: [
      "member_key",
      "encoded_member_key",
      "text_value",
      "encoded_text_value",
    ],
  },
  "system.plugin_values": {
    text: [
      "member_key",
      "encoded_member_key",
      "text_value",
      "encoded_text_value",
    ],
  },
  "system.plugin_scripts": { text: ["script"] },
  "system.bot_presets": { text: ["image", "data"] },
  "character.characters": {
    text: [
      "image",
      "first_message",
      "description",
      "notes",
      "creator_notes",
      "system_prompt",
      "post_history_instructions",
      "personality",
      "scenario",
      "example_message",
      "license",
      "default_variables",
      "additional_text",
      "translator_note",
      "background_html",
      "background_css",
    ],
  },
  "character.attributes": { text: ["value"] },
  "character.tags": {},
  "character.greetings": { text: ["content"] },
  "character.emotions": { text: ["asset"] },
  "character.scripts": {
    text: ["comment", "input_text", "output_text", "flag", "trigger_payload"],
  },
  "character.sd_data": { text: ["value"] },
  "character.assets": { text: ["uri", "extra_value"] },
  "character.lore_entries": {
    text: ["comment", "content"],
    binary: [],
  },
  "chat.chats": {
    text: ["note", "sd_data", "supa_memory_data", "last_memory"],
  },
  "chat.attributes": { text: ["value"] },
  "chat.suggestions": { text: ["content"] },
  "chat.script_state": { text: ["text_value"] },
  "chat.memory": { text: ["payload"] },
  "chat.lore_entries": { text: ["comment", "content"] },
  "chat.messages": { text: ["content_text"], binary: ["content_binary"] },
  "chat.message_attributes": { text: ["value"] },
  "chat.message_prompt_toggles": { text: ["toggle_value"] },
  "chat.message_prompt_items": { text: ["payload"] },
};

/** Short strings can bind straight to CLOB columns below this size. */
const STRING_BIND_MAX_BYTES = 4000;
/** Rows per `executeMany` call; matches the driver's existing chunk. */
const ORACLE_BIND_CHUNK_ROWS = 500;

/** Returns the flat Oracle table name for a logical name. */
export function oracleTableName(table: string): string {
  for (const [prefix, replacement] of SCHEMA_PREFIX_MAP) {
    if (table.startsWith(prefix)) {
      return replacement + table.slice(prefix.length);
    }
  }
  return table;
}

/** Returns the Oracle physical column name for a canonical name. */
export function oracleColumnName(table: string, column: string): string {
  return COLUMN_RENAMES[table]?.[column] || column;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return value;
}

function quoteTable(table: string): string {
  return assertIdentifier(oracleTableName(table));
}

/** Oracle physical column, upper-cased like the schema objects. */
function physicalColumn(table: string, column: string): string {
  return assertIdentifier(oracleColumnName(table, column)).toUpperCase();
}

/** Whether a neutral type is stored as a LOB (needs LOB-last ordering). */
function isLobType(type: SqlColumnType): boolean {
  return type === "text" || type === "json" || type === "binary";
}

/** Bind type for one neutral column type. */
function bindTypeOf(type: SqlColumnType): number {
  if (type === "binary") return oracledb.DB_TYPE_BLOB;
  if (type === "text" || type === "json") return oracledb.DB_TYPE_CLOB;
  if (type === "key") return oracledb.DB_TYPE_VARCHAR;
  if (type === "timestamp") return oracledb.DB_TYPE_TIMESTAMP;
  return oracledb.DB_TYPE_NUMBER;
}

/** Converts one value into what oracledb should bind for that type. */
function bindValue(value: unknown, type: SqlColumnType): unknown {
  if (type === "json") return encodeJsonValue(value);
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (type === "binary" && typeof value === "string") {
    return Buffer.from(value);
  }
  return value;
}

/** Lower-cases column keys and restores the canonical names. */
function mapRow(row: unknown): SqlRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return {};
  const result: SqlRow = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    result[ORACLE_TO_CANONICAL[lower] || lower] = value;
  }
  return result;
}

/** Reads a LOB locator into a string (or leaves parsed JSON alone). */
async function lobToString(value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "object") {
    const lob = value as OracleLob;
    if (typeof lob.getData === "function") {
      const data = await lob.getData();
      return typeof data === "string"
        ? data
        : Buffer.from(data as ArrayBufferLike).toString("utf8");
    }
    if (typeof lob.on === "function") {
      return await new Promise<string>((resolve, reject) => {
        const chunks: string[] = [];
        lob.setEncoding?.("utf8");
        lob.on?.("data", (chunk: string) => chunks.push(chunk));
        lob.on?.("end", () => resolve(chunks.join("")));
        lob.on?.("error", reject);
      });
    }
    return value;
  }
  return String(value);
}

/** Reads a BLOB locator into a Buffer. */
async function lobToBuffer(value: unknown): Promise<Buffer | null> {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (typeof value === "object") {
    const lob = value as OracleLob;
    if (typeof lob.getData === "function") {
      const data = await lob.getData();
      return Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBufferLike);
    }
    if (typeof lob.on === "function") {
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        lob.on?.("data", (chunk: Buffer) => chunks.push(chunk));
        lob.on?.("end", () => resolve(Buffer.concat(chunks)));
        lob.on?.("error", reject);
      });
    }
  }
  return Buffer.from(String(value));
}

/** Oracle implementation of the dialect vocabulary. */
export class OracleDialect implements SqlDialect {
  readonly connection: OracleDialectConnection;

  constructor(connection: OracleDialectConnection) {
    this.connection = connection;
  }

  /**
   * `executeMany` insert. Oracle requires LOB columns to sit after every
   * non-LOB column (ORA-24816), and short strings bind directly to CLOB
   * columns to avoid a temporary LOB per value.
   */
  async insertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { columns } = writableTable(table);
    const ordered: readonly SqlColumnSpec[] = [
      ...columns.filter(([, type]) => !isLobType(type)),
      ...columns.filter(([, type]) => isLobType(type)),
    ];
    const jsonColumns = new Set(
      ordered
        .filter(([, type]) => type === "json")
        .map(([column]) => physicalColumn(table, column)),
    );
    const bindNames = ordered
      .map(([column], index) =>
        jsonColumns.has(physicalColumn(table, column))
          ? `JSON(:${index + 1})`
          : `:${index + 1}`,
      )
      .join(", ");
    const statement = `INSERT INTO ${quoteTable(table)} (${ordered
      .map(([column]) => physicalColumn(table, column))
      .join(", ")}) VALUES (${bindNames})`;

    const baseTypes = ordered.map(([, type]) => bindTypeOf(type));
    let chunkBinds: unknown[][] = [];
    let chunkTypes: number[] = [];
    let chunkSizes: number[] = [];

    const flush = async () => {
      if (chunkBinds.length === 0) return;
      const bindDefs = chunkTypes.map((type, index) =>
        type === oracledb.DB_TYPE_VARCHAR
          ? {
              type,
              maxSize:
                baseTypes[index] === oracledb.DB_TYPE_CLOB
                  ? chunkSizes[index]
                  : STRING_BIND_MAX_BYTES,
            }
          : { type },
      );
      await this.connection.executeMany(statement, chunkBinds, { bindDefs });
      chunkBinds = [];
    };

    for (const row of rows) {
      if (chunkBinds.length >= ORACLE_BIND_CHUNK_ROWS) await flush();
      const binds = ordered.map(([column, type]) =>
        bindValue(row[column], type),
      );
      const sizes = binds.map((value) =>
        typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0,
      );
      // Short values may share a VARCHAR bind; a longer neighbour would force
      // the whole chunk through the temporary-LOB path, so flush first.
      const types = baseTypes.map((type, index) =>
        type === oracledb.DB_TYPE_CLOB && sizes[index] <= STRING_BIND_MAX_BYTES
          ? oracledb.DB_TYPE_VARCHAR
          : type,
      );
      if (
        chunkBinds.length > 0 &&
        types.some((type, index) => type !== chunkTypes[index])
      ) {
        await flush();
      }
      if (chunkBinds.length === 0) {
        chunkTypes = types;
        chunkSizes = sizes.map((size) => Math.max(1, size));
      } else {
        for (let index = 0; index < sizes.length; index++) {
          chunkSizes[index] = Math.max(chunkSizes[index], sizes[index]);
        }
      }
      chunkBinds.push(binds);
    }
    await flush();
  }

  /**
   * Update-then-insert upsert, which is the shape `oracleStorage.ts` already
   * used: one PL/SQL block with named binds, batched through `executeMany`.
   */
  async upsertRows(table: string, rows: readonly SqlRow[]): Promise<void> {
    const spec = sqlTable(table);
    if (!spec.key || spec.key.length === 0) {
      await this.insertRows(table, rows);
      return;
    }
    if (rows.length === 0) return;
    const { columns } = writableTable(table);
    const keyColumns = new Set(
      spec.key.map((column) => physicalColumn(table, column)),
    );
    const physical = columns.map(([column]) => physicalColumn(table, column));
    const updateColumns = physical.filter((column) => !keyColumns.has(column));
    const where = spec.key
      .map((column) => `${physicalColumn(table, column)} = :${column}`)
      .join(" AND ");
    const touch = spec.touch ? ", updated_at = SYSTIMESTAMP" : "";
    const statement = `BEGIN
            UPDATE ${quoteTable(table)} SET
                ${updateColumns.map((column) => `${column} = :${column}`).join(", ")}${touch}
            WHERE ${where};
            IF SQL%ROWCOUNT = 0 THEN
                INSERT INTO ${quoteTable(table)} (${physical.join(", ")})
                VALUES (${columns.map(([column]) => `:${column}`).join(", ")});
            END IF;
        END;`;

    const bindDefs: Record<string, { type: number; maxSize?: number }> = {};
    for (const [column, type] of columns) {
      const bindType = bindTypeOf(type);
      bindDefs[column] =
        bindType === oracledb.DB_TYPE_VARCHAR
          ? { type: bindType, maxSize: STRING_BIND_MAX_BYTES }
          : { type: bindType };
    }
    const binds = rows.map((row) =>
      Object.fromEntries(
        columns.map(([column, type]) => [column, bindValue(row[column], type)]),
      ),
    );
    for (let start = 0; start < binds.length; start += SQL_BATCH_ROWS) {
      await this.connection.executeMany(
        statement,
        binds.slice(start, start + SQL_BATCH_ROWS),
        { bindDefs },
      );
    }
  }

  async deleteByKeys(
    table: string,
    keyColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (rows.length === 0 || keyColumns.length === 0) return;
    const physical = keyColumns.map((column) => physicalColumn(table, column));
    const where = physical
      .map((column, index) => `${column} = :${index + 1}`)
      .join(" AND ");
    const statement = `DELETE FROM ${quoteTable(table)} WHERE ${where}`;
    const bindDefs = keyColumns.map(() => ({
      type: oracledb.DB_TYPE_VARCHAR,
      maxSize: STRING_BIND_MAX_BYTES,
    }));
    for (let start = 0; start < rows.length; start += SQL_BATCH_ROWS) {
      const batch = rows
        .slice(start, start + SQL_BATCH_ROWS)
        .map((row) => row.map((value) => value ?? null));
      await this.connection.executeMany(statement, batch, { bindDefs });
    }
  }

  async prunePositions(
    table: string,
    ownerColumn: string,
    specs: readonly { ownerId: string; length: number; subKind?: string }[],
    subKindColumn?: string | null,
  ): Promise<void> {
    if (specs.length === 0) return;
    const owner = physicalColumn(table, ownerColumn);
    const subKind = subKindColumn ? physicalColumn(table, subKindColumn) : null;
    const where = subKind
      ? `${owner} = :1 AND ${subKind} = :2 AND position >= :3`
      : `${owner} = :1 AND position >= :2`;
    const statement = `DELETE FROM ${quoteTable(table)} WHERE ${where}`;
    for (let start = 0; start < specs.length; start += SQL_BATCH_ROWS) {
      const batch = specs
        .slice(start, start + SQL_BATCH_ROWS)
        .map((item) =>
          subKind
            ? [item.ownerId, item.subKind ?? null, item.length]
            : [item.ownerId, item.length],
        );
      await this.connection.executeMany(statement, batch);
    }
  }

  async bumpPositions(table: string, amount: number): Promise<void> {
    await this.connection.execute(
      `UPDATE ${quoteTable(table)} SET position = position + :1`,
      [amount],
    );
  }

  async setPositions(
    table: string,
    idColumn: string,
    ids: readonly string[],
  ): Promise<void> {
    const statement = `UPDATE ${quoteTable(table)} SET position = :1 WHERE ${physicalColumn(table, idColumn)} = :2`;
    const binds = ids.map((id, position) => [position, id]);
    if (binds.length === 0) return;
    await this.connection.executeMany(statement, binds);
  }

  /**
   * `SELECT *` in spec order. Oracle returns upper-cased column names, CLOBs
   * and BLOBs as locators, so the rows are remapped and hydrated here — the
   * driver's `fetchRows` did the same for every read.
   */
  async selectOrdered(table: string): Promise<SqlRow[]> {
    const spec = sqlTable(table);
    const exclude = spec.excludeOnSnapshot;
    const where = exclude
      ? ` WHERE ${physicalColumn(table, exclude.column)} NOT IN (${exclude.values
          .map(sqlStringLiteral)
          .join(", ")})`
      : "";
    const order =
      spec.orderBy.length > 0
        ? ` ORDER BY ${spec.orderBy
            .map((column) => physicalColumn(table, column))
            .join(", ")}`
        : "";
    const result = await this.connection.execute(
      `SELECT * FROM ${quoteTable(table)}${where}${order}`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const rows: unknown[] = result.rows || [];
    const hydrated: SqlRow[] = [];
    for (const raw of rows) hydrated.push(await this.restoreRow(table, raw));
    return hydrated;
  }

  /**
   * Canonicalizes one raw Oracle row: upper-case keys, reserved-word renames,
   * LOB locators and the empty-string sentinel.
   * Oracle이 돌려준 행을 canonical 형태로 되돌립니다.
   */
  private async restoreRow(table: string, raw: unknown): Promise<SqlRow> {
    const spec = sqlTable(table);
    // Type information comes from the spec where it is declared; the driver
    // also sets fetchAsString/fetchAsBuffer globally for everything else.
    const textColumns = new Set<string>();
    const binaryColumns = new Set<string>();
    for (const [column, type] of spec.columns ?? []) {
      if (type === "binary") binaryColumns.add(column);
      else if (type === "text" || type === "json") textColumns.add(column);
    }
    const hints = LOB_COLUMNS[table];
    for (const column of hints?.text ?? []) textColumns.add(column);
    for (const column of hints?.binary ?? []) {
      binaryColumns.add(column);
      textColumns.delete(column);
    }
    const row = mapRow(raw);
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      if (binaryColumns.has(key)) row[key] = await lobToBuffer(value);
      else if (textColumns.has(key)) row[key] = await lobToString(value);
    }
    for (const key of Object.keys(row)) {
      if (row[key] === "\u0000") row[key] = "";
    }
    return row;
  }

  async selectByKey(
    table: string,
    column: string,
    value: string,
  ): Promise<SqlRow[]> {
    const spec = sqlTable(table);
    const order =
      spec.orderBy.length > 0
        ? ` ORDER BY ${spec.orderBy
            .map((name) => physicalColumn(table, name))
            .join(", ")}`
        : "";
    const result = await this.connection.execute(
      `SELECT * FROM ${quoteTable(table)} WHERE ${physicalColumn(table, column)} = :1${order}`,
      [value],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const rows: unknown[] = result.rows || [];
    const restored: SqlRow[] = [];
    for (const raw of rows) restored.push(await this.restoreRow(table, raw));
    return restored;
  }

  async countRows(table: string): Promise<number> {
    const result = await this.connection.execute(
      `SELECT COUNT(*) AS total FROM ${quoteTable(table)}`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = mapRow(result.rows?.[0]);
    return Number(row.total ?? 0);
  }
}
