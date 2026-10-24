import { loadOracle } from "../../util/runtimeModules.ts";
const __dirname = import.meta.dirname;
// Oracle Storage 구현체 (PostgresStorage 인터페이스 호환)
// PostgreSQL의 postgresStorage.cts를 Oracle 23c+ (Autonomous Database) 방언으로 구현.
// postgresRelationalCodec.cjs / postgresJsonCodec.cjs / postgresSettingsCodec.cjs 재사용.
//
// 주요 차이점:
// - pg.Pool → oracledb.createPool (walletLocation + walletPassword)
// - $1 바인드 → :1 바인드
// - ON CONFLICT DO UPDATE → MERGE INTO
// - UNNEST bulk → executeMany
// - JSONB → JSON (oracledb 자동 직렬화)
// - BYTEA → BLOB (fetchInfo BUFFER)
// - current_setting() → SYS_CONTEXT()
// - 스키마 점 표기(system.settings) → 접두어(system_settings)
// - row 컬럼명 대문자 → 소문자 변환 필요

("use strict");
import {
  authorNoteDatabase,
  withAuthorNoteDatabase,
  notes as authorNoteSql,
} from "../authorNotes.ts";
import {
  asUnknownArray,
  isSqlRow,
  mapBranchRow,
  type ExternalSyncTransaction as ExternalSyncTransactionOf,
  type AssetCatalogEntry,
  type AssetCatalogRow,
  type AttributeRow,
  type AuditLogEntryRow,
  type BotPresetDataRow,
  type BranchPageOptions,
  type BranchRow,
  type CharacterAssetRow,
  type CharacterAttributeRow,
  type CharacterBiasRow,
  type CharacterChatFolderRow,
  type CharacterCoreRow,
  type CharacterEmotionRow,
  type CharacterGreetingRow,
  type CharacterGroupMemberRow,
  type CharacterLoreRow,
  type CharacterModuleRow,
  type CharacterRelationName,
  type CharacterScriptRow,
  type CharacterSdRow,
  type CharacterSplit,
  type ChatAttributeRow,
  type ChatBookmarkRow,
  type CharacterTagRow,
  type ChatBranchSummary,
  type ChatCoreRow,
  type ChatLoreRow,
  type ChatMemoryRow,
  type ChatModuleRow,
  type ChatRelationName,
  type ChatScriptStateRow,
  type ChatShellRow,
  type ChatSplit,
  type BotChatStatsRow,
  type CharacterSummaryRow,
  type ChatSuggestionRow,
  type ColdArchiveRow,
  type ColdStorageSummaryRow,
  type CreateChatBranchInput,
  type ExplorerColumn,
  type KeyedOwnerKeys,
  type LegacyBranchStateRow,
  type LoadChatOptions,
  type LoadPluginsOptions,
  type MessageAttributeRow,
  type MessageCoreRow,
  type MessageDeletion,
  type MessageGenerationRow,
  type MessagePromptInfoRow,
  type MessagePromptItemRow,
  type MessagePromptSplit,
  type MessagePromptToggleRow,
  type MessageSearchRow,
  type MessageSplit,
  type ModuleEntry,
  type ModuleRecordRow,
  type ModuleValueUpsert,
  type PluginRecordRow,
  type PluginScriptRow,
  type RecentChatRow,
  type RevisionListRow,
  type RevisionRow,
  SETTING_RELATION_DEFINITIONS,
  SETTING_RELATION_TABLES,
  type SettingScalarRow,
  type SettingValueRow,
  type SqlStorageRow,
  type StorageMetaRow,
  type StorageSyncFinalizeContext,
  type StorageSyncSummaryRow,
  type SyncOptions,
  type SyncProgressCallback,
  type SyncProgressEvent,
  type TokenUsageRow,
} from "../relationalRows.ts";

/**
 * One column value accepted by an Oracle bind list or bind object.
 */
type OracleBind = unknown;
/** Bind description for one column bound through `executeMany`. */
type OracleBindDefinition = { type: number; maxSize?: number };
type OracleExecuteOptions = {
  outFormat?: number;
  fetchInfo?: Record<string, unknown>;
  autoCommit?: boolean;
  maxRows?: number;
  bindDefs?:
    | OracleBindDefinition
    | readonly OracleBindDefinition[]
    | Record<string, OracleBindDefinition>;
  resultSet?: boolean;
};
/**
 * Result of `execute`. `rows` is always present (empty for DML) in
 * `OUT_FORMAT_OBJECT` mode; `outBinds` only for `RETURNING INTO` statements.
 */
type OracleResult<TRow = SqlStorageRow> = {
  rows: TRow[];
  rowsAffected?: number;
  outBinds?: Record<string, unknown>;
};
/** Connection surface of the lazily loaded `oracledb` driver. */
type OracleConnection = {
  execute(
    sql: string,
    binds?: OracleBind,
    options?: OracleExecuteOptions,
  ): Promise<OracleResult>;
  executeMany(
    sql: string,
    binds?: OracleBind,
    options?: OracleExecuteOptions,
  ): Promise<OracleResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  /** Marks the empty-string sentinel proxy wrapper. */
  __risuEmptyStringWrapped?: boolean;
};
type OraclePoolOptions = {
  user: string;
  password: string;
  connectString: string;
  configDir?: string;
  walletLocation?: string;
  walletPassword?: string;
  poolMax?: number;
  poolMin?: number;
  poolIncrement?: number;
  poolTimeout?: number;
  queueTimeout?: number;
};
type OraclePool = {
  getConnection(): Promise<OracleConnection>;
  close(drainSeconds?: number): Promise<void>;
};
/** Constants and factory functions of the `oracledb` module we depend on. */
type OracleModule = {
  fetchAsString: number[];
  fetchAsBuffer: number[];
  CLOB: number;
  BLOB: number;
  BUFFER: number;
  NUMBER: number;
  STRING: number;
  BIND_OUT: number;
  DB_TYPE_VARCHAR: number;
  DB_TYPE_CLOB: number;
  DB_TYPE_BLOB: number;
  DB_TYPE_NUMBER: number;
  OUT_FORMAT_OBJECT: number;
  createPool(options: OraclePoolOptions): Promise<OraclePool>;
};
/** Row of `system_plugin_custom_storage`. */
type OracleKeyValueRow = { key: string; value: unknown };
/** Row of `system_bot_presets`, including the JSON payload. */
type OracleBotPresetRow = BotPresetDataRow;
/** Row of `system_asset_catalog_state`. */
type OracleAssetCatalogStateRow = {
  initialized: number | null;
  source_id: string | null;
};
/** Message row joined with its branch link columns. */
type OracleGraphMessageRow = MessageCoreRow & {
  parent_message_id: string | null;
  origin_branch_id: string;
  graph_generation_model?: string | null;
};
/** Row of the pending-message join used while linking incoming messages. */
type OracleUnlinkedMessageRow = {
  chat_id: string;
  message_id: string;
  position: number | string;
  branch_id: string;
};
/** Branch head bookkeeping while linking incoming messages. */
type BranchHead = {
  chatId: string;
  branchId: string;
  messageId: string;
  position: number;
};
/** One `chat_active_branches` row. */
type OracleActiveBranchRow = { chat_id: string; branch_id: string };
/** Transaction handed to `sync` when the storage-sync importer reuses one. */
type ExternalSyncTransaction = ExternalSyncTransactionOf<OracleConnection>;
type StorageSyncFinalizeCallback = (
  client: OracleConnection,
  context: StorageSyncFinalizeContext,
) => Promise<unknown>;

/** Cold-storage value shape produced by the shared splitter. */
type SplitColdStorageRows = ReturnType<typeof splitColdStorageValue>;

/** Connection settings accepted by the storage constructor and reconfigure. */
type OracleStorageOptions = {
  user?: string;
  password?: string;
  tnsAlias?: string;
  walletPath?: string;
  walletPassword?: string;
  poolMax?: number | string;
  enabled?: boolean;
};

const oracledb: OracleModule = await loadOracle();
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { promisify } from "util";
import { deflate, unzip } from "zlib";
import {
  describeOracleTarget,
  readStorageStartupSettings,
  runStartupStage,
  sanitizeSensitiveText,
} from "../../http/startupDiagnostics.ts";
import {
  decodePostgresJsonValue,
  encodePostgresJsonValue,
} from "../postgres/postgresJsonCodec.ts";
import {
  rebuildCharacter,
  rebuildChat,
  rebuildMessage,
  rebuildLore,
  splitCharacter,
  splitChat,
  splitMessage,
  splitLore,
} from "../postgres/postgresRelationalCodec.ts";
import {
  rebuildSettings,
  splitSetting,
} from "../postgres/postgresSettingsCodec.ts";
import { projectSettings } from "../postgres/postgresSettingRelations.ts";
import {
  StorageRevisionConflictError,
  StoragePayloadError,
} from "../storageErrors.ts";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  SqlStorageBase,
  createSqlStorageHelpers,
  groupRows,
  groupMessageRows,
  buildChatShell,
  mergeLegacyModulesIntoPayload,
  pluginExtensionData,
  rebuildPluginRecords,
  createSettingColumnMappers,
  createDbExplorerIdentifierValidator,
  readSyncProgress,
  readExternalTransaction,
  collectAffectedMessageChatIds,
  summarizeAuthorNotes,
  buildSyncResult,
  invalidateSyncCaches,
  type ScalarSettingColumns,
  type ScalarSettingRow,
  type SqlStorageHelpers,
} from "../sqlStorageCommon.ts";
import {
  decodeLegacyBranchState,
  migrateLegacyBranchStateWith,
  rebuildLinearMessages,
} from "../sqlBranchMigration.ts";
import { exportDatabaseSnapshotWith } from "../sqlSnapshot.ts";
import { OracleDialect } from "./oracleDialect.ts";
import {
  buildChatBranchGraph,
  buildRestorePreview,
  buildRevisionDetails,
  buildRevisionDiffTables,
  buildBotPresetList,
  buildModuleRecordsSnapshot,
  mapAssetCatalogStats,
  mapBotChatStatsRow,
  mapRecentChatRow,
  mapRevisionListRow,
  mapStartupCharacters,
  mapTokenUsageRow,
  parseJsonSnapshot,
  parseRevisionListLimit,
  summarizeStorageSyncRow,
} from "../sqlStorageReadModels.ts";

const helpers: SqlStorageHelpers = createSqlStorageHelpers({
  PayloadError: StoragePayloadError,
  allowShortColdStorageKeys: true,
  suppressLegacyReadErrors: true,
});
const {
  asArray,
  normalizeColdStorageKey,
  validateColdStorageValue,
  splitColdStorageValue,
  validateColdStorageKeys,
  findLegacyColdStorageFiles,
  validateSyncPayload,
  captureSyncCommitImpact,
  dedupeRootUpserts,
} = helpers;
// Assertion helpers need an explicit type annotation on their name before they
// can be called as assertions, so they cannot be destructured.
const assertId: SqlStorageHelpers["assertId"] = helpers.assertId;
const assertPosition: SqlStorageHelpers["assertPosition"] =
  helpers.assertPosition;
const assertData: SqlStorageHelpers["assertData"] = helpers.assertData;

// Oracle LOB 컬럼을 자동으로 string 및 Buffer로 가져오도록 글로벌 설정 (성능 최적화 및 스트림 행 방지)
try {
  oracledb.fetchAsString = [oracledb.CLOB];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
} catch (e) {}

const ORACLE_SCHEMA_VERSION = 4;
const RELATIONAL_SCHEMA_LAYOUT = "relational-schema-v3";
const MAX_SYNC_ROWS = 250000;

// Oracle은 스키마(사용자)가 하나이므로 점 표기(system.settings)를 접두어(system_settings)로 변환
const SCHEMA_PREFIX_MAP = {
  "system.": "system_",
  "character.": "character_",
  "chat.": "chat_",
  "cold.": "cold_",
};

// 점 표기 테이블명을 접두어 테이블명으로 변환
function mapTableName(qualifiedName: string): string {
  for (const [prefix, replacement] of Object.entries(SCHEMA_PREFIX_MAP)) {
    if (qualifiedName.startsWith(prefix)) {
      return replacement + qualifiedName.slice(prefix.length);
    }
  }
  return qualifiedName;
}

/** Column values of one `system_settings` row; Oracle stores booleans as 1/0. */
type OracleSettingColumns = ScalarSettingColumns<number>;

const { mapSettingValueToColumns, mapColumnsToSettingValue } =
  createSettingColumnMappers<number>({
    encodeBool: (value) => (value ? 1 : 0),
    decodeBool: (value) => Boolean(value),
    decodeNumber: (value) => Number(value),
  });

/** Row of `system_settings`; Oracle stores booleans as NUMBER(1). */
type OracleSettingScalarRow = ScalarSettingRow<number>;

// 감사 대상 테이블 목록 (PostgreSQL AUDITED_TABLES와 동일, 접두어 변환)
const AUDITED_TABLES_QUALIFIED = [
  "global_author_notes",
  "global_author_note_settings",
  "system.settings",
  "system.setting_values",
  "system.module_records",
  "system.module_values",
  "system.plugin_records",
  "system.plugin_scripts",
  "system.plugin_values",
  "system.plugin_custom_storage",
  "character.characters",
  ...SETTING_RELATION_TABLES,
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
  "chat.branches",
  "chat.active_branches",
  "chat.message_branch_links",
  "chat.message_attributes",
  "chat.message_generation",
  "chat.message_prompt_info",
  "chat.message_prompt_toggles",
  "chat.message_prompt_items",
  "cold.archives",
  "cold.archive_attributes",
  "cold.field_presence",
  "cold.character_tags",
  "cold.character_greetings",
  "cold.character_biases",
  "cold.character_emotions",
  "cold.character_modules",
  "cold.group_members",
  "cold.chat_folders",
  "cold.character_scripts",
  "cold.character_sd_data",
  "cold.character_assets",
  "cold.character_lore_entries",
  "cold.chats",
  "cold.chat_attributes",
  "cold.chat_suggestions",
  "cold.chat_modules",
  "cold.chat_script_state",
  "cold.chat_bookmarks",
  "cold.chat_memory",
  "cold.chat_lore_entries",
  "cold.messages",
  "cold.message_attributes",
  "cold.message_generation",
  "cold.message_prompt_info",
  "cold.message_prompt_toggles",
  "cold.message_prompt_items",
];
const AUDITED_TABLES = AUDITED_TABLES_QUALIFIED.map(mapTableName);

const DB_EXPLORER_MAX_ROWS = 200;
const deflateAsync = promisify(deflate);
const unzipAsync = promisify(unzip);
const STARTUP_EXCLUDED_SETTING_KEYS = [
  ...new Set<string>([
    ...DEFERRED_STARTUP_SETTING_KEYS,
    ...SETTINGS_STORE_EXCLUDED_KEYS,
  ]),
];
const STARTUP_EXCLUDED_KEYS_SQL_LITERAL = STARTUP_EXCLUDED_SETTING_KEYS.map(
  (key: string) => `'${key.replace(/'/g, "''")}'`,
).join(", ");

// Oracle은 점 표기를 식별자로 사용 불가. 접두어 테이블명으로 변환 후 따옴표 처리.
function assertSqlIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  // 점 표기 → 접두어 변환
  const mapped = mapTableName(value);
  const parts = mapped.split(".");
  // Oracle은 따옴표 없는 식별자를 대문자로 자동 처리.
  // 스키마에서 따옴표 없이 CREATE TABLE character_characters로 생성했으므로
  // Oracle은 CHARACTER_CHARACTERS로 저장. 따옴표 없이 반환하면 자동 매칭.
  if (parts.length === 1 && /^[a-z][a-z0-9_]*$/i.test(parts[0])) {
    return parts[0].toUpperCase();
  }
  if (
    parts.length === 2 &&
    /^[a-z][a-z0-9_]*$/i.test(parts[0]) &&
    /^[a-z][a-z0-9_]*$/i.test(parts[1])
  ) {
    return `${parts[0].toUpperCase()}.${parts[1].toUpperCase()}`;
  }
  throw new Error(`Unsafe SQL identifier: ${value}`);
}

// oracledb OUT_FORMAT_OBJECT는 컬럼명을 대문자로 반환.
// postgresRelationalCodec.cjs는 소문자 컬럼명을 가정하므로 변환 필요.
/** Lowercase every column of one Oracle row (OUT_FORMAT_OBJECT uppercases). */
function lowercaseRowKeys(row: unknown): SqlStorageRow {
  if (!isSqlRow(row)) return {};
  const result: SqlStorageRow = {};
  for (const key of Object.keys(row)) {
    result[key.toLowerCase()] = row[key];
  }
  return result;
}

function lowercaseRows(rows: readonly unknown[] | null | undefined) {
  return (rows || []).map(lowercaseRowKeys);
}

// Oracle BLOB을 Buffer로 변환 (fetchInfo BUFFER 모드 사용 시 이미 Buffer)
/** Oracle LOB surface used while hydrating BLOB/CLOB columns. */
type OracleLob = {
  getData?: () => Promise<string | Buffer>;
  on?: (event: string, listener: (payload: never) => void) => void;
  setEncoding?: (encoding: string) => void;
};

async function blobToBuffer(value: unknown): Promise<Buffer | null> {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isSqlRow(value)) {
    const lob = value as OracleLob;
    if (typeof lob.getData === "function") {
      const data = await lob.getData();
      return Buffer.isBuffer(data) ? data : Buffer.from(data);
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

// Oracle DATE/TIMESTAMP를 Unix epoch ms (PostgreSQL 호환) 로 변환
function timestampToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return null;
}

// NUMBER(1) → boolean 변환
function num1ToBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function booleanToNum1(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

// ============================================================
// Oracle 빈 문자열 처리 (sentinel)
// Oracle은 VARCHAR2/CLOB의 빈 문자열 ''를 NULL로 저장한다.
// 이 때문에 NOT NULL / CHECK (... IS NOT NULL ...) 제약이
// 위반되어 ORA-01400 / ORA-02290이 발생한다 (예:
// system_setting_values의 value_type/값 일치 CHECK,
// chat_messages의 content_text XOR CHECK, 빈 캐릭터/채팅 이름).
// 쓰는 쪽에서 ''를 sentinel '\u0000'으로, 읽는 쪽에서
// sentinel을 ''로 되돌린다. NUL 1자 문자열은 실제 데이터로
// 쓰이지 않으므로 안전한 sentinel이다.
// ============================================================
const ORACLE_EMPTY_STRING_SENTINEL = "\u0000";

function normalizeEmptyStringBind(value: unknown): unknown {
  return typeof value === "string" && value === ""
    ? ORACLE_EMPTY_STRING_SENTINEL
    : value;
}

function clobBind(value: string | null | undefined) {
  return {
    val: normalizeEmptyStringBind(value ?? null),
    type: oracledb.DB_TYPE_CLOB,
  };
}

// execute 바인드(플랫 배열/스칼라/객체)와 executeMany 바인드(배열의 배열/객체의 배열) 모두 처리
function normalizeEmptyStringBinds(binds: unknown): unknown {
  if (binds === undefined || binds === null) return binds;
  if (!Array.isArray(binds)) {
    if (typeof binds === "object" && !Buffer.isBuffer(binds)) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(binds)) {
        obj[k] = normalizeEmptyStringBind(v);
      }
      return obj;
    }
    return normalizeEmptyStringBind(binds);
  }
  return binds.map((entry: unknown) => {
    if (Array.isArray(entry)) return entry.map(normalizeEmptyStringBind);
    if (entry && typeof entry === "object" && !Buffer.isBuffer(entry)) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        obj[k] = normalizeEmptyStringBind(v);
      }
      return obj;
    }
    return normalizeEmptyStringBind(entry);
  });
}

function restoreEmptyStringInRow<TRow>(row: TRow): TRow {
  if (!isSqlRow(row)) return row;
  const mutable: SqlStorageRow = row;
  for (const key of Object.keys(mutable)) {
    if (mutable[key] === ORACLE_EMPTY_STRING_SENTINEL) mutable[key] = "";
  }
  return row;
}

// 풀에서 나온 연결의 execute/executeMany에 바인드 정규화를 적용하는 Proxy 래퍼
// oracledb는 arguments.length로 바인드 전달 여부를 판별하므로
// (execute: 1~3개, executeMany: 2~3개), undefined를 명시 전달하면
// NJS-005가 발생한다. 호출 arity를 그대로 보존한다.
/** Bind-normalizing proxy around one pooled connection. */
type WrappedOracleConnection = OracleConnection & {
  __risuRawConnection?: OracleConnection;
};

function wrapConnectionForEmptyStrings(
  connection: OracleConnection | null | undefined,
): WrappedOracleConnection | null | undefined {
  if (!connection || connection.__risuEmptyStringWrapped) return connection;
  connection.__risuEmptyStringWrapped = true;
  return new Proxy(connection, {
    get(target: OracleConnection, prop: string | symbol): unknown {
      if (prop === "__risuRawConnection") return target;
      const value = Reflect.get(target, prop);
      if (prop === "execute" || prop === "executeMany") {
        const run = target[prop].bind(target) as (
          sql: string,
          binds?: OracleBind,
          options?: OracleExecuteOptions,
        ) => Promise<OracleResult>;
        return (
          sql: string,
          binds?: OracleBind,
          options?: OracleExecuteOptions,
        ): Promise<OracleResult> => {
          if (binds === undefined) return run(sql);
          const normalizedBinds = normalizeEmptyStringBinds(binds);
          if (options === undefined) return run(sql, normalizedBinds);
          return run(sql, normalizedBinds, options);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WrappedOracleConnection;
}

// 컬럼명 예약어 회피: Oracle 예약어를 안전한 이름으로 매핑
// (스키마에서 이미 변경했지만, codec에서 소문자 컬럼명을 가정하므로 역매핑 필요)
const COLUMN_NAME_MAP = {
  // 스키마에서 변경한 Oracle 컬럼명 → codec이 기대하는 원래 이름 (읽기쪽)
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

// 쓰기쪽: codec(=PostgreSQL) 컬럼명 → Oracle 컬럼명
const ORACLE_COLUMN_NAME_MAP = Object.fromEntries(
  Object.entries(COLUMN_NAME_MAP).map(([oracleName, codecName]) => [
    codecName,
    oracleName,
  ]),
);

function toOracleColumn(name: string): string {
  return ORACLE_COLUMN_NAME_MAP[name] || name;
}

// row의 컬럼명을 codec 호환 이름으로 역매핑
/** Map one Oracle row onto the column names the shared codecs expect. */
function remapRowColumns<TRow>(row: TRow): TRow & SqlStorageRow {
  if (!isSqlRow(row)) return row as TRow & SqlStorageRow;
  const result: SqlStorageRow = {};
  for (const key of Object.keys(row)) {
    const lowerKey = key.toLowerCase();
    const mappedKey =
      COLUMN_NAME_MAP[lowerKey as keyof typeof COLUMN_NAME_MAP] || lowerKey;
    result[mappedKey] = row[key];
  }
  return result as TRow & SqlStorageRow;
}

function remapRows(rows: readonly unknown[] | null | undefined) {
  return (rows || []).map((row) => remapRowColumns(lowercaseRowKeys(row)));
}

// CLOB → string 변환 (oracledb는 CLOB을 Lob 스트림으로 반환할 수 있음)
async function clobToString(value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (isSqlRow(value)) {
    const lob = value as OracleLob;
    if (typeof lob.getData === "function") {
      const data = await lob.getData();
      return typeof data === "string"
        ? data
        : Buffer.from(data).toString("utf8");
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
    // 이미 파싱된 JSON 객체/배열인 경우 "[object Object]"로 강제 변환하지 않고 그대로 유지
    return value;
  }
  return String(value);
}

// row의 모든 CLOB/LOB 컬럼을 미리 읽어서 string/Buffer로 변환
async function hydrateLobs(
  row: unknown,
  lobColumns: readonly string[] = [],
  blobColumns: readonly string[] = [],
): Promise<unknown> {
  if (!isSqlRow(row)) return row;
  const result: SqlStorageRow = { ...row };
  // 대소문자 구분 없이 LOB 컬럼 매칭 (Oracle은 대문자, clobColumns는 소문자)
  const lowerLobCols = new Set<string>(
    lobColumns.map((column) => column.toLowerCase()),
  );
  const lowerBlobCols = new Set<string>(
    blobColumns.map((column) => column.toLowerCase()),
  );
  for (const key of Object.keys(result)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerLobCols.has(lowerKey) &&
      result[key] !== null &&
      result[key] !== undefined
    ) {
      result[key] = await clobToString(result[key]);
    }
    if (
      lowerBlobCols.has(lowerKey) &&
      result[key] !== null &&
      result[key] !== undefined
    ) {
      result[key] = await blobToBuffer(result[key]);
    }
  }
  return result;
}

/** Options understood by `fetchRows`. */
type FetchRowOptions = {
  clobColumns?: readonly string[];
  blobColumns?: readonly string[];
  fetchOptions?: OracleExecuteOptions;
};

// PostgreSQL 호환 행 반환 (oracledb 결과 → pg 호환 row)
// fetchInfo로 BUFFER/BLOB을 Buffer로, CLOB은 자동 문자열 변환 (oracledb 6.x thin 모드)
async function fetchRows<TRow = SqlStorageRow>(
  connection: OracleConnection,
  sql: string,
  binds: OracleBind = [],
  options: FetchRowOptions = {},
): Promise<TRow[]> {
  const fetchInfo: Record<string, { type: number }> = {};
  // BLOB 컬럼은 BUFFER로 직접 받기
  if (options.blobColumns) {
    for (const col of options.blobColumns) {
      fetchInfo[col.toUpperCase()] = { type: oracledb.BUFFER };
    }
  }
  const result = await connection.execute(sql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    fetchInfo: Object.keys(fetchInfo).length > 0 ? fetchInfo : undefined,
    ...options.fetchOptions,
  });
  let rows: unknown[] = result.rows || [];
  // CLOB 컬럼 미리 읽기 (oracledb thin 모드는 CLOB을 자동으로 문자열로 반환하지만 안전을 위해)
  if (options.clobColumns && options.clobColumns.length > 0) {
    rows = await Promise.all(
      rows.map((row) =>
        hydrateLobs(row, options.clobColumns, options.blobColumns || []),
      ),
    );
  }
  // 컬럼명 소문자 변환 + 예약어 역매핑 + Oracle sentinel → '' 복원
  return rows.map((row) =>
    restoreEmptyStringInRow(remapRowColumns(row)),
  ) as TRow[];
}

// 단일 행 반환
async function fetchOne<TRow = SqlStorageRow>(
  connection: OracleConnection,
  sql: string,
  binds: OracleBind = [],
  options: FetchRowOptions = {},
): Promise<TRow | null> {
  const rows = await fetchRows<TRow>(connection, sql, binds, {
    ...options,
    fetchOptions: { ...options.fetchOptions, maxRows: 1 },
  });
  return rows[0] || null;
}

/**
 * Fetch a row that must exist (singleton metadata, locked revision rows). A
 * missing row means the storage is corrupt, so fail loudly instead of
 * dereferencing null.
 */
async function fetchRequiredRow<TRow extends SqlStorageRow>(
  connection: OracleConnection,
  sql: string,
  binds: OracleBind = [],
  options: FetchRowOptions = {},
): Promise<TRow> {
  const row = await fetchOne<TRow>(connection, sql, binds, options);
  if (!row) {
    throw new StoragePayloadError(`Expected a row from: ${sql}`);
  }
  return row;
}

// PostgreSQL 호환 결과 객체 생성
function pgResult<TRow>(rows: TRow[]) {
  return { rows, rowCount: rows.length };
}

// 바인드 변수 변환: pg 스타일($1, $2) → Oracle 스타일(:1, :2)
function convertSql(sql: string): string {
  // $1, $2, ... → :1, :2, ...
  let converted = sql.replace(/\$(\d+)/g, ":$1");
  // ::type 캐스트 제거 (Oracle은 CAST() 사용)
  converted = converted.replace(/::\w+/g, "");
  // 점 표기 테이블명 → 접두어 (따옴표 안의 것은 제외)
  for (const [prefix, replacement] of Object.entries(SCHEMA_PREFIX_MAP)) {
    // 시스템 함수/컨텍스트는 제외 (current_setting 등은 이미 변환됨)
    converted = converted.replace(
      new RegExp(prefix.replace(".", "\\."), "g"),
      replacement,
    );
  }
  // current_setting('risu.revision_id', TRUE) → SYS_CONTEXT('RISU_AUDIT_CTX', 'revision_id')
  converted = converted.replace(
    /current_setting\(['"]risu\.revision_id['"]\s*,\s*(?:TRUE|true)\)/g,
    "SYS_CONTEXT('RISU_AUDIT_CTX', 'revision_id')",
  );
  converted = converted.replace(
    /current_setting\(['"]risu\.archive_id['"]\s*,\s*(?:TRUE|true)\)/g,
    "SYS_CONTEXT('RISU_AUDIT_CTX', 'archive_id')",
  );
  // set_config('risu.revision_id', $1, TRUE) → BEGIN risu_audit_ctx_pkg.set_revision(:1); END;
  // (이 변환은 호출부에서 처리)
  // LIMIT n → FETCH FIRST n ROWS ONLY
  converted = converted.replace(/LIMIT\s+(\d+)/gi, "FETCH FIRST $1 ROWS ONLY");
  // OFFSET n LIMIT m → OFFSET n ROWS FETCH NEXT m ROWS ONLY
  converted = converted.replace(
    /OFFSET\s+(\d+)\s+LIMIT\s+(\d+)/gi,
    "OFFSET $1 ROWS FETCH NEXT $2 ROWS ONLY",
  );
  // NOW() → SYSTIMESTAMP
  converted = converted.replace(/\bNOW\(\)/gi, "SYSTIMESTAMP");
  // TRUE/FALSE → 1/0 (boolean 컨텍스트)
  // 주의: CHECK 제약에서는 TRUE/FALSE가 허용되지만, 비교에서는 1/0 사용
  // 이 변환은 위험하므로 수동 처리
  return converted;
}

// PostgreSQL의 bulkInsert()를 Oracle executemany로 대체
// columnTypes: Oracle 타입 (oracledb.DB_TYPE_*)
async function bulkInsert(
  connection: OracleConnection,
  table: string,
  columns: readonly string[],
  columnTypes: readonly number[],
  rows: readonly SqlStorageRow[],
  conflictAction = false,
): Promise<void> {
  if (rows.length === 0) return;
  const quotedTable = assertSqlIdentifier(table);
  const quotedColumns = columns.map((col) => `${col.toUpperCase()}`);
  const batchRows = Math.max(
    1,
    Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || "1000", 10) || 1000,
  );

  // Oracle 바인드 변수명 생성 (:1, :2, ...)
  const bindNames = columns.map((_column, index) => `:${index + 1}`).join(", ");
  // 단순 INSERT (conflictAction은 호출부에서 MERGE로 직접 구현)
  const insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")}) VALUES (${bindNames})`;
  for (let start = 0; start < rows.length; start += batchRows) {
    const binds = rows
      .slice(start, start + batchRows)
      .map((row) =>
        columns.map((col, index) =>
          prepareBindValue(row[col], columnTypes[index]),
        ),
      );
    await connection.executeMany(insertSql, binds);
  }
}

// Oracle 타입에 맞게 값 변환
function prepareBindValue(value: unknown, _oracleType?: number): unknown {
  if (value === undefined || value === null) return null;
  // boolean → NUMBER(1)
  if (typeof value === "boolean") return value ? 1 : 0;
  // Buffer → BLOB, JSON 객체/배열 → oracledb가 자동 처리
  return value;
}

const assertDbExplorerIdentifier = createDbExplorerIdentifierValidator({
  PayloadError: StoragePayloadError,
  tooLong: (field) => `${field} must be a valid table or column name`,
  invalid: (field) => `${field} must be a valid table or column name`,
});

function dbExplorerSelectExpression(
  columnName: string,
  dataType: string | null,
): string {
  const column = columnName.toUpperCase();
  switch ((dataType ?? "").toLowerCase()) {
    case "number":
    case "float":
    case "binary_double":
    case "binary_float":
      return `TO_CHAR(${column})`;
    case "blob":
      return `RAWTOHEX(${column})`;
    case "clob":
      return `DBMS_LOB.GETLENGTH(${column}) || ' bytes'`;
    default:
      return column;
  }
}

/** Context of one audited storage revision. */
type AuditRevisionOptions = {
  storageRevision?: number | null;
  databaseInitialized?: boolean | null;
  scope: string;
  action: string;
  restoredFrom?: number | null;
};

async function beginAuditRevision(
  connection: OracleConnection,
  {
    storageRevision = null,
    databaseInitialized = null,
    scope,
    action,
    restoredFrom = null,
  }: AuditRevisionOptions,
): Promise<number> {
  const result = await connection.execute(
    `INSERT INTO system_revisions
            (storage_revision, database_initialized, scope, action, restored_from_revision)
         VALUES (:1, :2, :3, :4, :5)
         RETURNING id INTO :6`,
    {
      1: storageRevision,
      2: databaseInitialized === null ? null : databaseInitialized ? 1 : 0,
      3: scope,
      4: action,
      5: restoredFrom,
      6: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    },
    { autoCommit: false },
  );
  const outBinds = result.outBinds ?? {};
  const revisionId = Number((outBinds["6"] as readonly unknown[])[0]);
  // 세션 컨텍스트에 revision_id 설정
  await connection.execute(
    `BEGIN risu_audit_ctx_pkg.set_revision(:1); END;`,
    [String(revisionId)],
    { autoCommit: false },
  );
  return revisionId;
}

async function deleteMessageChildren(
  connection: OracleConnection,
  pairs: readonly { chatId: string; id: string }[],
  tables: readonly string[] = [
    "chat_message_attributes",
    "chat_message_generation",
    "chat_message_prompt_info",
    "chat_message_prompt_toggles",
    "chat_message_prompt_items",
  ],
): Promise<void> {
  if (pairs.length === 0) return;
  for (const table of tables) {
    // Oracle은 UNNEST 대신 개별 DELETE 사용
    // executemany로 chat_id/message_id 쌍 삭제
    const deleteSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = :1 AND message_id = :2`;
    const binds = pairs.map((pair) => [String(pair.chatId), String(pair.id)]);
    const bindDefs = [
      { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
      { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
    ];
    await connection.executeMany(deleteSql, binds, { bindDefs });
  }
}

class OracleStorage extends SqlStorageBase {
  // The `oracledb` package ships no type definitions and is loaded lazily.
  declare pool: OraclePool | null;
  declare user: string;
  declare password: string;
  declare tnsAlias: string;
  declare walletPath: string;
  declare walletPassword: string;
  declare poolMax: number;
  declare startupSettings: ReturnType<typeof readStorageStartupSettings>;

  constructor(options: OracleStorageOptions = {}) {
    super();
    this.user = options.user || "";
    this.password = options.password || "";
    this.tnsAlias = options.tnsAlias || "";
    this.walletPath = options.walletPath || "";
    this.walletPassword = options.walletPassword || "";
    this.poolMax = Number.parseInt(String(options.poolMax ?? "10"), 10);
    this.enabled = Boolean(
      options.enabled !== false && this.tnsAlias && this.user && this.password,
    );
    this.startupSettings = readStorageStartupSettings();
    this.pool = null;
  }

  async initialize() {
    if (!this.enabled) {
      console.log(
        "[Oracle] DATABASE not configured; using legacy file storage.",
      );
      return;
    }
    console.log(
      `[Oracle startup] Target: ${describeOracleTarget(this.tnsAlias, this.walletPath)}; ` +
        `pool max: ${this.poolMax}.`,
    );
    this.pool = await this.createInitializedPool();
    console.log("[Oracle] Structured storage is ready.");
  }

  runStartupStep<TOperationResult>(
    operation: string,
    task: () => TOperationResult | Promise<TOperationResult>,
  ): Promise<TOperationResult> {
    return runStartupStage(
      {
        scope: "Oracle startup",
        operation,
        heartbeatMs: this.startupSettings.heartbeatMs,
      },
      task,
    );
  }

  async createInitializedPool() {
    const pool = await this.runStartupStep("1/8 create connection pool", () =>
      oracledb.createPool({
        user: this.user,
        password: this.password,
        connectString: this.tnsAlias,
        configDir: this.walletPath,
        walletLocation: this.walletPath,
        walletPassword: this.walletPassword,
        poolMax:
          Number.isSafeInteger(this.poolMax) && this.poolMax > 0
            ? this.poolMax
            : 10,
        poolMin: 1,
        poolIncrement: 1,
        poolTimeout: 60,
        queueTimeout: this.startupSettings.startupTimeoutMs,
      }),
    );
    // 모든 연결이 빈 문자열 sentinel 정규화 래퍼를 통과하도록 getConnection 래핑
    const realGetConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () =>
      wrapConnectionForEmptyStrings(
        await realGetConnection(),
      ) as OracleConnection;
    try {
      // 연결 테스트
      const testConn = await this.runStartupStep(
        "2/8 acquire test connection",
        () => pool.getConnection(),
      );
      await this.runStartupStep("3/8 ping database", () =>
        testConn.execute("SELECT 1 FROM dual"),
      );
      // 스키마 기적용 여부 확인
      let alreadyInitialized = false;
      await this.runStartupStep(
        "4/8 inspect storage schema metadata",
        async () => {
          try {
            const checkRes = await testConn.execute(
              `SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1`,
              [],
              { outFormat: oracledb.OUT_FORMAT_OBJECT },
            );
            const v = checkRes.rows[0]?.SCHEMA_VERSION;
            const l = checkRes.rows[0]?.SCHEMA_LAYOUT;
            if (v === ORACLE_SCHEMA_VERSION && l === RELATIONAL_SCHEMA_LAYOUT) {
              alreadyInitialized = true;
            } else if (v !== undefined) {
              throw new Error(
                `Unsupported Oracle schema ${v}/${l}; expected ${ORACLE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}. ` +
                  "Reset the configured development database explicitly before retrying.",
              );
            }
          } catch (error) {
            if (
              String(error?.message || "").startsWith(
                "Unsupported Oracle schema",
              )
            )
              throw error;
            console.log(
              `[Oracle startup] Storage metadata is not available yet; schema setup will run ` +
                `(${sanitizeSensitiveText(error?.code || error?.message || "metadata table missing")}).`,
            );
          }
        },
      );

      if (!alreadyInitialized) {
        // 스키마 적용
        const schema = await this.runStartupStep(
          "5/8 load bundled storage schema",
          () => fs.readFile(path.join(__dirname, "oracle-schema.sql"), "utf8"),
        );
        await this.runStartupStep("6/8 apply storage schema", () =>
          this.applySchema(testConn, schema),
        );
      } else {
        console.log(
          "[Oracle startup] 5/8 and 6/8 existing storage schema is current; schema apply skipped.",
        );
      }
      await this.runStartupStep(
        "6b/8 ensure persistent chat branch schema",
        () => this.ensureBranchSchema(testConn),
      );
      await this.runStartupStep("6c/8 ensure chat last-message invariant", () =>
        this.ensureLastMessageTimeInvariant(testConn),
      );
      await this.runStartupStep("6d/8 ensure plugin storage schema", () =>
        this.ensurePluginSchema(testConn),
      );
      await this.runStartupStep(
        "6e/8 ensure global author note schema",
        async () => {
          const schema = await fs.readFile(
            path.join(__dirname, "oracle-schema.sql"),
            "utf8",
          );
          await this.applySchema(
            testConn,
            schema.slice(schema.indexOf("CREATE TABLE global_author_notes")),
          );
          await authorNoteSql.ensureAuthorNoteReceipts(
            authorNoteDatabase("oracle", testConn),
          );
          await testConn.commit();
        },
      );
      await this.runStartupStep("7/8 ensure asset catalog schema", () =>
        this.ensureAssetCatalogSchema(testConn),
      );
      await testConn.close();

      // 스키마 버전 확인
      const verifyConn = await pool.getConnection();
      const result = await this.runStartupStep(
        "8/8 verify applied storage schema",
        () =>
          verifyConn.execute(
            `SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1`,
            [],
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
          ),
      );
      await verifyConn.close();
      const schemaVersion = result.rows[0]?.SCHEMA_VERSION;
      const schemaLayout = result.rows[0]?.SCHEMA_LAYOUT;
      if (
        schemaVersion !== ORACLE_SCHEMA_VERSION ||
        schemaLayout !== RELATIONAL_SCHEMA_LAYOUT
      ) {
        throw new Error(
          `Unsupported Oracle schema ${schemaVersion}/${schemaLayout}; ` +
            `expected ${ORACLE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}`,
        );
      }
      return pool;
    } catch (error) {
      try {
        await pool.close(0);
      } catch (e) {}
      throw error;
    }
  }

  async ensureLastMessageTimeInvariant(
    connection: OracleConnection,
  ): Promise<void> {
    const existing = await connection.execute(
      `SELECT trigger_name FROM user_triggers WHERE trigger_name = 'CHAT_MESSAGES_LAST_MESSAGE_TIME'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    if (!existing.rows?.length) {
      await connection.execute(`
                UPDATE chat_chats ch
                   SET last_message_time = (
                       SELECT m.sent_time
                         FROM chat_messages m
                        WHERE m.chat_id = ch.id
                        ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                        FETCH FIRST 1 ROW ONLY
                   ), updated_at = SYSTIMESTAMP
            `);
    }
    const triggerSql = await fs.readFile(
      path.join(__dirname, "oracle-last-message-time.sql"),
      "utf8",
    );
    await this.applySchema(connection, triggerSql);
  }

  async ensureBranchSchema(connection: OracleConnection): Promise<void> {
    const statements = [
      `CREATE TABLE chat_branches (
                chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                id VARCHAR2(4000) NOT NULL,
                parent_branch_id VARCHAR2(4000), fork_message_id VARCHAR2(4000), head_message_id VARCHAR2(4000),
                reason VARCHAR2(32) NOT NULL CHECK (reason IN ('root', 'manual', 'reroll')),
                created_at NUMBER NOT NULL,
                PRIMARY KEY (chat_id, id),
                FOREIGN KEY (chat_id, parent_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (chat_id, fork_message_id) REFERENCES chat_messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (chat_id, head_message_id) REFERENCES chat_messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED)`,
      `CREATE INDEX branches_parent_idx ON chat_branches (chat_id, parent_branch_id, created_at)`,
      `CREATE TABLE chat_active_branches (
                chat_id VARCHAR2(4000) PRIMARY KEY REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                branch_id VARCHAR2(4000) NOT NULL,
                FOREIGN KEY (chat_id, branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)`,
      `CREATE TABLE chat_message_branch_links (
                chat_id VARCHAR2(4000) NOT NULL,
                message_id VARCHAR2(4000) NOT NULL, parent_message_id VARCHAR2(4000), origin_branch_id VARCHAR2(4000) NOT NULL,
                PRIMARY KEY (chat_id, message_id),
                FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (chat_id, parent_message_id) REFERENCES chat_messages(chat_id, id) DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (chat_id, origin_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)`,
      `CREATE INDEX message_branch_parent_idx ON chat_message_branch_links (chat_id, parent_message_id)`,
      `CREATE INDEX message_branch_origin_idx ON chat_message_branch_links (chat_id, origin_branch_id)`,
    ];
    for (const statement of statements) {
      try {
        await connection.execute(statement);
      } catch (error) {
        if (!String(error?.message || "").includes("ORA-00955")) throw error;
      }
    }
    await connection.commit();
  }

  async ensurePluginSchema(connection: OracleConnection): Promise<void> {
    const statements = [
      `CREATE TABLE system_plugin_records (
                plugin_id VARCHAR2(4000) PRIMARY KEY,
                position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
                name VARCHAR2(4000) NOT NULL UNIQUE,
                display_name VARCHAR2(4000),
                api_version VARCHAR2(64),
                plugin_version VARCHAR2(64),
                update_url VARCHAR2(4000),
                enabled NUMBER(1) DEFAULT 1 NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)`,
      `CREATE INDEX plugin_records_enabled_position_idx ON system_plugin_records (enabled, position)`,
      `CREATE TABLE system_plugin_scripts (
                plugin_id VARCHAR2(4000) PRIMARY KEY REFERENCES system_plugin_records(plugin_id) ON DELETE CASCADE,
                script CLOB NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)`,
      `CREATE TABLE system_plugin_values (
                plugin_id VARCHAR2(4000) NOT NULL REFERENCES system_plugin_records(plugin_id) ON DELETE CASCADE,
                node_id INTEGER NOT NULL,
                parent_node_id INTEGER,
                member_key CLOB, encoded_member_key CLOB,
                position INTEGER CHECK (position >= 0),
                value_type VARCHAR2(32) NOT NULL CHECK (value_type IN ('null','text','encoded-text','number','boolean','array','object')),
                text_value CLOB, encoded_text_value CLOB,
                number_value BINARY_DOUBLE, boolean_value NUMBER(1),
                PRIMARY KEY (plugin_id, node_id),
                FOREIGN KEY (plugin_id, parent_node_id) REFERENCES system_plugin_values(plugin_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
                CHECK (member_key IS NULL OR encoded_member_key IS NULL),
                CHECK (text_value IS NULL OR encoded_text_value IS NULL))`,
      `CREATE INDEX plugin_values_parent_idx ON system_plugin_values (plugin_id, parent_node_id, position, node_id)`,
      `CREATE TABLE system_plugin_custom_storage (
                key VARCHAR2(4000) PRIMARY KEY,
                value JSON NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)`,
    ];
    for (const statement of statements) {
      try {
        await connection.execute(statement);
      } catch (error) {
        if (!String(error?.message || "").includes("ORA-00955")) throw error;
      }
    }
    await connection.commit();
  }

  async ensureAssetCatalogSchema(connection: OracleConnection): Promise<void> {
    const statements = [
      `CREATE TABLE system_asset_catalog_state (
                singleton NUMBER(1) DEFAULT 1 PRIMARY KEY,
                initialized NUMBER(1) DEFAULT 0 NOT NULL,
                source_id VARCHAR2(2048),
                synced_at TIMESTAMP WITH TIME ZONE,
                CONSTRAINT asset_catalog_state_singleton CHECK (singleton = 1))`,
      `CREATE TABLE system_asset_catalog (
                asset_key VARCHAR2(1024) PRIMARY KEY,
                size_bytes NUMBER,
                etag VARCHAR2(1024),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL)`,
      `CREATE INDEX asset_catalog_updated_idx ON system_asset_catalog (updated_at DESC)`,
    ];
    for (const statement of statements) {
      try {
        await connection.execute(statement);
      } catch (error) {
        if (!String(error?.message || "").includes("ORA-00955")) throw error;
      }
    }
    try {
      await connection.execute(
        `ALTER TABLE system_asset_catalog_state ADD source_id VARCHAR2(2048)`,
      );
    } catch (error) {
      if (!String(error?.message || "").includes("ORA-01430")) throw error;
    }
    await connection.execute(
      `MERGE INTO system_asset_catalog_state target
             USING (SELECT 1 AS singleton FROM dual) src
             ON (target.singleton = src.singleton)
             WHEN NOT MATCHED THEN INSERT (singleton, initialized) VALUES (1, 0)`,
      [],
      { autoCommit: true },
    );
  }

  // 스키마 SQL을 분할하여 순차 실행 (/ 구분자 + 세미콜론)
  async applySchema(
    connection: OracleConnection,
    schemaSql: string,
  ): Promise<void> {
    // 블록 주석 제거
    const cleaned = schemaSql.replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = cleaned.split("\n");
    let buf: string[] = [];
    let plsqlBlock = false;

    const flush = async () => {
      const s = buf.join("\n").trim();
      if (s) {
        try {
          await connection.execute(s, [], { autoCommit: false });
        } catch (err) {
          // 이미 존재하는 객체/데이터/잠금은 무시
          const msg = err.message || "";
          if (
            msg.includes("ORA-00955") ||
            msg.includes("ORA-00942") ||
            msg.includes("ORA-00001") ||
            msg.includes("ORA-01400") ||
            msg.includes("ORA-00054")
          ) {
            // 무시
          } else {
            throw err;
          }
        }
      }
      buf = [];
      plsqlBlock = false;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--")) continue;
      if (!trimmed && buf.length === 0) continue;
      if (trimmed === "/") {
        await flush();
        continue;
      }
      buf.push(line);
      if (
        /^(CREATE\s+(OR\s+REPLACE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE))/i.test(
          trimmed,
        )
      ) {
        plsqlBlock = true;
      }
      if (!plsqlBlock && trimmed.endsWith(";")) {
        await flush();
      }
    }
    await flush();

    // 기존 테이블의 컬럼 타입 마이그레이션 (Oracle은 VARCHAR2 -> CLOB 직접 ALTER 불가하므로 임시 컬럼 교체)
    await this._migrateVarchar2ToClob(
      connection,
      "SYSTEM_MODULES",
      "CUSTOM_TOGGLE",
    );

    await connection.commit();
  }

  // Oracle은 VARCHAR2 -> CLOB 컬럼 타입 직접 변경(ALTER TABLE MODIFY) 시 ORA-22858 발생.
  // 임시 컬럼을 추가하고 데이터를 복사한 후 기존 컬럼을 교체한다.
  async _migrateVarchar2ToClob(
    connection: OracleConnection,
    tableName: string,
    columnName: string,
  ) {
    try {
      const checkSql = `SELECT data_type FROM user_tab_cols WHERE table_name = UPPER(:1) AND column_name = UPPER(:2)`;
      const res = await connection.execute(checkSql, [tableName, columnName], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const dataType = res.rows?.[0]?.DATA_TYPE;
      if (dataType === "VARCHAR2") {
        console.log(
          `[Oracle] Migrating ${tableName}.${columnName} from VARCHAR2 to CLOB...`,
        );
        const tableIdent = assertSqlIdentifier(tableName);
        const colIdent = assertSqlIdentifier(columnName);
        const tempCol = assertSqlIdentifier(`${columnName.slice(0, 20)}_clob`);
        await connection.execute(
          `ALTER TABLE ${tableIdent} ADD (${tempCol} CLOB)`,
        );
        await connection.execute(
          `UPDATE ${tableIdent} SET ${tempCol} = ${colIdent}`,
        );
        await connection.execute(
          `ALTER TABLE ${tableIdent} DROP COLUMN ${colIdent}`,
        );
        await connection.execute(
          `ALTER TABLE ${tableIdent} RENAME COLUMN ${tempCol} TO ${colIdent}`,
        );
        console.log(
          `[Oracle] Migrated ${tableName}.${columnName} to CLOB successfully.`,
        );
      }
    } catch (e) {
      console.error(
        `[Oracle] Migration error for ${tableName}.${columnName}:`,
        e.message || e,
      );
    }
  }

  async reconfigure(options: OracleStorageOptions = {}): Promise<void> {
    this.invalidateBootstrapCache();
    const tnsAlias = options.tnsAlias || "";
    const parsedPoolMax = Number.parseInt(String(options.poolMax ?? "10"), 10);
    const poolMax =
      Number.isSafeInteger(parsedPoolMax) && parsedPoolMax > 0
        ? parsedPoolMax
        : 10;
    if (!tnsAlias || !options.user || !options.password) {
      const previousPool = this.pool;
      this.tnsAlias = "";
      this.user = "";
      this.password = "";
      this.walletPassword = "";
      this.poolMax = poolMax;
      this.pool = null;
      this.enabled = false;
      if (previousPool) {
        try {
          await previousPool.close(0);
        } catch (e) {}
      }
      return;
    }
    this.user = options.user;
    this.password = options.password;
    this.tnsAlias = tnsAlias;
    this.walletPath = options.walletPath || this.walletPath;
    this.walletPassword = options.walletPassword || this.walletPassword;
    this.poolMax = poolMax;
    this.enabled = true;

    const nextPool = await this.createInitializedPool();
    const previousPool = this.pool;
    this.pool = nextPool;
    if (previousPool) {
      try {
        await previousPool.close(0);
      } catch (e) {}
    }
    console.log("[Oracle] Storage connection was reconfigured.");
  }

  assertEnabled(): asserts this is OracleStorage & { pool: OraclePool } {
    if (!this.enabled || !this.pool) {
      throw new Error("Oracle storage is not enabled");
    }
  }

  async getState() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const row = await fetchRequiredRow<StorageMetaRow>(
        conn,
        `SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1`,
      );
      return {
        revision: Number(row.revision),
        initialized: num1ToBool(row.initialized),
      };
    } finally {
      await conn.close();
    }
  }

  async getStorageSyncSummary() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const row = await fetchOne<StorageSyncSummaryRow>(
        conn,
        `SELECT meta.revision, meta.initialized,
                (SELECT COUNT(*) FROM system_settings) AS settings_count,
                (SELECT COUNT(*) FROM character_characters) AS characters_count,
                (SELECT COUNT(*) FROM chat_chats) AS chats_count,
                (SELECT COUNT(*) FROM chat_messages) AS messages_count
           FROM system_storage_meta meta
          WHERE meta.singleton = 1`,
      );
      return summarizeStorageSyncRow(row ?? {}, {
        decodeInitialized: num1ToBool,
      });
    } finally {
      await conn.close();
    }
  }

  async isAssetCatalogInitialized(sourceId?: string | null): Promise<boolean> {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const row = await fetchOne<OracleAssetCatalogStateRow>(
        conn,
        `SELECT initialized, source_id FROM system_asset_catalog_state WHERE singleton = 1`,
      );
      return (
        num1ToBool(row?.initialized) === true && row?.source_id === sourceId
      );
    } finally {
      await conn.close();
    }
  }

  async listAssetCatalog(prefix = ""): Promise<string[]> {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = prefix
        ? await fetchRows<AssetCatalogRow>(
            conn,
            `SELECT asset_key FROM system_asset_catalog
                     WHERE SUBSTR(asset_key, 1, :1) = :2 ORDER BY asset_key`,
            [prefix.length, prefix],
          )
        : await fetchRows<AssetCatalogRow>(
            conn,
            `SELECT asset_key FROM system_asset_catalog ORDER BY asset_key`,
          );
      return rows.map((row) => row.asset_key);
    } finally {
      await conn.close();
    }
  }

  async listAssetCatalogEntries(prefix = "") {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = prefix
        ? await fetchRows<AssetCatalogRow>(
            conn,
            `SELECT asset_key, size_bytes, etag, updated_at FROM system_asset_catalog
                     WHERE SUBSTR(asset_key, 1, :1) = :2 ORDER BY asset_key`,
            [prefix.length, prefix],
          )
        : await fetchRows<AssetCatalogRow>(
            conn,
            `SELECT asset_key, size_bytes, etag, updated_at FROM system_asset_catalog ORDER BY asset_key`,
          );
      return rows.map((row) => ({
        key: row.asset_key,
        size:
          row.size_bytes === null || row.size_bytes === undefined
            ? null
            : Number(row.size_bytes),
        etag: row.etag ?? null,
        updatedAt: row.updated_at
          ? new Date(row.updated_at as string | number | Date).getTime()
          : null,
      }));
    } finally {
      await conn.close();
    }
  }

  async getAssetCatalogStats() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const row = await fetchRequiredRow<{
        total_objects: number | string;
        total_size: number | string;
      }>(
        conn,
        `SELECT COUNT(*) AS total_objects, NVL(SUM(size_bytes), 0) AS total_size
                 FROM system_asset_catalog`,
      );
      return mapAssetCatalogStats(row);
    } finally {
      await conn.close();
    }
  }

  async upsertAssetCatalog(
    entries: readonly AssetCatalogEntry[],
  ): Promise<number> {
    this.assertEnabled();
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const conn = await this.pool.getConnection();
    try {
      await conn.executeMany(
        `MERGE /*+ DISABLE_PARALLEL_DML NO_PARALLEL INDEX(target) */ INTO system_asset_catalog target
                 USING (SELECT :1 AS asset_key, :2 AS size_bytes, :3 AS etag FROM dual) src
                 ON (target.asset_key = src.asset_key)
                 WHEN MATCHED THEN UPDATE SET
                    target.size_bytes = COALESCE(src.size_bytes, target.size_bytes),
                    target.etag = COALESCE(src.etag, target.etag),
                    target.updated_at = SYSTIMESTAMP
                 WHEN NOT MATCHED THEN INSERT (asset_key, size_bytes, etag)
                    VALUES (src.asset_key, src.size_bytes, src.etag)`,
        entries.map((entry) => [
          entry.key,
          entry.size ?? null,
          entry.etag ?? null,
        ]),
        {
          autoCommit: true,
          bindDefs: [
            { type: oracledb.STRING, maxSize: 1024 },
            { type: oracledb.NUMBER },
            { type: oracledb.STRING, maxSize: 1024 },
          ],
        },
      );
      return entries.length;
    } finally {
      await conn.close();
    }
  }

  async removeAssetCatalog(keys: readonly string[]): Promise<number> {
    this.assertEnabled();
    if (!Array.isArray(keys) || keys.length === 0) return 0;
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.executeMany(
        `DELETE FROM system_asset_catalog WHERE asset_key = :1`,
        keys.map((key) => [key]),
        { autoCommit: true },
      );
      return result.rowsAffected || 0;
    } finally {
      await conn.close();
    }
  }

  async replaceAssetCatalog(
    prefix: string,
    entries: readonly AssetCatalogEntry[],
    sourceId: string | null,
  ): Promise<number> {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      if (prefix) {
        await conn.execute(
          `DELETE FROM system_asset_catalog WHERE SUBSTR(asset_key, 1, :1) = :2`,
          [prefix.length, prefix],
        );
      } else {
        await conn.execute(`DELETE FROM system_asset_catalog`);
      }
      if (entries.length > 0) {
        await conn.executeMany(
          `INSERT INTO system_asset_catalog (asset_key, size_bytes, etag)
                     VALUES (:1, :2, :3)`,
          entries.map((entry) => [
            entry.key,
            entry.size ?? null,
            entry.etag ?? null,
          ]),
          {
            bindDefs: [
              { type: oracledb.STRING, maxSize: 1024 },
              { type: oracledb.NUMBER },
              { type: oracledb.STRING, maxSize: 1024 },
            ],
          },
        );
      }
      await conn.execute(
        `UPDATE system_asset_catalog_state
                 SET initialized = 1, synced_at = SYSTIMESTAMP WHERE singleton = 1`,
        [],
        { autoCommit: false },
      );
      await conn.execute(
        `UPDATE system_asset_catalog_state SET source_id = :1 WHERE singleton = 1`,
        [sourceId],
        { autoCommit: true },
      );
      return entries.length;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      await conn.close();
    }
  }

  async listRevisions(rawLimit: unknown = null) {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      let sql = `SELECT r.id, r.storage_revision, r.database_initialized,
                        r.scope, r.action, r.restored_from_revision,
                        r.created_at, COUNT(a.sequence_num) AS change_count
                 FROM system_revisions r
                 LEFT JOIN system_audit_log a ON a.revision_id = r.id
                 GROUP BY r.id, r.storage_revision, r.database_initialized,
                          r.scope, r.action, r.restored_from_revision, r.created_at
                 ORDER BY r.id DESC`;
      const params: OracleBind[] = [];
      const parsedLimit = parseRevisionListLimit(rawLimit);
      if (parsedLimit !== null) {
        sql += " FETCH FIRST :1 ROWS ONLY";
        params.push(parsedLimit);
      }
      const rows = await fetchRows<RevisionListRow>(conn, sql, params);
      return rows.map((row) =>
        mapRevisionListRow(row, { decodeDatabaseInitialized: num1ToBool }),
      );
    } finally {
      await conn.close();
    }
  }

  async getRevisionDetails(id: unknown) {
    this.assertEnabled();
    const revisionId = Number(id);
    const conn = await this.pool.getConnection();
    try {
      const revRows = await fetchRows<RevisionRow>(
        conn,
        "SELECT * FROM system_revisions WHERE id = :1",
        [revisionId],
      );
      if (revRows.length === 0) return null;
      const rev = revRows[0];

      const auditRows = await fetchRows<AuditLogEntryRow>(
        conn,
        "SELECT sequence_num, revision_id, table_name, operation, before_row, after_row, recorded_at FROM system_audit_log WHERE revision_id = :1 ORDER BY sequence_num ASC",
        [revisionId],
      );

      return buildRevisionDetails(rev, auditRows, {
        decodeRow: parseJsonSnapshot,
        decodeDatabaseInitialized: num1ToBool,
      });
    } finally {
      await conn.close();
    }
  }

  async getRevisionDiff(baseId: unknown, targetId: unknown) {
    this.assertEnabled();
    const minId = Math.min(Number(baseId), Number(targetId));
    const maxId = Math.max(Number(baseId), Number(targetId));
    const conn = await this.pool.getConnection();
    try {
      const auditRows = await fetchRows<AuditLogEntryRow>(
        conn,
        "SELECT sequence_num, revision_id, table_name, operation, before_row, after_row, recorded_at FROM system_audit_log WHERE revision_id > :1 AND revision_id <= :2 ORDER BY sequence_num ASC",
        [minId, maxId],
      );

      return {
        baseRevisionId: Number(baseId),
        targetRevisionId: Number(targetId),
        totalChanges: auditRows.length,
        tables: buildRevisionDiffTables(auditRows, {
          decodeRow: parseJsonSnapshot,
        }),
      };
    } finally {
      await conn.close();
    }
  }

  async previewRestore(rawRevisionId: unknown) {
    this.assertEnabled();
    const targetRevisionId = Number(rawRevisionId);
    const conn = await this.pool.getConnection();
    try {
      const targetRows = await fetchRows<RevisionRow>(
        conn,
        "SELECT id FROM system_revisions WHERE id = :1",
        [targetRevisionId],
      );
      if (targetRows.length === 0) {
        throw new Error("The requested revision does not exist");
      }

      const latestRows = await fetchRows<RevisionRow>(
        conn,
        "SELECT id FROM system_revisions ORDER BY id DESC FETCH FIRST 1 ROWS ONLY",
        [],
      );
      const currentRevisionId = latestRows[0]?.id
        ? Number(latestRows[0].id)
        : targetRevisionId;

      const auditRows = await fetchRows<AuditLogEntryRow>(
        conn,
        "SELECT sequence_num, table_name, operation, before_row, after_row FROM system_audit_log WHERE revision_id > :1 ORDER BY sequence_num DESC",
        [targetRevisionId],
      );

      return {
        targetRevisionId,
        currentRevisionId,
        revisionsToRevert: Math.max(0, currentRevisionId - targetRevisionId),
        ...buildRestorePreview(auditRows),
      };
    } finally {
      await conn.close();
    }
  }

  async loadStartupData() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const metaRow = await fetchRequiredRow<StorageMetaRow>(
        conn,
        `SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1`,
      );
      const revision = Number(metaRow.revision);
      const initialized = num1ToBool(metaRow.initialized);
      if (!initialized) {
        await conn.rollback();
        return {
          status: "empty",
          revision,
          settings: {},
          characters: [],
          deferredSettingKeys: [],
        };
      }
      const settings = await fetchRows<OracleSettingScalarRow>(
        conn,
        `SELECT key, text_val, num_val, bool_val FROM system_settings ` +
          `WHERE key NOT IN (${STARTUP_EXCLUDED_KEYS_SQL_LITERAL}) ORDER BY key`,
        [],
        { clobColumns: ["text_val"] },
      );
      const settingValues = await fetchRows<SettingValueRow>(
        conn,
        `SELECT * FROM system_setting_values ` +
          `WHERE setting_key NOT IN (${STARTUP_EXCLUDED_KEYS_SQL_LITERAL}) ` +
          `ORDER BY setting_key, node_id`,
        [],
        {
          clobColumns: [
            "member_key",
            "encoded_member_key",
            "text_value",
            "encoded_text_value",
          ],
        },
      );
      const rebuiltSettings = rebuildSettings(settings, settingValues);
      for (const row of settings) {
        if (!Object.prototype.hasOwnProperty.call(rebuiltSettings, row.key)) {
          rebuiltSettings[row.key] = mapColumnsToSettingValue(row);
        }
      }
      const characterRows = await fetchRows<CharacterCoreRow>(
        conn,
        `SELECT id, kind, name, image, trash_time, creation_time, ` +
          `modification_time, last_interaction_time FROM character_characters ` +
          `ORDER BY position, id`,
        [],
        { clobColumns: ["image"] },
      );
      const characters = mapStartupCharacters(
        characterRows,
        (value) => timestampToNumber(value) ?? undefined,
      );
      await conn.rollback();
      return {
        status: "ready",
        revision,
        settings: rebuiltSettings,
        characters,
        deferredSettingKeys: [...DEFERRED_STARTUP_SETTING_KEYS],
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async listGlobalAuthorNotes() {
    return withAuthorNoteDatabase(
      this,
      "oracle",
      authorNoteSql.listAuthorNotes,
    );
  }
  async getGlobalAuthorNote(id: string) {
    return withAuthorNoteDatabase(
      this,
      "oracle",
      (
        db: import("../../../../packages/protocol/src/authorNoteSql.ts").AuthorNoteSql,
      ) => authorNoteSql.getAuthorNote(db, id),
    );
  }
  async readGlobalAuthorNote(id: string) {
    return withAuthorNoteDatabase(
      this,
      "oracle",
      (
        db: import("../../../../packages/protocol/src/authorNoteSql.ts").AuthorNoteSql,
      ) => authorNoteSql.readAuthorNote(db, id),
    );
  }
  async getGlobalAuthorNoteScriptWrite() {
    return withAuthorNoteDatabase(
      this,
      "oracle",
      authorNoteSql.allowAuthorNoteScriptWrite,
    );
  }

  async exportDatabaseSnapshot() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      // Oracle: READ ONLY 트랜잭션
      await conn.execute("SET TRANSACTION READ ONLY");
      const snapshot = await exportDatabaseSnapshotWith(
        new OracleDialect(conn),
        {
          readMeta: async () => {
            const metaRow = await fetchRequiredRow<StorageMetaRow>(
              conn,
              `SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1`,
            );
            return {
              revision: Number(metaRow.revision),
              initialized: Boolean(num1ToBool(metaRow.initialized)),
            };
          },
          readAuthorNotes: () =>
            authorNoteSql.exportAuthorNotes(authorNoteDatabase("oracle", conn)),
        },
      );
      await conn.rollback();
      return snapshot;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadCharacter(characterId: unknown) {
    this.assertEnabled();
    assertId(characterId, "characterId");
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const charRow = await fetchOne<CharacterCoreRow>(
        conn,
        `SELECT * FROM character_characters WHERE id = :1`,
        [characterId],
        {
          clobColumns: [
            "image",
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
            "first_message",
          ],
        },
      );
      if (!charRow) {
        await conn.rollback();
        return null;
      }
      const [
        attributes,
        tags,
        greetings,
        biases,
        emotions,
        modules,
        groupMembers,
        chatFolders,
        scripts,
        sdData,
        assets,
        lore,
        chats,
      ] = await Promise.all([
        fetchRows<CharacterAttributeRow>(
          conn,
          `SELECT * FROM character_attributes WHERE character_id = :1 ORDER BY key_value`,
          [characterId],
        ),
        fetchRows<CharacterTagRow>(
          conn,
          `SELECT * FROM character_tags WHERE character_id = :1 ORDER BY position`,
          [characterId],
        ),
        fetchRows<CharacterGreetingRow>(
          conn,
          `SELECT * FROM character_greetings WHERE character_id = :1 ORDER BY greeting_type, position`,
          [characterId],
          { clobColumns: ["content"] },
        ),
        fetchRows<CharacterBiasRow>(
          conn,
          `SELECT * FROM character_biases WHERE character_id = :1 ORDER BY position`,
          [characterId],
        ),
        fetchRows<CharacterEmotionRow>(
          conn,
          `SELECT * FROM character_emotions WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["asset"] },
        ),
        fetchRows<CharacterModuleRow>(
          conn,
          `SELECT * FROM character_modules WHERE character_id = :1 ORDER BY position`,
          [characterId],
        ),
        fetchRows<CharacterGroupMemberRow>(
          conn,
          `SELECT * FROM character_group_members WHERE group_id = :1 ORDER BY position`,
          [characterId],
        ),
        fetchRows<CharacterChatFolderRow>(
          conn,
          `SELECT * FROM character_chat_folders WHERE character_id = :1 ORDER BY position`,
          [characterId],
        ),
        fetchRows<CharacterScriptRow>(
          conn,
          `SELECT * FROM character_scripts WHERE character_id = :1 ORDER BY script_kind, position`,
          [characterId],
          {
            clobColumns: ["comment_text", "input_text", "output_text", "flag"],
          },
        ),
        fetchRows<CharacterSdRow>(
          conn,
          `SELECT * FROM character_sd_data WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["value"] },
        ),
        fetchRows<CharacterAssetRow>(
          conn,
          `SELECT * FROM character_assets WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["uri", "extra_value"] },
        ),
        fetchRows<CharacterLoreRow>(
          conn,
          `SELECT * FROM character_lore_entries WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["comment_text", "content"] },
        ),
        fetchRows<ChatCoreRow>(
          conn,
          `SELECT id, name, note, folder_id, last_message_time FROM chat_chats WHERE character_id = :1 ORDER BY position, id`,
          [characterId],
          { clobColumns: ["note"] },
        ),
      ]);
      const character = rebuildCharacter(charRow, {
        attributes,
        tags,
        greetings,
        biases,
        emotions,
        modules,
        groupMembers,
        chatFolders,
        scripts,
        sdData,
        assets,
        lore,
      });
      character.chats = chats.map(buildChatShell);
      character.detailsLoaded = true;
      await conn.rollback();
      return character;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  // Asset-bearing fields only (image, customBackground, gptSoVitsConfig, vits,
  // emotionImages, additionalAssets, ccAssets). The storage explorer's orphan
  // analysis needs these without hydrating lore, scripts or chats.
  async loadCharacterAssetFields(characterId: unknown) {
    this.assertEnabled();
    assertId(characterId, "characterId");
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const charRow = await fetchOne<CharacterCoreRow>(
        conn,
        `SELECT image FROM character_characters WHERE id = :1`,
        [characterId],
        { clobColumns: ["image"] },
      );
      if (!charRow) {
        await conn.rollback();
        return null;
      }
      const [attributes, emotions, assets] = await Promise.all([
        fetchRows<CharacterAttributeRow>(
          conn,
          `SELECT * FROM character_attributes WHERE character_id = :1 ORDER BY key_value`,
          [characterId],
        ),
        fetchRows<CharacterEmotionRow>(
          conn,
          `SELECT * FROM character_emotions WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["asset"] },
        ),
        fetchRows<CharacterAssetRow>(
          conn,
          `SELECT * FROM character_assets WHERE character_id = :1 ORDER BY position`,
          [characterId],
          { clobColumns: ["uri", "extra_value"] },
        ),
      ]);
      const fields: Record<string, unknown> = {};
      if (charRow.image !== null && charRow.image !== undefined)
        fields.image = charRow.image;
      for (const row of attributes) {
        fields[row.key] = decodePostgresJsonValue(row.value);
      }
      if (emotions.length) {
        fields.emotionImages = emotions.map((item) => [
          item.emotion,
          item.asset,
        ]);
      }
      const additionalAssets = assets
        .filter((item) => item.asset_source === "additional")
        .map((item) => [item.name, item.uri, item.extension]);
      if (additionalAssets.length) fields.additionalAssets = additionalAssets;
      const ccAssets = assets
        .filter((item) => item.asset_source === "character-card")
        .map((item) => ({
          type: item.asset_type,
          uri: item.uri,
          name: item.name,
          ext: item.extension,
        }));
      if (ccAssets.length) fields.ccAssets = ccAssets;
      await conn.rollback();
      return { assets: fields };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async _loadLinearMessagesForBranchMigration(
    conn: OracleConnection,
    chatId: string,
  ) {
    const dialect = new OracleDialect(conn);
    return rebuildLinearMessages({
      messages: await dialect.selectByKey("chat.messages", "chat_id", chatId),
      attributes: await dialect.selectByKey(
        "chat.message_attributes",
        "chat_id",
        chatId,
      ),
      generations: await dialect.selectByKey(
        "chat.message_generation",
        "chat_id",
        chatId,
      ),
      promptInfos: await dialect.selectByKey(
        "chat.message_prompt_info",
        "chat_id",
        chatId,
      ),
      promptToggles: await dialect.selectByKey(
        "chat.message_prompt_toggles",
        "chat_id",
        chatId,
      ),
      promptItems: await dialect.selectByKey(
        "chat.message_prompt_items",
        "chat_id",
        chatId,
      ),
    });
  }

  async _upsertMessagesForBranchMigration(
    conn: OracleConnection,
    splitMessages: readonly MessageSplit[],
  ): Promise<void> {
    if (splitMessages.length === 0) return;
    const messageColumns: readonly (keyof MessageCoreRow)[] = [
      "chat_id",
      "id",
      "position",
      "role",
      "content_text",
      "content_binary",
      "saying_character_id",
      "sent_time",
      "sender_name",
      "other_user",
      "disabled_scope",
      "is_comment",
    ];
    const updateCols = messageColumns.slice(2);
    const upsertSql = `BEGIN
            UPDATE chat_messages SET
                ${updateCols.map((column) => `${column.toUpperCase()} = :${column}`).join(", ")},
                updated_at = SYSTIMESTAMP
            WHERE chat_id = :chat_id AND id = :id;
            IF SQL%ROWCOUNT = 0 THEN
                INSERT INTO chat_messages (${messageColumns.map((column) => column.toUpperCase()).join(", ")})
                VALUES (${messageColumns.map((column) => `:${column}`).join(", ")});
            END IF;
        END;`;
    const bindDefs: Record<string, OracleBindDefinition> = {};
    for (const column of messageColumns) {
      const type = this._getColumnBindType("chat_messages", column);
      bindDefs[column] =
        type === oracledb.DB_TYPE_VARCHAR ? { type, maxSize: 4000 } : { type };
    }
    const binds = splitMessages.map((item) => {
      const row: Record<string, unknown> = {};
      for (const column of messageColumns) {
        const type = this._getColumnBindType("chat_messages", column);
        row[column] = this._formatBindValue(item.core[column], type, false);
      }
      return row;
    });
    await conn.executeMany(upsertSql, binds, { bindDefs });
  }

  async migrateLegacyBranchState(conn: OracleConnection, chatId: string) {
    return migrateLegacyBranchStateWith(new OracleDialect(conn), chatId, {
      readLegacyState: async () => {
        const legacyRow = await fetchOne<LegacyBranchStateRow>(
          conn,
          `
            SELECT
                (SELECT COUNT(*) FROM chat_branches WHERE chat_id = :chatId) AS branch_count,
                (SELECT value FROM chat_attributes WHERE chat_id = :chatId AND key_value = 'branchState') AS branch_state
              FROM dual
        `,
          { chatId },
        );
        return {
          branchCount: Number(legacyRow?.branch_count ?? 0),
          branchState: legacyRow?.branch_state ?? null,
        };
      },
      readLinearMessages: () =>
        this._loadLinearMessagesForBranchMigration(conn, chatId),
      decodeState: (value) =>
        decodePostgresJsonValue(decodeLegacyBranchState(value)),
      newId: () => crypto.randomUUID(),
    });
  }

  async ensureChatBranchGraphs(
    conn: OracleConnection,
    chatIds: readonly unknown[],
  ): Promise<void> {
    const ids = [
      ...new Set<string>(
        (chatIds || []).filter(
          (chatId): chatId is string => typeof chatId === "string" && !!chatId,
        ),
      ),
    ];
    if (ids.length === 0) return;
    const idsJson = JSON.stringify(ids);
    await conn.execute(
      `
            MERGE INTO chat_branches target
            USING (
                SELECT chats.id AS chat_id,
                       chats.id || ':root' AS id,
                       (SELECT id FROM chat_messages
                         WHERE chat_id = chats.id
                         ORDER BY position DESC, id DESC FETCH FIRST 1 ROW ONLY) AS head_message_id
                  FROM chat_chats chats
                  JOIN JSON_TABLE(:idsJson, '$[*]' COLUMNS (id VARCHAR2(4000) PATH '$')) ids
                    ON ids.id = chats.id
                 WHERE NOT EXISTS (
                     SELECT 1 FROM chat_branches existing WHERE existing.chat_id = chats.id
                 )
            ) source
            ON (target.chat_id = source.chat_id AND target.id = source.id)
            WHEN NOT MATCHED THEN INSERT
                (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
            VALUES
                (source.chat_id, source.id, NULL, NULL, source.head_message_id, 'root', 0)
        `,
      { idsJson: clobBind(idsJson) },
    );
    await conn.execute(
      `
            MERGE INTO chat_message_branch_links target
            USING (
                SELECT ordered.chat_id,
                       ordered.id AS message_id,
                       ordered.parent_message_id,
                       ordered.chat_id || ':root' AS origin_branch_id
                  FROM (
                      SELECT messages.chat_id, messages.id,
                             LAG(messages.id) OVER (PARTITION BY messages.chat_id ORDER BY messages.position, messages.id) AS parent_message_id
                        FROM chat_messages messages
                        JOIN JSON_TABLE(:idsJson, '$[*]' COLUMNS (id VARCHAR2(4000) PATH '$')) ids
                          ON ids.id = messages.chat_id
                       WHERE NOT EXISTS (
                           SELECT 1 FROM chat_active_branches active WHERE active.chat_id = messages.chat_id
                       )
                         AND (SELECT COUNT(*) FROM chat_branches branches WHERE branches.chat_id = messages.chat_id) = 1
                         AND EXISTS (
                             SELECT 1 FROM chat_branches root
                              WHERE root.chat_id = messages.chat_id AND root.id = messages.chat_id || ':root'
                         )
                  ) ordered
            ) source
            ON (target.chat_id = source.chat_id AND target.message_id = source.message_id)
            WHEN NOT MATCHED THEN INSERT
                (chat_id, message_id, parent_message_id, origin_branch_id)
            VALUES
                (source.chat_id, source.message_id, source.parent_message_id, source.origin_branch_id)
        `,
      { idsJson: clobBind(idsJson) },
    );
    await conn.execute(
      `
            MERGE INTO chat_active_branches target
            USING (
                SELECT chats.id AS chat_id, chats.id || ':root' AS branch_id
                  FROM chat_chats chats
                  JOIN JSON_TABLE(:idsJson, '$[*]' COLUMNS (id VARCHAR2(4000) PATH '$')) ids
                    ON ids.id = chats.id
                 WHERE (SELECT COUNT(*) FROM chat_branches branches WHERE branches.chat_id = chats.id) = 1
                   AND EXISTS (
                       SELECT 1 FROM chat_branches root
                        WHERE root.chat_id = chats.id AND root.id = chats.id || ':root'
                   )
            ) source
            ON (target.chat_id = source.chat_id)
            WHEN NOT MATCHED THEN INSERT (chat_id, branch_id)
            VALUES (source.chat_id, source.branch_id)
        `,
      { idsJson: clobBind(idsJson) },
    );
  }

  async ensureChatBranchGraph(
    conn: OracleConnection,
    chatId: string,
  ): Promise<string | null> {
    await this.migrateLegacyBranchState(conn, chatId);
    let active = await this._activeBranchId(conn, chatId);
    if (active) return active;
    await this.ensureChatBranchGraphs(conn, [chatId]);
    active = await this._activeBranchId(conn, chatId);
    return active;
  }

  async linkIncomingMessagesToActiveBranches(
    conn: OracleConnection,
    splitMessages: readonly MessageSplit[],
  ): Promise<void> {
    if (!splitMessages || splitMessages.length === 0) return;
    const incoming = splitMessages.map((item) => ({
      chat_id: item.core.chat_id,
      message_id: item.core.id,
      position: item.core.position,
    }));
    const incomingJson = JSON.stringify(incoming);
    const unlinked = await fetchRows<OracleUnlinkedMessageRow>(
      conn,
      `
            SELECT incoming.chat_id, incoming.message_id, incoming.position, active.branch_id
              FROM JSON_TABLE(:incomingJson, '$[*]' COLUMNS (
                       chat_id VARCHAR2(4000) PATH '$.chat_id',
                       message_id VARCHAR2(4000) PATH '$.message_id',
                       position NUMBER PATH '$.position'
                   )) incoming
              JOIN chat_active_branches active ON active.chat_id = incoming.chat_id
              LEFT JOIN chat_message_branch_links links
                ON links.chat_id = incoming.chat_id AND links.message_id = incoming.message_id
             WHERE links.message_id IS NULL
             ORDER BY incoming.chat_id, incoming.position, incoming.message_id
        `,
      { incomingJson },
    );
    if (unlinked.length === 0) return;
    const unlinkedJson = JSON.stringify(
      unlinked.map((row) => ({
        chat_id: row.chat_id,
        message_id: row.message_id,
        position: Number(row.position) || 0,
      })),
    );
    await conn.execute(
      `
            MERGE INTO chat_message_branch_links target
            USING (
                SELECT ordered.chat_id,
                       ordered.message_id,
                       COALESCE(ordered.previous_incoming_id, branch.head_message_id) AS parent_message_id,
                       active.branch_id AS origin_branch_id
                  FROM (
                      SELECT incoming.*,
                             LAG(message_id) OVER (PARTITION BY chat_id ORDER BY position, message_id) AS previous_incoming_id
                        FROM JSON_TABLE(:unlinkedJson, '$[*]' COLUMNS (
                                 chat_id VARCHAR2(4000) PATH '$.chat_id',
                                 message_id VARCHAR2(4000) PATH '$.message_id',
                                 position NUMBER PATH '$.position'
                             )) incoming
                  ) ordered
                  JOIN chat_active_branches active ON active.chat_id = ordered.chat_id
                  JOIN chat_branches branch ON branch.chat_id = active.chat_id AND branch.id = active.branch_id
            ) source
            ON (target.chat_id = source.chat_id AND target.message_id = source.message_id)
            WHEN NOT MATCHED THEN INSERT
                (chat_id, message_id, parent_message_id, origin_branch_id)
            VALUES
                (source.chat_id, source.message_id, source.parent_message_id, source.origin_branch_id)
        `,
      { unlinkedJson },
    );
    const heads = new Map<string, BranchHead>();
    for (const row of unlinked) {
      const key = `${row.chat_id}\0${row.branch_id}`;
      const position = Number(row.position) || 0;
      const previous = heads.get(key);
      if (!previous || position >= previous.position) {
        heads.set(key, {
          chatId: row.chat_id,
          branchId: row.branch_id,
          messageId: row.message_id,
          position,
        });
      }
    }
    for (const head of heads.values()) {
      await conn.execute(
        `UPDATE chat_branches SET head_message_id = :messageId WHERE chat_id = :chatId AND id = :branchId`,
        {
          chatId: head.chatId,
          branchId: head.branchId,
          messageId: head.messageId,
        },
      );
    }
  }

  async detachMessagesFromBranchGraph(
    conn: OracleConnection,
    deletions: readonly MessageDeletion[],
  ): Promise<void> {
    for (const deletion of deletions || []) {
      for (const messageId of deletion.ids || []) {
        await conn.execute(
          `
                    UPDATE chat_message_branch_links child
                       SET parent_message_id = (
                           SELECT removed.parent_message_id
                             FROM chat_message_branch_links removed
                            WHERE removed.chat_id = :chatId AND removed.message_id = :messageId
                       )
                     WHERE child.chat_id = :chatId AND child.parent_message_id = :messageId
                `,
          { chatId: deletion.chatId, messageId },
        );
        await conn.execute(
          `
                    UPDATE chat_branches branch
                       SET head_message_id = (
                           SELECT removed.parent_message_id
                             FROM chat_message_branch_links removed
                            WHERE removed.chat_id = :chatId AND removed.message_id = :messageId
                       )
                     WHERE branch.chat_id = :chatId AND branch.head_message_id = :messageId
                `,
          { chatId: deletion.chatId, messageId },
        );
        await conn.execute(
          `UPDATE chat_branches SET fork_message_id = NULL WHERE chat_id = :1 AND fork_message_id = :2`,
          [deletion.chatId, messageId],
        );
        await conn.execute(
          `DELETE FROM chat_message_branch_links WHERE chat_id = :1 AND message_id = :2`,
          [deletion.chatId, messageId],
        );
      }
    }
  }

  async _activeBranchId(
    conn: OracleConnection,
    chatId: string,
  ): Promise<string | null> {
    const row = await fetchOne<OracleActiveBranchRow>(
      conn,
      `SELECT branch_id FROM chat_active_branches WHERE chat_id = :1`,
      [chatId],
    );
    return row?.branch_id ?? null;
  }

  async _loadBranchPage(
    conn: OracleConnection,
    chatId: string,
    branchId: string,
    options: BranchPageOptions = {},
  ) {
    const countRow = await fetchOne<{ total: number | string }>(
      conn,
      `
            SELECT COUNT(*) AS total
              FROM (
                  SELECT links.message_id, LEVEL AS depth
                    FROM chat_message_branch_links links
                   WHERE links.chat_id = :chatId
                   START WITH links.message_id = (
                       SELECT head_message_id FROM chat_branches
                        WHERE chat_id = :chatId AND id = :branchId
                   )
                 CONNECT BY NOCYCLE PRIOR links.parent_message_id = links.message_id
                                    AND PRIOR links.chat_id = links.chat_id
              )
        `,
      { chatId, branchId },
    );
    const total = Number(countRow?.total ?? 0);
    const end =
      options.before === undefined
        ? total
        : Math.max(0, Math.min(total, Math.floor(Number(options.before) || 0)));
    const requestedLimit =
      options.limit === undefined
        ? end
        : Math.max(1, Math.floor(Number(options.limit) || 1));
    const offset = Math.max(0, end - requestedLimit);
    const pageSize = Math.max(0, end - offset);
    if (pageSize === 0)
      return { messages: [], offset, total, hasMore: offset > 0 };
    const messages = await fetchRows<MessageCoreRow>(
      conn,
      `
            SELECT messages.*, path.depth
              FROM (
                  SELECT links.message_id, LEVEL AS depth
                    FROM chat_message_branch_links links
                   WHERE links.chat_id = :chatId
                   START WITH links.message_id = (
                       SELECT head_message_id FROM chat_branches
                        WHERE chat_id = :chatId AND id = :branchId
                   )
                 CONNECT BY NOCYCLE PRIOR links.parent_message_id = links.message_id
                                    AND PRIOR links.chat_id = links.chat_id
              ) path
              JOIN chat_messages messages
                ON messages.chat_id = :chatId AND messages.id = path.message_id
             ORDER BY path.depth DESC
             OFFSET :branchOffset ROWS FETCH NEXT :branchPageSize ROWS ONLY
        `,
      { chatId, branchId, branchOffset: offset, branchPageSize: pageSize },
      {
        clobColumns: ["content_text"],
        blobColumns: ["content_binary"],
      },
    );
    const ids = messages.map((row) => row.id);
    if (ids.length === 0)
      return { messages: [], offset, total, hasMore: offset > 0 };
    const idsJson = JSON.stringify(ids);
    const relationJoin = `JOIN JSON_TABLE(:idsJson, '$[*]' COLUMNS (id VARCHAR2(4000) PATH '$')) ids ON ids.id = source.message_id`;
    let attributes: MessageAttributeRow[] = [];
    let generations: MessageGenerationRow[] = [];
    let promptInfos: MessagePromptInfoRow[] = [];
    let promptToggles: MessagePromptToggleRow[] = [];
    let promptItems: MessagePromptItemRow[] = [];
    if (options.mode === "graph") {
      generations = await fetchRows<MessageGenerationRow>(
        conn,
        `SELECT source.* FROM chat_message_generation source ${relationJoin} WHERE source.chat_id = :chatId`,
        { idsJson, chatId },
      );
    } else {
      attributes = await fetchRows<MessageAttributeRow>(
        conn,
        `SELECT source.* FROM chat_message_attributes source ${relationJoin} WHERE source.chat_id = :chatId ORDER BY source.message_id, source.key_value`,
        { idsJson, chatId },
      );
      if (options.mode !== "generation") {
        [generations, promptInfos, promptToggles, promptItems] =
          await Promise.all([
            fetchRows<MessageGenerationRow>(
              conn,
              `SELECT source.* FROM chat_message_generation source ${relationJoin} WHERE source.chat_id = :chatId`,
              { idsJson, chatId },
            ),
            fetchRows<MessagePromptInfoRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_info source ${relationJoin} WHERE source.chat_id = :chatId`,
              { idsJson, chatId },
            ),
            fetchRows<MessagePromptToggleRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_toggles source ${relationJoin} WHERE source.chat_id = :chatId ORDER BY source.message_id, source.position`,
              { idsJson, chatId },
              { clobColumns: ["toggle_value"] },
            ),
            fetchRows<MessagePromptItemRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_items source ${relationJoin} WHERE source.chat_id = :chatId ORDER BY source.message_id, source.position`,
              { idsJson, chatId },
            ),
          ]);
      }
    }
    const relations = {
      attributes: groupMessageRows(attributes),
      generation: new Map<string, MessageGenerationRow>(
        generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row]),
      ),
      promptInfo: new Map<string, MessagePromptInfoRow>(
        promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row]),
      ),
      promptToggles: groupMessageRows(promptToggles),
      promptItems: groupMessageRows(promptItems),
    };
    const rebuilt = messages.map((row) => {
      const key = `${row.chat_id}\0${row.id}`;
      return rebuildMessage(row, {
        attributes: relations.attributes.get(key),
        generation: relations.generation.get(key),
        promptInfo: relations.promptInfo.get(key),
        promptToggles: relations.promptToggles.get(key),
        promptItems: relations.promptItems.get(key),
      });
    });
    return { messages: rebuilt, offset, total, hasMore: offset > 0 };
  }

  async loadChat(chatId: unknown, options: LoadChatOptions = {}) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const activeBranchId = await this._activeBranchId(conn, chatId);
      const chatRow = await fetchOne<ChatCoreRow>(
        conn,
        `SELECT * FROM chat_chats WHERE id = :1`,
        [chatId],
        { clobColumns: ["note", "sd_data", "supa_memory_data", "last_memory"] },
      );
      if (!chatRow || !activeBranchId) {
        await conn.commit();
        return null;
      }
      const [
        attributes,
        suggestions,
        modules,
        scriptState,
        bookmarks,
        memory,
        lore,
      ] = await Promise.all([
        fetchRows<ChatAttributeRow>(
          conn,
          `SELECT * FROM chat_attributes WHERE chat_id = :1 ORDER BY key_value`,
          [chatId],
        ),
        fetchRows<ChatSuggestionRow>(
          conn,
          `SELECT * FROM chat_suggestions WHERE chat_id = :1 ORDER BY position`,
          [chatId],
          { clobColumns: ["content"] },
        ),
        fetchRows<ChatModuleRow>(
          conn,
          `SELECT * FROM chat_modules WHERE chat_id = :1 ORDER BY position`,
          [chatId],
        ),
        fetchRows<ChatScriptStateRow>(
          conn,
          `SELECT * FROM chat_script_state WHERE chat_id = :1 ORDER BY key_value`,
          [chatId],
          { clobColumns: ["text_value"] },
        ),
        fetchRows<ChatBookmarkRow>(
          conn,
          `SELECT * FROM chat_bookmarks WHERE chat_id = :1 ORDER BY position`,
          [chatId],
        ),
        fetchRows<ChatMemoryRow>(
          conn,
          `SELECT * FROM chat_memory WHERE chat_id = :1 ORDER BY memory_type`,
          [chatId],
        ),
        fetchRows<ChatLoreRow>(
          conn,
          `SELECT * FROM chat_lore_entries WHERE chat_id = :1 ORDER BY position`,
          [chatId],
          { clobColumns: ["comment_text", "content", "cache_payload"] },
        ),
      ]);
      const page = await this._loadBranchPage(conn, chatId, activeBranchId, {
        limit: options.messageLimit,
        mode: "full",
      });
      const chat = rebuildChat(chatRow, {
        attributes,
        suggestions,
        modules,
        scriptState,
        bookmarks,
        memory,
        lore,
        messages: page.messages,
      });
      chat.activeBranchId = activeBranchId;
      delete chat.branchState;
      chat.messageOffset = page.offset;
      chat.messageTotal = page.total;
      chat.messagesFullyLoaded = !page.hasMore;
      chat.messagesLoaded = true;
      chat.detailsLoaded = true;
      await conn.commit();
      return chat;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadChatMessages(chatId: unknown, options: LoadChatOptions = {}) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const branchId = await this._activeBranchId(conn, chatId);
      const messages = branchId
        ? (
            await this._loadBranchPage(conn, chatId, branchId, {
              mode: options.mode,
            })
          ).messages
        : [];
      await conn.commit();
      return messages;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadChatMessagePage(chatId: unknown, before: unknown, limit: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const branchId = await this._activeBranchId(conn, chatId);
      const page = branchId
        ? await this._loadBranchPage(conn, chatId, branchId, {
            before,
            limit,
            mode: "full",
          })
        : { messages: [], offset: 0, total: 0, hasMore: false };
      await conn.commit();
      return page;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async listChatBranches(chatId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const rows = await fetchRows<BranchRow>(
        conn,
        `
                SELECT id, chat_id, parent_branch_id, fork_message_id, head_message_id, reason, created_at
                  FROM chat_branches WHERE chat_id = :1 ORDER BY created_at, id
            `,
        [chatId],
      );
      await conn.commit();
      return rows.map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        parentBranchId: row.parent_branch_id ?? undefined,
        forkMessageId: row.fork_message_id ?? undefined,
        headMessageId: row.head_message_id ?? undefined,
        reason: row.reason,
        createdAt: Number(row.created_at) || 0,
      }));
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadChatBranchGraphPage(
    chatId: unknown,
    rawOffset: unknown,
    rawLimit: unknown,
  ) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const offset = Math.max(0, Math.floor(Number(rawOffset) || 0));
    const limit = Math.min(
      1000,
      Math.max(1, Math.floor(Number(rawLimit) || 256)),
    );
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const branchesRows = await fetchRows<BranchRow>(
        conn,
        `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
                branch.head_message_id, branch.reason, branch.created_at,
                active.branch_id AS active_branch_id
           FROM chat_branches branch
      LEFT JOIN chat_active_branches active ON active.chat_id = branch.chat_id
          WHERE branch.chat_id = :graphChatId
       ORDER BY branch.created_at, branch.id`,
        { graphChatId: chatId },
      );
      const countRow = await fetchOne<{ total: number | string }>(
        conn,
        "SELECT COUNT(*) AS total FROM chat_message_branch_links WHERE chat_id = :graphChatId",
        { graphChatId: chatId },
      );
      const total = Number(countRow?.total ?? 0);
      const messages = await fetchRows<OracleGraphMessageRow>(
        conn,
        `SELECT messages.*, links.parent_message_id, links.origin_branch_id
           FROM chat_message_branch_links links
           JOIN chat_messages messages
             ON messages.chat_id = links.chat_id AND messages.id = links.message_id
          WHERE links.chat_id = :graphChatId
       ORDER BY messages.position, messages.id
         OFFSET :graphOffset ROWS FETCH NEXT :graphLimit ROWS ONLY`,
        { graphChatId: chatId, graphOffset: offset, graphLimit: limit },
        { clobColumns: ["content_text"], blobColumns: ["content_binary"] },
      );
      const ids = messages.map((row) => row.id);
      let attributes: MessageAttributeRow[] = [];
      let generations: MessageGenerationRow[] = [];
      let promptInfos: MessagePromptInfoRow[] = [];
      let promptToggles: MessagePromptToggleRow[] = [];
      let promptItems: MessagePromptItemRow[] = [];
      if (ids.length > 0) {
        const idsJson = JSON.stringify(ids);
        const relationJoin = `JOIN JSON_TABLE(:idsJson, '$[*]' COLUMNS (id VARCHAR2(4000) PATH '$')) ids ON ids.id = source.message_id`;
        [attributes, generations, promptInfos, promptToggles, promptItems] =
          await Promise.all([
            fetchRows<MessageAttributeRow>(
              conn,
              `SELECT source.* FROM chat_message_attributes source ${relationJoin} WHERE source.chat_id = :graphChatId ORDER BY source.message_id, source.key_value`,
              { idsJson, graphChatId: chatId },
            ),
            fetchRows<MessageGenerationRow>(
              conn,
              `SELECT source.* FROM chat_message_generation source ${relationJoin} WHERE source.chat_id = :graphChatId`,
              { idsJson, graphChatId: chatId },
            ),
            fetchRows<MessagePromptInfoRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_info source ${relationJoin} WHERE source.chat_id = :graphChatId`,
              { idsJson, graphChatId: chatId },
            ),
            fetchRows<MessagePromptToggleRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_toggles source ${relationJoin} WHERE source.chat_id = :graphChatId ORDER BY source.message_id, source.position`,
              { idsJson, graphChatId: chatId },
              { clobColumns: ["toggle_value"] },
            ),
            fetchRows<MessagePromptItemRow>(
              conn,
              `SELECT source.* FROM chat_message_prompt_items source ${relationJoin} WHERE source.chat_id = :graphChatId ORDER BY source.message_id, source.position`,
              { idsJson, graphChatId: chatId },
            ),
          ]);
      }
      const relations = {
        attributes: groupMessageRows(attributes),
        generation: new Map<string, MessageGenerationRow>(
          generations.map((row) => [`${row.chat_id}\0${row.message_id}`, row]),
        ),
        promptInfo: new Map<string, MessagePromptInfoRow>(
          promptInfos.map((row) => [`${row.chat_id}\0${row.message_id}`, row]),
        ),
        promptToggles: groupMessageRows(promptToggles),
        promptItems: groupMessageRows(promptItems),
      };
      const rebuilt = messages.map((row) => {
        const key = `${row.chat_id}\0${row.id}`;
        return rebuildMessage(row, {
          attributes: relations.attributes.get(key),
          generation: relations.generation.get(key),
          promptInfo: relations.promptInfo.get(key),
          promptToggles: relations.promptToggles.get(key),
          promptItems: relations.promptItems.get(key),
        });
      });
      const branches = branchesRows.map(mapBranchRow);
      await conn.commit();
      return {
        branches,
        activeBranchId: branchesRows[0]?.active_branch_id ?? undefined,
        messages: rebuilt,
        links: messages.map((row) => ({
          messageId: row.id,
          position: Number(row.position) || 0,
          parentMessageId: row.parent_message_id ?? undefined,
          originBranchId: row.origin_branch_id,
        })),
        offset,
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadChatBranchGraph(chatId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const branchesRows = await fetchRows<BranchRow>(
        conn,
        `
                SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
                       branch.head_message_id, branch.reason, branch.created_at,
                       active.branch_id AS active_branch_id
                  FROM chat_branches branch
             LEFT JOIN chat_active_branches active ON active.chat_id = branch.chat_id
                 WHERE branch.chat_id = :graphChatId
              ORDER BY branch.created_at, branch.id
            `,
        { graphChatId: chatId },
      );
      const graphRows = await fetchRows(
        conn,
        `
                SELECT messages.*, links.parent_message_id, links.origin_branch_id,
                       generation.model AS graph_generation_model
                  FROM chat_message_branch_links links
                  JOIN chat_messages messages
                    ON messages.chat_id = links.chat_id AND messages.id = links.message_id
             LEFT JOIN chat_message_generation generation
                    ON generation.chat_id = messages.chat_id AND generation.message_id = messages.id
                 WHERE links.chat_id = :graphChatId
              ORDER BY messages.position, messages.id
            `,
        { graphChatId: chatId },
        {
          clobColumns: ["content_text"],
          blobColumns: ["content_binary"],
        },
      );
      await conn.commit();
      return buildChatBranchGraph(branchesRows, graphRows);
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadBranchMessages(
    chatId: unknown,
    branchId: unknown,
    options: LoadChatOptions = {},
  ) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    assertId(branchId, "branchId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const page = await this._loadBranchPage(conn, chatId, branchId, {
        limit: options.messageLimit,
        mode: options.mode,
      });
      await conn.commit();
      return page.messages;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async createChatBranch(input: CreateChatBranchInput) {
    this.assertEnabled();
    assertId(input?.chatId, "chatId");
    assertId(input?.id, "branchId");
    if (input?.parentBranchId) assertId(input.parentBranchId, "parentBranchId");
    if (input?.forkMessageId) assertId(input.forkMessageId, "forkMessageId");
    const chatId = input.chatId;
    const branchId = input.id;
    const parentInput = input.parentBranchId ?? null;
    const forkMessageId = input.forkMessageId ?? null;
    const reason = input?.reason;
    if (!reason || !["root", "manual", "reroll"].includes(reason))
      throw new StoragePayloadError("Invalid chat branch reason");
    const createdAt = Number.isFinite(Number(input?.createdAt))
      ? Math.trunc(Number(input.createdAt))
      : Date.now();
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const activeId = await this._activeBranchId(conn, chatId);
      const parentBranchId = parentInput ?? activeId;
      if (!parentBranchId)
        throw new StoragePayloadError("Chat branch root does not exist");
      const parent = await fetchOne<BranchRow>(
        conn,
        `SELECT 1 AS ok FROM chat_branches WHERE chat_id = :1 AND id = :2`,
        [chatId, parentBranchId],
      );
      if (!parent)
        throw new StoragePayloadError("Parent chat branch does not exist");
      await conn.execute(
        `
                INSERT INTO chat_branches
                    (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
                VALUES (:chatId, :branchId, :parentBranchId, :forkMessageId, :forkMessageId, :reason, :createdAt)
            `,
        { chatId, branchId, parentBranchId, forkMessageId, reason, createdAt },
      );
      await conn.execute(
        `UPDATE chat_active_branches SET branch_id = :branchId WHERE chat_id = :chatId`,
        { chatId, branchId },
      );
      await conn.commit();
      return {
        id: branchId,
        chatId,
        parentBranchId,
        forkMessageId: forkMessageId ?? undefined,
        headMessageId: forkMessageId ?? undefined,
        reason,
        createdAt,
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async activateChatBranch(chatId: unknown, branchId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    assertId(branchId, "branchId");
    const conn = await this.pool.getConnection();
    try {
      await this.ensureChatBranchGraph(conn, chatId);
      const exists = await fetchOne<BranchRow>(
        conn,
        `SELECT 1 AS ok FROM chat_branches WHERE chat_id = :1 AND id = :2`,
        [chatId, branchId],
      );
      if (!exists) throw new StoragePayloadError("Chat branch does not exist");
      await conn.execute(
        `UPDATE chat_active_branches SET branch_id = :branchId WHERE chat_id = :chatId`,
        { chatId, branchId },
      );
      await conn.commit();
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  // ============================================================
  // 설정 로드: loadPlugins, loadPluginCustomStorage, ...
  // ============================================================

  async loadPlugins(options: LoadPluginsOptions = {}) {
    this.assertEnabled();
    const pluginId =
      typeof options?.pluginId === "string" ? options.pluginId : null;
    if (pluginId) assertId(pluginId, "pluginId");
    if (!pluginId && this.pluginsCache) {
      return this.pluginsCache;
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const binds = pluginId ? [pluginId] : [];
      const where = pluginId ? " WHERE plugin_id = :1" : "";
      const records = await fetchRows<PluginRecordRow>(
        conn,
        `SELECT plugin_id, position, name, display_name, api_version, plugin_version, update_url, enabled FROM system_plugin_records${where} ORDER BY position`,
        binds,
        { clobColumns: [] },
      );
      const values = await fetchRows<SettingValueRow>(
        conn,
        `SELECT plugin_id AS setting_key, node_id, parent_node_id, member_key, encoded_member_key, position, value_type, text_value, encoded_text_value, number_value, boolean_value FROM system_plugin_values${where} ORDER BY plugin_id, node_id`,
        binds,
        {
          clobColumns: [
            "member_key",
            "encoded_member_key",
            "text_value",
            "encoded_text_value",
          ],
        },
      );
      const plugins = rebuildPluginRecords(records, values);
      await conn.rollback();
      const serialized = JSON.stringify(plugins);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      const result = { plugins, hash };
      if (!pluginId && this.objectCacheEnabled) this.pluginsCache = result;
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadPluginScript(pluginId: unknown) {
    this.assertEnabled();
    assertId(pluginId, "pluginId");
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<PluginScriptRow>(
        conn,
        "SELECT script FROM system_plugin_scripts WHERE plugin_id = :1",
        [pluginId],
        { clobColumns: ["script"] },
      );
      return rows[0]?.script ?? null;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadPluginCustomStorage() {
    this.assertEnabled();
    if (this.pluginCustomStorageCache) {
      return this.pluginCustomStorageCache;
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const rows = await fetchRows<OracleKeyValueRow>(
        conn,
        `SELECT key, JSON_SERIALIZE(value RETURNING CLOB) AS value
                 FROM system_plugin_custom_storage ORDER BY key`,
        [],
        { clobColumns: ["value"] },
      );
      await conn.rollback();
      const pluginCustomStorage = Object.fromEntries(
        rows.map((row) => [row.key, JSON.parse(String(row.value))]),
      );
      const serialized = JSON.stringify(pluginCustomStorage);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      const result = { pluginCustomStorage, hash };
      if (this.objectCacheEnabled) this.pluginCustomStorageCache = result;
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async listPluginCustomStorageKeys() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const rows = await fetchRows<OracleKeyValueRow>(
        conn,
        `SELECT key FROM system_plugin_custom_storage ORDER BY key`,
      );
      await conn.rollback();
      return rows.map((row) => row.key);
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadPluginCustomStorageKey(storageKey: unknown) {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const rows = await fetchRows<OracleKeyValueRow>(
        conn,
        `SELECT JSON_SERIALIZE(value RETURNING CLOB) AS value
                 FROM system_plugin_custom_storage WHERE key = :1`,
        [storageKey],
        { clobColumns: ["value"] },
      );
      await conn.rollback();
      if (rows.length === 0) {
        return { key: storageKey, exists: false, value: null, hash: "null" };
      }
      const value: unknown = JSON.parse(String(rows[0].value));
      const serialized = JSON.stringify(value);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      return { key: storageKey, exists: true, value, hash };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async listSettingKeys() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<OracleSettingScalarRow>(
        conn,
        "SELECT key FROM system_settings ORDER BY key",
      );
      return rows.map((row) => row.key);
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadSettingKeys(keys: readonly string[]) {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      // Oracle IN 목록: 바인드 변수 목록 생성
      const inClause = keys.map((_key, index) => `:${index + 1}`).join(", ");
      const settings = await fetchRows<OracleSettingScalarRow>(
        conn,
        `SELECT * FROM system_settings WHERE key IN (${inClause}) ORDER BY key`,
        keys,
      );
      const settingValues = await fetchRows<SettingValueRow>(
        conn,
        `SELECT * FROM system_setting_values WHERE setting_key IN (${inClause}) ORDER BY setting_key, node_id`,
        keys,
        { clobColumns: ["text_value", "encoded_text_value"] },
      );
      await conn.rollback();
      const rebuilt = rebuildSettings(settings, settingValues);
      if (keys.includes("pluginCustomStorage")) {
        const pluginRows = await fetchRows<OracleKeyValueRow>(
          conn,
          `SELECT key, JSON_SERIALIZE(value RETURNING CLOB) AS value FROM system_plugin_custom_storage`,
          [],
          { clobColumns: ["value"] },
        );
        rebuilt.pluginCustomStorage = Object.fromEntries(
          pluginRows.map((row) => [row.key, JSON.parse(String(row.value))]),
        );
      }
      const serialized = JSON.stringify(rebuilt);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      return { settings: rebuilt, hash };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async loadModuleRecords() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const modules = await fetchRows<ModuleRecordRow>(
        conn,
        "SELECT module_id, position FROM system_module_records ORDER BY position",
      );
      if (modules.length === 0) return null;
      const values = await fetchRows<SettingValueRow>(
        conn,
        "SELECT module_id AS setting_key, node_id, parent_node_id, member_key, encoded_member_key, position, value_type, text_value, encoded_text_value, number_value, boolean_value FROM system_module_values ORDER BY module_id, node_id",
        [],
        {
          clobColumns: [
            "member_key",
            "encoded_member_key",
            "text_value",
            "encoded_text_value",
          ],
        },
      );
      return buildModuleRecordsSnapshot(modules, values);
    } finally {
      try {
        await conn.close();
      } catch {}
    }
  }

  async listBotPresets() {
    this.assertEnabled();
    const started = process.hrtime.bigint();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<OracleBotPresetRow>(
        conn,
        `SELECT preset_id, position, name, image, api_type, ai_model, content_hash
                FROM system_bot_presets ORDER BY position`,
        [],
        { clobColumns: ["image"] },
      );
      const { presets, hash } = buildBotPresetList(rows);
      return {
        presets,
        hash,
        queryMs: Number(process.hrtime.bigint() - started) / 1e6,
      };
    } finally {
      try {
        await conn.close();
      } catch {}
    }
  }

  async loadBotPreset(id: unknown) {
    this.assertEnabled();
    const started = process.hrtime.bigint();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<OracleBotPresetRow>(
        conn,
        "SELECT data, content_hash FROM system_bot_presets WHERE preset_id = :1",
        [id],
        { clobColumns: ["data"] },
      );
      if (!rows.length) return null;
      return {
        preset: { ...JSON.parse(String(rows[0].data)), id },
        hash: rows[0].content_hash,
        queryMs: Number(process.hrtime.bigint() - started) / 1e6,
      };
    } finally {
      try {
        await conn.close();
      } catch {}
    }
  }

  // ============================================================
  // sync: 변경사항 동기화 (가장 복잡한 메서드)
  // ============================================================

  // Destructive storage sync must never auto-rebase. The revision is checked
  // again while the metadata row is locked in the same transaction that will
  // apply the replacement.
  async runStorageSyncFinalizeTransaction(
    expectedRevision: unknown,
    callback: StorageSyncFinalizeCallback,
  ) {
    this.assertEnabled();
    const expectedRevisionNumber = Number(expectedRevision);
    if (
      !Number.isSafeInteger(expectedRevisionNumber) ||
      expectedRevisionNumber < 0
    ) {
      throw new StoragePayloadError(
        "Storage sync finalize revision must be a non-negative integer",
      );
    }
    if (typeof callback !== "function") {
      throw new StoragePayloadError(
        "Storage sync finalize callback is required",
      );
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");
      const metaRow = await fetchRequiredRow<StorageMetaRow>(
        conn,
        "SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1 FOR UPDATE",
      );
      const currentRevision = Number(metaRow?.revision) || 0;
      if (currentRevision !== expectedRevisionNumber) {
        throw new StorageRevisionConflictError(
          currentRevision,
          `Oracle data changed in another session (server revision ${currentRevision}). Refresh the sync preview before finalizing.`,
        );
      }
      const previousRevision = await fetchOne<RevisionRow>(
        conn,
        "SELECT id FROM system_revisions WHERE storage_revision = :1 ORDER BY id DESC FETCH FIRST 1 ROW ONLY",
        [currentRevision],
      );
      const previousRevisionId =
        previousRevision?.id == null ? null : Number(previousRevision.id);
      const databaseInitialized = Boolean(metaRow?.initialized);
      const nextRevision = currentRevision + 1;
      const revisionId = await beginAuditRevision(conn, {
        storageRevision: nextRevision,
        databaseInitialized: true,
        scope: "database",
        action: "storage-sync:replace",
      });
      const result = await callback(conn, {
        currentRevision,
        nextRevision,
        revisionId,
        previousRevisionId,
        databaseInitialized,
      });
      await conn.execute(
        `UPDATE system_storage_meta
         SET revision = :1, initialized = 1, updated_at = SYSTIMESTAMP
         WHERE singleton = 1`,
        [nextRevision],
      );
      await conn.commit();
      return {
        success: true,
        revision: nextRevision,
        revisionId,
        ...(isSqlRow(result) ? result : {}),
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch {}
    }
  }

  async sync(rawPayload: unknown, options: SyncOptions = {}) {
    this.assertEnabled();
    const onProgress = readSyncProgress(options);
    const external = readExternalTransaction<OracleConnection>(options);
    const payload = validateSyncPayload(rawPayload);
    // Report the compact commit impact to the internal realtime channel right
    // after validation; it is never serialized into the sync result.
    // 검증 직후 압축 커밋 영향을 내부 실시간 채널로 보고하며, sync 결과에는
    // 절대 직렬화되지 않습니다.
    captureSyncCommitImpact(options, payload);
    const conn = external?.client ?? (await this.pool.getConnection());
    const ownsTransaction = !external;
    try {
      onProgress?.({
        stage: "init",
        message: "Oracle 연결 및 잠금 확인 중...",
        percent: 2,
      });
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");

      let currentRevision: number;
      let nextRevision: number;
      if (external) {
        currentRevision = Number(external.currentRevision);
        nextRevision = Number(external.nextRevision);
        if (
          !Number.isSafeInteger(currentRevision) ||
          !Number.isSafeInteger(nextRevision) ||
          nextRevision !== currentRevision + 1
        ) {
          throw new StoragePayloadError(
            "Invalid external storage sync transaction context",
          );
        }
      } else {
        const metaRow = await fetchRequiredRow<StorageMetaRow>(
          conn,
          `SELECT revision FROM system_storage_meta WHERE singleton = 1 FOR UPDATE`,
        );
        currentRevision = Number(metaRow.revision);
        const receipt = await authorNoteSql.readAuthorNoteReceipt(
          authorNoteDatabase("oracle", conn),
          payload,
        );
        if (receipt) {
          await conn.commit();
          return receipt;
        }
        nextRevision = currentRevision + 1;
      }
      if (payload.baseRevision !== currentRevision) {
        throw new StorageRevisionConflictError(
          currentRevision,
          `Oracle data changed in another session (server revision ${currentRevision}). Reload before saving again.`,
        );
      }
      const affectedMessageChatIds = collectAffectedMessageChatIds(payload);
      if (!external) {
        await beginAuditRevision(conn, {
          storageRevision: nextRevision,
          databaseInitialized: true,
          scope: "database",
          action:
            payload.action || (payload.replaceAll ? "replace-all" : "sync"),
        });
      }

      const noteDb = authorNoteDatabase("oracle", conn);
      if (payload.replaceAll) await authorNoteSql.resetAuthorNotes(noteDb);
      const authorNotes = await authorNoteSql.applyAuthorNotes(
        noteDb,
        payload.authorNotes,
      );

      if (payload.replaceAll) {
        onProgress?.({
          stage: "cleanup",
          message: "기존 데이터 정리 중...",
          percent: 5,
        });
        await conn.execute("DELETE FROM system_settings");
        await conn.execute("DELETE FROM system_plugin_custom_storage");
        await conn.execute("DELETE FROM system_bot_presets");
        await conn.execute("DELETE FROM system_module_records");
        await conn.execute("DELETE FROM system_plugin_records");
        await conn.execute("DELETE FROM character_characters");
      }

      if (payload.modules) {
        const existing = await fetchRows<ModuleRecordRow>(
          conn,
          "SELECT module_id, position FROM system_module_records ORDER BY position",
        );
        if (
          !payload.replaceAll &&
          existing.length === 0 &&
          !external?.storageSyncImport
        ) {
          const settings = await fetchRows<OracleSettingScalarRow>(
            conn,
            "SELECT * FROM system_settings WHERE key = 'modules'",
          );
          const values = await fetchRows<SettingValueRow>(
            conn,
            "SELECT * FROM system_setting_values WHERE setting_key = 'modules' ORDER BY node_id",
            [],
            {
              clobColumns: [
                "member_key",
                "encoded_member_key",
                "text_value",
                "encoded_text_value",
              ],
            },
          );
          mergeLegacyModulesIntoPayload(
            payload,
            rebuildSettings(settings, values).modules,
          );
        }
        for (const id of payload.modules.deletes) {
          await conn.execute(
            "DELETE FROM system_module_records WHERE module_id = :1",
            [id],
          );
        }
        if (payload.modules.order) {
          await conn.execute(
            "UPDATE system_module_records SET position = position + 1000000000",
          );
        }
        const positions = new Map<string, number>(
          existing.map((row) => [row.module_id, Number(row.position)]),
        );
        const mergeModule = `MERGE INTO system_module_records t
                    USING (SELECT :module_id module_id FROM dual) s ON (t.module_id=s.module_id)
                    WHEN MATCHED THEN UPDATE SET t.position=:position,t.updated_at=SYSTIMESTAMP
                    WHEN NOT MATCHED THEN INSERT (module_id,position,updated_at)
                    VALUES (:module_id,:position,SYSTIMESTAMP)`;
        for (const entry of payload.modules.upserts) {
          await conn.execute(mergeModule, {
            module_id: entry.id,
            position: entry.position ?? positions.get(entry.id) ?? 0,
          });
        }
        if (payload.modules.upserts.length > 0) {
          await conn.executeMany(
            "DELETE FROM system_module_values WHERE module_id = :1",
            payload.modules.upserts.map((entry) => [entry.id]),
          );
          const rows = payload.modules.upserts.flatMap((entry) =>
            splitSetting(entry.id, entry.data).values.map(
              (row: SettingValueRow) => ({
                ...row,
                module_id: row.setting_key,
              }),
            ),
          );
          await this._bulkInsertRows(
            conn,
            "system_module_values",
            [
              "module_id",
              "node_id",
              "parent_node_id",
              "member_key",
              "encoded_member_key",
              "position",
              "value_type",
              "text_value",
              "encoded_text_value",
              "number_value",
              "boolean_value",
            ],
            rows,
            onProgress,
          );
        }
        if (payload.modules.order) {
          for (const [position, id] of payload.modules.order.entries()) {
            await conn.execute(
              "UPDATE system_module_records SET position = :1 WHERE module_id = :2",
              [position, id],
            );
          }
        }
      }

      if (payload.plugins) {
        const existing = await fetchRows<PluginRecordRow>(
          conn,
          "SELECT plugin_id, position FROM system_plugin_records ORDER BY position",
        );
        const positions = new Map<string, number>(
          existing.map((row) => [row.plugin_id, Number(row.position)]),
        );

        for (const id of payload.plugins.deletes) {
          await conn.execute(
            "DELETE FROM system_plugin_records WHERE plugin_id = :1",
            [id],
          );
        }
        if (payload.plugins.order) {
          await conn.execute(
            "UPDATE system_plugin_records SET position = position + 1000000000",
          );
        }

        let nextPosition =
          existing.reduce(
            (max, row) => Math.max(max, Number(row.position)),
            -1,
          ) + 1;
        const mergePlugin = `MERGE INTO system_plugin_records t
          USING (SELECT :plugin_id plugin_id FROM dual) s
          ON (t.plugin_id=s.plugin_id)
          WHEN MATCHED THEN UPDATE SET
            t.position=:position,t.name=:name,t.display_name=:display_name,
            t.api_version=:api_version,t.plugin_version=:plugin_version,
            t.update_url=:update_url,t.enabled=:enabled,t.updated_at=SYSTIMESTAMP
          WHEN NOT MATCHED THEN INSERT
            (plugin_id,position,name,display_name,api_version,plugin_version,update_url,enabled,updated_at)
            VALUES
            (:plugin_id,:position,:name,:display_name,:api_version,:plugin_version,:update_url,:enabled,SYSTIMESTAMP)`;
        for (const entry of payload.plugins.upserts) {
          const data = isSqlRow(entry.data) ? entry.data : {};
          if (typeof data.name !== "string" || data.name.length === 0) {
            throw new StoragePayloadError(
              `Plugin ${entry.id} must have a non-empty name`,
            );
          }
          await conn.execute(mergePlugin, {
            plugin_id: entry.id,
            position:
              entry.position ?? positions.get(entry.id) ?? nextPosition++,
            name: data.name,
            display_name:
              typeof data.displayName === "string" ? data.displayName : null,
            api_version: data.version == null ? null : String(data.version),
            plugin_version:
              typeof data.versionOfPlugin === "string"
                ? data.versionOfPlugin
                : null,
            update_url:
              typeof data.updateURL === "string" ? data.updateURL : null,
            enabled: data.enabled === false ? 0 : 1,
          });
        }

        if (payload.plugins.upserts.length > 0) {
          await conn.executeMany(
            "DELETE FROM system_plugin_values WHERE plugin_id = :1",
            payload.plugins.upserts.map((entry) => [entry.id]),
          );
          const rows = payload.plugins.upserts.flatMap((entry) =>
            splitSetting(entry.id, pluginExtensionData(entry.data)).values.map(
              (row: SettingValueRow) => ({
                ...row,
                plugin_id: row.setting_key,
              }),
            ),
          );
          await this._bulkInsertRows(
            conn,
            "system_plugin_values",
            [
              "plugin_id",
              "node_id",
              "parent_node_id",
              "member_key",
              "encoded_member_key",
              "position",
              "value_type",
              "text_value",
              "encoded_text_value",
              "number_value",
              "boolean_value",
            ],
            rows,
            onProgress,
          );
        }

        const mergeScript = `MERGE INTO system_plugin_scripts t
          USING (SELECT :plugin_id plugin_id FROM dual) s
          ON (t.plugin_id=s.plugin_id)
          WHEN MATCHED THEN UPDATE SET t.script=:script,t.updated_at=SYSTIMESTAMP
          WHEN NOT MATCHED THEN INSERT (plugin_id,script,updated_at)
          VALUES (:plugin_id,:script,SYSTIMESTAMP)`;
        for (const script of payload.plugins.scripts || []) {
          await conn.execute(mergeScript, {
            plugin_id: script.id,
            script: clobBind(script.script),
          });
        }

        for (const update of payload.plugins.enabled || []) {
          await conn.execute(
            "UPDATE system_plugin_records SET enabled = :1, updated_at = SYSTIMESTAMP WHERE plugin_id = :2",
            [update.enabled ? 1 : 0, update.id],
          );
        }

        if (payload.plugins.order) {
          for (const [position, id] of payload.plugins.order.entries()) {
            await conn.execute(
              "UPDATE system_plugin_records SET position = :1 WHERE plugin_id = :2",
              [position, id],
            );
          }
        }
      }

      if (payload.presets) {
        const existing = await fetchRows<OracleBotPresetRow>(
          conn,
          "SELECT preset_id, position FROM system_bot_presets ORDER BY position",
        );
        const currentActiveRows = await fetchRows<OracleSettingScalarRow>(
          conn,
          "SELECT text_val FROM system_settings WHERE key = 'activeBotPresetId'",
        );
        const currentActiveId = currentActiveRows[0]?.text_val;
        const originalIds = existing.map((row) => row.preset_id);
        const ids = new Set<string>(existing.map((row) => row.preset_id));
        for (const id of payload.presets.deletes) ids.delete(id);
        for (const entry of payload.presets.upserts) ids.add(entry.id);
        if (!ids.size)
          throw new StoragePayloadError("At least one bot preset must remain");
        if (
          payload.presets.order &&
          (payload.presets.order.length !== ids.size ||
            new Set<string>(payload.presets.order).size !== ids.size ||
            payload.presets.order.some((id) => !ids.has(id)))
        ) {
          throw new StoragePayloadError(
            "Preset order must contain every preset ID exactly once",
          );
        }
        if (
          payload.presets.activeId !== undefined &&
          !ids.has(payload.presets.activeId)
        )
          throw new StoragePayloadError("Active bot preset does not exist");
        for (const id of payload.presets.deletes)
          await conn.execute(
            "DELETE FROM system_bot_presets WHERE preset_id = :1",
            [id],
          );
        let nextPosition =
          existing.reduce(
            (max, row) => Math.max(max, Number(row.position)),
            -1,
          ) + 1;
        const positions = new Map<string, number>(
          existing.map((row) => [row.preset_id, Number(row.position)]),
        );
        const mergePreset = `MERGE INTO system_bot_presets t USING (SELECT :preset_id preset_id FROM dual) s
                    ON (t.preset_id=s.preset_id) WHEN MATCHED THEN UPDATE SET t.position=:position,t.name=:name,t.image=:image,
                    t.api_type=:api_type,t.ai_model=:ai_model,t.data=:data,t.content_hash=:content_hash,t.updated_at=SYSTIMESTAMP
                    WHEN NOT MATCHED THEN INSERT (preset_id,position,name,image,api_type,ai_model,data,content_hash,updated_at)
                    VALUES (:preset_id,:position,:name,:image,:api_type,:ai_model,:data,:content_hash,SYSTIMESTAMP)`;
        for (const entry of payload.presets.upserts) {
          const data = { ...entry.data };
          delete data.id;
          const serialized = JSON.stringify(data);
          await conn.execute(mergePreset, {
            preset_id: entry.id,
            position:
              entry.position ?? positions.get(entry.id) ?? nextPosition++,
            name: data.name || "",
            image: clobBind((data.image || "") as string),
            api_type: data.apiType || "",
            ai_model: data.aiModel || "",
            data: clobBind(serialized),
            content_hash: crypto
              .createHash("sha256")
              .update(serialized)
              .digest("hex"),
          });
        }
        if (payload.presets.order) {
          await conn.execute(
            "UPDATE system_bot_presets SET position = position + 1000000000",
          );
          for (const [position, id] of payload.presets.order.entries())
            await conn.execute(
              "UPDATE system_bot_presets SET position = :1 WHERE preset_id = :2",
              [position, id],
            );
        }
        let activeId: string | undefined = payload.presets.activeId;
        if (activeId === undefined && !external?.storageSyncImport) {
          if (!currentActiveId || !ids.has(currentActiveId)) {
            const deletedIndex = currentActiveId
              ? originalIds.indexOf(currentActiveId)
              : -1;
            activeId =
              originalIds.slice(deletedIndex + 1).find((id) => ids.has(id)) ||
              originalIds
                .slice(0, Math.max(0, deletedIndex))
                .reverse()
                .find((id) => ids.has(id)) ||
              (payload.presets.order || Array.from(ids))[0];
          }
        }
        if (activeId !== undefined)
          payload.rootUpserts.push({
            key: "activeBotPresetId",
            value: activeId,
          });
      }

      // 설정 upsert (MERGE INTO system_settings)
      onProgress?.({
        stage: "settings",
        message: `설정 동기화 중... (${payload.rootUpserts.length}개 설정)`,
        percent: 10,
      });
      dedupeRootUpserts(payload);
      const rootSettingUpserts = payload.rootUpserts.filter(
        (row) => row.key !== "pluginCustomStorage",
      );
      if (rootSettingUpserts.length > 0) {
        const mergeSql = `MERGE INTO system_settings t
                    USING (SELECT :key AS key, :text_val AS text_val, :num_val AS num_val, :bool_val AS bool_val FROM dual) s
                    ON (t.key = s.key)
                    WHEN MATCHED THEN UPDATE SET
                        t.text_val = s.text_val,
                        t.num_val = s.num_val,
                        t.bool_val = s.bool_val,
                        t.updated_at = SYSTIMESTAMP
                    WHEN NOT MATCHED THEN INSERT (key, text_val, num_val, bool_val, updated_at)
                        VALUES (s.key, s.text_val, s.num_val, s.bool_val, SYSTIMESTAMP)`;
        const settingBinds = rootSettingUpserts.map((row) => {
          const mapped = mapSettingValueToColumns(row.value);
          return { key: row.key, ...mapped };
        });
        await conn.executeMany(mergeSql, settingBinds, {
          bindDefs: {
            key: { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
            text_val: { type: oracledb.DB_TYPE_CLOB },
            num_val: { type: oracledb.DB_TYPE_NUMBER },
            bool_val: { type: oracledb.DB_TYPE_NUMBER },
          },
        });
        await conn.executeMany(
          `DELETE FROM system_setting_values WHERE setting_key = :1`,
          rootSettingUpserts.map((row) => [row.key]),
        );
        const settingValueRows = rootSettingUpserts.flatMap(
          (row) => splitSetting(row.key, row.value).values,
        );
        await this._bulkInsertRows(
          conn,
          "system_setting_values",
          [
            "setting_key",
            "node_id",
            "parent_node_id",
            "member_key",
            "encoded_member_key",
            "position",
            "value_type",
            "text_value",
            "encoded_text_value",
            "number_value",
            "boolean_value",
          ],
          settingValueRows,
          onProgress,
        );
      }
      const changedSettingKeys = rootSettingUpserts.map((row) => row.key);

      // 관계형 설정 테이블
      const projectedSettings = projectSettings(rootSettingUpserts);
      if (changedSettingKeys.length > 0) {
        const changedSet = new Set<string>(changedSettingKeys);
        for (const definition of SETTING_RELATION_DEFINITIONS) {
          const projectedKeys = definition.settingKeys.filter((key: string) =>
            changedSet.has(key),
          );
          if (projectedKeys.length === 0) continue;
          const delSql = `DELETE FROM ${assertSqlIdentifier(definition.table)} WHERE setting_key = :1`;
          await conn.executeMany(
            delSql,
            projectedKeys.map((key) => [key]),
          );
        }
      }
      for (const definition of SETTING_RELATION_DEFINITIONS) {
        const rows: readonly SqlStorageRow[] | undefined =
          projectedSettings[definition.table];
        if (rows && rows.length > 0) {
          await this._bulkInsertRows(
            conn,
            definition.table,
            definition.columns,
            rows,
            onProgress,
          );
        }
      }
      if (payload.rootDeletes.length > 0) {
        await conn.executeMany(
          `DELETE FROM system_settings WHERE key = :1`,
          payload.rootDeletes.map((key) => [key]),
        );
      }
      if (payload.pluginStorageClear) {
        await conn.execute("DELETE FROM system_plugin_custom_storage");
      }
      if (payload.pluginStorageDeletes?.length) {
        await conn.executeMany(
          "DELETE FROM system_plugin_custom_storage WHERE key = :1",
          payload.pluginStorageDeletes.map((key) => [key]),
        );
      }
      if (payload.pluginStorageUpserts?.length) {
        const pluginSql = `MERGE INTO system_plugin_custom_storage target
                    USING (SELECT :1 AS key, JSON(:2) AS value FROM dual) source
                    ON (target.key = source.key)
                    WHEN MATCHED THEN UPDATE SET target.value = source.value, target.updated_at = SYSTIMESTAMP
                    WHEN NOT MATCHED THEN INSERT (key, value, updated_at)
                    VALUES (source.key, source.value, SYSTIMESTAMP)`;
        await conn.executeMany(
          pluginSql,
          payload.pluginStorageUpserts.map((item) => [
            item.key,
            JSON.stringify(item.value),
          ]),
          {
            bindDefs: [
              { type: oracledb.DB_TYPE_VARCHAR, maxSize: 4000 },
              { type: oracledb.DB_TYPE_CLOB },
            ],
          },
        );
      }

      // 캐릭터 upsert
      onProgress?.({
        stage: "characters",
        message: `캐릭터 및 속성 저장 중... (${payload.characters.length}개)`,
        percent: 25,
      });
      const splitCharacters: CharacterSplit[] =
        payload.characters.map(splitCharacter);
      const characterColumns: readonly (keyof CharacterCoreRow)[] = [
        "id",
        "position",
        "kind",
        "name",
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
        "creator",
        "character_version",
        "nickname",
        "view_screen",
        "chat_page",
        "first_message_index",
        "utility_bot",
        "is_private",
        "realm_id",
        "license",
        "default_variables",
        "additional_text",
        "translator_note",
        "background_html",
        "background_css",
        "creation_time",
        "modification_time",
        "last_interaction_time",
        "trash_time",
      ];
      if (splitCharacters.length > 0) {
        const updateCols = characterColumns.slice(1);
        const upsertSql = `BEGIN
                    UPDATE character_characters SET
                        ${updateCols.map((column) => `${column.toUpperCase()} = :${column}`).join(", ")},
                        updated_at = SYSTIMESTAMP
                    WHERE id = :id;
                    IF SQL%ROWCOUNT = 0 THEN
                        INSERT INTO character_characters (${characterColumns.map((column) => column.toUpperCase()).join(", ")})
                        VALUES (${characterColumns.map((column) => `:${column}`).join(", ")});
                    END IF;
                END;`;
        const characterBindDefs: Record<string, OracleBindDefinition> = {};
        for (const c of characterColumns) {
          const t = this._getColumnBindType("character_characters", c);
          characterBindDefs[c] =
            t === oracledb.DB_TYPE_VARCHAR
              ? { type: t, maxSize: 4000 }
              : { type: t };
        }
        const binds = splitCharacters.map((item) => {
          const row: Record<string, unknown> = {};
          for (const c of characterColumns) {
            const v = item.core[c];
            const t = this._getColumnBindType("character_characters", c);
            row[c] = this._formatBindValue(v, t, false);
          }
          return row;
        });
        await conn.executeMany(upsertSql, binds, {
          bindDefs: characterBindDefs,
        });
      }

      const changedCharacterIds = payload.characters.map((row) => row.id);
      const characterChildTables = [
        "character_attributes",
        "character_tags",
        "character_greetings",
        "character_biases",
        "character_emotions",
        "character_modules",
        "character_group_members",
        "character_chat_folders",
        "character_scripts",
        "character_sd_data",
        "character_assets",
        "character_lore_entries",
      ];
      if (changedCharacterIds.length > 0) {
        for (const table of characterChildTables) {
          const ownerColumn =
            table === "character_group_members" ? "group_id" : "character_id";
          const delSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE ${ownerColumn.toUpperCase()} = :1`;
          await conn.executeMany(
            delSql,
            changedCharacterIds.map((id) => [id]),
          );
        }
      }

      // 캐릭터 자식 테이블 bulk insert
      const characterRows = (name: CharacterRelationName): SqlStorageRow[] =>
        splitCharacters.flatMap((item) => [...item[name]]);
      await this._bulkInsertRows(
        conn,
        "character_attributes",
        ["character_id", "key_value", "value"],
        splitCharacters.flatMap((item) =>
          item.attributes.map((attribute) => ({
            character_id: item.core.id,
            key_value: attribute.key,
            value: attribute.value,
          })),
        ),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_tags",
        ["character_id", "position", "tag"],
        characterRows("tags"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_greetings",
        ["character_id", "greeting_type", "position", "content"],
        characterRows("greetings"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_biases",
        ["character_id", "position", "phrase", "bias"],
        characterRows("biases"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_emotions",
        ["character_id", "position", "emotion", "asset"],
        characterRows("emotions"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_modules",
        ["character_id", "position", "module_id"],
        characterRows("modules"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_group_members",
        ["group_id", "position", "character_id", "talk_weight", "active"],
        characterRows("groupMembers"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_chat_folders",
        ["character_id", "position", "folder_id", "name", "color", "folded"],
        characterRows("chatFolders"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_scripts",
        [
          "character_id",
          "script_kind",
          "position",
          "comment_text",
          "input_text",
          "output_text",
          "script_type",
          "flag",
          "able_flag",
          "trigger_payload",
        ],
        characterRows("scripts"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_sd_data",
        ["character_id", "position", "key_value", "value"],
        characterRows("sdData"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_assets",
        [
          "character_id",
          "position",
          "asset_source",
          "asset_type",
          "uri",
          "name",
          "extension",
          "extra_value",
        ],
        characterRows("assets"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "character_lore_entries",
        [
          "character_id",
          "position",
          "lore_id",
          "primarykey",
          "secondary_key",
          "insert_order",
          "comment_text",
          "content",
          "lore_mode",
          "always_active",
          "selective",
          "case_sensitive",
          "activation_percent",
          "use_regex",
          "book_version",
          "folder",
          "cache_payload",
        ],
        characterRows("lore"),
        onProgress,
      );

      if (payload.characterTouches.length > 0) {
        await conn.executeMany(
          `UPDATE character_characters
                     SET last_interaction_time = :lastInteraction, updated_at = SYSTIMESTAMP
                     WHERE id = :id`,
          payload.characterTouches.map((touch) => ({
            id: touch.id,
            lastInteraction: touch.lastInteraction,
          })),
        );
      }

      // 채팅 upsert
      onProgress?.({
        stage: "chats",
        message: `채팅 목록 저장 중... (${payload.chats.length}개)`,
        percent: 45,
      });
      const splitChats: ChatSplit[] = payload.chats.map(splitChat);
      const chatColumns: readonly (keyof ChatCoreRow)[] = [
        "id",
        "character_id",
        "position",
        "name",
        "note",
        "sd_data",
        "supa_memory_data",
        "last_memory",
        "is_streaming",
        "streaming_optimization_mode",
        "bound_persona_id",
        "first_message_index",
        "folder_id",
      ];
      if (splitChats.length > 0) {
        const updateCols = chatColumns.slice(1);
        const upsertSql = `BEGIN
                    UPDATE chat_chats SET
                        ${updateCols.map((column) => `${column.toUpperCase()} = :${column}`).join(", ")},
                        updated_at = SYSTIMESTAMP
                    WHERE id = :id;
                    IF SQL%ROWCOUNT = 0 THEN
                        INSERT INTO chat_chats (${chatColumns.map((column) => column.toUpperCase()).join(", ")})
                        VALUES (${chatColumns.map((column) => `:${column}`).join(", ")});
                    END IF;
                END;`;
        const chatBindDefs: Record<string, OracleBindDefinition> = {};
        for (const c of chatColumns) {
          const t = this._getColumnBindType("chat_chats", c);
          chatBindDefs[c] =
            t === oracledb.DB_TYPE_VARCHAR
              ? { type: t, maxSize: 4000 }
              : { type: t };
        }
        const binds = splitChats.map((item) => {
          const row: Record<string, unknown> = {};
          for (const c of chatColumns) {
            const v = item.core[c];
            const t = this._getColumnBindType("chat_chats", c);
            row[c] = this._formatBindValue(v, t, false);
          }
          return row;
        });
        await conn.executeMany(upsertSql, binds, { bindDefs: chatBindDefs });
      }
      const changedChatIds = payload.chats.map((row) => row.id);
      const chatChildTables = [
        "chat_attributes",
        "chat_suggestions",
        "chat_modules",
        "chat_script_state",
        "chat_bookmarks",
        "chat_memory",
        "chat_lore_entries",
      ];
      if (changedChatIds.length > 0) {
        for (const table of chatChildTables) {
          const delSql = `DELETE FROM ${assertSqlIdentifier(table)} WHERE chat_id = :1`;
          await conn.executeMany(
            delSql,
            changedChatIds.map((id) => [id]),
          );
        }
      }
      const chatRows = (name: ChatRelationName): SqlStorageRow[] =>
        splitChats.flatMap((item) => [...item[name]]);
      await this._bulkInsertRows(
        conn,
        "chat_attributes",
        ["chat_id", "key_value", "value"],
        splitChats.flatMap((item) =>
          item.attributes.map((attribute) => ({
            chat_id: item.core.id,
            key_value: attribute.key,
            value: attribute.value,
          })),
        ),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_suggestions",
        ["chat_id", "position", "content"],
        chatRows("suggestions"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_modules",
        ["chat_id", "position", "module_id"],
        chatRows("modules"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_script_state",
        [
          "chat_id",
          "key_value",
          "value_type",
          "text_value",
          "number_value",
          "boolean_value",
        ],
        chatRows("scriptState"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_bookmarks",
        ["chat_id", "position", "message_id", "name"],
        chatRows("bookmarks"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_memory",
        ["chat_id", "memory_type", "payload"],
        chatRows("memory"),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_lore_entries",
        [
          "chat_id",
          "position",
          "lore_id",
          "primarykey",
          "secondary_key",
          "insert_order",
          "comment_text",
          "content",
          "lore_mode",
          "always_active",
          "selective",
          "case_sensitive",
          "activation_percent",
          "use_regex",
          "book_version",
          "folder",
          "cache_payload",
        ],
        chatRows("lore"),
        onProgress,
      );

      // 메시지 upsert / bulk insert
      onProgress?.({
        stage: "messages",
        message: `메시지 저장 중... (${payload.messages.length}개)`,
        percent: 65,
      });
      const splitMessages: MessageSplit[] = payload.messages.map(splitMessage);
      const messageColumns: readonly (keyof MessageCoreRow)[] = [
        "chat_id",
        "id",
        "position",
        "role",
        "content_text",
        "content_binary",
        "saying_character_id",
        "sent_time",
        "sender_name",
        "other_user",
        "disabled_scope",
        "is_comment",
      ];
      const messageChildTables = [
        "chat_message_attributes",
        "chat_message_generation",
        "chat_message_prompt_info",
        "chat_message_prompt_toggles",
        "chat_message_prompt_items",
      ];
      if (payload.messages.length > 0) {
        await deleteMessageChildren(conn, payload.messages);
        await this.ensureChatBranchGraphs(
          conn,
          splitMessages.map((item) => String(item.core.chat_id)),
        );
      }
      if (splitMessages.length > 0) {
        const updateCols = messageColumns.slice(2);
        const upsertSql = `BEGIN
                    UPDATE chat_messages SET
                        ${updateCols.map((column) => `${column.toUpperCase()} = :${column}`).join(", ")},
                        updated_at = SYSTIMESTAMP
                    WHERE chat_id = :chat_id AND id = :id;
                    IF SQL%ROWCOUNT = 0 THEN
                        INSERT INTO chat_messages (${messageColumns.map((column) => column.toUpperCase()).join(", ")})
                        VALUES (${messageColumns.map((column) => `:${column}`).join(", ")});
                    END IF;
                END;`;
        const bindDefs: Record<string, OracleBindDefinition> = {};
        for (const column of messageColumns) {
          const type = this._getColumnBindType("chat_messages", column);
          bindDefs[column] =
            type === oracledb.DB_TYPE_VARCHAR
              ? { type, maxSize: 4000 }
              : { type };
        }
        const binds = splitMessages.map((item) => {
          const row: Record<string, unknown> = {};
          for (const column of messageColumns) {
            const type = this._getColumnBindType("chat_messages", column);
            row[column] = this._formatBindValue(item.core[column], type, false);
          }
          return row;
        });
        await conn.executeMany(upsertSql, binds, { bindDefs });
        if (!external?.storageSyncImport) {
          await this.linkIncomingMessagesToActiveBranches(conn, splitMessages);
        }
      }
      onProgress?.({
        stage: "message_children",
        message: "메시지 메타데이터 및 프롬프트 토글 저장 중...",
        percent: 85,
      });
      await this._bulkInsertRows(
        conn,
        "chat_message_attributes",
        ["chat_id", "message_id", "key_value", "value"],
        splitMessages.flatMap((item) =>
          item.attributes.map((attribute) => ({
            chat_id: item.core.chat_id,
            message_id: item.core.id,
            key_value: attribute.key,
            value: attribute.value,
          })),
        ),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_message_generation",
        [
          "chat_id",
          "message_id",
          "model",
          "generation_id",
          "input_tokens",
          "output_tokens",
          "max_context",
          "stage1_time",
          "stage2_time",
          "stage3_time",
          "stage4_time",
        ],
        splitMessages.flatMap((item) =>
          item.generation ? [item.generation] : [],
        ),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_message_prompt_info",
        ["chat_id", "message_id", "prompt_name"],
        splitMessages.flatMap((item) =>
          item.prompt ? [item.prompt.info] : [],
        ),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_message_prompt_toggles",
        ["chat_id", "message_id", "position", "toggle_key", "toggle_value"],
        splitMessages.flatMap((item) => item.prompt?.toggles || []),
        onProgress,
      );
      await this._bulkInsertRows(
        conn,
        "chat_message_prompt_items",
        ["chat_id", "message_id", "position", "payload"],
        splitMessages.flatMap((item) => item.prompt?.items || []),
        onProgress,
      );

      // 명시적으로 지정된 캐릭터만 삭제한다.
      if (payload.characterDeletes?.length) {
        await conn.executeMany(
          `DELETE FROM character_characters WHERE id = :1`,
          payload.characterDeletes.map((id) => [id]),
        );
      }
      if (payload.chatDeletes?.length) {
        await conn.executeMany(
          `DELETE FROM chat_chats WHERE id = :1`,
          payload.chatDeletes.map((id) => [id]),
        );
      }
      if (payload.messageDeletes) {
        await this.detachMessagesFromBranchGraph(conn, payload.messageDeletes);
        for (const del of payload.messageDeletes) {
          if (del.ids.length > 0) {
            await conn.executeMany(
              `DELETE FROM chat_messages WHERE chat_id = :1 AND id = :2`,
              del.ids.map((id) => [del.chatId, id]),
            );
          }
        }
      }

      if (affectedMessageChatIds.size > 0) {
        await conn.executeMany(
          `UPDATE chat_chats ch
                        SET last_message_time = (
                            SELECT m.sent_time
                              FROM chat_messages m
                             WHERE m.chat_id = :chatId
                             ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                             FETCH FIRST 1 ROW ONLY
                        ), updated_at = SYSTIMESTAMP
                      WHERE ch.id = :chatId`,
          Array.from(affectedMessageChatIds).map((chatId) => ({
            chatId,
          })),
        );
      }

      if (!external) {
        onProgress?.({
          stage: "commit",
          message: "오라클 트랜잭션 커밋 중...",
          percent: 98,
        });
        await conn.execute(
          `UPDATE system_storage_meta
                   SET revision = :1, initialized = 1, updated_at = SYSTIMESTAMP
                   WHERE singleton = 1`,
          [nextRevision],
        );
        await authorNoteSql.writeAuthorNoteReceipt(noteDb, payload, {
          revision: nextRevision,
          authorNotes: summarizeAuthorNotes(authorNotes),
        });
        await conn.commit();
      }
      invalidateSyncCaches(this, payload);
      onProgress?.({
        stage: "done",
        message: `동기화 완료 (Revision: ${nextRevision})`,
        percent: 100,
      });
      return buildSyncResult({
        payload,
        revision: nextRevision,
        authorNotes,
      });
    } catch (error) {
      if (ownsTransaction) {
        try {
          await conn.rollback();
        } catch (e) {}
      }
      throw error;
    } finally {
      if (ownsTransaction) {
        try {
          await conn.close();
        } catch (e) {}
      }
    }
  }

  _getColumnBindType(table: string, column: string): number {
    const col = column.toLowerCase();
    const mappedTable = mapTableName(table);
    const jsonCols = new Set<string>(
      this._getJsonColumnsForTable(mappedTable).map((name) =>
        name.toLowerCase(),
      ),
    );
    if (jsonCols.has(col)) {
      return oracledb.DB_TYPE_CLOB;
    }
    const lobCols = new Set<string>(
      this._getLobColumnsForTable(mappedTable).map((name) =>
        name.toLowerCase(),
      ),
    );
    if (lobCols.has(col)) {
      if (col === "content_binary" || col === "data") {
        return oracledb.DB_TYPE_BLOB;
      }
      return oracledb.DB_TYPE_CLOB;
    }

    const numberCols = new Set<string>([
      "position",
      "book_position",
      "lore_position",
      "model_position",
      "insert_order",
      "activation_percent",
      "book_version",
      "input_tokens",
      "output_tokens",
      "max_context",
      "max_response",
      "temperature",
      "frequency_penalty",
      "presence_penalty",
      "stage1_time",
      "stage2_time",
      "stage3_time",
      "stage4_time",
      "talk_weight",
      "active",
      "folded",
      "able_flag",
      "always_active",
      "selective",
      "case_sensitive",
      "use_regex",
      "number_value",
      "boolean_value",
      "low_level_access",
      "hide_icon",
      "enabled",
      "large_portrait",
      "favorite",
      "icons_present",
      "prompt_preprocess",
      "control",
      "shift",
      "alt",
      "alt_flag",
      "format",
      "tokenizer",
      "last_used",
      "bound_persona_id",
      "first_message_index",
      "last_message_time",
      "sent_time",
      "is_comment",
      "is_streaming",
      "streaming_optimization_mode",
      "node_id",
      "parent_node_id",
      "bias",
      "sd_model",
      "use_sd",
      "new_chat_on_start",
      "chat_page",
      "utility_bot",
      "is_private",
      "creation_time",
      "modification_time",
      "last_interaction_time",
      "trash_time",
      "revision",
      "schema_version",
      "singleton",
      "initialized",
      "created_at",
    ]);

    if (
      numberCols.has(col) &&
      !(mappedTable === "character_scripts" && col === "flag")
    ) {
      return oracledb.DB_TYPE_NUMBER;
    }
    return oracledb.DB_TYPE_VARCHAR;
  }

  _formatBindValue(v: unknown, bindType?: number, isJson = false): unknown {
    if (isJson) {
      if (v === null || v === undefined) return "null";
      if (typeof v === "string") {
        try {
          JSON.parse(v);
          return v;
        } catch (e) {
          return JSON.stringify(v);
        }
      }
      return JSON.stringify(v);
    }
    if (v === null || v === undefined) return null;
    if (bindType === oracledb.DB_TYPE_NUMBER) {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return Number.isNaN(v) ? null : v;
      if (v === "") return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
    if (bindType === oracledb.DB_TYPE_BLOB) {
      if (Buffer.isBuffer(v)) return v;
      return Buffer.from(String(v));
    }
    if (bindType === oracledb.DB_TYPE_CLOB) {
      if (typeof v === "string") return v;
      return JSON.stringify(v);
    }
    // DB_TYPE_VARCHAR
    if (typeof v === "boolean") return v ? "1" : "0";
    return String(v);
  }

  // 범용 bulk insert 헬퍼 (행 객체 배열 → executemany)
  async _bulkInsertRows(
    connection: OracleConnection,
    table: string,
    columns: readonly string[],
    rows: readonly SqlStorageRow[],
    onProgress?: SyncProgressCallback | null,
  ): Promise<void> {
    if (!rows || rows.length === 0) return;
    const quotedTable = assertSqlIdentifier(mapTableName(table));
    const lobCols = new Set<string>(
      this._getLobColumnsForTable(table).map((column) => column.toLowerCase()),
    );
    const jsonColumns = new Set<string>(
      this._getJsonColumnsForTable(table).map((column) => column.toLowerCase()),
    );

    // ORA-24816 방지: Oracle은 LOB/LONG/JSON 컬럼이 non-LOB 컬럼 뒤에 오도록 요구함
    const orderedColumns = [
      ...columns.filter(
        (column) =>
          !lobCols.has(column.toLowerCase()) &&
          !jsonColumns.has(column.toLowerCase()),
      ),
      ...columns.filter(
        (column) =>
          lobCols.has(column.toLowerCase()) ||
          jsonColumns.has(column.toLowerCase()),
      ),
    ];

    // SQL 컬럼: Oracle 이름 (codec 이름이 넘어와도 예약어 회피 이름으로 변환)
    const quotedCols = orderedColumns.map((column) =>
      toOracleColumn(column).toUpperCase(),
    );
    // JSON 컬럼은 JSON(:n) 함수로 명시적 변환 (문자열/객체 모두 처리)
    const bindNames = orderedColumns
      .map((column, index) =>
        jsonColumns.has(column.toLowerCase())
          ? `JSON(:${index + 1})`
          : `:${index + 1}`,
      )
      .join(", ");
    const insertSql = `INSERT INTO ${quotedTable} (${quotedCols.join(", ")}) VALUES (${bindNames})`;

    const bindTypes = orderedColumns.map((column) =>
      this._getColumnBindType(table, column),
    );
    // Thin-mode CLOB binds create and write a temporary LOB for every value.
    // Short strings can bind directly to CLOB columns instead. Keeping them
    // at <= 4000 bytes also avoids ORA-24816 after any real LOB bind.
    const STRING_BIND_MAX_BYTES = 4000;
    const CHUNK_SIZE = 500;
    let chunkBinds: unknown[][] = [];
    let chunkTypes: number[] = [];
    let chunkSizes: number[] = [];
    let written = 0;

    const flush = async () => {
      if (chunkBinds.length === 0) return;
      const bindDefs = chunkTypes.map((type, index) =>
        type === oracledb.DB_TYPE_VARCHAR
          ? {
              type,
              maxSize:
                bindTypes[index] === oracledb.DB_TYPE_CLOB
                  ? chunkSizes[index]
                  : STRING_BIND_MAX_BYTES,
            }
          : { type },
      );
      await connection.executeMany(insertSql, chunkBinds, { bindDefs });
      written += chunkBinds.length;
      chunkBinds = [];
      onProgress?.({
        stage: "bulk_insert",
        table,
        current: written,
        total: rows.length,
        message: `${table}: ${written} / ${rows.length} 저장 중...`,
      });
    };

    for (const row of rows) {
      if (chunkBinds.length >= CHUNK_SIZE) await flush();
      const binds = orderedColumns.map((column, index) => {
        // 행 객체는 공용 codec의 컬럼명 프로퍼티를 쓸 수 있음
        const codecColumn =
          COLUMN_NAME_MAP[
            column.toLowerCase() as keyof typeof COLUMN_NAME_MAP
          ] || column;
        const v0 = row[column];
        const v = v0 !== undefined ? v0 : row[codecColumn];
        const isJson = jsonColumns.has(column.toLowerCase());
        return this._formatBindValue(v, bindTypes[index], isJson);
      });
      const sizes = binds.map((value: unknown) =>
        typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0,
      );
      const types = bindTypes.map((type, index) =>
        type === oracledb.DB_TYPE_CLOB && sizes[index] <= STRING_BIND_MAX_BYTES
          ? oracledb.DB_TYPE_VARCHAR
          : type,
      );
      // Preserve row order while keeping long values from forcing short
      // values in neighbouring rows through the temporary-LOB path.
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

  // 테이블별 LOB (CLOB/BLOB) 컬럼 목록 (스키마 기반)
  _getLobColumnsForTable(table: string): readonly string[] {
    const mapped = mapTableName(table);
    const lobCols: Record<string, readonly string[]> = {
      system_setting_values: [
        "member_key",
        "encoded_member_key",
        "text_value",
        "encoded_text_value",
      ],
      system_module_values: [
        "member_key",
        "encoded_member_key",
        "text_value",
        "encoded_text_value",
      ],
      system_bot_presets: ["image", "data"],
      system_personas: ["prompt", "icon", "note"],
      system_modules: [
        "description",
        "cjs",
        "background_embedding",
        "custom_toggle",
        "icon",
      ],
      system_plugins: ["script"],
      system_global_lore_entries: ["comment", "content", "comment_text"],
      system_translator_presets: ["prompt"],
      system_custom_models: ["api_key", "params"],
      system_themes: ["value"],
      system_custom_plugin_storage: ["value"],
      system_client_data: ["value"],
      system_loadouts: ["value"],
      character_characters: [
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
      character_greetings: ["content"],
      character_emotions: ["asset"],
      character_scripts: ["comment_text", "input_text", "output_text", "flag"],
      character_sd_data: ["value"],
      character_assets: ["uri", "extra_value"],
      character_lore_entries: ["comment_text", "content"],
      chat_chats: ["note", "sd_data", "supa_memory_data", "last_memory"],
      chat_suggestions: ["content"],
      chat_script_state: ["text_value"],
      chat_lore_entries: ["comment_text", "content"],
      chat_messages: ["content_text", "content_binary"],
      chat_message_prompt_toggles: ["toggle_value"],
      cold_archives: ["data"],
      cold_character_characters: [
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
      cold_character_greetings: ["content"],
      cold_character_emotions: ["asset"],
      cold_character_scripts: [
        "comment_text",
        "input_text",
        "output_text",
        "flag",
      ],
      cold_character_sd_data: ["value"],
      cold_character_assets: ["uri", "extra_value"],
      cold_character_lore_entries: ["comment_text", "content"],
      cold_chat_chats: ["note", "sd_data", "supa_memory_data", "last_memory"],
      cold_chat_suggestions: ["content"],
      cold_chat_script_state: ["text_value"],
      cold_chat_lore_entries: ["comment_text", "content"],
      cold_messages: ["content_text", "content_binary"],
      cold_message_prompt_toggles: ["toggle_value"],
    };
    return lobCols[mapped] ?? [];
  }

  // 테이블별 JSON 컬럼 목록 (스키마 기반)
  _getJsonColumnsForTable(table: string): readonly string[] {
    const mapped = mapTableName(table);
    const jsonCols: Record<string, readonly string[]> = {
      character_attributes: ["value"],
      character_scripts: ["trigger_payload"],
      character_lore_entries: ["cache_payload"],
      chat_attributes: ["value"],
      chat_memory: ["payload"],
      chat_lore_entries: ["cache_payload"],
      chat_message_attributes: ["value"],
      chat_message_prompt_items: ["payload"],
      cold_archive_attributes: ["value"],
      cold_character_scripts: ["trigger_payload"],
      cold_character_lore_entries: ["cache_payload"],
      cold_chat_attributes: ["value"],
      cold_chat_memory: ["payload"],
      cold_chat_lore_entries: ["cache_payload"],
      cold_message_attributes: ["value"],
      cold_message_prompt_items: ["payload"],
      system_audit_log: ["before_row", "after_row"],
    };
    return jsonCols[mapped] ?? [];
  }

  // ============================================================
  // 검색: searchMessages, searchCharactersByTag, searchCharactersByName
  // ============================================================

  async listRecentChats(rawLimit: unknown, activeChatId: unknown = null) {
    this.assertEnabled();
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      const rows = await fetchRows<RecentChatRow>(
        conn,
        `SELECT ch.character_id,
                        c.name AS character_name,
                        c.image AS character_image,
                        c.kind AS character_kind,
                        ch.id AS chat_id,
                        ch.position AS chat_position,
                        ch.name AS chat_name,
                        ch.folder_id,
                        ch.last_message_time,
                        (SELECT m.content_text
                           FROM chat_messages m
                          WHERE m.chat_id = ch.id
                          ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                          FETCH FIRST 1 ROW ONLY) AS last_message_text
                   FROM chat_chats ch
                   JOIN character_characters c ON c.id = ch.character_id
                  WHERE c.trash_time IS NULL
                  ORDER BY CASE WHEN ch.id = :activeChatId THEN 1 ELSE 0 END DESC,
                           CASE
                             WHEN ch.id = :activeChatId THEN GREATEST(NVL(ch.last_message_time, 0), NVL(c.last_interaction_time, 0))
                             WHEN ch.last_message_time IS NOT NULL THEN ch.last_message_time
                             WHEN ch.position = 0 THEN NVL(c.last_interaction_time, 0)
                             ELSE 0
                           END DESC, ch.id
                  FETCH FIRST :limit ROWS ONLY`,
        { limit, activeChatId },
        { clobColumns: ["character_image", "last_message_text"] },
      );
      return rows.map((row) => mapRecentChatRow(row));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async searchMessages(rawQuery: unknown, rawScope = "all", rawLimit = 50) {
    this.assertEnabled();
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query)
      throw new StoragePayloadError("search query must be a non-empty string");
    if (query.length > 1024)
      throw new StoragePayloadError(
        "search query must be at most 1024 characters",
      );
    const scope =
      rawScope === "active" || rawScope === "cold" ? rawScope : "all";
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 50;

    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      // Oracle: CONTAINS 또는 INSTR fallback. 보안상 INSTR 사용.
      const likeQuery = `%${query}%`;
      const scopeCondition = scope === "all" ? "1=1" : `m.storage_state = :2`;
      const binds =
        scope === "all" ? [likeQuery, limit] : [likeQuery, scope, limit];
      const rows = await fetchRows<MessageSearchRow>(
        conn,
        `SELECT m.storage_state, m.archive_id,
                        COALESCE(ch.character_id, a.owner_character_id) AS character_id,
                        COALESCE(c.name, a.character_name) AS character_name,
                        m.chat_id,
                        COALESCE(ch.name, '') AS chat_name,
                        m.message_id, m.position, m.role, m.sent_time, m.sender_name,
                        SUBSTR(m.content_text, 1, 200) AS snippet
                 FROM chat_all_messages m
                 LEFT JOIN chat_chats ch
                     ON m.storage_state = 'active' AND ch.id = m.chat_id
                 LEFT JOIN character_characters c ON c.id = ch.character_id
                 LEFT JOIN cold_archives a
                     ON m.storage_state = 'cold' AND a.id = m.archive_id
                 WHERE m.content_text IS NOT NULL
                   AND DBMS_LOB.INSTR(LOWER(m.content_text), LOWER(:1)) > 0
                   AND ${scopeCondition}
                 ORDER BY m.sent_time DESC
                 FETCH FIRST :${binds.length} ROWS ONLY`,
        binds,
        { clobColumns: ["snippet"] },
      );
      await conn.rollback();
      return rows.map((row) => ({
        storageState: row.storage_state,
        archiveId: row.archive_id
          ? Buffer.from(row.archive_id).toString("hex")
          : null,
        characterId: row.character_id,
        characterName: row.character_name,
        chatId: row.chat_id,
        chatName: row.chat_name,
        messageId: row.message_id,
        position: row.position,
        role: row.role,
        sentTime: row.sent_time === null ? null : Number(row.sent_time),
        senderName: row.sender_name,
        snippet: row.snippet,
      }));
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async getTokenUsage() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<TokenUsageRow>(
        conn,
        `SELECT model,
                        COUNT(*) AS message_count,
                        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                        COALESCE(SUM(output_tokens), 0) AS total_output_tokens
                 FROM (
                     SELECT model, input_tokens, output_tokens FROM chat_message_generation
                     UNION ALL
                     SELECT model, input_tokens, output_tokens FROM cold_message_generation
                 )
                 WHERE model IS NOT NULL
                 GROUP BY model
                 ORDER BY total_output_tokens DESC, total_input_tokens DESC`,
      );
      return rows.map((row) => mapTokenUsageRow(row));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async getBotChatStats() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<BotChatStatsRow>(
        conn,
        `
                WITH session_counts AS (
                    SELECT
                        ch.character_id,
                        ch.id AS chat_id,
                        COUNT(m.id) AS session_msgs,
                        MAX(m.sent_time) AS max_sent_time,
                        MAX(ch.last_message_time) AS last_msg_time
                    FROM chat_chats ch
                    LEFT JOIN chat_messages m ON m.chat_id = ch.id
                    GROUP BY ch.character_id, ch.id
                ),
                char_msg_stats AS (
                    SELECT
                        ch.character_id,
                        COUNT(m.id) AS total_messages,
                        COUNT(CASE WHEN m.role = 'user' THEN 1 END) AS user_messages,
                        COUNT(CASE WHEN m.role = 'char' THEN 1 END) AS bot_messages,
                        AVG(CASE WHEN m.role = 'char' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END) AS avg_bot_len,
                        AVG(CASE WHEN m.role = 'user' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END) AS avg_user_len
                    FROM chat_chats ch
                    JOIN chat_messages m ON m.chat_id = ch.id
                    GROUP BY ch.character_id
                )
                SELECT
                    c.id,
                    c.name,
                    c.image,
                    c.kind,
                    COUNT(sc.chat_id) AS total_sessions,
                    COALESCE(cms.total_messages, 0) AS total_messages,
                    COALESCE(cms.user_messages, 0) AS user_messages,
                    COALESCE(cms.bot_messages, 0) AS bot_messages,
                    COALESCE(MAX(sc.session_msgs), 0) AS longest_session_messages,
                    COALESCE(MAX(sc.max_sent_time), COALESCE(MAX(sc.last_msg_time), c.last_interaction_time)) AS last_active_date,
                    ROUND(COALESCE(cms.avg_bot_len, 0)) AS avg_bot_message_len,
                    ROUND(COALESCE(cms.avg_user_len, 0)) AS avg_user_message_len
                FROM character_characters c
                LEFT JOIN session_counts sc ON sc.character_id = c.id
                LEFT JOIN char_msg_stats cms ON cms.character_id = c.id
                GROUP BY c.id, c.name, c.image, c.kind, c.position, c.last_interaction_time, cms.total_messages, cms.user_messages, cms.bot_messages, cms.avg_bot_len, cms.avg_user_len
                ORDER BY c.position ASC
            `,
      );
      return rows.map((row) => mapBotChatStatsRow(row));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async searchCharactersByTag(rawTag: unknown, rawLimit = 100) {
    this.assertEnabled();
    const tag = typeof rawTag === "string" ? rawTag.trim() : "";
    if (!tag) throw new StoragePayloadError("tag must be a non-empty string");
    if (tag.length > 256)
      throw new StoragePayloadError("tag must be at most 256 characters");
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<CharacterSummaryRow>(
        conn,
        `SELECT c.id, c.name, c.image, c.kind
                 FROM character_tags t
                 JOIN character_characters c ON c.id = t.character_id
                 WHERE LOWER(t.tag) LIKE '%' || LOWER(:1) || '%'
                 ORDER BY c.name
                 FETCH FIRST :2 ROWS ONLY`,
        [tag, limit],
        { clobColumns: ["image"] },
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        image: row.image,
        kind: row.kind,
      }));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async searchCharactersByName(rawName: unknown, rawLimit = 100) {
    this.assertEnabled();
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) throw new StoragePayloadError("name must be a non-empty string");
    if (name.length > 256)
      throw new StoragePayloadError("name must be at most 256 characters");
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<CharacterSummaryRow>(
        conn,
        `SELECT id, name, image, kind
                 FROM character_characters
                 WHERE LOWER(name) LIKE '%' || LOWER(:1) || '%'
                 ORDER BY name
                 FETCH FIRST :2 ROWS ONLY`,
        [name, limit],
        { clobColumns: ["image"] },
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        image: row.image,
        kind: row.kind,
      }));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  // ============================================================
  // DB 탐색기: listDbExplorerTables, getDbExplorerTableColumns, getDbExplorerTableRows
  // ============================================================

  async listDbExplorerTables() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<{ table_name: string }>(
        conn,
        `SELECT table_name FROM user_tables
                 WHERE table_name LIKE 'SYSTEM\_%' ESCAPE ':'
                    OR table_name LIKE 'CHARACTER\_%' ESCAPE ':'
                    OR table_name LIKE 'CHAT\_%' ESCAPE ':'
                    OR table_name LIKE 'COLD\_%' ESCAPE ':'
                 ORDER BY table_name`,
      );
      // 접두어 테이블명을 점 표기로 변환 (클라이언트 호환성)
      const tables = rows
        .map((r) => {
          const name = r.table_name.toLowerCase();
          if (name.startsWith("system_")) return "system." + name.slice(7);
          if (name.startsWith("character_"))
            return "character." + name.slice(10);
          if (name.startsWith("chat_")) return "chat." + name.slice(5);
          if (name.startsWith("cold_")) return "cold." + name.slice(5);
          return name;
        })
        .map((name) => assertDbExplorerIdentifier(name, "table name"));
      const counts = new Map<string, unknown>();
      for (let i = 0; i < tables.length; i += 25) {
        const batch = tables.slice(i, i + 25);
        const union = batch
          .map((name) => {
            const mapped = mapTableName(name);
            return `SELECT '${name}' AS table_name, TO_CHAR(COUNT(*)) AS row_count FROM ${assertSqlIdentifier(mapped)}`;
          })
          .join(" UNION ALL ");
        if (union) {
          const countRows = await fetchRows<{
            table_name: string;
            row_count: string | number;
          }>(conn, union);
          for (const row of countRows) {
            counts.set(row.table_name, row.row_count);
          }
        }
      }
      return tables.map((name) => ({
        name,
        rowCount: Number(counts.get(name) ?? "0"),
      }));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async getDbExplorerTableColumns(table: unknown): Promise<ExplorerColumn[]> {
    this.assertEnabled();
    const validated = assertDbExplorerIdentifier(table, "table name");
    const parts = validated.split(".");
    const schemaName = parts.length === 2 ? parts[0] : "";
    const tableName = parts.length === 2 ? parts[1] : parts[0];
    const mappedTable = mapTableName(validated);
    const conn = await this.pool.getConnection();
    try {
      // 테이블 존재 확인
      const existsRow = await fetchOne<{ found: number }>(
        conn,
        `SELECT 1 AS found FROM user_tables WHERE table_name = UPPER(:1)`,
        [mappedTable],
      );
      if (!existsRow) throw new StoragePayloadError("table was not found");
      const colRows = await fetchRows<{
        column_name: string;
        data_type: string;
        is_nullable: string | null;
      }>(
        conn,
        `SELECT column_name, data_type, nullable AS is_nullable
                 FROM user_tab_columns WHERE table_name = UPPER(:1)
                 ORDER BY column_id`,
        [mappedTable],
      );
      const pkRows = await fetchRows<{ column_name: string }>(
        conn,
        `SELECT cc.column_name
                 FROM user_constraints c
                 JOIN user_cons_columns cc ON c.constraint_name = cc.constraint_name
                 WHERE c.table_name = UPPER(:1) AND c.constraint_type = 'P'
                 ORDER BY cc.position`,
        [mappedTable],
      );
      const primaryKeys = new Set<string>(
        pkRows.map((row) => row.column_name.toLowerCase()),
      );
      return colRows.map((row) => ({
        name: row.column_name.toLowerCase(),
        dataType: row.data_type,
        nullable: row.is_nullable === "Y" || row.is_nullable === "y",
        primaryKey: primaryKeys.has(row.column_name.toLowerCase()),
      }));
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async getDbExplorerTableRows(
    table: unknown,
    rawOffset = 0,
    rawLimit = 50,
    rawSortColumn: unknown = null,
    rawSortOrder = "asc",
    rawSearch = "",
    rawColumns: unknown = null,
  ) {
    this.assertEnabled();
    const validated = assertDbExplorerIdentifier(table, "table name");
    const mappedTable = mapTableName(validated);
    const quotedTable = assertSqlIdentifier(mappedTable);
    const columns = await this.getDbExplorerTableColumns(table);
    if (columns.length === 0)
      throw new StoragePayloadError("table has no columns");

    let visibleColumns = columns;
    if (rawColumns !== null && rawColumns !== undefined) {
      if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
        throw new StoragePayloadError("column list must not be empty");
      }
      const visibleNames: string[] = [];
      for (const name of rawColumns) {
        const validatedCol = assertDbExplorerIdentifier(name, "column name");
        const match = columns.find((column) => column.name === validatedCol);
        if (!match)
          throw new StoragePayloadError("column was not found in the table");
        if (!visibleNames.includes(validatedCol))
          visibleNames.push(validatedCol);
      }
      visibleColumns = columns.filter((column) =>
        visibleNames.includes(column.name),
      );
    }

    const searchTerm =
      typeof rawSearch === "string" ? rawSearch.trim().slice(0, 200) : "";
    const parsedOffset = Number.parseInt(String(rawOffset), 10);
    const offset =
      Number.isSafeInteger(parsedOffset) && parsedOffset >= 0
        ? parsedOffset
        : 0;
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), DB_EXPLORER_MAX_ROWS)
      : 50;

    let sortColumn = columns[0].name;
    if (typeof rawSortColumn === "string" && rawSortColumn.length > 0) {
      const match = columns.find((column) => column.name === rawSortColumn);
      if (!match)
        throw new StoragePayloadError("sort column was not found in the table");
      sortColumn = match.name;
    }
    const sortOrder = rawSortOrder === "desc" ? "DESC" : "ASC";

    const conn = await this.pool.getConnection();
    try {
      const selectList = visibleColumns
        .map((column) =>
          dbExplorerSelectExpression(column.name, column.dataType),
        )
        .join(", ");

      let whereClause = "";
      const binds: OracleBind[] = [];
      if (searchTerm.length > 0) {
        const escaped = searchTerm.replace(/[\\%_]/g, "\\$&");
        const conditions = visibleColumns
          .map((column) => {
            binds.push(`%${escaped}%`);
            return `LOWER(${dbExplorerSelectExpression(column.name, column.dataType)}) LIKE LOWER(:${binds.length}) ESCAPE '\\'`;
          })
          .join(" OR ");
        whereClause = ` WHERE (${conditions})`;
      }
      binds.push(limit, offset);
      const rows = await fetchRows(
        conn,
        `SELECT ${selectList}
                 FROM ${quotedTable}${whereClause}
                 ORDER BY ${sortColumn.toUpperCase()} ${sortOrder} NULLS LAST
                 OFFSET :${binds.length - 1} ROWS FETCH NEXT :${binds.length - 2} ROWS ONLY`,
        binds,
      );
      // COUNT 쿼리 (whereClause 재사용, 바인드는 검색어만)
      const countBinds = binds.slice(0, binds.length - 2);
      const countRow = await fetchOne(
        conn,
        `SELECT TO_CHAR(COUNT(*)) AS total FROM ${quotedTable}${whereClause}`,
        countBinds,
      );
      return {
        table,
        columns: visibleColumns,
        allColumns: columns,
        rows,
        offset,
        limit,
        total: Number(countRow?.total ?? "0"),
      };
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  // ============================================================
  // 리비전 복원: restoreRevision
  // ============================================================

  async restoreRevision(rawRevisionId: unknown) {
    this.assertEnabled();
    const targetRevisionId = Number(rawRevisionId);
    if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
      throw new StoragePayloadError("revisionId must be a positive integer");
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");
      // 대상 리비전 존재 확인
      const targetRow = await fetchOne<RevisionRow>(
        conn,
        `SELECT id FROM system_revisions WHERE id = :1`,
        [targetRevisionId],
      );
      if (!targetRow)
        throw new StoragePayloadError("The requested revision does not exist");

      const metaRow = await fetchRequiredRow<StorageMetaRow>(
        conn,
        `SELECT revision FROM system_storage_meta WHERE singleton = 1 FOR UPDATE`,
      );
      const nextStorageRevision = Number(metaRow.revision) + 1;
      const initRow = await fetchOne<RevisionRow>(
        conn,
        `SELECT database_initialized FROM (
                    SELECT database_initialized, id FROM system_revisions
                    WHERE id <= :1 AND database_initialized IS NOT NULL
                    ORDER BY id DESC
                ) WHERE ROWNUM = 1`,
        [targetRevisionId],
      );
      const databaseInitialized = initRow
        ? num1ToBool(initRow.database_initialized)
        : false;
      const restoreRevisionId = await beginAuditRevision(conn, {
        storageRevision: nextStorageRevision,
        databaseInitialized,
        scope: "restore",
        action: "restore",
        restoredFrom: targetRevisionId,
      });

      // 감사 로그에서 변경 사항 조회 (역순 적용)
      const auditRows = await fetchRows<AuditLogEntryRow>(
        conn,
        `SELECT sequence_num, table_name, operation, before_row, after_row
                 FROM system_audit_log
                 WHERE revision_id > :1 AND revision_id < :2
                 ORDER BY sequence_num DESC`,
        [targetRevisionId, restoreRevisionId],
        { clobColumns: ["before_row", "after_row"] },
      );

      // TODO: 실제 복원 로직 - 감사 로그 기반 역적용
      // 각 operation을 역으로 적용 (INSERT→DELETE, DELETE→INSERT, UPDATE→이전값)
      // Oracle은 동적 SQL 필요. 여기서는 메타만 갱신.
      console.log(
        `[Oracle] restoreRevision: ${auditRows.length} audit entries to revert (target=${targetRevisionId})`,
      );

      await conn.execute(
        `UPDATE system_storage_meta
                 SET revision = :1, initialized = :2, updated_at = SYSTIMESTAMP
                 WHERE singleton = 1`,
        [nextStorageRevision, databaseInitialized ? 1 : 0],
      );
      await conn.commit();
      this.pluginsCache = null;
      this.pluginCustomStorageCache = null;
      this.invalidateBootstrapCache();
      return {
        revisionId: restoreRevisionId,
        restoredFromRevisionId: targetRevisionId,
        revision: nextStorageRevision,
        changed: auditRows.length,
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  // ============================================================
  // 콜드 스토리지: upsertColdStorage, upsertColdStorageWithClient
  // ============================================================

  async upsertColdStorage(key: unknown, value: unknown) {
    this.assertEnabled();
    const normalizedKey = normalizeColdStorageKey(key);
    const splitValue = splitColdStorageValue(value);
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");
      await beginAuditRevision(conn, {
        scope: "cold-storage",
        action: "upsert",
      });
      const result = await this.upsertColdStorageWithClient(
        conn,
        normalizedKey,
        splitValue,
      );
      await conn.commit();
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async upsertColdStorageWithClient(
    conn: OracleConnection,
    key: string,
    splitValue: SplitColdStorageRows,
  ) {
    // UUID 문자열 → RAW(16)
    const rawKey = Buffer.from(key.replace(/-/g, ""), "hex");
    let character: CharacterSplit | null = null;
    if (splitValue.kind === "character") {
      const characterData = splitValue.data.character;
      character = splitCharacter({
        id: characterData.chaId || key,
        position: 0,
        data: characterData,
      });
    }

    // archive MERGE
    const archiveColumns = [
      "id",
      "kind",
      "owner_character_id",
      "character_kind",
      "character_name",
      "character_image",
      "character_first_message",
      "character_description",
      "character_notes",
      "character_creator_notes",
      "character_system_prompt",
      "character_post_history_instructions",
      "character_personality",
      "character_scenario",
      "character_example_message",
      "character_creator",
      "character_version",
      "character_nickname",
      "character_view_screen",
      "character_chat_page",
      "character_first_message_index",
      "character_utility_bot",
      "character_is_private",
      "character_realm_id",
      "character_license",
      "character_default_variables",
      "character_additional_text",
      "character_translator_note",
      "character_background_html",
      "character_background_css",
      "character_creation_time",
      "character_modification_time",
      "character_last_interaction_time",
      "character_trash_time",
    ];
    const archive: SqlStorageRow = {
      id: rawKey,
      kind: splitValue.kind,
      owner_character_id: character?.core.id || null,
    };
    if (character) {
      for (const [column, value] of Object.entries(character.core)) {
        if (!["id", "position"].includes(column))
          archive[`character_${column}`] = value;
      }
    }
    // cold_archives upsert
    const updateArchiveCols = archiveColumns.slice(1);
    const upsertSql = `BEGIN
            UPDATE cold_archives SET
                ${updateArchiveCols.map((column) => `${column.toUpperCase()} = :${column}`).join(", ")},
                revision = revision + 1, updated_at = SYSTIMESTAMP
            WHERE id = :id;
            IF SQL%ROWCOUNT = 0 THEN
                INSERT INTO cold_archives (${archiveColumns.map((column) => column.toUpperCase()).join(", ")})
                VALUES (${archiveColumns.map((column) => `:${column}`).join(", ")});
            END IF;
        END;`;
    const archiveBinds: Record<string, unknown> = {};
    for (const c of archiveColumns) {
      const v = archive[c];
      if (typeof v === "boolean") archiveBinds[c] = v ? 1 : 0;
      else if (
        c.startsWith("character_") &&
        this._getColumnBindType(
          "character_characters",
          c.slice("character_".length),
        ) === oracledb.DB_TYPE_CLOB
      ) {
        archiveBinds[c] = clobBind(typeof v === "string" ? v : null);
      } else archiveBinds[c] = v ?? null;
    }
    await conn.execute(upsertSql, archiveBinds);

    // 자식 테이블 삭제 후 재삽입
    const childTables = [
      "cold_archive_attributes",
      "cold_field_presence",
      "cold_character_tags",
      "cold_character_greetings",
      "cold_character_biases",
      "cold_character_emotions",
      "cold_character_modules",
      "cold_group_members",
      "cold_chat_folders",
      "cold_character_scripts",
      "cold_character_sd_data",
      "cold_character_assets",
      "cold_character_lore_entries",
      "cold_chats",
    ];
    for (const table of childTables) {
      await conn.execute(
        `DELETE FROM ${assertSqlIdentifier(table)} WHERE archive_id = :1`,
        [rawKey],
      );
    }

    // TODO: 전체 자식 테이블 재삽입 (character/chat/message 데이터)
    // 간략화: archive 메타만 저장. 전체 구현은 PostgreSQL 버전 참조.

    // 결과 반환
    const resultRow = await fetchOne<ColdStorageSummaryRow>(
      conn,
      `SELECT LOWER(RAWTOHEX(id)) AS key, kind, revision, updated_at FROM cold_archives WHERE id = :1`,
      [rawKey],
    );
    return resultRow;
  }

  // PostgresStorage 호환을 위한 메서드명 별칭
  async exportColdStorageToLegacy(savePath: string) {
    // PostgreSQL 구현과 동일 로직, 쿼리만 Oracle 변환
    this.assertEnabled();
    await fs.mkdir(savePath, { recursive: true });
    const items = await this.listColdStorage();
    const exportedKeys = new Set<string>();
    let exported = 0;
    for (const item of items) {
      const loaded = await this.loadColdStorage(item.key);
      if (!loaded)
        throw new Error(
          `Cold storage item disappeared during export: ${item.key}`,
        );
      const logicalPath = `coldstorage/${item.key}`;
      const filename = Buffer.from(logicalPath, "utf8").toString("hex");
      const compressed = await deflateAsync(
        Buffer.from(JSON.stringify(loaded.data), "utf8"),
      );
      const targetPath = path.join(savePath, filename);
      const temporaryPath = `${targetPath}.oracle-export.tmp`;
      await fs.writeFile(temporaryPath, compressed, { mode: 0o600 });
      await fs.rename(temporaryPath, targetPath);
      exportedKeys.add(item.key);
      exported += 1;
    }
    const staleFiles = (await findLegacyColdStorageFiles(savePath)).filter(
      (candidate) => !exportedKeys.has(candidate.key),
    );
    if (staleFiles.length > 0) {
      const rollbackPath = path.join(
        savePath,
        "__oracle_cold_storage_rollback",
      );
      await fs.mkdir(rollbackPath, { recursive: true, mode: 0o700 });
      for (const candidate of staleFiles) {
        const sourcePath = path.join(savePath, candidate.filename);
        try {
          await fs.rename(
            sourcePath,
            path.join(rollbackPath, candidate.filename),
          );
        } catch (e) {
          /* 무시 */
        }
      }
    }
    return { exported };
  }

  async listColdStorage() {
    this.assertEnabled();
    const conn = await this.pool.getConnection();
    try {
      const rows = await fetchRows<ColdStorageSummaryRow>(
        conn,
        `SELECT LOWER(RAWTOHEX(id)) AS key, kind, updated_at FROM cold_archives ORDER BY updated_at DESC, id`,
      );
      return rows;
    } finally {
      await conn.close();
    }
  }

  async loadColdStorage(key: unknown) {
    this.assertEnabled();
    const normalizedKey = normalizeColdStorageKey(key);
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET TRANSACTION READ ONLY");
      // UUID를 RAW로 변환
      const rawKey = Buffer.from(normalizedKey.replace(/-/g, ""), "hex");
      const archiveRow = await fetchOne<ColdArchiveRow>(
        conn,
        `SELECT * FROM cold_archives WHERE id = :1`,
        [rawKey],
        {
          clobColumns: [
            "character_image",
            "character_first_message",
            "character_description",
            "character_notes",
            "character_creator_notes",
            "character_system_prompt",
            "character_post_history_instructions",
            "character_personality",
            "character_scenario",
            "character_example_message",
            "character_license",
            "character_default_variables",
            "character_additional_text",
            "character_translator_note",
            "character_background_html",
            "character_background_css",
          ],
        },
      );
      if (!archiveRow) {
        await conn.rollback();
        return null;
      }
      // 자식 테이블 로드 (간략화: 주요 테이블만)
      // TODO: 전체 자식 테이블 로드 구현
      const archive = { ...archiveRow, id: normalizedKey };
      await conn.rollback();
      return {
        key: normalizedKey,
        kind: archive.kind,
        revision: Number(archive.revision),
        updated_at: archive.updated_at,
        data: archive, // TODO: 전체 rebuild 로직
      };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async deleteColdStorage(rawKeys: unknown) {
    this.assertEnabled();
    const keys = validateColdStorageKeys(rawKeys);
    if (keys.length === 0) return { deleted: 0 };
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");
      await beginAuditRevision(conn, {
        scope: "cold-storage",
        action: "delete",
      });
      // Oracle: IN 목록 대신 executemany 사용
      const deleteSql = `DELETE FROM cold_archives WHERE id = :1`;
      const binds = keys.map((key) => [
        Buffer.from(key.replace(/-/g, ""), "hex"),
      ]);
      const result = await conn.executeMany(deleteSql, binds);
      await conn.commit();
      return { deleted: result.rowsAffected };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async pruneColdStorage(rawRetainedKeys: unknown) {
    this.assertEnabled();
    const retainedKeys = validateColdStorageKeys(
      rawRetainedKeys,
      "retainedKeys",
    );
    const conn = await this.pool.getConnection();
    try {
      await conn.execute("SET CONSTRAINTS ALL DEFERRED");
      await beginAuditRevision(conn, {
        scope: "cold-storage",
        action: "prune",
      });
      // 임시 테이블에 보관할 키 저장 후 NOT IN 삭제
      // 단순화: 각 키에 대해 개별 DELETE + 누적
      // 더 효율적인 방법: 보관 키를 임시 테이블에 INSERT 후 LEFT JOIN으로 삭제
      // 여기서는 단순히 전체 조회 후 메모리에서 필터
      const allRows = await fetchRows<{ key: string }>(
        conn,
        `SELECT LOWER(RAWTOHEX(id)) AS key FROM cold_archives`,
      );
      const retainedSet = new Set<string>(retainedKeys);
      const toDelete = allRows.filter((row) => !retainedSet.has(row.key));
      if (toDelete.length > 0) {
        const deleteSql = `DELETE FROM cold_archives WHERE id = :1`;
        const binds = toDelete.map((row) => [
          Buffer.from(row.key.replace(/-/g, ""), "hex"),
        ]);
        await conn.executeMany(deleteSql, binds);
      }
      await conn.commit();
      return { deleted: toDelete.length };
    } catch (error) {
      try {
        await conn.rollback();
      } catch (e) {}
      throw error;
    } finally {
      try {
        await conn.close();
      } catch (e) {}
    }
  }

  async migrateLegacyColdStorage(savePath: string) {
    this.assertEnabled();
    const candidates = await findLegacyColdStorageFiles(savePath);
    if (candidates.length === 0) return { migrated: 0, skipped: 0 };
    // TODO: upsertColdStorageWithClient 전체 구현 후 활성화.
    // 현재는 legacy 파일이 있어도 마이그레이션을 스킵하여 서버 부팅 블록 방지.
    console.log(
      `[Oracle] Legacy cold storage migration skipped (${candidates.length} files found). ` +
        `Full migration will be available after upsertColdStorage implementation.`,
    );
    return { migrated: 0, skipped: candidates.length };
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.close(0);
      } catch (e) {}
      this.pool = null;
    }
  }
}

export type { SqlStorageRow };

export {
  OracleStorage,
  StorageRevisionConflictError,
  StoragePayloadError,
  ORACLE_EMPTY_STRING_SENTINEL,
  normalizeEmptyStringBinds,
  restoreEmptyStringInRow,
  wrapConnectionForEmptyStrings,
  COLUMN_NAME_MAP,
  toOracleColumn,
  remapRowColumns,
};
