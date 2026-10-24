"use strict";

import protocolSettings from "../../../packages/protocol/settings.ts";

const { LEGACY_PERSONA_MIRROR_KEYS } = protocolSettings;

/**
 * One neutral description of the tables the three SQL drivers share.
 *
 * The Azure, Oracle and PostgreSQL drivers store the same schema, so the
 * tables, their write columns, their neutral column types and their read
 * order are described once here. `SqlDialect` implementations turn a spec
 * into dialect SQL; no driver writes a column or type array of its own.
 *
 * 세 드라이버가 같은 스키마를 다루므로 테이블·쓰기 컬럼·중립 타입·정렬은 여기서
 * 한 번만 정의하고, 방언 구현이 이 명세로 SQL을 만듭니다.
 *
 * 규칙
 * - 컬럼 이름은 PostgreSQL 스키마 이름이 정본입니다. Oracle의 예약어 회피
 *   이름(`key` → `key_value` 등)은 Oracle 방언 내부 표가 변환합니다.
 * - `columns`는 **쓰기 집합**입니다(테이블 전체 컬럼이 아닙니다). DB가 기본값으로
 *   채우는 컬럼은 여기 넣지 않습니다. 이 순서가 바인딩 순서입니다.
 * - `orderBy`는 조회 정렬입니다. 스냅샷(`selectOrdered`)이 그대로 씁니다.
 * - `key`가 있으면 `upsertRows`, 없으면 `insertRows`만 의미가 있습니다.
 */

/** Neutral column types. Every observed driver type maps onto one of these. */
export type SqlColumnType =
  /** Long text: PostgreSQL `text`, SQL Server `NVARCHAR(MAX)`, Oracle `CLOB`. */
  | "text"
  /** Short identifier/code: `text` / `NVARCHAR(450)` / `VARCHAR2(4000)`. */
  | "key"
  | "int"
  | "bigint"
  | "float"
  /** `boolean` / `BIT` / `NUMBER(1)`. */
  | "bool"
  /** Parsed JSON value: `jsonb` / `NVARCHAR(MAX)` / `CLOB` with `JSON()`. */
  | "json"
  /** Raw bytes: `bytea` / `VARBINARY(MAX)` / `BLOB`. */
  | "binary"
  | "timestamp";

/** One write column and its neutral type. */
export type SqlColumnSpec = readonly [column: string, type: SqlColumnType];

/** Everything a dialect needs to generate the statements for one table. */
export type SqlTableSpec = {
  /** Logical name in PostgreSQL notation, e.g. `chat.messages`. */
  readonly name: string;
  /** Write set, in binding order. Absent for read-only tables. */
  readonly columns?: readonly SqlColumnSpec[];
  /** Read order used by `selectOrdered`. Empty means unordered. */
  readonly orderBy: readonly string[];
  /** Upsert key. Absent means the table is append-only. */
  readonly key?: readonly string[];
  /** Whether updates bump `updated_at`. */
  readonly touch?: boolean;
  /** Column the snapshot must exclude a fixed set of keys from. */
  readonly excludeOnSnapshot?: {
    readonly column: string;
    readonly values: readonly string[];
  };
};

/** Message child tables pruned and deleted together with message rows. */
const MESSAGE_CHILD_TABLES = [
  "chat.message_attributes",
  "chat.message_generation",
  "chat.message_prompt_info",
  "chat.message_prompt_toggles",
  "chat.message_prompt_items",
] as const;

/**
 * Legacy persona mirror keys are stored as root settings for compatibility but
 * are excluded from the snapshot, exactly as the drivers did inline before
 * (`LEGACY_PERSONA_MIRROR_KEYS` in `packages/protocol/settings.ts`).
 */
export const SNAPSHOT_EXCLUDED_SETTING_KEYS: readonly string[] =
  LEGACY_PERSONA_MIRROR_KEYS;

const TABLES: readonly SqlTableSpec[] = [
  {
    name: "system.settings",
    orderBy: ["key"],
    excludeOnSnapshot: {
      column: "key",
      values: SNAPSHOT_EXCLUDED_SETTING_KEYS,
    },
  },
  {
    name: "system.setting_values",
    orderBy: ["setting_key", "node_id"],
    excludeOnSnapshot: {
      column: "setting_key",
      values: SNAPSHOT_EXCLUDED_SETTING_KEYS,
    },
  },
  { name: "character.characters", orderBy: ["position", "id"] },
  { name: "character.attributes", orderBy: ["character_id", "key"] },
  { name: "character.tags", orderBy: ["character_id", "position"] },
  {
    name: "character.greetings",
    orderBy: ["character_id", "greeting_type", "position"],
  },
  { name: "character.biases", orderBy: ["character_id", "position"] },
  { name: "character.emotions", orderBy: ["character_id", "position"] },
  { name: "character.modules", orderBy: ["character_id", "position"] },
  { name: "character.group_members", orderBy: ["group_id", "position"] },
  { name: "character.chat_folders", orderBy: ["character_id", "position"] },
  {
    name: "character.scripts",
    orderBy: ["character_id", "script_kind", "position"],
  },
  { name: "character.sd_data", orderBy: ["character_id", "position"] },
  { name: "character.assets", orderBy: ["character_id", "position"] },
  { name: "character.lore_entries", orderBy: ["character_id", "position"] },
  { name: "chat.chats", orderBy: ["character_id", "position", "id"] },
  { name: "chat.attributes", orderBy: ["chat_id", "key"] },
  { name: "chat.suggestions", orderBy: ["chat_id", "position"] },
  { name: "chat.modules", orderBy: ["chat_id", "position"] },
  { name: "chat.script_state", orderBy: ["chat_id", "key"] },
  { name: "chat.bookmarks", orderBy: ["chat_id", "position"] },
  { name: "chat.memory", orderBy: ["chat_id", "memory_type"] },
  { name: "chat.lore_entries", orderBy: ["chat_id", "position"] },
  { name: "chat.branches", orderBy: ["chat_id", "created_at", "id"] },
  { name: "chat.active_branches", orderBy: ["chat_id"] },
  {
    name: "chat.message_branch_links",
    orderBy: ["chat_id", "message_id"],
  },
  {
    name: "chat.messages",
    orderBy: ["chat_id", "position", "id"],
    key: ["chat_id", "id"],
    touch: true,
    columns: [
      ["chat_id", "key"],
      ["id", "key"],
      ["position", "int"],
      ["role", "key"],
      ["content_text", "text"],
      ["content_binary", "binary"],
      ["saying_character_id", "key"],
      ["sent_time", "bigint"],
      ["sender_name", "key"],
      ["other_user", "bool"],
      ["disabled_scope", "key"],
      ["is_comment", "bool"],
    ],
  },
  {
    name: "chat.message_attributes",
    orderBy: ["chat_id", "message_id", "key"],
    key: ["chat_id", "message_id", "key"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["key", "key"],
      ["value", "json"],
    ],
  },
  {
    name: "chat.message_generation",
    orderBy: [],
    key: ["chat_id", "message_id"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["model", "key"],
      ["generation_id", "key"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["max_context", "int"],
      ["stage1_time", "float"],
      ["stage2_time", "float"],
      ["stage3_time", "float"],
      ["stage4_time", "float"],
    ],
  },
  {
    name: "chat.message_prompt_info",
    orderBy: [],
    key: ["chat_id", "message_id"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["prompt_name", "key"],
    ],
  },
  {
    name: "chat.message_prompt_toggles",
    orderBy: ["chat_id", "message_id", "position"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["position", "int"],
      ["toggle_key", "key"],
      ["toggle_value", "text"],
    ],
  },
  {
    name: "chat.message_prompt_items",
    orderBy: ["chat_id", "message_id", "position"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["position", "int"],
      ["payload", "json"],
    ],
  },
  {
    name: "chat.branches",
    orderBy: ["chat_id", "created_at", "id"],
    key: ["chat_id", "id"],
    columns: [
      ["chat_id", "key"],
      ["id", "key"],
      ["parent_branch_id", "key"],
      ["fork_message_id", "key"],
      ["head_message_id", "key"],
      ["reason", "key"],
      ["created_at", "bigint"],
    ],
  },
  {
    name: "chat.message_branch_links",
    orderBy: ["chat_id", "message_id"],
    key: ["chat_id", "message_id"],
    columns: [
      ["chat_id", "key"],
      ["message_id", "key"],
      ["parent_message_id", "key"],
      ["origin_branch_id", "key"],
    ],
  },
  {
    name: "chat.active_branches",
    orderBy: ["chat_id"],
    key: ["chat_id"],
    columns: [
      ["chat_id", "key"],
      ["branch_id", "key"],
    ],
  },
  { name: "system.module_records", orderBy: ["position"] },
  { name: "system.module_values", orderBy: ["module_id", "node_id"] },
  { name: "system.plugin_records", orderBy: ["position"] },
  { name: "system.plugin_values", orderBy: ["plugin_id", "node_id"] },
  { name: "system.plugin_scripts", orderBy: ["plugin_id"] },
  { name: "system.bot_presets", orderBy: ["position"] },
  { name: "system.plugin_custom_storage", orderBy: ["key"] },
];

const TABLES_BY_NAME: ReadonlyMap<string, SqlTableSpec> = new Map(
  TABLES.map((table) => [table.name, table]),
);

/**
 * Tables the snapshot reads, in the order the drivers always read them.
 * 스냅샷이 읽는 테이블 목록이며 순서는 기존 드라이버와 같습니다.
 */
export const SNAPSHOT_TABLES: readonly string[] = [
  "system.settings",
  "system.setting_values",
  "character.characters",
  "character.attributes",
  "character.tags",
  "character.greetings",
  "character.biases",
  "character.emotions",
  "character.modules",
  "character.group_members",
  "character.chat_folders",
  "character.scripts",
  "character.sd_data",
  "character.assets",
  "character.lore_entries",
  "chat.chats",
  "chat.attributes",
  "chat.suggestions",
  "chat.modules",
  "chat.script_state",
  "chat.bookmarks",
  "chat.memory",
  "chat.lore_entries",
  "chat.messages",
  "chat.message_attributes",
  "chat.message_generation",
  "chat.message_prompt_info",
  "chat.message_prompt_toggles",
  "chat.message_prompt_items",
  "system.module_records",
  "system.module_values",
  "system.plugin_records",
  "system.plugin_values",
  "system.plugin_scripts",
  "system.bot_presets",
];

/** Looks up one table spec; unknown tables are a programming error. */
export function sqlTable(name: string): SqlTableSpec {
  const table = TABLES_BY_NAME.get(name);
  if (!table) throw new Error(`Unknown SQL table: ${name}`);
  return table;
}

/** Returns the write columns of a table, or throws when it is read-only. */
export function sqlTableColumns(name: string): readonly SqlColumnSpec[] {
  const table = sqlTable(name);
  if (!table.columns || table.columns.length === 0) {
    throw new Error(`SQL table has no write columns declared: ${name}`);
  }
  return table.columns;
}

/** Every declared table spec (for tests and conformance checks). */
export function sqlTableSpecs(): readonly SqlTableSpec[] {
  return TABLES;
}

export { MESSAGE_CHILD_TABLES };
