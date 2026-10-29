const __dirname = import.meta.dirname;
import {
  authorNoteDatabase,
  withAuthorNoteDatabase,
  notes as authorNoteSql,
} from "../authorNotes.ts";
import { v4 as uuidv4 } from 'uuid';
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { loadPostgres } from "../../util/runtimeModules.ts";
import type {
  SqlModuleUpsert,
  SqlPluginUpsert,
  SqlSettingUpsert,
} from "../../../../packages/protocol/src/sqlCommit.ts";
import type {
  StorageSyncActiveBranchRecord,
  StorageSyncBranchRecord,
  StorageSyncMessageRecord,
} from "../../sync/storageSyncSqlApply.ts";
import {
  asRows,
  asUnknownArray,
  decodePresetData,
  isSqlRow,
  legacyModuleId,
  mapBranchRow,
  type AssetCatalogEntry,
  type AssetCatalogEntryRow,
  type ExternalSyncTransaction as ExternalSyncTransactionOf,
  type AssetCatalogKeyRow,
  type AssetCatalogRow,
  type AttributeRow,
  type AuditLogEntryRow,
  type BotChatStatsRow,
  type BotPresetDataRow,
  type BotPresetListRow,
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
  type CharacterSummaryRow,
  type CharacterTagRow,
  type ChatAttributeRow,
  type ChatBookmarkRow,
  type ChatBranchInsertRow,
  type ChatBranchSummary,
  type ChatCoreRow,
  type ChatLoreRow,
  type ChatMemoryRow,
  type ChatModuleRow,
  type ChatRelationName,
  type ChatScriptStateRow,
  type ChatShellRow,
  type ChatSplit,
  type ChatSuggestionRow,
  type ColdArchiveRow,
  type ColdChatRowOf,
  type ColdFieldPresenceRow,
  type ColdMessageRowOf,
  type ColdStorageSummaryRow,
  type ColdTableName,
  type ColdTableRows,
  type CreateChatBranchInput,
  type ExplorerColumn,
  type ExplorerColumnRow,
  SETTING_RELATION_DEFINITIONS,
  SETTING_RELATION_TABLES,
  type KeyedOwnerKeys,
  type LegacyBranchStateRow,
  type LoadChatOptions,
  type LoadPluginsOptions,
  type LoreEntryColumns,
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
  type PositionalOwnerLength,
  type RecentChatRow,
  type RestoreMetadataRow,
  type RestoreTable,
  type RevisionListRow,
  type RevisionRow,
  type SettingScalarRow,
  type SettingValueRow,
  type SqlStorageRow,
  type StorageMetaRow,
  type StorageSyncFinalizeContext,
  type StorageSyncSummaryRow,
  type SyncOptions,
  type TokenUsageRow,
} from "../relationalRows.ts";
import { promisify } from "util";
import { deflate, unzip } from "zlib";
import {
  describePostgresTarget,
  readStorageStartupSettings,
  runStartupStage,
} from "../../http/startupDiagnostics.ts";
import {
  decodePostgresScript,
  decodePostgresJsonValue,
  encodePostgresScript,
  encodePostgresJsonValue,
} from "./postgresJsonCodec.ts";
import {
  rebuildCharacter,
  rebuildChat,
  rebuildMessage,
  splitCharacter,
  splitChat,
  splitMessage,
} from "./postgresRelationalCodec.ts";
import { projectSettings } from "./postgresSettingRelations.ts";
import { rebuildSettings, splitSetting } from "./postgresSettingsCodec.ts";
import {
  DEFERRED_SETTING_KEYS,
  DEFERRED_STARTUP_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  SqlStorageBase,
  createSqlStorageHelpers,
  groupRows,
  groupMessageRows,
  buildChatShell,
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
  type SqlStorageHelpers,
  type ScalarSettingColumns,
} from "../sqlStorageCommon.ts";
import {
  migrateLegacyBranchStateWith,
  rebuildLinearMessages,
} from "../sqlBranchMigration.ts";
import { exportDatabaseSnapshotWith } from "../sqlSnapshot.ts";
import { syncModuleRecords } from "../sqlSyncDomain.ts";
import { PostgresDialect } from "./postgresDialect.ts";
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
  parseRevisionListLimit,
  summarizeStorageSyncRow,
} from "../sqlStorageReadModels.ts";
import { Character } from "../../../../packages/protocol/domain/character.ts";
import type { ISqlStorage } from "../../../../packages/storage-core/src/sqlStorage.ts";
import { Kysely, PostgresDialect as KyselyPostgresDialect, sql } from "kysely";
import { Pool } from "pg";

/** One column value accepted by a PostgreSQL query parameter list. */
type SqlParameter = unknown;
/** Row shape returned by the lazily loaded `pg` driver, which ships no types. */
type PgQueryResult<TRow = SqlStorageRow> = {
  rows: TRow[];
  rowCount: number | null;
};
/** Callback form of `client.query`, still supported by `pg`. */
type PgQueryCallback = (error: Error | null, result?: PgQueryResult) => void;
type PgQuery = <TRow = SqlStorageRow>(
  text: string,
  values?: readonly SqlParameter[],
) => Promise<PgQueryResult<TRow>>;
type PgClient = { query: PgQuery };
type PgPoolClient = PgClient & { release(): void };
type PgPoolEvents = { error: Error; connect: PgClient };
type PgPool = PgClient & {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on<TEvent extends keyof PgPoolEvents>(
    event: TEvent,
    listener: (payload: PgPoolEvents[TEvent]) => void,
  ): unknown;
};

/**
 * Message object persisted by `saveMessage`. The chat role, data, timing and
 * every other app-defined field travel through the open record part; only the
 * routing columns are named here.
 */
type MessageSaveInput = SqlStorageRow & {
  chatId?: string;
  id?: string;
  position?: number;
};

/**
 * Module object passed to `saveModule`. The module body is app-defined JSON, so
 * the record stays open beyond the two columns the writer reads.
 */
type ModuleRecord = SqlStorageRow & { id: string; name?: string };
/**
 * Bot preset passed to `saveBotPreset`. Every other preset field is stored as
 * JSON in `system.bot_presets.data`, so the record stays open.
 */
type BotPresetRecord = SqlStorageRow & {
  id?: string;
  name?: string;
  image?: string;
  apiType?: string;
  aiModel?: string;
};
/** Body run inside an audited storage revision. */
type RevisionCallback = (
  client: PgClient,
  revisionId: number,
) => Promise<unknown>;
/** Transaction handed to `sync` when the storage-sync importer reuses one. */
type ExternalSyncTransaction = ExternalSyncTransactionOf<PgClient>;
type StorageSyncFinalizeCallback = (
  client: PgClient,
  context: StorageSyncFinalizeContext,
) => Promise<unknown>;

/** Branch head bookkeeping while linking incoming messages. */
type BranchHead = {
  chatId: string;
  branchId: string;
  messageId: string;
  position: number;
};
/** Connection settings accepted by the storage constructor and reconfigure. */
type PostgresStorageOptions = {
  connectionString?: string;
  poolMax?: number | string;
};

const POSTGRES_SCHEMA_VERSION = 4;
const RELATIONAL_SCHEMA_LAYOUT = "relational-schema-v3";
const MAX_SYNC_ROWS = 250000;
const BULK_INSERT_BATCH_ROWS = Math.max(
  1,
  Number.parseInt(process.env.RISUAI_SQL_BATCH_ROWS || "1000", 10) || 1000,
);
const AUDITED_TABLES = [
  "system.global_author_notes",
  "system.global_author_note_settings",
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
  (key: string) => `'${key}'`,
).join(", ");

type SettingColumns = ScalarSettingColumns<boolean>;

const { mapSettingValueToColumns, mapColumnsToSettingValue } =
  createSettingColumnMappers<boolean>({
    encodeBool: (value) => value,
    decodeBool: (value) => value,
  });

/**
 * `pg` resolves a multi-statement text query to one result per statement.
 * pg는 여러 문장을 담은 텍스트 쿼리를 문장별 결과 배열로 반환합니다.
 */
async function queryStatementResults(
  client: PgClient,
  sql: string,
): Promise<PgQueryResult[]> {
  const results = (await client.query(sql)) as unknown as PgQueryResult[];
  return Array.isArray(results) ? results : [results];
}

async function replaceSettingValueRows(
  client: PgClient,
  upserts: readonly SqlSettingUpsert[],
): Promise<void> {
  if (upserts.length === 0) return;
  const keys = upserts.map((item) => item.key);
  await client.query(
    "DELETE FROM system.setting_values WHERE setting_key = ANY($1::text[])",
    [keys],
  );
  const rows: SettingValueRow[] = upserts.flatMap(
    (item) => splitSetting(item.key, item.value).values,
  );
  await bulkInsert(
    client,
    "system.setting_values",
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
    [
      "text",
      "integer",
      "integer",
      "text",
      "text",
      "integer",
      "text",
      "text",
      "text",
      "double precision",
      "boolean",
    ],
    rows,
  );
}

async function replaceModuleValueRows(
  client: PgClient,
  upserts: readonly ModuleValueUpsert[],
): Promise<void> {
  if (upserts.length === 0) return;
  const ids = upserts.map((item) => item.id);
  await client.query(
    "DELETE FROM system.module_values WHERE module_id = ANY($1::text[])",
    [ids],
  );
  const rows = upserts.flatMap((item) =>
    splitSetting(item.id, item.data).values.map((row: SettingValueRow) => ({
      ...row,
      module_id: row.setting_key,
    })),
  );
  await bulkInsert(
    client,
    "system.module_values",
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
    [
      "text",
      "integer",
      "integer",
      "text",
      "text",
      "integer",
      "text",
      "text",
      "text",
      "double precision",
      "boolean",
    ],
    rows,
  );
}

async function replacePluginValueRows(
  client: PgClient,
  upserts: readonly SqlPluginUpsert[],
): Promise<void> {
  if (upserts.length === 0) return;
  const ids = upserts.map((item) => item.id);
  await client.query(
    "DELETE FROM system.plugin_values WHERE plugin_id = ANY($1::text[])",
    [ids],
  );
  const rows = upserts.flatMap((item) =>
    splitSetting(item.id, pluginExtensionData(item.data)).values.map(
      (row: SettingValueRow) => ({
        ...row,
        plugin_id: row.setting_key,
      }),
    ),
  );
  await bulkInsert(
    client,
    "system.plugin_values",
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
    [
      "text",
      "integer",
      "integer",
      "text",
      "text",
      "integer",
      "text",
      "text",
      "text",
      "double precision",
      "boolean",
    ],
    rows,
  );
}

function rebuildSettingRows(
  settings: readonly SettingScalarRow[],
  valueRows: readonly SettingValueRow[],
) {
  const rebuilt: Record<string, unknown> = rebuildSettings(settings, valueRows);
  for (const row of settings) {
    if (!Object.prototype.hasOwnProperty.call(rebuilt, row.key)) {
      rebuilt[row.key] = mapColumnsToSettingValue(row);
    }
  }
  return rebuilt;
}

import {
  PostgresRevisionConflictError,
  PostgresPayloadError,
} from "../storageErrors.ts";
import type { CharacterTables } from "./tables/character.ts";
import type { SystemTables } from "./tables/system.ts";
import type { ChatTables } from "./tables/chat.ts";
import type { ColdTables } from "./tables/cold.ts";
const helpers: SqlStorageHelpers = createSqlStorageHelpers({
  PayloadError: PostgresPayloadError,
  maxIdLength: 1024,
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
/** Cold-storage value shape produced by the shared splitter. */
type SplitColdStorageRows = ReturnType<typeof splitColdStorageValue>;
// Assertion helpers need an explicit type annotation on their name before they
// can be called as assertions, so they cannot be destructured.
const assertId: SqlStorageHelpers["assertId"] = helpers.assertId;
const assertPosition: SqlStorageHelpers["assertPosition"] =
  helpers.assertPosition;
const assertData: SqlStorageHelpers["assertData"] = helpers.assertData;

const assertDbExplorerIdentifier = createDbExplorerIdentifierValidator({
  PayloadError: PostgresPayloadError,
  tooLong: (field) => `${field} must be a valid table or column name`,
  invalid: (field) => `${field} must be a valid table or column name`,
});

function dbExplorerSelectExpression(
  columnName: string,
  dataType: string | null,
): string {
  const column = `"${columnName}"`;
  switch (dataType) {
    case "bigint":
    case "numeric":
    case "decimal":
      return `${column}::text`;
    case "bytea":
      return `encode(${column}, 'hex')`;
    default:
      return column;
  }
}

function assertSqlIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  const parts = value.split(".");
  if (parts.length === 1 && /^[a-z][a-z0-9_]*$/i.test(parts[0])) {
    return `"${parts[0]}"`;
  }
  if (
    parts.length === 2 &&
    /^[a-z][a-z0-9_]*$/i.test(parts[0]) &&
    /^[a-z][a-z0-9_]*$/i.test(parts[1])
  ) {
    return `"${parts[0]}"."${parts[1]}"`;
  }
  throw new Error(`Unsafe SQL identifier: ${value}`);
}

async function bulkInsert(
  client: PgClient,
  table: string,
  columns: readonly string[],
  columnTypes: readonly string[],
  rows: readonly SqlStorageRow[],
  suffix = "",
): Promise<void> {
  if (rows.length === 0) return;
  const quotedTable = assertSqlIdentifier(table);
  const quotedColumns = columns.map((col) => `"${col}"`);
  const unnest = columns
    .map((_column, index) => `$${index + 1}::${columnTypes[index]}[]`)
    .join(", ");
  const query = `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")})
         SELECT * FROM UNNEST(${unnest}) AS item(${quotedColumns.join(", ")})
         ${suffix}`;

  // Keep only one column-major parameter batch alive during large restores.
  for (let start = 0; start < rows.length; start += BULK_INSERT_BATCH_ROWS) {
    const end = Math.min(rows.length, start + BULK_INSERT_BATCH_ROWS);
    const parameters: SqlParameter[][] = columns.map((column, columnIndex) => {
      const values: SqlParameter[] = new Array(end - start);
      for (let rowIndex = start; rowIndex < end; rowIndex++) {
        const value = rows[rowIndex][column];
        values[rowIndex - start] =
          columnTypes[columnIndex] === "jsonb"
            ? value === undefined
              ? null
              : JSON.stringify(value)
            : (value ?? null);
      }
      return values;
    });
    await client.query(query, parameters);
  }
}

type AuditRevisionOptions = {
  storageRevision?: number | null;
  databaseInitialized?: boolean | null;
  scope: string;
  action: string;
  restoredFrom?: number | null;
};

async function beginAuditRevision(
  client: PgClient,
  {
    storageRevision = null,
    databaseInitialized = null,
    scope,
    action,
    restoredFrom = null,
  }: AuditRevisionOptions,
): Promise<number> {
  const result = await client.query(
    `WITH inserted AS (
            INSERT INTO system.revisions
                (storage_revision, database_initialized, scope, action, restored_from_revision)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
         )
         SELECT id, set_config('risu.revision_id', id::text, TRUE)
         FROM inserted`,
    [storageRevision, databaseInitialized, scope, action, restoredFrom],
  );
  const revisionId = Number(result.rows[0].id);
  return revisionId;
}

function buildUpsertClause(
  table: string,
  pkColumns: readonly string[],
  valueColumns: readonly string[],
  updateTimestamp = false,
): string {
  if (valueColumns.length === 0) {
    return `ON CONFLICT (${pkColumns.map((c) => `"${c}"`).join(", ")}) DO NOTHING`;
  }
  const quotedTable = assertSqlIdentifier(table);
  const sets = valueColumns.map((c) => `"${c}" = EXCLUDED."${c}"`);
  if (updateTimestamp) {
    sets.push('"updated_at" = NOW()');
  }
  const leftCols = valueColumns.map((c) => `${quotedTable}."${c}"`).join(", ");
  const rightCols = valueColumns.map((c) => `EXCLUDED."${c}"`).join(", ");
  return `ON CONFLICT (${pkColumns.map((c) => `"${c}"`).join(", ")}) DO UPDATE SET
        ${sets.join(", ")}
        WHERE (${leftCols}) IS DISTINCT FROM (${rightCols})`;
}

async function prunePositionalChildren(
  client: PgClient,
  table: string,
  ownerColumn: string,
  lengthsByOwner: readonly PositionalOwnerLength[],
  subKindColumn: string | null = null,
): Promise<void> {
  if (lengthsByOwner.length === 0) return;
  const quotedTable = assertSqlIdentifier(table);
  const ownerCol = `"${ownerColumn}"`;

  if (subKindColumn) {
    const subKindCol = `"${subKindColumn}"`;
    const owners = lengthsByOwner.map((item) => item.ownerId);
    const subKinds = lengthsByOwner.map((item) => item.subKind);
    const lengths = lengthsByOwner.map((item) => item.length);
    await client.query(
      `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(owner_id, sub_kind, target_len)
             WHERE target.${ownerCol} = spec.owner_id
               AND target.${subKindCol} = spec.sub_kind
               AND target."position" >= spec.target_len`,
      [owners, subKinds, lengths],
    );
  } else {
    const owners = lengthsByOwner.map((item) => item.ownerId);
    const lengths = lengthsByOwner.map((item) => item.length);
    await client.query(
      `DELETE FROM ${quotedTable} AS target
             USING UNNEST($1::text[], $2::integer[]) AS spec(owner_id, target_len)
             WHERE target.${ownerCol} = spec.owner_id
               AND target."position" >= spec.target_len`,
      [owners, lengths],
    );
  }
}

async function pruneKeyedChildren(
  client: PgClient,
  table: string,
  ownerColumn: string,
  keyColumn: string,
  keysByOwner: readonly KeyedOwnerKeys[],
): Promise<void> {
  if (keysByOwner.length === 0) return;
  const quotedTable = assertSqlIdentifier(table);
  const ownerCol = `"${ownerColumn}"`;
  const keyCol = `"${keyColumn}"`;

  for (const { ownerId, keys } of keysByOwner) {
    if (!keys || keys.length === 0) {
      await client.query(`DELETE FROM ${quotedTable} WHERE ${ownerCol} = $1`, [
        ownerId,
      ]);
    } else {
      await client.query(
        `DELETE FROM ${quotedTable} WHERE ${ownerCol} = $1 AND NOT (${keyCol} = ANY($2::text[]))`,
        [ownerId, keys],
      );
    }
  }
}

export type PostgresStorageContract = PostgresStorage;

type PostgresDatabase = 
& CharacterTables
& SystemTables
& ChatTables
& ColdTables;
export class NPostgresStorage implements ISqlStorage {
  db: Kysely<PostgresDatabase>;

  constructor(connectionString: string, poolMax: number = 10) {
    this.db = new Kysely({
      dialect: new KyselyPostgresDialect({
        pool: new Pool({ max: poolMax, connectionString: connectionString }),
      }),
    });
  }

  character = {
    create: async (name: string): Promise<Character> => {
      const row = await this.db
        .insertInto("character.characters")
        .values({
          id: uuidv4(),
          position: Number(1),
          kind: "character",
          name: name,
        })
        .returning(["id", "name"])
        .executeTakeFirstOrThrow();
      return new Character({ chaId: row.id, name: row.name });
    },
    position: {
      max: async (): Promise<number> => {
        return (
          (
            await this.db
              .selectFrom("character.characters")
              .select(({ fn }) => fn.max<number>("position").as("maxPosition"))
              .executeTakeFirstOrThrow()
          ).maxPosition ?? -1
        );
      },
    },
  };
}

/**
 * @deprecated
 */
class PostgresStorage extends SqlStorageBase {
  // The `pg` package ships no type definitions and is loaded lazily.
  declare pool: PgPool | null;
  declare connectionString: string;
  declare poolMax: number;
  declare postgresSchemaSql: string | null;
  declare schemaRecoveryPromise: Promise<void> | null;
  declare startupSettings: ReturnType<typeof readStorageStartupSettings>;

  constructor(options: PostgresStorageOptions = {}) {
    super();
    this.connectionString = options.connectionString || "";
    this.poolMax = Number.parseInt(String(options.poolMax ?? "10"), 10);
    this.enabled = Boolean(this.connectionString);
    this.startupSettings = readStorageStartupSettings();
    this.pool = null;
    this.schemaRecoveryPromise = null;
    this.postgresSchemaSql = null;
  }

  async initialize() {
    if (!this.enabled) {
      console.log(
        "[PostgreSQL] DATABASE_URL is not configured; using legacy file storage.",
      );
      return;
    }

    console.log(
      `[PostgreSQL startup] Target: ${describePostgresTarget(this.connectionString)}; ` +
        `pool max: ${this.poolMax}; connect timeout: ${this.startupSettings.connectTimeoutMs}ms.`,
    );
    this.pool = await this.createInitializedPool(
      this.connectionString,
      this.poolMax,
    );
    console.log("[PostgreSQL] Structured storage is ready.");
  }

  runStartupStep<TOperationResult>(
    operation: string,
    task: () => TOperationResult | Promise<TOperationResult>,
  ): Promise<TOperationResult> {
    return runStartupStage(
      {
        scope: "PostgreSQL startup",
        operation,
        heartbeatMs: this.startupSettings.heartbeatMs,
      },
      task,
    );
  }

  async loadPostgresSchemaSql(): Promise<string> {
    if (!this.postgresSchemaSql) {
      this.postgresSchemaSql = await fs.readFile(
        path.join(__dirname, "postgres-schema.sql"),
        "utf8",
      );
    }
    return this.postgresSchemaSql;
  }

  async verifyPostgresSchema(query: PgQuery): Promise<void> {
    const result = await query(
      "SELECT schema_version, schema_layout FROM system.storage_meta WHERE singleton = TRUE",
    );
    const schemaVersion = Number(result.rows[0]?.schema_version);
    const schemaLayout = result.rows[0]?.schema_layout;
    if (
      schemaVersion !== POSTGRES_SCHEMA_VERSION ||
      schemaLayout !== RELATIONAL_SCHEMA_LAYOUT
    ) {
      throw new Error(
        `Unsupported PostgreSQL schema ${schemaVersion}/${schemaLayout}; ` +
          `expected ${POSTGRES_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}. ` +
          "Reset the configured development database explicitly before retrying.",
      );
    }
  }

  async recoverMissingPostgresSchema(query: PgQuery): Promise<void> {
    if (this.schemaRecoveryPromise != null) {
      return this.schemaRecoveryPromise;
    }
    const recovery = (async () => {
      const existingMeta = await query(
        "SELECT to_regclass('system.storage_meta') AS table_name",
      );
      if (!existingMeta.rows[0]?.table_name) {
        console.warn(
          "[PostgreSQL] Storage schema disappeared; reinitializing it on the current database.",
        );
        await query(await this.loadPostgresSchemaSql());
        this.invalidateBootstrapCache();
      }
      await this.verifyPostgresSchema(query);
      await this.ensureLastMessageTimeInvariant(query);
    })();
    this.schemaRecoveryPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (this.schemaRecoveryPromise === recovery) {
        this.schemaRecoveryPromise = null;
      }
    }
  }

  async ensureConnectedClientSchema(query: PgQuery): Promise<void> {
    const existingMeta = await query(
      "SELECT to_regclass('system.storage_meta') AS table_name",
    );
    if (!existingMeta.rows[0]?.table_name) {
      await this.recoverMissingPostgresSchema(query);
      return;
    }
    await this.verifyPostgresSchema(query);
  }

  async ensureLastMessageTimeInvariant(query: PgQuery): Promise<void> {
    const triggerName = "messages_last_message_time_after_insert";
    const existing = await query(
      `SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'chat.messages'::regclass
                AND tgname = $1
                AND NOT tgisinternal`,
      [triggerName],
    );
    if (existing.rows.length === 0) {
      await query(`
                UPDATE chat.chats AS ch
                   SET last_message_time = (
                       SELECT m.sent_time
                         FROM chat.messages AS m
                        WHERE m.chat_id = ch.id
                        ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                        LIMIT 1
                   ), updated_at = NOW()
            `);
    }
    const triggerSql = await fs.readFile(
      path.join(__dirname, "postgres-last-message-time.sql"),
      "utf8",
    );
    await query(triggerSql);
  }

  installPoolSchemaRecovery(pool: PgPool): void {
    pool.on("error", (error: Error) => {
      console.warn(
        "[PostgreSQL] Idle pool connection failed; a later request will reconnect:",
        error.message || error,
      );
    });
    pool.on("connect", (client: PgClient) => {
      const originalQuery: PgQuery = client.query.bind(client) as PgQuery;
      const schemaReady = this.ensureConnectedClientSchema(originalQuery);
      schemaReady.catch(() => {});
      // `pg` still accepts the legacy callback form for `query`.
      const queryWithSchema: PgQuery = ((...args: unknown[]) => {
        const callback =
          typeof args[args.length - 1] === "function"
            ? (args.pop() as PgQueryCallback)
            : null;
        if (callback) {
          schemaReady
            .then(() =>
              (originalQuery as (...argv: unknown[]) => unknown)(
                ...args,
                callback,
              ),
            )
            .catch((error: unknown) => callback(error as Error));
          return undefined as never;
        }
        return schemaReady.then(() =>
          (originalQuery as (...argv: unknown[]) => Promise<PgQueryResult>)(
            ...args,
          ),
        );
      }) as PgQuery;
      client.query = queryWithSchema;
    });
  }

  async createInitializedPool(
    connectionString: string,
    poolMax: number,
  ): Promise<PgPool> {
    const pool = new (await loadPostgres()).Pool({
      connectionString,
      max: Number.isSafeInteger(poolMax) && poolMax > 0 ? poolMax : 10,
      application_name: "risuai-node",
      connectionTimeoutMillis: this.startupSettings.connectTimeoutMs,
    });
    try {
      await this.runStartupStep("1/6 connect and ping database", () =>
        pool.query("SELECT 1"),
      );
      const existingMeta = await this.runStartupStep(
        "2/6 inspect storage schema metadata",
        () =>
          pool.query("SELECT to_regclass('system.storage_meta') AS table_name"),
      );
      if (existingMeta.rows[0]?.table_name) {
        await this.runStartupStep(
          "3/6 validate existing storage schema version",
          () => this.verifyPostgresSchema(pool.query.bind(pool)),
        );
      } else {
        console.log(
          "[PostgreSQL startup] 3/6 no existing storage schema found; a new schema will be created.",
        );
      }
      const schemaSql = await this.runStartupStep(
        "4/6 load bundled storage schema",
        () => this.loadPostgresSchemaSql(),
      );
      await this.runStartupStep("5/6 apply storage schema", () =>
        pool.query(schemaSql),
      );
      await this.runStartupStep("5b/6 ensure chat last-message invariant", () =>
        this.ensureLastMessageTimeInvariant(pool.query.bind(pool)),
      );
      await this.runStartupStep("6/6 verify applied storage schema", () =>
        this.verifyPostgresSchema(pool.query.bind(pool)),
      );
      await authorNoteSql.ensureAuthorNoteReceipts(
        authorNoteDatabase("postgres", pool),
      );
      this.installPoolSchemaRecovery(pool);
      return pool;
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
  }

  async reconfigure(options: PostgresStorageOptions = {}): Promise<void> {
    this.invalidateBootstrapCache();
    const connectionString = options.connectionString || "";
    const parsedPoolMax = Number.parseInt(String(options.poolMax ?? "10"), 10);
    const poolMax =
      Number.isSafeInteger(parsedPoolMax) && parsedPoolMax > 0
        ? parsedPoolMax
        : 10;
    if (!connectionString) {
      const previousPool = this.pool;
      this.connectionString = "";
      this.poolMax = poolMax;
      this.pool = null;
      this.enabled = false;
      if (previousPool) {
        await previousPool.end();
      }
      return;
    }

    const nextPool = await this.createInitializedPool(
      connectionString,
      poolMax,
    );
    const previousPool = this.pool;
    this.connectionString = connectionString;
    this.poolMax = poolMax;
    this.pool = nextPool;
    this.enabled = true;
    if (previousPool) {
      await previousPool.end();
    }
    console.log("[PostgreSQL] Storage connection was reconfigured.");
  }

  assertEnabled(): asserts this is PostgresStorage & { pool: PgPool } {
    if (!this.enabled || !this.pool) {
      throw new Error("PostgreSQL storage is not enabled");
    }
  }

  async getState(): Promise<{ revision: number; initialized: boolean }> {
    this.assertEnabled();
    const result = await this.pool.query<StorageMetaRow>(
      "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE",
    );
    return {
      revision: Number(result.rows[0].revision),
      initialized: Boolean(result.rows[0].initialized),
    };
  }

  async getStorageSyncSummary() {
    this.assertEnabled();
    const result = await this.pool.query<StorageSyncSummaryRow>(`
      SELECT meta.revision, meta.initialized,
             (SELECT COUNT(*)::bigint FROM system.settings) AS settings_count,
             (SELECT COUNT(*)::bigint FROM character.characters) AS characters_count,
             (SELECT COUNT(*)::bigint FROM chat.chats) AS chats_count,
             (SELECT COUNT(*)::bigint FROM chat.messages) AS messages_count
        FROM system.storage_meta meta
       WHERE meta.singleton = TRUE
    `);
    const row: Partial<StorageSyncSummaryRow> = result.rows[0] ?? {};
    return summarizeStorageSyncRow(row);
  }

  async isAssetCatalogInitialized(sourceId?: string | null): Promise<boolean> {
    this.assertEnabled();
    const result = await this.pool.query<{
      initialized: boolean | null;
      source_id: string | null;
    }>(
      "SELECT initialized, source_id FROM system.asset_catalog_state WHERE singleton = TRUE",
    );
    return (
      Boolean(result.rows[0]?.initialized) &&
      result.rows[0]?.source_id === sourceId
    );
  }

  async listAssetCatalog(prefix = ""): Promise<string[]> {
    this.assertEnabled();
    const result = prefix
      ? await this.pool.query<AssetCatalogKeyRow>(
          "SELECT asset_key FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2 ORDER BY asset_key",
          [prefix.length, prefix],
        )
      : await this.pool.query<AssetCatalogKeyRow>(
          "SELECT asset_key FROM system.asset_catalog ORDER BY asset_key",
        );
    return result.rows.map((row) => row.asset_key);
  }

  async listAssetCatalogEntries(prefix = ""): Promise<AssetCatalogEntryRow[]> {
    this.assertEnabled();
    const result = prefix
      ? await this.pool.query<AssetCatalogRow>(
          "SELECT asset_key, size_bytes, etag, updated_at FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2 ORDER BY asset_key",
          [prefix.length, prefix],
        )
      : await this.pool.query<AssetCatalogRow>(
          "SELECT asset_key, size_bytes, etag, updated_at FROM system.asset_catalog ORDER BY asset_key",
        );
    return result.rows.map((row) => ({
      key: row.asset_key,
      size: row.size_bytes === null ? null : Number(row.size_bytes),
      etag: row.etag ?? null,
      updatedAt: row.updated_at
        ? new Date(row.updated_at as string | number | Date).getTime()
        : null,
    }));
  }

  async getAssetCatalogStats() {
    this.assertEnabled();
    const result = await this.pool.query(
      "SELECT COUNT(*)::bigint AS total_objects, COALESCE(SUM(size_bytes), 0)::bigint AS total_size FROM system.asset_catalog",
    );
    return mapAssetCatalogStats(result.rows[0] ?? {});
  }

  async upsertAssetCatalog(
    entries: readonly AssetCatalogEntry[],
  ): Promise<number> {
    this.assertEnabled();
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const keys = entries.map((entry) => entry.key);
    const sizes = entries.map((entry) => entry.size ?? null);
    const etags = entries.map((entry) => entry.etag ?? null);
    await this.pool.query(
      `INSERT INTO system.asset_catalog (asset_key, size_bytes, etag)
             SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::text[])
             ON CONFLICT (asset_key) DO UPDATE SET
                size_bytes = COALESCE(EXCLUDED.size_bytes, system.asset_catalog.size_bytes),
                etag = COALESCE(EXCLUDED.etag, system.asset_catalog.etag),
                updated_at = NOW()`,
      [keys, sizes, etags],
    );
    return entries.length;
  }

  async removeAssetCatalog(keys: readonly string[]): Promise<number | null> {
    this.assertEnabled();
    if (!Array.isArray(keys) || keys.length === 0) return 0;
    const result = await this.pool.query(
      "DELETE FROM system.asset_catalog WHERE asset_key = ANY($1::text[])",
      [keys],
    );
    return result.rowCount;
  }

  async replaceAssetCatalog(
    prefix: string,
    entries: readonly AssetCatalogEntry[],
    sourceId: string | null,
  ): Promise<number> {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (prefix) {
        await client.query(
          "DELETE FROM system.asset_catalog WHERE LEFT(asset_key, $1) = $2",
          [prefix.length, prefix],
        );
      } else {
        await client.query("DELETE FROM system.asset_catalog");
      }
      if (entries.length > 0) {
        const keys = entries.map((entry) => entry.key);
        const sizes = entries.map((entry) => entry.size ?? null);
        const etags = entries.map((entry) => entry.etag ?? null);
        await client.query(
          `INSERT INTO system.asset_catalog (asset_key, size_bytes, etag)
                     SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::text[])`,
          [keys, sizes, etags],
        );
      }
      await client.query(
        `UPDATE system.asset_catalog_state
                 SET initialized = TRUE, source_id = $1, synced_at = NOW()
                 WHERE singleton = TRUE`,
        [sourceId],
      );
      await client.query("COMMIT");
      return entries.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listRevisions(rawLimit: unknown = null) {
    this.assertEnabled();
    let sql = `SELECT revision.id, revision.storage_revision, revision.database_initialized,
                    revision.scope, revision.action, revision.restored_from_revision,
                    revision.created_at, COUNT(audit.sequence)::integer AS change_count
             FROM system.revisions AS revision
             LEFT JOIN system.audit_log AS audit ON audit.revision_id = revision.id
             GROUP BY revision.id
             ORDER BY revision.id DESC`;
    const params: SqlParameter[] = [];
    const parsedLimit = parseRevisionListLimit(rawLimit);
    if (parsedLimit !== null) {
      sql += " LIMIT $1";
      params.push(parsedLimit);
    }
    const result = await this.pool.query<RevisionListRow>(sql, params);
    return result.rows.map((row) => mapRevisionListRow(row));
  }

  async getRevisionDetails(rawRevisionId: unknown) {
    this.assertEnabled();
    const revisionId = Number(rawRevisionId);
    if (!Number.isSafeInteger(revisionId) || revisionId <= 0) {
      throw new PostgresPayloadError("revisionId must be a positive integer");
    }
    const revResult = await this.pool.query<RevisionRow>(
      `SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at
             FROM system.revisions
             WHERE id = $1`,
      [revisionId],
    );
    if (revResult.rowCount === 0) {
      return null;
    }
    const revision = revResult.rows[0];

    const auditResult = await this.pool.query<AuditLogEntryRow>(
      `SELECT sequence, revision_id, table_name, operation, before_row, after_row, recorded_at
             FROM system.audit_log
             WHERE revision_id = $1
             ORDER BY sequence ASC`,
      [revisionId],
    );

    return buildRevisionDetails(revision, auditResult.rows);
  }

  async getRevisionDiff(rawBaseId: unknown, rawTargetId: unknown) {
    this.assertEnabled();
    const baseId = Number(rawBaseId);
    const targetId = Number(rawTargetId);
    if (
      !Number.isSafeInteger(baseId) ||
      !Number.isSafeInteger(targetId) ||
      baseId <= 0 ||
      targetId <= 0
    ) {
      throw new PostgresPayloadError(
        "baseRevisionId and targetRevisionId must be positive integers",
      );
    }
    const minId = Math.min(baseId, targetId);
    const maxId = Math.max(baseId, targetId);

    const auditResult = await this.pool.query<AuditLogEntryRow>(
      `SELECT sequence, revision_id, table_name, operation, before_row, after_row, recorded_at
             FROM system.audit_log
             WHERE revision_id > $1 AND revision_id <= $2
             ORDER BY sequence ASC`,
      [minId, maxId],
    );

    return {
      baseRevisionId: baseId,
      targetRevisionId: targetId,
      totalChanges: auditResult.rowCount,
      tables: buildRevisionDiffTables(auditResult.rows),
    };
  }

  async previewRestore(rawRevisionId: unknown) {
    this.assertEnabled();
    const targetRevisionId = Number(rawRevisionId);
    if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
      throw new PostgresPayloadError("revisionId must be a positive integer");
    }
    const target = await this.pool.query(
      "SELECT id, scope, action, created_at FROM system.revisions WHERE id = $1",
      [targetRevisionId],
    );
    if (target.rowCount === 0) {
      throw new PostgresPayloadError("The requested revision does not exist");
    }
    const latest = await this.pool.query(
      "SELECT id FROM system.revisions ORDER BY id DESC LIMIT 1",
    );
    const currentRevisionId = latest.rows[0]?.id
      ? Number(latest.rows[0].id)
      : targetRevisionId;

    const auditResult = await this.pool.query<AuditLogEntryRow>(
      `SELECT sequence, table_name, operation, before_row, after_row
             FROM system.audit_log
             WHERE revision_id > $1
             ORDER BY sequence DESC`,
      [targetRevisionId],
    );

    return {
      targetRevisionId,
      currentRevisionId,
      revisionsToRevert: Math.max(0, currentRevisionId - targetRevisionId),
      ...buildRestorePreview(auditResult.rows),
    };
  }

  async getRestoreMetadata(
    client: PgClient,
  ): Promise<Map<string, RestoreTable>> {
    const result = await client.query<RestoreMetadataRow>(
      `SELECT (namespace.nspname || '.' || class.relname) AS table_name,
                    attribute.attname AS column_name,
                    format_type(attribute.atttypid, attribute.atttypmod) AS column_type,
                    attribute.attnum AS ordinal,
                    attribute.attnotnull AS not_null,
                    EXISTS (
                        SELECT 1
                        FROM pg_index AS idx
                        WHERE idx.indrelid = class.oid
                          AND idx.indisprimary
                          AND attribute.attnum = ANY(idx.indkey::smallint[])
                    ) AS is_primary
             FROM pg_class AS class
             JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
             JOIN pg_attribute AS attribute ON attribute.attrelid = class.oid
             WHERE (namespace.nspname || '.' || class.relname) = ANY($1::text[])
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
             ORDER BY namespace.nspname, class.relname, attribute.attnum`,
      [AUDITED_TABLES],
    );
    const metadata = new Map<string, RestoreTable>();
    for (const row of result.rows) {
      const table: RestoreTable = metadata.get(row.table_name) || {
        columns: [],
        primary: [],
      };
      table.columns.push({
        name: row.column_name,
        type: row.column_type,
        notNull: row.not_null,
      });
      if (row.is_primary) table.primary.push(row.column_name);
      metadata.set(row.table_name, table);
    }
    return metadata;
  }

  async restoreRevision(rawRevisionId: unknown) {
    this.assertEnabled();
    const targetRevisionId = Number(rawRevisionId);
    if (!Number.isSafeInteger(targetRevisionId) || targetRevisionId <= 0) {
      throw new PostgresPayloadError("revisionId must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const target = await client.query(
        "SELECT id FROM system.revisions WHERE id = $1 FOR SHARE",
        [targetRevisionId],
      );
      if (target.rowCount === 0)
        throw new PostgresPayloadError("The requested revision does not exist");
      const metaResult = await client.query<{ revision: number | string }>(
        "SELECT revision FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE",
      );
      const nextStorageRevision = Number(metaResult.rows[0].revision) + 1;
      const initializedResult = await client.query<{
        database_initialized: boolean | null;
      }>(
        `SELECT database_initialized
                 FROM system.revisions
                 WHERE id <= $1 AND database_initialized IS NOT NULL
                 ORDER BY id DESC LIMIT 1`,
        [targetRevisionId],
      );
      const databaseInitialized =
        initializedResult.rows[0]?.database_initialized ?? false;
      const restoreRevisionId = await beginAuditRevision(client, {
        storageRevision: nextStorageRevision,
        databaseInitialized,
        scope: "restore",
        action: "restore",
        restoredFrom: targetRevisionId,
      });
      const auditResult = await client.query<AuditLogEntryRow>(
        `SELECT sequence, table_name, operation, before_row, after_row
                 FROM system.audit_log
                 WHERE revision_id > $1 AND revision_id < $2
                 ORDER BY sequence DESC`,
        [targetRevisionId, restoreRevisionId],
      );
      const metadata = await this.getRestoreMetadata(client);
      for (const event of auditResult.rows) {
        const table = metadata.get(event.table_name);
        if (!table || table.primary.length === 0) {
          throw new Error(
            `Cannot restore unknown or keyless audit table: ${event.table_name}`,
          );
        }
        const quotedTable = assertSqlIdentifier(event.table_name);
        if (event.operation === "INSERT") {
          const source = isSqlRow(event.after_row) ? event.after_row : {};
          const where = table.primary
            .map((column, index) => `"${column}" = $${index + 1}`)
            .join(" AND ");
          await client.query(
            `DELETE FROM ${quotedTable} WHERE ${where}`,
            table.primary.map((column) => source[column]),
          );
          continue;
        }
        const source = isSqlRow(event.before_row) ? event.before_row : {};
        const columns = table.columns.map((column) => column.name);
        const values = table.columns.map((column): SqlParameter => {
          const value = source[column.name];
          if (column.type !== "jsonb") return value;
          if (value === null && !column.notNull) return null;
          return JSON.stringify(value);
        });
        const placeholders = table.columns
          .map((column, index) => `$${index + 1}::${column.type}`)
          .join(", ");
        const updateColumns = columns.filter(
          (column) => !table.primary.includes(column),
        );
        const conflictAction =
          updateColumns.length === 0
            ? "DO NOTHING"
            : `DO UPDATE SET ${updateColumns
                .map((column) => `"${column}" = EXCLUDED."${column}"`)
                .join(", ")}`;
        await client.query(
          `INSERT INTO ${quotedTable} (${columns.map((c) => `"${c}"`).join(", ")})
                     VALUES (${placeholders})
                     ON CONFLICT (${table.primary.map((c) => `"${c}"`).join(", ")}) ${conflictAction}`,
          values,
        );
      }
      await client.query(
        `UPDATE system.storage_meta
                 SET revision = $1, initialized = $2, updated_at = NOW()
                 WHERE singleton = TRUE`,
        [nextStorageRevision, databaseInitialized],
      );
      await client.query("COMMIT");
      this.pluginsCache = null;
      this.pluginCustomStorageCache = null;
      this.invalidateBootstrapCache();
      return {
        revisionId: restoreRevisionId,
        restoredFromRevisionId: targetRevisionId,
        revision: nextStorageRevision,
        changed: auditResult.rowCount,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadColdStorage(key: unknown) {
    this.assertEnabled();
    const normalizedKey = normalizeColdStorageKey(key);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const archiveResult = await client.query<ColdArchiveRow>(
        "SELECT * FROM cold.archives WHERE id = $1::uuid",
        [normalizedKey],
      );
      const archive = archiveResult.rows[0];
      if (!archive) {
        await client.query("COMMIT");
        return null;
      }
      const tableNames: readonly ColdTableName[] = [
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
      await client.query(`SELECT set_config('risu.archive_id', $1, TRUE)`, [
        normalizedKey,
      ]);
      const loaded = await queryStatementResults(
        client,
        tableNames
          .map(
            (table) =>
              `SELECT * FROM ${assertSqlIdentifier(table)}
                 WHERE archive_id = current_setting('risu.archive_id')::uuid ORDER BY 1, 2, 3`,
          )
          .join(";\n"),
      );
      // Each statement comes from `tableNames` in order, so the positional
      // results line up with the declared per-table row shapes.
      const rows = Object.fromEntries(
        tableNames.map((table, index) => [table, loaded[index].rows]),
      ) as ColdTableRows;
      let data: unknown;
      if (archive.kind === "legacy") {
        const legacy = rows["cold.archive_attributes"].find(
          (item) => item.key === "legacy",
        );
        data = legacy ? decodePostgresJsonValue(legacy.value) : [];
      } else {
        const presence = (
          entityType: ColdFieldPresenceRow["entity_type"],
          chatPosition: number,
          entityPosition: number,
        ): Set<unknown> =>
          new Set<unknown>(
            rows["cold.field_presence"]
              .filter(
                (item) =>
                  item.entity_type === entityType &&
                  item.chat_position === chatPosition &&
                  item.entity_position === entityPosition,
              )
              .map((item) => item.field_name),
          );
        const retainPresentFields = <TValue extends unknown>(
          value: TValue,
          fields: ReadonlySet<unknown>,
        ): TValue => {
          if (fields.size === 0) return value;
          if (!isSqlRow(value)) return value;
          for (const field of Object.keys(value))
            if (!fields.has(field)) delete value[field];
          return value;
        };
        const chatAttributes = groupRows(
          rows["cold.chat_attributes"],
          "chat_position",
        );
        const chatSuggestions = groupRows(
          rows["cold.chat_suggestions"],
          "chat_position",
        );
        const chatModules = groupRows(
          rows["cold.chat_modules"],
          "chat_position",
        );
        const chatScriptState = groupRows(
          rows["cold.chat_script_state"],
          "chat_position",
        );
        const chatBookmarks = groupRows(
          rows["cold.chat_bookmarks"],
          "chat_position",
        );
        const chatMemory = groupRows(rows["cold.chat_memory"], "chat_position");
        const chatLore = groupRows(
          rows["cold.chat_lore_entries"],
          "chat_position",
        );
        const messagesByPosition = groupRows(
          rows["cold.messages"],
          "chat_position",
        );
        const messageKey = (chatPosition: number, messagePosition: number) =>
          `${chatPosition}\0${messagePosition}`;
        /** Group cold message relations by their chat and message positions. */
        const groupColdMessages = <
          TRow extends { chat_position: number; message_position: number },
        >(
          items: readonly TRow[],
        ): Map<string, TRow[]> => {
          const grouped = new Map<string, TRow[]>();
          for (const item of items) {
            const key = messageKey(item.chat_position, item.message_position);
            const value = grouped.get(key);
            if (value) value.push(item);
            else grouped.set(key, [item]);
          }
          return grouped;
        };
        const messageAttributes = groupColdMessages(
          rows["cold.message_attributes"],
        );
        const messageGenerations = new Map<
          string,
          ColdMessageRowOf<MessageGenerationRow>
        >(
          rows["cold.message_generation"].map((item) => [
            messageKey(item.chat_position, item.message_position),
            item,
          ]),
        );
        const messagePromptInfos = new Map<
          string,
          ColdMessageRowOf<MessagePromptInfoRow>
        >(
          rows["cold.message_prompt_info"].map((item) => [
            messageKey(item.chat_position, item.message_position),
            item,
          ]),
        );
        const messagePromptToggles = groupColdMessages(
          rows["cold.message_prompt_toggles"],
        );
        const messagePromptItems = groupColdMessages(
          rows["cold.message_prompt_items"],
        );
        const rebuiltChats = rows["cold.chats"].map((chatRow) => {
          const messages = (messagesByPosition.get(chatRow.position) || []).map(
            (messageRow) => {
              const relationKey = messageKey(
                messageRow.chat_position,
                messageRow.position,
              );
              return retainPresentFields(
                rebuildMessage(
                  {
                    ...messageRow,
                    id:
                      messageRow.original_message_id ||
                      `cold-message-${messageRow.position}`,
                  },
                  {
                    attributes: messageAttributes.get(relationKey),
                    generation: messageGenerations.get(relationKey),
                    promptInfo: messagePromptInfos.get(relationKey),
                    promptToggles: messagePromptToggles.get(relationKey),
                    promptItems: messagePromptItems.get(relationKey),
                  },
                ),
                presence(
                  "message",
                  messageRow.chat_position,
                  messageRow.position,
                ),
              );
            },
          );
          return retainPresentFields(
            rebuildChat(
              {
                ...chatRow,
                id: chatRow.original_chat_id || `cold-chat-${chatRow.position}`,
              },
              {
                attributes: chatAttributes.get(chatRow.position),
                suggestions: chatSuggestions.get(chatRow.position),
                modules: chatModules.get(chatRow.position),
                scriptState: chatScriptState.get(chatRow.position),
                bookmarks: chatBookmarks.get(chatRow.position),
                memory: chatMemory.get(chatRow.position),
                lore: chatLore.get(chatRow.position),
                messages,
              },
            ),
            presence("chat", chatRow.position, -1),
          );
        });
        if (archive.kind === "chat") {
          const chat = rebuiltChats[0] || { message: [] };
          data = chat;
        } else {
          const characterRow: SqlStorageRow = {
            id: archive.owner_character_id || normalizedKey,
          };
          for (const [key, value] of Object.entries(archive)) {
            if (key.startsWith("character_"))
              characterRow[key.slice("character_".length)] = value;
          }
          characterRow.kind = archive.character_kind || "character";
          data = {
            character: retainPresentFields(
              rebuildCharacter(characterRow, {
                attributes: rows["cold.archive_attributes"].filter(
                  (item) => item.key !== "legacy",
                ),
                tags: rows["cold.character_tags"],
                greetings: rows["cold.character_greetings"],
                biases: rows["cold.character_biases"],
                emotions: rows["cold.character_emotions"],
                modules: rows["cold.character_modules"],
                groupMembers: rows["cold.group_members"],
                chatFolders: rows["cold.chat_folders"],
                scripts: rows["cold.character_scripts"],
                sdData: rows["cold.character_sd_data"],
                assets: rows["cold.character_assets"],
                lore: rows["cold.character_lore_entries"],
                chats: rebuiltChats,
              }),
              presence("character", -1, -1),
            ),
          };
        }
      }
      await client.query("COMMIT");
      return {
        key: normalizedKey,
        kind: archive.kind,
        revision: Number(archive.revision),
        updated_at: archive.updated_at,
        data,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listColdStorage(): Promise<ColdStorageSummaryRow[]> {
    this.assertEnabled();
    const result = await this.pool.query<ColdStorageSummaryRow>(
      `SELECT id::text AS key, kind, updated_at
             FROM cold.archives
             ORDER BY updated_at DESC, id`,
    );
    return result.rows;
  }

  async upsertColdStorage(key: unknown, value: unknown) {
    this.assertEnabled();
    const normalizedKey = normalizeColdStorageKey(key);
    const splitValue = splitColdStorageValue(value);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await beginAuditRevision(client, {
        scope: "cold-storage",
        action: "upsert",
      });
      const result = await this.upsertColdStorageWithClient(
        client,
        normalizedKey,
        splitValue,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertColdStorageWithClient(
    client: PgClient,
    key: string,
    splitValue: SplitColdStorageRows,
  ) {
    let character: CharacterSplit | null = null;
    if (splitValue.kind === "character") {
      const characterData = splitValue.data.character;
      character = splitCharacter({
        id: characterData.chaId || key,
        position: 0,
        data: characterData,
      });
    }
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
      id: key,
      kind: splitValue.kind,
      owner_character_id: character?.core.id || null,
    };
    if (character) {
      for (const [column, value] of Object.entries(character.core)) {
        if (!["id", "position"].includes(column))
          archive[`character_${column}`] = value;
      }
    }
    await bulkInsert(
      client,
      "cold.archives",
      archiveColumns,
      [
        "uuid",
        "text",
        ...Array(17).fill("text"),
        "integer",
        "integer",
        "boolean",
        "boolean",
        ...Array(7).fill("text"),
        "bigint",
        "bigint",
        "bigint",
        "bigint",
      ],
      [archive],
      `ON CONFLICT (id) DO UPDATE SET ${archiveColumns
        .slice(1)
        .map((column) => `"${column}" = EXCLUDED."${column}"`)
        .join(", ")},
                revision = cold.archives.revision + 1, updated_at = NOW()`,
    );

    const childTables = [
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
    ];
    for (const table of childTables) {
      await client.query(
        `DELETE FROM ${assertSqlIdentifier(table)} WHERE archive_id = $1::uuid`,
        [key],
      );
    }

    let archiveAttributes: (AttributeRow & { archive_id: string })[] = [];
    if (splitValue.kind === "legacy") {
      archiveAttributes = [
        {
          archive_id: key,
          key: "legacy",
          value: encodePostgresJsonValue(splitValue.data),
        },
      ];
    } else if (character) {
      archiveAttributes = character.attributes.map((item) => ({
        ...item,
        archive_id: key,
      }));
    }
    await bulkInsert(
      client,
      "cold.archive_attributes",
      ["archive_id", "key", "value"],
      ["uuid", "text", "jsonb"],
      archiveAttributes,
    );
    const presenceRows = [
      ...(splitValue.characterFields || []).map((fieldName) => ({
        archive_id: key,
        entity_type: "character",
        chat_position: -1,
        entity_position: -1,
        field_name: fieldName,
      })),
      ...splitValue.chats.flatMap((chat) =>
        (chat.fields || []).map((fieldName) => ({
          archive_id: key,
          entity_type: "chat",
          chat_position: chat.position,
          entity_position: -1,
          field_name: fieldName,
        })),
      ),
      ...splitValue.messages.flatMap((message) =>
        (message.fields || []).map((fieldName) => ({
          archive_id: key,
          entity_type: "message",
          chat_position: message.chatPosition,
          entity_position: message.position,
          field_name: fieldName,
        })),
      ),
    ];
    await bulkInsert(
      client,
      "cold.field_presence",
      [
        "archive_id",
        "entity_type",
        "chat_position",
        "entity_position",
        "field_name",
      ],
      ["uuid", "text", "integer", "integer", "text"],
      presenceRows,
    );
    const mapCharacterRows = (name: CharacterRelationName): SqlStorageRow[] =>
      [...(character?.[name] || [])].map((item) => {
        const mapped: SqlStorageRow = { ...item, archive_id: key };
        delete mapped.character_id;
        delete mapped.group_id;
        return mapped;
      });
    await bulkInsert(
      client,
      "cold.character_tags",
      ["archive_id", "position", "tag"],
      ["uuid", "integer", "text"],
      mapCharacterRows("tags"),
    );
    await bulkInsert(
      client,
      "cold.character_greetings",
      ["archive_id", "greeting_type", "position", "content"],
      ["uuid", "text", "integer", "text"],
      mapCharacterRows("greetings"),
    );
    await bulkInsert(
      client,
      "cold.character_biases",
      ["archive_id", "position", "phrase", "bias"],
      ["uuid", "integer", "text", "double precision"],
      mapCharacterRows("biases"),
    );
    await bulkInsert(
      client,
      "cold.character_emotions",
      ["archive_id", "position", "emotion", "asset"],
      ["uuid", "integer", "text", "text"],
      mapCharacterRows("emotions"),
    );
    await bulkInsert(
      client,
      "cold.character_modules",
      ["archive_id", "position", "module_id"],
      ["uuid", "integer", "text"],
      mapCharacterRows("modules"),
    );
    await bulkInsert(
      client,
      "cold.group_members",
      ["archive_id", "position", "character_id", "talk_weight", "active"],
      ["uuid", "integer", "text", "double precision", "boolean"],
      mapCharacterRows("groupMembers"),
    );
    await bulkInsert(
      client,
      "cold.chat_folders",
      ["archive_id", "position", "folder_id", "name", "color", "folded"],
      ["uuid", "integer", "text", "text", "text", "boolean"],
      mapCharacterRows("chatFolders"),
    );
    await bulkInsert(
      client,
      "cold.character_scripts",
      [
        "archive_id",
        "script_kind",
        "position",
        "comment",
        "input_text",
        "output_text",
        "script_type",
        "flag",
        "able_flag",
        "trigger_payload",
      ],
      [
        "uuid",
        "text",
        "integer",
        "text",
        "text",
        "text",
        "text",
        "text",
        "boolean",
        "jsonb",
      ],
      mapCharacterRows("scripts"),
    );
    await bulkInsert(
      client,
      "cold.character_sd_data",
      ["archive_id", "position", "key", "value"],
      ["uuid", "integer", "text", "text"],
      mapCharacterRows("sdData"),
    );
    await bulkInsert(
      client,
      "cold.character_assets",
      [
        "archive_id",
        "position",
        "asset_source",
        "asset_type",
        "uri",
        "name",
        "extension",
        "extra_value",
      ],
      ["uuid", "integer", "text", "text", "text", "text", "text", "text"],
      mapCharacterRows("assets"),
    );
    await bulkInsert(
      client,
      "cold.character_lore_entries",
      [
        "archive_id",
        "position",
        "lore_id",
        "primary_key",
        "secondary_key",
        "insert_order",
        "comment",
        "content",
        "mode",
        "always_active",
        "selective",
        "case_sensitive",
        "activation_percent",
        "use_regex",
        "book_version",
        "folder",
        "cache_payload",
      ],
      [
        "uuid",
        "integer",
        "text",
        "text",
        "text",
        "integer",
        "text",
        "text",
        "text",
        "boolean",
        "boolean",
        "boolean",
        "double precision",
        "boolean",
        "integer",
        "text",
        "jsonb",
      ],
      mapCharacterRows("lore"),
    );

    const chatInputs =
      splitValue.kind === "chat"
        ? [{ position: 0, data: splitValue.data }]
        : splitValue.chats;
    const splitChats: ChatSplit[] = chatInputs.map((chat) =>
      splitChat({
        id: chat.data.id || `cold-chat-${chat.position}`,
        characterId: character?.core.id || "",
        position: chat.position,
        data: chat.data,
      }),
    );
    const coldChats = splitChats.map((item, index) => ({
      archive_id: key,
      position: item.core.position,
      original_chat_id: chatInputs[index].data.id ?? null,
      name: item.core.name,
      note: item.core.note,
      sd_data: item.core.sd_data,
      supa_memory_data: item.core.supa_memory_data,
      last_memory: item.core.last_memory,
      is_streaming: item.core.is_streaming,
      streaming_optimization_mode: item.core.streaming_optimization_mode,
      bound_persona_id: item.core.bound_persona_id,
      first_message_index: item.core.first_message_index,
      folder_id: item.core.folder_id,
      last_message_time: item.core.last_message_time,
    }));
    await bulkInsert(
      client,
      "cold.chats",
      [
        "archive_id",
        "position",
        "original_chat_id",
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
        "last_message_time",
      ],
      [
        "uuid",
        "integer",
        "text",
        "text",
        "text",
        "text",
        "text",
        "text",
        "boolean",
        "text",
        "text",
        "integer",
        "text",
        "bigint",
      ],
      coldChats,
    );
    const mapChatRows = (name: ChatRelationName): SqlStorageRow[] =>
      splitChats.flatMap((item) =>
        [...item[name]].map((row) => {
          const mapped: SqlStorageRow = {
            ...row,
            archive_id: key,
            chat_position: item.core.position,
          };
          delete mapped.chat_id;
          return mapped;
        }),
      );
    await bulkInsert(
      client,
      "cold.chat_attributes",
      ["archive_id", "chat_position", "key", "value"],
      ["uuid", "integer", "text", "jsonb"],
      splitChats.flatMap((item) =>
        item.attributes.map((row) => ({
          ...row,
          archive_id: key,
          chat_position: item.core.position,
        })),
      ),
    );
    await bulkInsert(
      client,
      "cold.chat_suggestions",
      ["archive_id", "chat_position", "position", "content"],
      ["uuid", "integer", "integer", "text"],
      mapChatRows("suggestions"),
    );
    await bulkInsert(
      client,
      "cold.chat_modules",
      ["archive_id", "chat_position", "position", "module_id"],
      ["uuid", "integer", "integer", "text"],
      mapChatRows("modules"),
    );
    await bulkInsert(
      client,
      "cold.chat_script_state",
      [
        "archive_id",
        "chat_position",
        "key",
        "value_type",
        "text_value",
        "number_value",
        "boolean_value",
      ],
      [
        "uuid",
        "integer",
        "text",
        "text",
        "text",
        "double precision",
        "boolean",
      ],
      mapChatRows("scriptState"),
    );
    await bulkInsert(
      client,
      "cold.chat_bookmarks",
      ["archive_id", "chat_position", "position", "message_id", "name"],
      ["uuid", "integer", "integer", "text", "text"],
      mapChatRows("bookmarks"),
    );
    await bulkInsert(
      client,
      "cold.chat_memory",
      ["archive_id", "chat_position", "memory_type", "payload"],
      ["uuid", "integer", "text", "jsonb"],
      mapChatRows("memory"),
    );
    await bulkInsert(
      client,
      "cold.chat_lore_entries",
      [
        "archive_id",
        "chat_position",
        "position",
        "lore_id",
        "primary_key",
        "secondary_key",
        "insert_order",
        "comment",
        "content",
        "mode",
        "always_active",
        "selective",
        "case_sensitive",
        "activation_percent",
        "use_regex",
        "book_version",
        "folder",
        "cache_payload",
      ],
      [
        "uuid",
        "integer",
        "integer",
        "text",
        "text",
        "text",
        "integer",
        "text",
        "text",
        "text",
        "boolean",
        "boolean",
        "boolean",
        "double precision",
        "boolean",
        "integer",
        "text",
        "jsonb",
      ],
      mapChatRows("lore"),
    );

    const splitMessages: MessageSplit[] = splitValue.messages.map((message) =>
      splitMessage({
        id: message.data.chatId || `cold-message-${message.position}`,
        chatId: `cold-chat-${message.chatPosition}`,
        position: message.position,
        data: message.data,
      }),
    );
    const coldMessages = splitMessages.map((item, index) => ({
      archive_id: key,
      chat_position: splitValue.messages[index].chatPosition,
      position: item.core.position,
      original_message_id: splitValue.messages[index].data.chatId ?? null,
      role: item.core.role,
      content_text: item.core.content_text,
      content_binary: item.core.content_binary,
      saying_character_id: item.core.saying_character_id,
      sent_time: item.core.sent_time,
      sender_name: item.core.sender_name,
      other_user: item.core.other_user,
      disabled_scope: item.core.disabled_scope,
      is_comment: item.core.is_comment,
    }));
    await bulkInsert(
      client,
      "cold.messages",
      [
        "archive_id",
        "chat_position",
        "position",
        "original_message_id",
        "role",
        "content_text",
        "content_binary",
        "saying_character_id",
        "sent_time",
        "sender_name",
        "other_user",
        "disabled_scope",
        "is_comment",
      ],
      [
        "uuid",
        "integer",
        "integer",
        "text",
        "text",
        "text",
        "bytea",
        "text",
        "bigint",
        "text",
        "boolean",
        "text",
        "boolean",
      ],
      coldMessages,
    );
    const messageOwner = (item: MessageSplit, index: number) => ({
      archive_id: key,
      chat_position: splitValue.messages[index].chatPosition,
      message_position: item.core.position,
    });
    await bulkInsert(
      client,
      "cold.message_attributes",
      ["archive_id", "chat_position", "message_position", "key", "value"],
      ["uuid", "integer", "integer", "text", "jsonb"],
      splitMessages.flatMap((item, index) =>
        item.attributes.map((row) => ({
          ...row,
          ...messageOwner(item, index),
        })),
      ),
    );
    await bulkInsert(
      client,
      "cold.message_generation",
      [
        "archive_id",
        "chat_position",
        "message_position",
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
      [
        "uuid",
        "integer",
        "integer",
        "text",
        "text",
        "integer",
        "integer",
        "integer",
        "double precision",
        "double precision",
        "double precision",
        "double precision",
      ],
      splitMessages.flatMap((item, index) =>
        item.generation
          ? [{ ...item.generation, ...messageOwner(item, index) }]
          : [],
      ),
    );
    await bulkInsert(
      client,
      "cold.message_prompt_info",
      ["archive_id", "chat_position", "message_position", "prompt_name"],
      ["uuid", "integer", "integer", "text"],
      splitMessages.flatMap((item, index) =>
        item.prompt
          ? [{ ...item.prompt.info, ...messageOwner(item, index) }]
          : [],
      ),
    );
    await bulkInsert(
      client,
      "cold.message_prompt_toggles",
      [
        "archive_id",
        "chat_position",
        "message_position",
        "position",
        "toggle_key",
        "toggle_value",
      ],
      ["uuid", "integer", "integer", "integer", "text", "text"],
      splitMessages.flatMap((item, index) =>
        (item.prompt?.toggles || []).map((row) => ({
          ...row,
          ...messageOwner(item, index),
        })),
      ),
    );
    await bulkInsert(
      client,
      "cold.message_prompt_items",
      [
        "archive_id",
        "chat_position",
        "message_position",
        "position",
        "payload",
      ],
      ["uuid", "integer", "integer", "integer", "jsonb"],
      splitMessages.flatMap((item, index) =>
        (item.prompt?.items || []).map((row) => ({
          ...row,
          ...messageOwner(item, index),
        })),
      ),
    );
    const archiveResult = await client.query<ColdStorageSummaryRow>(
      "SELECT id::text AS key, kind, revision, updated_at FROM cold.archives WHERE id = $1::uuid",
      [key],
    );
    return archiveResult.rows[0];
  }

  async deleteColdStorage(rawKeys: unknown) {
    this.assertEnabled();
    const keys = validateColdStorageKeys(rawKeys);
    if (keys.length === 0) {
      return { deleted: 0 };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await beginAuditRevision(client, {
        scope: "cold-storage",
        action: "delete",
      });
      const result = await client.query(
        "DELETE FROM cold.archives WHERE id = ANY($1::uuid[])",
        [keys],
      );
      await client.query("COMMIT");
      return { deleted: result.rowCount };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneColdStorage(rawRetainedKeys: unknown) {
    this.assertEnabled();
    const retainedKeys = validateColdStorageKeys(
      rawRetainedKeys,
      "retainedKeys",
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await beginAuditRevision(client, {
        scope: "cold-storage",
        action: "prune",
      });
      const result = await client.query(
        "DELETE FROM cold.archives WHERE NOT (id = ANY($1::uuid[]))",
        [retainedKeys],
      );
      await client.query("COMMIT");
      return { deleted: result.rowCount };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async migrateLegacyColdStorage(savePath: string) {
    this.assertEnabled();
    const candidates = await findLegacyColdStorageFiles(savePath);
    if (candidates.length === 0) {
      return { migrated: 0, skipped: 0 };
    }

    const importedResult = await this.pool.query<{ key: string }>(
      "SELECT id::text AS key FROM cold.legacy_imports WHERE id = ANY($1::uuid[])",
      [candidates.map((candidate) => candidate.key)],
    );
    const imported = new Set<string>(importedResult.rows.map((row) => row.key));
    const pending = candidates.filter(
      (candidate) => !imported.has(candidate.key),
    );
    if (pending.length === 0) {
      return { migrated: 0, skipped: 0 };
    }

    const client = await this.pool.connect();
    let migrated = 0;
    let skipped = 0;
    try {
      await client.query("BEGIN");
      await beginAuditRevision(client, {
        scope: "cold-storage",
        action: "legacy-import",
      });
      for (const candidate of pending) {
        await client.query("SAVEPOINT cold_storage_item");
        try {
          const compressed = await fs.readFile(
            path.join(savePath, candidate.filename),
          );
          const decoded = JSON.parse(
            (await unzipAsync(compressed)).toString("utf8"),
          );
          const splitValue = splitColdStorageValue(decoded);
          const existing = await client.query(
            "SELECT 1 FROM cold.archives WHERE id = $1::uuid",
            [candidate.key],
          );
          if (existing.rowCount === 0) {
            await this.upsertColdStorageWithClient(
              client,
              candidate.key,
              splitValue,
            );
          }
          await client.query(
            `INSERT INTO cold.legacy_imports (id)
                         VALUES ($1::uuid)
                         ON CONFLICT (id) DO NOTHING`,
            [candidate.key],
          );
          await client.query("RELEASE SAVEPOINT cold_storage_item");
          migrated += 1;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT cold_storage_item");
          await client.query("RELEASE SAVEPOINT cold_storage_item");
          skipped += 1;
          console.error(
            `[PostgreSQL] Could not migrate legacy cold storage ${candidate.key}:`,
            error.message,
          );
        }
      }
      await client.query("COMMIT");
      return { migrated, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async exportColdStorageToLegacy(savePath: string) {
    this.assertEnabled();
    await fs.mkdir(savePath, { recursive: true });
    const items = await this.listColdStorage();
    const exportedKeys = new Set<string>();
    let exported = 0;
    for (const item of items) {
      const loaded = await this.loadColdStorage(item.key);
      if (!loaded) {
        throw new Error(
          `Cold storage item disappeared during export: ${item.key}`,
        );
      }
      const logicalPath = `coldstorage/${item.key}`;
      const filename = Buffer.from(logicalPath, "utf8").toString("hex");
      const compressed = await deflateAsync(
        Buffer.from(JSON.stringify(loaded.data), "utf8"),
      );
      const targetPath = path.join(savePath, filename);
      const temporaryPath = `${targetPath}.postgres-export.tmp`;
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
        "__postgres_cold_storage_rollback",
      );
      await fs.mkdir(rollbackPath, { recursive: true, mode: 0o700 });
      const suffix = `${Date.now()}-${process.pid}`;
      for (let index = 0; index < staleFiles.length; index++) {
        const candidate = staleFiles[index];
        await fs.rename(
          path.join(savePath, candidate.filename),
          path.join(rollbackPath, `${candidate.filename}.${suffix}-${index}`),
        );
      }
    }
    return { exported, archived: staleFiles.length };
  }

  async loadStartupData() {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const metaResult = await client.query<StorageMetaRow>(
        "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE",
      );
      const revision = Number(metaResult.rows[0].revision);
      const initialized = Boolean(metaResult.rows[0].initialized);
      if (!initialized) {
        await client.query("COMMIT");
        return {
          status: "empty",
          revision,
          settings: {},
          characters: [],
          deferredSettingKeys: [],
        };
      }
      const queries = [
        `SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key NOT IN (${STARTUP_EXCLUDED_KEYS_SQL_LITERAL}) ORDER BY key`,
        `SELECT * FROM system.setting_values WHERE setting_key NOT IN (${STARTUP_EXCLUDED_KEYS_SQL_LITERAL}) ORDER BY setting_key, node_id`,
        "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time FROM character.characters ORDER BY position, id",
      ];
      const [settingsResult, settingValueResult, characterResult] =
        await queryStatementResults(client, queries.join(";\n"));
      const settings = rebuildSettingRows(
        asRows<SettingScalarRow>(settingsResult.rows),
        asRows<SettingValueRow>(settingValueResult.rows),
      );
      const characters = mapStartupCharacters(
        asRows<CharacterCoreRow>(characterResult.rows),
        (value) => (value == null ? undefined : Number(value)),
      );
      await client.query("COMMIT");
      return {
        status: "ready",
        revision,
        settings,
        characters,
        deferredSettingKeys: [...DEFERRED_STARTUP_SETTING_KEYS],
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listGlobalAuthorNotes() {
    return withAuthorNoteDatabase(
      this,
      "postgres",
      authorNoteSql.listAuthorNotes,
    );
  }
  async getGlobalAuthorNote(id: string) {
    return withAuthorNoteDatabase(
      this,
      "postgres",
      (
        db: import("../../../../packages/protocol/src/authorNoteSql.ts").AuthorNoteSql,
      ) => authorNoteSql.getAuthorNote(db, id),
    );
  }
  async readGlobalAuthorNote(id: string) {
    return withAuthorNoteDatabase(
      this,
      "postgres",
      (
        db: import("../../../../packages/protocol/src/authorNoteSql.ts").AuthorNoteSql,
      ) => authorNoteSql.readAuthorNote(db, id),
    );
  }
  async getGlobalAuthorNoteScriptWrite() {
    return withAuthorNoteDatabase(
      this,
      "postgres",
      authorNoteSql.allowAuthorNoteScriptWrite,
    );
  }

  async exportDatabaseSnapshot() {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await exportDatabaseSnapshotWith(
        new PostgresDialect(client),
        {
          readMeta: async () => {
            const metaResult = await client.query<StorageMetaRow>(
              "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE",
            );
            return {
              revision: Number(metaResult.rows[0].revision),
              initialized: Boolean(metaResult.rows[0].initialized),
            };
          },
          readAuthorNotes: () =>
            authorNoteSql.exportAuthorNotes(
              authorNoteDatabase("postgres", client),
            ),
          decodeScript: decodePostgresScript,
        },
      );
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadCharacter(characterId: unknown) {
    this.assertEnabled();
    assertId(characterId, "characterId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const charRes = await client.query<CharacterCoreRow>(
        "SELECT * FROM character.characters WHERE id = $1",
        [characterId],
      );
      if (charRes.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const attributesRes = await client.query<CharacterAttributeRow>(
        "SELECT * FROM character.attributes WHERE character_id = $1 ORDER BY key",
        [characterId],
      );
      const tagsRes = await client.query<CharacterTagRow>(
        "SELECT * FROM character.tags WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const greetingsRes = await client.query<CharacterGreetingRow>(
        "SELECT * FROM character.greetings WHERE character_id = $1 ORDER BY greeting_type, position",
        [characterId],
      );
      const biasesRes = await client.query<CharacterBiasRow>(
        "SELECT * FROM character.biases WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const emotionsRes = await client.query<CharacterEmotionRow>(
        "SELECT * FROM character.emotions WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const modulesRes = await client.query<CharacterModuleRow>(
        "SELECT * FROM character.modules WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const groupMembersRes = await client.query<CharacterGroupMemberRow>(
        "SELECT * FROM character.group_members WHERE group_id = $1 ORDER BY position",
        [characterId],
      );
      const chatFoldersRes = await client.query<CharacterChatFolderRow>(
        "SELECT * FROM character.chat_folders WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const scriptsRes = await client.query<CharacterScriptRow>(
        "SELECT * FROM character.scripts WHERE character_id = $1 ORDER BY script_kind, position",
        [characterId],
      );
      const sdDataRes = await client.query<CharacterSdRow>(
        "SELECT * FROM character.sd_data WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const assetsRes = await client.query<CharacterAssetRow>(
        "SELECT * FROM character.assets WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const loreRes = await client.query<CharacterLoreRow>(
        "SELECT * FROM character.lore_entries WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const chatsRes = await client.query<ChatShellRow>(
        "SELECT id, name, note, folder_id, last_message_time FROM chat.chats WHERE character_id = $1 ORDER BY position, id",
        [characterId],
      );

      const characterRelations = {
        attributes: attributesRes.rows,
        tags: tagsRes.rows,
        greetings: greetingsRes.rows,
        biases: biasesRes.rows,
        emotions: emotionsRes.rows,
        modules: modulesRes.rows,
        groupMembers: groupMembersRes.rows,
        chatFolders: chatFoldersRes.rows,
        scripts: scriptsRes.rows,
        sdData: sdDataRes.rows,
        assets: assetsRes.rows,
        lore: loreRes.rows,
      };

      const character = rebuildCharacter(charRes.rows[0], characterRelations);
      character.chats = chatsRes.rows.map(buildChatShell);
      character.detailsLoaded = true;

      await client.query("COMMIT");
      return character;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Asset-bearing fields only (image, customBackground, gptSoVitsConfig, vits,
  // emotionImages, additionalAssets, ccAssets). The storage explorer's orphan
  // analysis needs these without hydrating lore, scripts or chats.
  async loadCharacterAssetFields(characterId: unknown) {
    this.assertEnabled();
    assertId(characterId, "characterId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const charRes = await client.query<{ image: string | null }>(
        "SELECT image FROM character.characters WHERE id = $1",
        [characterId],
      );
      if (charRes.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const attributesRes = await client.query<CharacterAttributeRow>(
        "SELECT * FROM character.attributes WHERE character_id = $1 ORDER BY key",
        [characterId],
      );
      const emotionsRes = await client.query<CharacterEmotionRow>(
        "SELECT * FROM character.emotions WHERE character_id = $1 ORDER BY position",
        [characterId],
      );
      const assetsRes = await client.query<CharacterAssetRow>(
        "SELECT * FROM character.assets WHERE character_id = $1 ORDER BY position",
        [characterId],
      );

      const assets: Record<string, unknown> = {};
      const core = charRes.rows[0];
      if (core.image !== null && core.image !== undefined)
        assets.image = core.image;
      for (const row of attributesRes.rows) {
        assets[row.key] = decodePostgresJsonValue(row.value);
      }
      if (emotionsRes.rows.length) {
        assets.emotionImages = emotionsRes.rows.map((item) => [
          item.emotion,
          item.asset,
        ]);
      }
      const additionalAssets = assetsRes.rows
        .filter((item) => item.asset_source === "additional")
        .map((item) => [item.name, item.uri, item.extension]);
      if (additionalAssets.length) assets.additionalAssets = additionalAssets;
      const ccAssets = assetsRes.rows
        .filter((item) => item.asset_source === "character-card")
        .map((item) => ({
          type: item.asset_type,
          uri: item.uri,
          name: item.name,
          ext: item.extension,
        }));
      if (ccAssets.length) assets.ccAssets = ccAssets;

      await client.query("COMMIT");
      return { assets };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async _loadLinearMessagesForBranchMigration(
    client: PgClient,
    chatId: string,
  ) {
    const dialect = new PostgresDialect(client);
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

  async migrateLegacyBranchState(client: PgClient, chatId: string) {
    return migrateLegacyBranchStateWith(new PostgresDialect(client), chatId, {
      readLegacyState: async () => {
        const legacyRes = await client.query<LegacyBranchStateRow>(
          `SELECT
                (SELECT COUNT(*)::integer FROM chat.branches WHERE chat_id = $1) AS branch_count,
                (SELECT value FROM chat.attributes WHERE chat_id = $1 AND key = 'branchState') AS branch_state`,
          [chatId],
        );
        const legacyRow: Partial<LegacyBranchStateRow> =
          legacyRes.rows[0] ?? {};
        return {
          branchCount: Number(legacyRow.branch_count ?? 0),
          branchState: legacyRow.branch_state,
        };
      },
      readLinearMessages: () =>
        this._loadLinearMessagesForBranchMigration(client, chatId),
      decodeState: decodePostgresJsonValue,
      newId: () => crypto.randomUUID(),
    });
  }

  async ensureChatBranchGraphs(client: PgClient, chatIds: readonly unknown[]) {
    const ids = [
      ...new Set<string>(
        (chatIds || []).filter(
          (chatId): chatId is string => typeof chatId === "string" && !!chatId,
        ),
      ),
    ];
    if (ids.length === 0) return;
    await client.query(
      `INSERT INTO chat.branches
                (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
             SELECT chats.id, chats.id || ':root', NULL, NULL,
                    (SELECT id FROM chat.messages WHERE chat_id = chats.id ORDER BY position DESC, id DESC LIMIT 1),
                    'root', 0
               FROM chat.chats chats
              WHERE chats.id = ANY($1::text[])
                AND NOT EXISTS (
                    SELECT 1 FROM chat.branches existing WHERE existing.chat_id = chats.id
                )
             ON CONFLICT (chat_id, id) DO NOTHING`,
      [ids],
    );
    await client.query(
      `INSERT INTO chat.message_branch_links
                (chat_id, message_id, parent_message_id, origin_branch_id)
             SELECT ordered.chat_id, ordered.id, ordered.parent_message_id, ordered.chat_id || ':root'
               FROM (
                    SELECT messages.chat_id, messages.id,
                           LAG(messages.id) OVER (PARTITION BY messages.chat_id ORDER BY messages.position, messages.id) AS parent_message_id
                      FROM chat.messages messages
                     WHERE messages.chat_id = ANY($1::text[])
                       AND NOT EXISTS (
                           SELECT 1 FROM chat.active_branches active WHERE active.chat_id = messages.chat_id
                       )
                       AND (SELECT COUNT(*) FROM chat.branches branches WHERE branches.chat_id = messages.chat_id) = 1
                       AND EXISTS (
                           SELECT 1 FROM chat.branches root
                            WHERE root.chat_id = messages.chat_id
                              AND root.id = messages.chat_id || ':root'
                       )
               ) ordered
             ON CONFLICT (chat_id, message_id) DO NOTHING`,
      [ids],
    );
    await client.query(
      `INSERT INTO chat.active_branches (chat_id, branch_id)
             SELECT chats.id, chats.id || ':root'
               FROM chat.chats chats
              WHERE chats.id = ANY($1::text[])
                AND (SELECT COUNT(*) FROM chat.branches branches WHERE branches.chat_id = chats.id) = 1
                AND EXISTS (
                    SELECT 1 FROM chat.branches root
                     WHERE root.chat_id = chats.id AND root.id = chats.id || ':root'
                )
             ON CONFLICT (chat_id) DO NOTHING`,
      [ids],
    );
  }

  async ensureChatBranchGraph(
    client: PgClient,
    chatId: string,
  ): Promise<string | null> {
    await this.migrateLegacyBranchState(client, chatId);
    let result = await client.query<{ branch_id: string | null }>(
      "SELECT branch_id FROM chat.active_branches WHERE chat_id = $1",
      [chatId],
    );
    if (result.rows[0]?.branch_id) return result.rows[0].branch_id;
    await this.ensureChatBranchGraphs(client, [chatId]);
    result = await client.query<{ branch_id: string | null }>(
      "SELECT branch_id FROM chat.active_branches WHERE chat_id = $1",
      [chatId],
    );
    return result.rows[0]?.branch_id ?? null;
  }

  async linkIncomingMessagesToActiveBranches(
    client: PgClient,
    splitMessages: readonly MessageSplit[],
  ): Promise<void> {
    if (!splitMessages || splitMessages.length === 0) return;
    const chatIds = splitMessages.map((item) => item.core.chat_id);
    const messageIds = splitMessages.map((item) => item.core.id);
    const positions = splitMessages.map((item) => item.core.position);
    const inserted = await client.query(
      `WITH incoming(chat_id, message_id, position) AS (
                 SELECT * FROM UNNEST($1::text[], $2::text[], $3::integer[])
             ),
             unlinked AS (
                 SELECT incoming.*
                   FROM incoming
                   LEFT JOIN chat.message_branch_links links
                     ON links.chat_id = incoming.chat_id AND links.message_id = incoming.message_id
                  WHERE links.message_id IS NULL
             ),
             ordered AS (
                 SELECT unlinked.*,
                        LAG(message_id) OVER (PARTITION BY chat_id ORDER BY position, message_id) AS previous_incoming_id
                   FROM unlinked
             )
             INSERT INTO chat.message_branch_links
                 (chat_id, message_id, parent_message_id, origin_branch_id)
             SELECT ordered.chat_id,
                    ordered.message_id,
                    COALESCE(ordered.previous_incoming_id, branch.head_message_id),
                    active.branch_id
               FROM ordered
               JOIN chat.active_branches active ON active.chat_id = ordered.chat_id
               JOIN chat.branches branch ON branch.chat_id = active.chat_id AND branch.id = active.branch_id
              ORDER BY ordered.chat_id, ordered.position, ordered.message_id
             ON CONFLICT (chat_id, message_id) DO NOTHING
             RETURNING chat_id, message_id, origin_branch_id`,
      [chatIds, messageIds, positions],
    );
    if (inserted.rows.length === 0) return;
    const positionByKey = new Map<unknown, number>(
      splitMessages.map((item) => [
        `${item.core.chat_id}\0${item.core.id}`,
        item.core.position,
      ]),
    );
    const heads = new Map<string, BranchHead>();
    for (const row of inserted.rows) {
      const key = `${row.chat_id}\0${row.origin_branch_id}`;
      const position =
        positionByKey.get(`${row.chat_id}\0${row.message_id}`) ?? 0;
      const previous = heads.get(key);
      if (!previous || position >= previous.position) {
        heads.set(key, {
          chatId: String(row.chat_id),
          branchId: String(row.origin_branch_id),
          messageId: String(row.message_id),
          position,
        });
      }
    }
    for (const head of heads.values()) {
      await client.query(
        "UPDATE chat.branches SET head_message_id = $3 WHERE chat_id = $1 AND id = $2",
        [head.chatId, head.branchId, head.messageId],
      );
    }
  }

  async detachMessagesFromBranchGraph(
    client: PgClient,
    deletions: readonly MessageDeletion[],
  ): Promise<void> {
    for (const deletion of deletions || []) {
      for (const messageId of deletion.ids || []) {
        await client.query(
          `UPDATE chat.message_branch_links child
                        SET parent_message_id = (
                            SELECT removed.parent_message_id
                              FROM chat.message_branch_links removed
                             WHERE removed.chat_id = $1 AND removed.message_id = $2
                        )
                      WHERE child.chat_id = $1 AND child.parent_message_id = $2`,
          [deletion.chatId, messageId],
        );
        await client.query(
          `UPDATE chat.branches branch
                        SET head_message_id = (
                            SELECT removed.parent_message_id
                              FROM chat.message_branch_links removed
                             WHERE removed.chat_id = $1 AND removed.message_id = $2
                        )
                      WHERE branch.chat_id = $1 AND branch.head_message_id = $2`,
          [deletion.chatId, messageId],
        );
        await client.query(
          "UPDATE chat.branches SET fork_message_id = NULL WHERE chat_id = $1 AND fork_message_id = $2",
          [deletion.chatId, messageId],
        );
        await client.query(
          "DELETE FROM chat.message_branch_links WHERE chat_id = $1 AND message_id = $2",
          [deletion.chatId, messageId],
        );
      }
    }
  }

  async _loadBranchPageWithClient(
    client: PgClient,
    chatId: string,
    branchId: string,
    options: BranchPageOptions = {},
  ) {
    const countRes = await client.query<{ total: number | string }>(
      `WITH RECURSIVE branch_path(message_id) AS (
                 SELECT head_message_id FROM chat.branches WHERE chat_id = $1 AND id = $2
                 UNION ALL
                 SELECT links.parent_message_id
                   FROM branch_path path
                   JOIN chat.message_branch_links links
                     ON links.chat_id = $1 AND links.message_id = path.message_id
                  WHERE links.parent_message_id IS NOT NULL
             )
             SELECT COUNT(message_id)::bigint AS total FROM branch_path`,
      [chatId, branchId],
    );
    const total = Number(countRes.rows[0]?.total ?? 0);
    const rawBefore = options.before;
    const end =
      rawBefore === undefined
        ? total
        : Math.max(0, Math.min(total, Math.floor(Number(rawBefore) || 0)));
    const requestedLimit =
      options.limit === undefined
        ? end
        : Math.max(1, Math.floor(Number(options.limit) || 1));
    const offset = Math.max(0, end - requestedLimit);
    const pageSize = Math.max(0, end - offset);
    if (pageSize === 0) {
      return { messages: [], offset, total, hasMore: offset > 0 };
    }
    const messagesRes = await client.query(
      `WITH RECURSIVE branch_path(message_id, depth) AS (
                 SELECT head_message_id, 0 FROM chat.branches WHERE chat_id = $1 AND id = $2
                 UNION ALL
                 SELECT links.parent_message_id, path.depth + 1
                   FROM branch_path path
                   JOIN chat.message_branch_links links
                     ON links.chat_id = $1 AND links.message_id = path.message_id
                  WHERE links.parent_message_id IS NOT NULL
             )
             SELECT messages.*, branch_path.depth
               FROM branch_path
               JOIN chat.messages messages
                 ON messages.chat_id = $1 AND messages.id = branch_path.message_id
              ORDER BY branch_path.depth DESC
              OFFSET $3 LIMIT $4`,
      [chatId, branchId, offset, pageSize],
    );
    const ids = messagesRes.rows.map((row) => row.id);
    if (ids.length === 0) {
      return { messages: [], offset, total, hasMore: offset > 0 };
    }
    let attributes: MessageAttributeRow[] = [];
    let generations: MessageGenerationRow[] = [];
    let promptInfos: MessagePromptInfoRow[] = [];
    let promptToggles: MessagePromptToggleRow[] = [];
    let promptItems: MessagePromptItemRow[] = [];
    if (options.mode === "graph") {
      generations = (
        await client.query<MessageGenerationRow>(
          "SELECT * FROM chat.message_generation WHERE chat_id = $1 AND message_id = ANY($2::text[])",
          [chatId, ids],
        )
      ).rows;
    } else {
      attributes = (
        await client.query<MessageAttributeRow>(
          "SELECT * FROM chat.message_attributes WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, key",
          [chatId, ids],
        )
      ).rows;
      if (options.mode !== "generation") {
        generations = (
          await client.query<MessageGenerationRow>(
            "SELECT * FROM chat.message_generation WHERE chat_id = $1 AND message_id = ANY($2::text[])",
            [chatId, ids],
          )
        ).rows;
        promptInfos = (
          await client.query<MessagePromptInfoRow>(
            "SELECT * FROM chat.message_prompt_info WHERE chat_id = $1 AND message_id = ANY($2::text[])",
            [chatId, ids],
          )
        ).rows;
        promptToggles = (
          await client.query<MessagePromptToggleRow>(
            "SELECT * FROM chat.message_prompt_toggles WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, position",
            [chatId, ids],
          )
        ).rows;
        promptItems = (
          await client.query<MessagePromptItemRow>(
            "SELECT * FROM chat.message_prompt_items WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, position",
            [chatId, ids],
          )
        ).rows;
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
    const messages = messagesRes.rows.map((row) => {
      const key = `${row.chat_id}\0${row.id}`;
      return rebuildMessage(row, {
        attributes: relations.attributes.get(key),
        generation: relations.generation.get(key),
        promptInfo: relations.promptInfo.get(key),
        promptToggles: relations.promptToggles.get(key),
        promptItems: relations.promptItems.get(key),
      });
    });
    return { messages, offset, total, hasMore: offset > 0 };
  }

  async _activeBranchIdWithClient(
    client: PgClient,
    chatId: string,
  ): Promise<string | null> {
    return await this.ensureChatBranchGraph(client, chatId);
  }

  async loadChat(chatId: unknown, options: LoadChatOptions = {}) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const activeBranchId = await this._activeBranchIdWithClient(
        client,
        chatId,
      );
      const chatRes = await client.query<ChatCoreRow>(
        "SELECT * FROM chat.chats WHERE id = $1",
        [chatId],
      );
      const attributesRes = await client.query<ChatAttributeRow>(
        "SELECT * FROM chat.attributes WHERE chat_id = $1 ORDER BY key",
        [chatId],
      );
      const suggestionsRes = await client.query<ChatSuggestionRow>(
        "SELECT * FROM chat.suggestions WHERE chat_id = $1 ORDER BY position",
        [chatId],
      );
      const modulesRes = await client.query<ChatModuleRow>(
        "SELECT * FROM chat.modules WHERE chat_id = $1 ORDER BY position",
        [chatId],
      );
      const scriptStateRes = await client.query<ChatScriptStateRow>(
        "SELECT * FROM chat.script_state WHERE chat_id = $1 ORDER BY key",
        [chatId],
      );
      const bookmarksRes = await client.query<ChatBookmarkRow>(
        "SELECT * FROM chat.bookmarks WHERE chat_id = $1 ORDER BY position",
        [chatId],
      );
      const memoryRes = await client.query<ChatMemoryRow>(
        "SELECT * FROM chat.memory WHERE chat_id = $1 ORDER BY memory_type",
        [chatId],
      );
      const loreRes = await client.query<ChatLoreRow>(
        "SELECT * FROM chat.lore_entries WHERE chat_id = $1 ORDER BY position",
        [chatId],
      );
      if (chatRes.rows.length === 0 || !activeBranchId) {
        await client.query("COMMIT");
        return null;
      }
      const page = await this._loadBranchPageWithClient(
        client,
        chatId,
        activeBranchId,
        {
          limit: options.messageLimit,
          mode: "full",
        },
      );
      const chat = rebuildChat(chatRes.rows[0], {
        attributes: attributesRes.rows,
        suggestions: suggestionsRes.rows,
        modules: modulesRes.rows,
        scriptState: scriptStateRes.rows,
        bookmarks: bookmarksRes.rows,
        memory: memoryRes.rows,
        lore: loreRes.rows,
        messages: page.messages,
      });
      chat.activeBranchId = activeBranchId;
      delete chat.branchState;
      chat.messageOffset = page.offset;
      chat.messageTotal = page.total;
      chat.messagesFullyLoaded = !page.hasMore;
      chat.messagesLoaded = true;
      chat.detailsLoaded = true;
      await client.query("COMMIT");
      return chat;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadChatMessages(chatId: unknown, options: LoadChatOptions = {}) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const branchId = await this._activeBranchIdWithClient(client, chatId);
      if (!branchId) {
        await client.query("COMMIT");
        return [];
      }
      const page = await this._loadBranchPageWithClient(
        client,
        chatId,
        branchId,
        { mode: options.mode },
      );
      await client.query("COMMIT");
      return page.messages;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadChatMessagePage(chatId: unknown, before: unknown, limit: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const branchId = await this._activeBranchIdWithClient(client, chatId);
      const page = branchId
        ? await this._loadBranchPageWithClient(client, chatId, branchId, {
            before,
            limit,
            mode: "full",
          })
        : { messages: [], offset: 0, total: 0, hasMore: false };
      await client.query("COMMIT");
      return page;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listChatBranches(chatId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureChatBranchGraph(client, chatId);
      const result = await client.query<BranchRow>(
        `SELECT id, chat_id, parent_branch_id, fork_message_id, head_message_id, reason, created_at
                   FROM chat.branches WHERE chat_id = $1 ORDER BY created_at, id`,
        [chatId],
      );
      await client.query("COMMIT");
      return result.rows.map(mapBranchRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.ensureChatBranchGraph(client, chatId);
      const branchResult = await client.query<BranchRow>(
        `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
                branch.head_message_id, branch.reason, branch.created_at,
                active.branch_id AS active_branch_id
           FROM chat.branches branch
      LEFT JOIN chat.active_branches active ON active.chat_id = branch.chat_id
          WHERE branch.chat_id = $1
       ORDER BY branch.created_at, branch.id`,
        [chatId],
      );
      const countResult = await client.query<{ total: number | string }>(
        "SELECT COUNT(*)::bigint AS total FROM chat.message_branch_links WHERE chat_id = $1",
        [chatId],
      );
      const total = Number(countResult.rows[0]?.total ?? 0);
      const messagesRes = await client.query(
        `SELECT messages.*, links.parent_message_id, links.origin_branch_id
           FROM chat.message_branch_links links
           JOIN chat.messages messages
             ON messages.chat_id = links.chat_id AND messages.id = links.message_id
          WHERE links.chat_id = $1
       ORDER BY messages.position, messages.id
         OFFSET $2 LIMIT $3`,
        [chatId, offset, limit],
      );
      const ids = messagesRes.rows.map((row) => row.id);
      let attributes: MessageAttributeRow[] = [];
      let generations: MessageGenerationRow[] = [];
      let promptInfos: MessagePromptInfoRow[] = [];
      let promptToggles: MessagePromptToggleRow[] = [];
      let promptItems: MessagePromptItemRow[] = [];
      if (ids.length > 0) {
        attributes = (
          await client.query<MessageAttributeRow>(
            "SELECT * FROM chat.message_attributes WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, key",
            [chatId, ids],
          )
        ).rows;
        generations = (
          await client.query<MessageGenerationRow>(
            "SELECT * FROM chat.message_generation WHERE chat_id = $1 AND message_id = ANY($2::text[])",
            [chatId, ids],
          )
        ).rows;
        promptInfos = (
          await client.query<MessagePromptInfoRow>(
            "SELECT * FROM chat.message_prompt_info WHERE chat_id = $1 AND message_id = ANY($2::text[])",
            [chatId, ids],
          )
        ).rows;
        promptToggles = (
          await client.query<MessagePromptToggleRow>(
            "SELECT * FROM chat.message_prompt_toggles WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, position",
            [chatId, ids],
          )
        ).rows;
        promptItems = (
          await client.query<MessagePromptItemRow>(
            "SELECT * FROM chat.message_prompt_items WHERE chat_id = $1 AND message_id = ANY($2::text[]) ORDER BY message_id, position",
            [chatId, ids],
          )
        ).rows;
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
      const messages = messagesRes.rows.map((row) => {
        const key = `${row.chat_id}\0${row.id}`;
        return rebuildMessage(row, {
          attributes: relations.attributes.get(key),
          generation: relations.generation.get(key),
          promptInfo: relations.promptInfo.get(key),
          promptToggles: relations.promptToggles.get(key),
          promptItems: relations.promptItems.get(key),
        });
      });
      const branches = branchResult.rows.map(mapBranchRow);
      const links = messagesRes.rows.map((row) => ({
        messageId: String(row.id),
        position: Number(row.position) || 0,
        parentMessageId: row.parent_message_id ?? undefined,
        originBranchId: row.origin_branch_id,
      }));
      await client.query("COMMIT");
      return {
        branches,
        activeBranchId: branchResult.rows[0]?.active_branch_id ?? undefined,
        messages,
        links,
        offset,
        total,
        hasMore: offset + messagesRes.rows.length < total,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadChatBranchGraph(chatId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureChatBranchGraph(client, chatId);
      const branchResult = await client.query<BranchRow>(
        `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
                        branch.head_message_id, branch.reason, branch.created_at,
                        active.branch_id AS active_branch_id
                   FROM chat.branches branch
              LEFT JOIN chat.active_branches active ON active.chat_id = branch.chat_id
                  WHERE branch.chat_id = $1
               ORDER BY branch.created_at, branch.id`,
        [chatId],
      );
      const graphRows = await client.query(
        `SELECT messages.*, links.parent_message_id, links.origin_branch_id,
                        generation.model AS graph_generation_model
                   FROM chat.message_branch_links links
                   JOIN chat.messages messages
                     ON messages.chat_id = links.chat_id AND messages.id = links.message_id
              LEFT JOIN chat.message_generation generation
                     ON generation.chat_id = messages.chat_id AND generation.message_id = messages.id
                  WHERE links.chat_id = $1
               ORDER BY messages.position, messages.id`,
        [chatId],
      );
      await client.query("COMMIT");
      return buildChatBranchGraph(branchResult.rows, graphRows.rows);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await this.ensureChatBranchGraph(client, chatId);
      const page = await this._loadBranchPageWithClient(
        client,
        chatId,
        branchId,
        {
          limit: options.messageLimit,
          mode: options.mode,
        },
      );
      await client.query("COMMIT");
      return page.messages;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
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
    const parentBranchIdInput = input.parentBranchId ?? null;
    const forkMessageId = input.forkMessageId ?? null;
    const reason = input?.reason;
    if (!reason || !["root", "manual", "reroll"].includes(reason))
      throw new PostgresPayloadError("Invalid chat branch reason");
    const createdAt = Number.isFinite(Number(input?.createdAt))
      ? Math.trunc(Number(input.createdAt))
      : Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureChatBranchGraph(client, chatId);
      const activeRes = await client.query(
        "SELECT branch_id FROM chat.active_branches WHERE chat_id = $1",
        [chatId],
      );
      const parentBranchId =
        parentBranchIdInput ?? activeRes.rows[0]?.branch_id;
      if (!parentBranchId)
        throw new PostgresPayloadError("Chat branch root does not exist");
      const parentRes = await client.query(
        "SELECT 1 FROM chat.branches WHERE chat_id = $1 AND id = $2",
        [chatId, parentBranchId],
      );
      if (parentRes.rows.length === 0)
        throw new PostgresPayloadError("Parent chat branch does not exist");
      await client.query(
        `INSERT INTO chat.branches
                    (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
                 VALUES ($1, $2, $3, $4, $4, $5, $6)`,
        [chatId, branchId, parentBranchId, forkMessageId, reason, createdAt],
      );
      await client.query(
        `INSERT INTO chat.active_branches (chat_id, branch_id) VALUES ($1, $2)
                 ON CONFLICT (chat_id) DO UPDATE SET branch_id = EXCLUDED.branch_id`,
        [chatId, branchId],
      );
      const result = await client.query<BranchRow>(
        `SELECT id, chat_id, parent_branch_id, fork_message_id, head_message_id, reason, created_at
                   FROM chat.branches WHERE chat_id = $1 AND id = $2`,
        [chatId, branchId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return mapBranchRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async activateChatBranch(chatId: unknown, branchId: unknown) {
    this.assertEnabled();
    assertId(chatId, "chatId");
    assertId(branchId, "branchId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureChatBranchGraph(client, chatId);
      const exists = await client.query(
        "SELECT 1 FROM chat.branches WHERE chat_id = $1 AND id = $2",
        [chatId, branchId],
      );
      if (exists.rows.length === 0)
        throw new PostgresPayloadError("Chat branch does not exist");
      await client.query(
        "UPDATE chat.active_branches SET branch_id = $2 WHERE chat_id = $1",
        [chatId, branchId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPlugins(options: LoadPluginsOptions = {}) {
    this.assertEnabled();
    const pluginId =
      typeof options?.pluginId === "string" ? options.pluginId : null;
    if (pluginId) assertId(pluginId, "pluginId");
    if (!pluginId && this.pluginsCache) {
      return this.pluginsCache;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const params = pluginId ? [pluginId] : [];
      const where = pluginId ? " WHERE plugin_id = $1" : "";
      const records = (
        await client.query<PluginRecordRow>(
          `SELECT plugin_id, position, name, display_name, api_version, plugin_version, update_url, enabled FROM system.plugin_records${where} ORDER BY position`,
          params,
        )
      ).rows;
      const values = (
        await client.query<SettingValueRow>(
          `SELECT plugin_id AS setting_key, node_id, parent_node_id, member_key, encoded_member_key, position, value_type, text_value, encoded_text_value, number_value, boolean_value FROM system.plugin_values${where} ORDER BY plugin_id, node_id`,
          params,
        )
      ).rows;
      const plugins = rebuildPluginRecords(records, values);
      await client.query("COMMIT");

      const serialized = JSON.stringify(plugins);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      const result = { plugins, hash };
      if (!pluginId && this.objectCacheEnabled) this.pluginsCache = result;
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPluginScript(pluginId: unknown) {
    this.assertEnabled();
    assertId(pluginId, "pluginId");
    const result = await this.pool.query<{ script: unknown }>(
      "SELECT script FROM system.plugin_scripts WHERE plugin_id = $1",
      [pluginId],
    );
    const script = result.rows[0]?.script;
    return script == null ? null : decodePostgresScript(script);
  }

  async loadPluginCustomStorage() {
    this.assertEnabled();
    if (this.pluginCustomStorageCache) {
      return this.pluginCustomStorageCache;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = (
        await client.query(
          "SELECT key, value FROM system.plugin_custom_storage ORDER BY key",
        )
      ).rows;
      await client.query("COMMIT");
      const pluginCustomStorage = Object.fromEntries(
        rows.map((row) => [String(row.key), row.value]),
      );
      const serialized = JSON.stringify(pluginCustomStorage);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");

      const result = {
        pluginCustomStorage,
        hash,
      };
      if (this.objectCacheEnabled) this.pluginCustomStorageCache = result;
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listPluginCustomStorageKeys() {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{ key: string }>(
        "SELECT key FROM system.plugin_custom_storage ORDER BY key",
      );
      await client.query("COMMIT");
      return result.rows.map((row) => row.key);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPluginCustomStorageKey(storageKey: unknown) {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{ value: unknown }>(
        "SELECT value FROM system.plugin_custom_storage WHERE key = $1",
        [storageKey],
      );
      await client.query("COMMIT");

      if (result.rows.length === 0) {
        return {
          key: storageKey,
          exists: false,
          value: null,
          hash: "null",
        };
      }

      const value = result.rows[0].value;
      const serialized = JSON.stringify(value);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");

      return {
        key: storageKey,
        exists: true,
        value,
        hash,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listSettingKeys(): Promise<string[]> {
    this.assertEnabled();
    const result = await this.pool.query<{ key: string }>(
      "SELECT key FROM system.settings ORDER BY key",
    );
    return result.rows.map((row) => row.key);
  }

  async loadSettingKeys(keys: readonly string[]) {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const settingsResult = await client.query<SettingScalarRow>(
        "SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key = ANY($1::text[]) ORDER BY key",
        [keys],
      );
      const valuesResult = await client.query<SettingValueRow>(
        "SELECT * FROM system.setting_values WHERE setting_key = ANY($1::text[]) ORDER BY setting_key, node_id",
        [keys],
      );
      await client.query("COMMIT");
      const rebuilt = rebuildSettingRows(
        settingsResult.rows,
        valuesResult.rows,
      );
      if (keys.includes("pluginCustomStorage")) {
        const pluginRows = (
          await client.query<{ key: string; value: unknown }>(
            "SELECT key, value FROM system.plugin_custom_storage ORDER BY key",
          )
        ).rows;
        rebuilt.pluginCustomStorage = Object.fromEntries(
          pluginRows.map((row) => [String(row.key), row.value]),
        );
      }
      const serialized = JSON.stringify(rebuilt);
      const hash = crypto.createHash("sha256").update(serialized).digest("hex");
      return {
        settings: rebuilt,
        hash,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadModuleRecords() {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const modules = (
        await client.query<ModuleRecordRow>(
          "SELECT module_id, position FROM system.module_records ORDER BY position",
        )
      ).rows;
      const values = (
        await client.query<SettingValueRow>(
          "SELECT module_id AS setting_key, node_id, parent_node_id, member_key, encoded_member_key, position, value_type, text_value, encoded_text_value, number_value, boolean_value FROM system.module_values ORDER BY module_id, node_id",
        )
      ).rows;
      await client.query("COMMIT");
      return buildModuleRecordsSnapshot(modules, values);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listBotPresets() {
    this.assertEnabled();
    const started = process.hrtime.bigint();
    const result = await this.pool.query<BotPresetListRow>(
      `SELECT preset_id, position, name, image, api_type, ai_model, content_hash
             FROM system.bot_presets ORDER BY position`,
    );
    const { presets, hash } = buildBotPresetList(result.rows);
    return {
      presets,
      hash,
      queryMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  }

  async loadBotPreset(id: unknown) {
    this.assertEnabled();
    const started = process.hrtime.bigint();
    const result = await this.pool.query<{
      data: unknown;
      content_hash: string;
    }>(
      "SELECT data, content_hash FROM system.bot_presets WHERE preset_id = $1",
      [id],
    );
    if (result.rowCount === 0) return null;
    const data = decodePresetData(result.rows[0].data);
    return {
      preset: { ...data, id },
      hash: result.rows[0].content_hash,
      queryMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  }

  async executeRevision(
    action: string,
    scope = "database",
    callback: RevisionCallback,
  ) {
    this.assertEnabled();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const metaResult = await client.query<{ revision: number | string }>(
        "SELECT revision FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE",
      );
      const currentRevision = Number(metaResult.rows[0].revision);
      const nextRevision = currentRevision + 1;
      const revisionId = await beginAuditRevision(client, {
        storageRevision: nextRevision,
        databaseInitialized: true,
        scope,
        action,
      });

      const result = await callback(client, revisionId);

      await client.query(
        `UPDATE system.storage_meta
                 SET revision = $1, initialized = TRUE, updated_at = NOW()
                 WHERE singleton = TRUE`,
        [nextRevision],
      );
      await client.query("COMMIT");
      return {
        success: true,
        revision: nextRevision,
        revisionId,
        ...(isSqlRow(result) ? result : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

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
      throw new PostgresPayloadError(
        "Storage sync finalize revision must be a non-negative integer",
      );
    }
    if (typeof callback !== "function") {
      throw new PostgresPayloadError(
        "Storage sync finalize callback is required",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const metaResult = await client.query<{
        revision: number | string;
        initialized: boolean | null;
      }>(
        "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE",
      );
      const currentRevision = Number(metaResult.rows[0].revision);
      if (currentRevision !== expectedRevisionNumber) {
        throw new PostgresRevisionConflictError(currentRevision);
      }
      const previousRevisionResult = await client.query<{
        id: number | string;
      }>(
        "SELECT id FROM system.revisions WHERE storage_revision = $1 ORDER BY id DESC LIMIT 1",
        [currentRevision],
      );
      const previousRevisionId =
        previousRevisionResult.rows[0]?.id == null
          ? null
          : Number(previousRevisionResult.rows[0].id);
      const databaseInitialized = Boolean(metaResult.rows[0].initialized);
      const nextRevision = currentRevision + 1;
      const revisionId = await beginAuditRevision(client, {
        storageRevision: nextRevision,
        databaseInitialized: true,
        scope: "database",
        action: "storage-sync:replace",
      });
      const result = await callback(client, {
        currentRevision,
        nextRevision,
        revisionId,
        previousRevisionId,
        databaseInitialized,
      });
      await client.query(
        `UPDATE system.storage_meta
         SET revision = $1, initialized = TRUE, updated_at = NOW()
         WHERE singleton = TRUE`,
        [nextRevision],
      );
      await client.query("COMMIT");
      return {
        success: true,
        revision: nextRevision,
        revisionId,
        ...(isSqlRow(result) ? result : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSetting(key: string, value: unknown) {
    return await this.executeRevision(
      `setting:update (${key})`,
      "database",
      async (client) => {
        const mapped = mapSettingValueToColumns(value);
        await client.query(
          `INSERT INTO system.settings (key, text_val, num_val, bool_val, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (key) DO UPDATE SET
                    text_val = EXCLUDED.text_val,
                    num_val = EXCLUDED.num_val,
                    bool_val = EXCLUDED.bool_val,
                    updated_at = NOW()`,
          [key, mapped.text_val, mapped.num_val, mapped.bool_val],
        );
        await replaceSettingValueRows(client, [{ key, value }]);
        const projected = projectSettings([{ key, value }]);
        for (const definition of SETTING_RELATION_DEFINITIONS) {
          if (definition.settingKeys.includes(key)) {
            await client.query(
              `DELETE FROM ${assertSqlIdentifier(definition.table)} WHERE setting_key = $1`,
              [key],
            );
            await bulkInsert(
              client,
              definition.table,
              definition.columns,
              definition.types,
              projected[definition.table],
            );
          }
        }
        this.invalidateBootstrapCache([key]);
        return { key };
      },
    );
  }

  async deleteSetting(key: string) {
    return await this.executeRevision(
      `setting:delete (${key})`,
      "database",
      async (client) => {
        await client.query("DELETE FROM system.settings WHERE key = $1", [key]);
        this.invalidateBootstrapCache([key]);
        return { key };
      },
    );
  }

  async saveBotPreset(preset: BotPresetRecord, position = 0) {
    return await this.executeRevision(
      `preset:save (${preset.name || position})`,
      "database",
      async (client) => {
        const id = preset.id || crypto.randomUUID();
        const data = { ...preset };
        delete data.id;
        const serialized = JSON.stringify(data);
        const hash = crypto
          .createHash("sha256")
          .update(serialized)
          .digest("hex");
        await client.query(
          `INSERT INTO system.bot_presets
                (preset_id,position,name,image,api_type,ai_model,data,content_hash)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
                ON CONFLICT (preset_id) DO UPDATE SET name=EXCLUDED.name,image=EXCLUDED.image,
                api_type=EXCLUDED.api_type,ai_model=EXCLUDED.ai_model,data=EXCLUDED.data,
                content_hash=EXCLUDED.content_hash,updated_at=NOW()`,
          [
            id,
            Number(position) || 0,
            data.name || "",
            data.image || "",
            data.apiType || "",
            data.aiModel || "",
            serialized,
            hash,
          ],
        );
        return { id, position };
      },
    );
  }

  async saveModule(moduleData: ModuleRecord) {
    return await this.executeRevision(
      `module:save (${moduleData.name || moduleData.id})`,
      "database",
      async (client) => {
        const id = moduleData.id;
        const records = (
          await client.query<ModuleRecordRow>(
            "SELECT module_id, position FROM system.module_records ORDER BY position",
          )
        ).rows;
        const nextPosition =
          records.reduce(
            (max, row) => Math.max(max, Number(row.position)),
            -1,
          ) + 1;
        let entries: ModuleEntry[] = [
          {
            id,
            position: Number(
              records.find((row) => row.module_id === id)?.position ??
                nextPosition,
            ),
            data: moduleData,
          },
        ];
        if (records.length === 0) {
          const settings = (
            await client.query<SettingScalarRow>(
              "SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key = 'modules'",
            )
          ).rows;
          const values = (
            await client.query<SettingValueRow>(
              "SELECT * FROM system.setting_values WHERE setting_key = 'modules' ORDER BY node_id",
            )
          ).rows;
          const legacy = asUnknownArray(
            rebuildSettingRows(settings, values).modules,
          );
          if (legacy) {
            const merged = legacy.filter(
              (module) => !isSqlRow(module) || module.id !== id,
            );
            merged.push(moduleData);
            entries = merged.map((data, position) => ({
              id: legacyModuleId(data),
              position,
              data,
            }));
          }
        }
        for (const entry of entries) {
          await client.query(
            `INSERT INTO system.module_records (module_id, position, updated_at)
                     VALUES ($1, $2, NOW()) ON CONFLICT (module_id) DO UPDATE SET
                     position=EXCLUDED.position, updated_at=NOW()`,
            [entry.id, entry.position],
          );
        }
        await replaceModuleValueRows(client, entries);
        await client.query("DELETE FROM system.settings WHERE key = 'modules'");
        return { id };
      },
    );
  }

  async deleteModule(moduleId: string) {
    return await this.executeRevision(
      `module:delete (${moduleId})`,
      "database",
      async (client) => {
        const records = (
          await client.query<{ module_id: string }>(
            "SELECT module_id FROM system.module_records LIMIT 1",
          )
        ).rows;
        if (records.length === 0) {
          const settings = (
            await client.query<SettingScalarRow>(
              "SELECT key, text_val, num_val, bool_val FROM system.settings WHERE key = 'modules'",
            )
          ).rows;
          const values = (
            await client.query<SettingValueRow>(
              "SELECT * FROM system.setting_values WHERE setting_key = 'modules' ORDER BY node_id",
            )
          ).rows;
          const legacy = asUnknownArray(
            rebuildSettingRows(settings, values).modules,
          );
          if (legacy) {
            const entries: ModuleEntry[] = legacy
              .filter((module) => !isSqlRow(module) || module.id !== moduleId)
              .map((data, position) => ({
                id: legacyModuleId(data),
                position,
                data,
              }));
            for (const entry of entries) {
              await client.query(
                "INSERT INTO system.module_records (module_id, position) VALUES ($1, $2)",
                [entry.id, entry.position],
              );
            }
            await replaceModuleValueRows(client, entries);
          }
        }
        await client.query(
          "DELETE FROM system.module_records WHERE module_id = $1",
          [moduleId],
        );
        await client.query("DELETE FROM system.settings WHERE key = 'modules'");
        return { id: moduleId };
      },
    );
  }

  async saveMessage(chatId: string, message: MessageSaveInput) {
    return await this.executeRevision(
      "message:save",
      "database",
      async (client) => {
        const split: MessageSplit = splitMessage({
          id: message.chatId || message.id,
          chatId,
          position: message.position ?? 0,
          data: message,
        });
        const messageColumns = [
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
        await bulkInsert(
          client,
          "chat.messages",
          messageColumns,
          [
            "text",
            "text",
            "integer",
            "text",
            "text",
            "bytea",
            "text",
            "bigint",
            "text",
            "boolean",
            "text",
            "boolean",
          ],
          [split.core],
          buildUpsertClause(
            "chat.messages",
            ["chat_id", "id"],
            messageColumns.slice(2),
            true,
          ),
        );
        if (split.attributes.length > 0) {
          await bulkInsert(
            client,
            "chat.message_attributes",
            ["chat_id", "message_id", "key", "value"],
            ["text", "text", "text", "jsonb"],
            split.attributes.map((r) => ({
              ...r,
              chat_id: chatId,
              message_id: split.core.id,
            })),
            buildUpsertClause(
              "chat.message_attributes",
              ["chat_id", "message_id", "key"],
              ["value"],
            ),
          );
        }
        await pruneKeyedChildren(
          client,
          "chat.message_attributes",
          "chat_id",
          "key",
          [
            {
              ownerId: chatId,
              keys: split.attributes.map((r) => String(r.key)),
            },
          ],
        );

        if (split.generation) {
          await bulkInsert(
            client,
            "chat.message_generation",
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
            [
              "text",
              "text",
              "text",
              "text",
              "integer",
              "integer",
              "integer",
              "double precision",
              "double precision",
              "double precision",
              "double precision",
            ],
            [split.generation],
            buildUpsertClause(
              "chat.message_generation",
              ["chat_id", "message_id"],
              [
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
            ),
          );
        } else {
          await client.query(
            "DELETE FROM chat.message_generation WHERE chat_id = $1 AND message_id = $2",
            [chatId, split.core.id],
          );
        }

        if (split.prompt?.info) {
          await bulkInsert(
            client,
            "chat.message_prompt_info",
            ["chat_id", "message_id", "prompt_name"],
            ["text", "text", "text"],
            [split.prompt.info],
            buildUpsertClause(
              "chat.message_prompt_info",
              ["chat_id", "message_id"],
              ["prompt_name"],
            ),
          );
        } else {
          await client.query(
            "DELETE FROM chat.message_prompt_info WHERE chat_id = $1 AND message_id = $2",
            [chatId, split.core.id],
          );
        }

        if (split.prompt && split.prompt.toggles.length > 0) {
          await bulkInsert(
            client,
            "chat.message_prompt_toggles",
            ["chat_id", "message_id", "position", "toggle_key", "toggle_value"],
            ["text", "text", "integer", "text", "text"],
            split.prompt.toggles,
            buildUpsertClause(
              "chat.message_prompt_toggles",
              ["chat_id", "message_id", "position"],
              ["toggle_key", "toggle_value"],
            ),
          );
        }
        await client.query(
          "DELETE FROM chat.message_prompt_toggles WHERE chat_id = $1 AND message_id = $2 AND position >= $3",
          [chatId, split.core.id, (split.prompt?.toggles || []).length],
        );

        if (split.prompt && split.prompt.items.length > 0) {
          await bulkInsert(
            client,
            "chat.message_prompt_items",
            ["chat_id", "message_id", "position", "payload"],
            ["text", "text", "integer", "jsonb"],
            split.prompt.items,
            buildUpsertClause(
              "chat.message_prompt_items",
              ["chat_id", "message_id", "position"],
              ["payload"],
            ),
          );
        }
        await client.query(
          "DELETE FROM chat.message_prompt_items WHERE chat_id = $1 AND message_id = $2 AND position >= $3",
          [chatId, split.core.id, (split.prompt?.items || []).length],
        );

        return { id: split.core.id, chatId };
      },
    );
  }

  async deleteMessage(chatId: string, messageId: string) {
    return await this.executeRevision(
      "message:delete",
      "database",
      async (client) => {
        await this.detachMessagesFromBranchGraph(client, [
          { chatId, ids: [messageId] },
        ]);
        await client.query(
          "DELETE FROM chat.messages WHERE chat_id = $1 AND id = $2",
          [chatId, messageId],
        );
        return { chatId, messageId };
      },
    );
  }

  async clearStorageSyncColdStorage(client: PgClient) {
    await client.query("DELETE FROM cold.archives");
  }

  async applyStorageSyncColdStorageRecord(
    client: PgClient,
    key: unknown,
    value: unknown,
  ) {
    const normalizedKey = normalizeColdStorageKey(key);
    const splitValue = splitColdStorageValue(value);
    return await this.upsertColdStorageWithClient(
      client,
      normalizedKey,
      splitValue,
    );
  }

  async applyStorageSyncBranchRecords(
    client: PgClient,
    branches: readonly StorageSyncBranchRecord[],
    activeBranches: readonly StorageSyncActiveBranchRecord[],
  ) {
    const branchRows: ChatBranchInsertRow[] = (branches || []).map((record) => {
      assertId(record.chatId, "branch.chatId");
      const data = record.data;
      assertId(data?.id, "branch.id");
      const reason = data.reason;
      if (!["root", "manual", "reroll"].includes(reason)) {
        throw new PostgresPayloadError("Invalid chat branch reason");
      }
      return {
        chat_id: record.chatId,
        id: data.id,
        parent_branch_id: data.parentBranchId ?? null,
        fork_message_id: data.forkMessageId ?? null,
        head_message_id: data.headMessageId ?? null,
        reason,
        created_at: Number(data.createdAt) || 0,
      };
    });
    await bulkInsert(
      client,
      "chat.branches",
      [
        "chat_id",
        "id",
        "parent_branch_id",
        "fork_message_id",
        "head_message_id",
        "reason",
        "created_at",
      ],
      ["text", "text", "text", "text", "text", "text", "bigint"],
      branchRows,
      buildUpsertClause(
        "chat.branches",
        ["chat_id", "id"],
        [
          "parent_branch_id",
          "fork_message_id",
          "head_message_id",
          "reason",
          "created_at",
        ],
      ),
    );
    for (const record of activeBranches || []) {
      assertId(record.chatId, "active-branch.chatId");
      assertId(record.branchId, "active-branch.branchId");
      await client.query(
        `INSERT INTO chat.active_branches (chat_id, branch_id) VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET branch_id = EXCLUDED.branch_id`,
        [record.chatId, record.branchId],
      );
    }
  }

  async applyStorageSyncMessageLinks(
    client: PgClient,
    records: readonly StorageSyncMessageRecord[],
  ) {
    const rows = (records || []).map((record) => ({
      chat_id: record.chatId,
      message_id: record.id,
      parent_message_id: record.parentMessageId ?? null,
      origin_branch_id: record.originBranchId,
    }));
    await bulkInsert(
      client,
      "chat.message_branch_links",
      ["chat_id", "message_id", "parent_message_id", "origin_branch_id"],
      ["text", "text", "text", "text"],
      rows,
      buildUpsertClause(
        "chat.message_branch_links",
        ["chat_id", "message_id"],
        ["parent_message_id", "origin_branch_id"],
      ),
    );
  }

  async sync(rawPayload: unknown, options: SyncOptions = {}) {
    this.assertEnabled();
    const onProgress = readSyncProgress(options);
    const payload = validateSyncPayload(rawPayload);
    // Report the compact commit impact to the internal realtime channel right
    // after validation; it is never serialized into the sync result.
    // 검증 직후 압축 커밋 영향을 내부 실시간 채널로 보고하며, sync 결과에는
    // 절대 직렬화되지 않습니다.
    captureSyncCommitImpact(options, payload);
    const external = readExternalTransaction<PgClient>(options);
    const ownedClient = external ? null : await this.pool.connect();
    const client: PgClient = external?.client ?? ownedClient!;
    const ownsTransaction = !external;
    try {
      let currentRevision: number;
      let nextRevision: number;
      if (ownsTransaction) {
        onProgress?.({ stage: "start", message: "Starting transaction" });
        await client.query("BEGIN");
        const metaResult = await client.query<{
          revision: number | string;
          initialized: boolean | null;
        }>(
          "SELECT revision, initialized FROM system.storage_meta WHERE singleton = TRUE FOR UPDATE",
        );
        currentRevision = Number(metaResult.rows[0].revision);
        const receipt = await authorNoteSql.readAuthorNoteReceipt(
          authorNoteDatabase("postgres", client),
          payload,
        );
        if (receipt) {
          await client.query("COMMIT");
          return receipt;
        }
        if (payload.baseRevision !== currentRevision) {
          throw new PostgresRevisionConflictError(currentRevision);
        }
        nextRevision = currentRevision + 1;
        await beginAuditRevision(client, {
          storageRevision: nextRevision,
          databaseInitialized: true,
          scope: "database",
          action:
            payload.action || (payload.replaceAll ? "replace-all" : "sync"),
        });
      } else {
        currentRevision = Number(external.currentRevision);
        nextRevision = Number(external.nextRevision);
        if (
          !Number.isSafeInteger(currentRevision) ||
          !Number.isSafeInteger(nextRevision) ||
          nextRevision !== currentRevision + 1 ||
          payload.baseRevision !== currentRevision
        ) {
          throw new PostgresPayloadError(
            "Invalid external sync transaction context",
          );
        }
      }

      const noteDb = authorNoteDatabase("postgres", client);
      if (payload.replaceAll) await authorNoteSql.resetAuthorNotes(noteDb);
      const authorNotes = await authorNoteSql.applyAuthorNotes(
        noteDb,
        payload.authorNotes,
      );

      if (payload.replaceAll) {
        await client.query("DELETE FROM system.settings");
        await client.query("DELETE FROM system.plugin_custom_storage");
        await client.query("DELETE FROM system.bot_presets");
        await client.query("DELETE FROM system.module_records");
        await client.query("DELETE FROM system.plugin_records");
        await client.query("DELETE FROM character.characters");
      }

      if (payload.modules) {
        await syncModuleRecords(
          new PostgresDialect(client),
          payload.modules,
          {
            replaceAll: Boolean(payload.replaceAll),
            legacyMergeAllowed: !external?.storageSyncImport,
          },
          payload,
        );
      }

      if (payload.plugins) {
        const existing = (
          await client.query<{ plugin_id: string; position: number | string }>(
            "SELECT plugin_id, position FROM system.plugin_records ORDER BY position",
          )
        ).rows;
        const positions = new Map<string, number>(
          existing.map((row) => [row.plugin_id, Number(row.position)]),
        );

        if (payload.plugins.deletes.length) {
          await client.query(
            "DELETE FROM system.plugin_records WHERE plugin_id = ANY($1::text[])",
            [payload.plugins.deletes],
          );
        }
        if (payload.plugins.order) {
          await client.query(
            "UPDATE system.plugin_records SET position = position + 1000000000",
          );
        }
        let nextPosition =
          existing.reduce(
            (max, row) => Math.max(max, Number(row.position)),
            -1,
          ) + 1;
        for (const entry of payload.plugins.upserts) {
          const data = isSqlRow(entry.data) ? entry.data : {};
          if (typeof data.name !== "string" || data.name.length === 0) {
            throw new PostgresPayloadError(
              `Plugin ${entry.id} must have a non-empty name`,
            );
          }
          const position =
            entry.position ?? positions.get(entry.id) ?? nextPosition++;
          await client.query(
            `INSERT INTO system.plugin_records
              (plugin_id, position, name, display_name, api_version, plugin_version, update_url, enabled, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
             ON CONFLICT (plugin_id) DO UPDATE SET
              position=EXCLUDED.position, name=EXCLUDED.name,
              display_name=EXCLUDED.display_name, api_version=EXCLUDED.api_version,
              plugin_version=EXCLUDED.plugin_version, update_url=EXCLUDED.update_url,
              enabled=EXCLUDED.enabled, updated_at=NOW()`,
            [
              entry.id,
              position,
              data.name,
              typeof data.displayName === "string" ? data.displayName : null,
              data.version == null ? null : String(data.version),
              typeof data.versionOfPlugin === "string"
                ? data.versionOfPlugin
                : null,
              typeof data.updateURL === "string" ? data.updateURL : null,
              data.enabled !== false,
            ],
          );
        }
        await replacePluginValueRows(client, payload.plugins.upserts);

        for (const script of payload.plugins.scripts || []) {
          await client.query(
            `INSERT INTO system.plugin_scripts (plugin_id, script, updated_at)
             VALUES ($1,$2,NOW())
             ON CONFLICT (plugin_id) DO UPDATE SET
              script=EXCLUDED.script, updated_at=NOW()`,
            [script.id, encodePostgresScript(script.script)],
          );
        }
        for (const update of payload.plugins.enabled || []) {
          await client.query(
            "UPDATE system.plugin_records SET enabled = $1, updated_at = NOW() WHERE plugin_id = $2",
            [update.enabled, update.id],
          );
        }
        if (payload.plugins.order) {
          for (const [position, id] of payload.plugins.order.entries()) {
            await client.query(
              "UPDATE system.plugin_records SET position = $1 WHERE plugin_id = $2",
              [position, id],
            );
          }
        }
      }

      if (payload.presets) {
        const existingResult = await client.query<{
          preset_id: string;
          position: number | string;
        }>(
          "SELECT preset_id, position FROM system.bot_presets ORDER BY position",
        );
        const currentActiveResult = await client.query<{
          text_val: string | null;
        }>(
          "SELECT text_val FROM system.settings WHERE key = 'activeBotPresetId'",
        );
        const currentActiveId = currentActiveResult.rows[0]?.text_val;
        const originalIds = existingResult.rows.map((row) => row.preset_id);
        const ids = new Set<string>(
          existingResult.rows.map((row) => row.preset_id),
        );
        for (const id of payload.presets.deletes) ids.delete(id);
        for (const entry of payload.presets.upserts) ids.add(entry.id);
        if (ids.size === 0)
          throw new PostgresPayloadError("At least one bot preset must remain");
        if (
          payload.presets.order &&
          (payload.presets.order.length !== ids.size ||
            new Set<string>(payload.presets.order).size !== ids.size ||
            payload.presets.order.some((id) => !ids.has(id)))
        ) {
          throw new PostgresPayloadError(
            "Preset order must contain every preset ID exactly once",
          );
        }
        if (
          payload.presets.activeId !== undefined &&
          !ids.has(payload.presets.activeId)
        ) {
          throw new PostgresPayloadError("Active bot preset does not exist");
        }
        if (payload.presets.deletes.length) {
          await client.query(
            "DELETE FROM system.bot_presets WHERE preset_id = ANY($1::text[])",
            [payload.presets.deletes],
          );
        }
        let nextPosition =
          existingResult.rows.reduce(
            (max, row) => Math.max(max, Number(row.position)),
            -1,
          ) + 1;
        const existingPositions = new Map<string, number>(
          existingResult.rows.map((row) => [
            row.preset_id,
            Number(row.position),
          ]),
        );
        for (const entry of payload.presets.upserts) {
          const data = { ...entry.data };
          delete data.id;
          const serialized = JSON.stringify(data);
          const contentHash = crypto
            .createHash("sha256")
            .update(serialized)
            .digest("hex");
          const position =
            entry.position ?? existingPositions.get(entry.id) ?? nextPosition++;
          await client.query(
            `INSERT INTO system.bot_presets
                        (preset_id, position, name, image, api_type, ai_model, data, content_hash, updated_at)
                        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())
                        ON CONFLICT (preset_id) DO UPDATE SET position=EXCLUDED.position, name=EXCLUDED.name,
                        image=EXCLUDED.image, api_type=EXCLUDED.api_type, ai_model=EXCLUDED.ai_model,
                        data=EXCLUDED.data, content_hash=EXCLUDED.content_hash, updated_at=NOW()`,
            [
              entry.id,
              position,
              data.name || "",
              data.image || "",
              data.apiType || "",
              data.aiModel || "",
              serialized,
              contentHash,
            ],
          );
        }
        if (payload.presets.order) {
          await client.query(
            "UPDATE system.bot_presets SET position = position + 1000000000",
          );
          for (const [position, id] of payload.presets.order.entries()) {
            await client.query(
              "UPDATE system.bot_presets SET position = $1 WHERE preset_id = $2",
              [position, id],
            );
          }
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

      onProgress?.({
        stage: "settings",
        message: `Syncing settings (${payload.rootUpserts.length})`,
        count: payload.rootUpserts.length,
      });
      dedupeRootUpserts(payload);
      const rootSettingUpserts = payload.rootUpserts.filter(
        (row) => row.key !== "pluginCustomStorage",
      );
      if (rootSettingUpserts.length > 0) {
        const settingRows = rootSettingUpserts.map((row) => {
          const mapped = mapSettingValueToColumns(row.value);
          return { key: row.key, ...mapped };
        });
        await bulkInsert(
          client,
          "system.settings",
          ["key", "text_val", "num_val", "bool_val"],
          ["text", "text", "double precision", "boolean"],
          settingRows,
          buildUpsertClause(
            "system.settings",
            ["key"],
            ["text_val", "num_val", "bool_val"],
            true,
          ),
        );
        await replaceSettingValueRows(client, rootSettingUpserts);
      }
      const changedSettingKeys = rootSettingUpserts.map((item) => item.key);
      const projectedSettings = projectSettings(rootSettingUpserts);
      if (changedSettingKeys.length > 0) {
        const changedSettingKeySet = new Set<string>(changedSettingKeys);
        for (const definition of SETTING_RELATION_DEFINITIONS) {
          const projectedKeys = definition.settingKeys.filter((key) =>
            changedSettingKeySet.has(key),
          );
          if (projectedKeys.length === 0) continue;
          await client.query(
            `DELETE FROM ${assertSqlIdentifier(definition.table)}
                         WHERE setting_key = ANY($1::text[])`,
            [projectedKeys],
          );
        }
      }
      for (const definition of SETTING_RELATION_DEFINITIONS) {
        await bulkInsert(
          client,
          definition.table,
          definition.columns,
          definition.types,
          projectedSettings[definition.table],
        );
      }
      if (payload.rootDeletes.length > 0) {
        await client.query(
          "DELETE FROM system.settings WHERE key = ANY($1::text[])",
          [payload.rootDeletes],
        );
      }
      if (payload.pluginStorageClear) {
        await client.query("DELETE FROM system.plugin_custom_storage");
      }
      if (
        payload.pluginStorageDeletes &&
        payload.pluginStorageDeletes.length > 0
      ) {
        await client.query(
          "DELETE FROM system.plugin_custom_storage WHERE key = ANY($1::text[])",
          [payload.pluginStorageDeletes],
        );
      }
      if (
        payload.pluginStorageUpserts &&
        payload.pluginStorageUpserts.length > 0
      ) {
        for (const upsert of payload.pluginStorageUpserts) {
          await client.query(
            `INSERT INTO system.plugin_custom_storage (key, value, updated_at)
                         VALUES ($1, $2::jsonb, NOW())
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [upsert.key, JSON.stringify(upsert.value)],
          );
        }
      }
      if (
        payload.pluginStorageClear ||
        (payload.pluginStorageDeletes &&
          payload.pluginStorageDeletes.length > 0) ||
        (payload.pluginStorageUpserts &&
          payload.pluginStorageUpserts.length > 0)
      ) {
        this.pluginCustomStorageCache = null;
        this.bootstrapCache = null;
        this.bootstrapCacheGeneration++;
      }

      onProgress?.({
        stage: "characters",
        message: `Syncing characters (${payload.characters.length})`,
        count: payload.characters.length,
      });
      const splitCharacters: CharacterSplit[] =
        payload.characters.map(splitCharacter);
      const characterColumns = [
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
      await bulkInsert(
        client,
        "character.characters",
        characterColumns,
        [
          "text",
          "integer",
          "text",
          ...Array(15).fill("text"),
          "integer",
          "integer",
          "boolean",
          "boolean",
          "text",
          "text",
          "text",
          "text",
          "text",
          "text",
          "text",
          "bigint",
          "bigint",
          "bigint",
          "bigint",
        ],
        splitCharacters.map((item) => item.core),
        buildUpsertClause(
          "character.characters",
          ["id"],
          characterColumns.slice(1),
          true,
        ),
      );

      // Relation rows are homogeneous per name, so flattening widens them to
      // the plain column maps the bulk writer consumes.
      const characterRows = (name: CharacterRelationName): SqlStorageRow[] =>
        splitCharacters.flatMap((item) => [...item[name]]);

      // 1. attributes (PK: character_id, key)
      const charAttrRows: CharacterAttributeRow[] = splitCharacters.flatMap(
        (item) =>
          item.attributes.map((row) => ({
            ...row,
            character_id: item.core.id,
          })),
      );
      await bulkInsert(
        client,
        "character.attributes",
        ["character_id", "key", "value"],
        ["text", "text", "jsonb"],
        charAttrRows,
        buildUpsertClause(
          "character.attributes",
          ["character_id", "key"],
          ["value"],
        ),
      );
      await pruneKeyedChildren(
        client,
        "character.attributes",
        "character_id",
        "key",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          keys: (c.attributes || []).map((a) => a.key),
        })),
      );

      // 2. tags (PK: character_id, position)
      await bulkInsert(
        client,
        "character.tags",
        ["character_id", "position", "tag"],
        ["text", "integer", "text"],
        characterRows("tags"),
        buildUpsertClause(
          "character.tags",
          ["character_id", "position"],
          ["tag"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.tags",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.tags || []).length,
        })),
      );

      // 3. greetings (PK: character_id, greeting_type, position)
      await bulkInsert(
        client,
        "character.greetings",
        ["character_id", "greeting_type", "position", "content"],
        ["text", "text", "integer", "text"],
        characterRows("greetings"),
        buildUpsertClause(
          "character.greetings",
          ["character_id", "greeting_type", "position"],
          ["content"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.greetings",
        "character_id",
        splitCharacters.flatMap((c) => [
          {
            ownerId: c.core.id,
            subKind: "alternate",
            length: (c.greetings || []).filter(
              (g) => g.greeting_type === "alternate",
            ).length,
          },
          {
            ownerId: c.core.id,
            subKind: "group-only",
            length: (c.greetings || []).filter(
              (g) => g.greeting_type === "group-only",
            ).length,
          },
        ]),
        "greeting_type",
      );

      // 4. biases (PK: character_id, position)
      await bulkInsert(
        client,
        "character.biases",
        ["character_id", "position", "phrase", "bias"],
        ["text", "integer", "text", "double precision"],
        characterRows("biases"),
        buildUpsertClause(
          "character.biases",
          ["character_id", "position"],
          ["phrase", "bias"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.biases",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.biases || []).length,
        })),
      );

      // 5. emotions (PK: character_id, position)
      await bulkInsert(
        client,
        "character.emotions",
        ["character_id", "position", "emotion", "asset"],
        ["text", "integer", "text", "text"],
        characterRows("emotions"),
        buildUpsertClause(
          "character.emotions",
          ["character_id", "position"],
          ["emotion", "asset"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.emotions",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.emotions || []).length,
        })),
      );

      // 6. modules (PK: character_id, position)
      await bulkInsert(
        client,
        "character.modules",
        ["character_id", "position", "module_id"],
        ["text", "integer", "text"],
        characterRows("modules"),
        buildUpsertClause(
          "character.modules",
          ["character_id", "position"],
          ["module_id"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.modules",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.modules || []).length,
        })),
      );

      // 7. group_members (PK: group_id, position)
      await bulkInsert(
        client,
        "character.group_members",
        ["group_id", "position", "character_id", "talk_weight", "active"],
        ["text", "integer", "text", "double precision", "boolean"],
        characterRows("groupMembers"),
        buildUpsertClause(
          "character.group_members",
          ["group_id", "position"],
          ["character_id", "talk_weight", "active"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.group_members",
        "group_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.groupMembers || []).length,
        })),
      );

      // 8. chat_folders (PK: character_id, position)
      await bulkInsert(
        client,
        "character.chat_folders",
        ["character_id", "position", "folder_id", "name", "color", "folded"],
        ["text", "integer", "text", "text", "text", "boolean"],
        characterRows("chatFolders"),
        buildUpsertClause(
          "character.chat_folders",
          ["character_id", "position"],
          ["folder_id", "name", "color", "folded"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.chat_folders",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.chatFolders || []).length,
        })),
      );

      // 9. scripts (PK: character_id, script_kind, position)
      await bulkInsert(
        client,
        "character.scripts",
        [
          "character_id",
          "script_kind",
          "position",
          "comment",
          "input_text",
          "output_text",
          "script_type",
          "flag",
          "able_flag",
          "trigger_payload",
        ],
        [
          "text",
          "text",
          "integer",
          "text",
          "text",
          "text",
          "text",
          "text",
          "boolean",
          "jsonb",
        ],
        characterRows("scripts"),
        buildUpsertClause(
          "character.scripts",
          ["character_id", "script_kind", "position"],
          [
            "comment",
            "input_text",
            "output_text",
            "script_type",
            "flag",
            "able_flag",
            "trigger_payload",
          ],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.scripts",
        "character_id",
        splitCharacters.flatMap((c) => [
          {
            ownerId: c.core.id,
            subKind: "custom",
            length: (c.scripts || []).filter((s) => s.script_kind === "custom")
              .length,
          },
          {
            ownerId: c.core.id,
            subKind: "trigger",
            length: (c.scripts || []).filter((s) => s.script_kind === "trigger")
              .length,
          },
        ]),
        "script_kind",
      );

      // 10. sd_data (PK: character_id, position)
      await bulkInsert(
        client,
        "character.sd_data",
        ["character_id", "position", "key", "value"],
        ["text", "integer", "text", "text"],
        characterRows("sdData"),
        buildUpsertClause(
          "character.sd_data",
          ["character_id", "position"],
          ["key", "value"],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.sd_data",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.sdData || []).length,
        })),
      );

      // 11. assets (PK: character_id, position)
      await bulkInsert(
        client,
        "character.assets",
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
        ["text", "integer", "text", "text", "text", "text", "text", "text"],
        characterRows("assets"),
        buildUpsertClause(
          "character.assets",
          ["character_id", "position"],
          [
            "asset_source",
            "asset_type",
            "uri",
            "name",
            "extension",
            "extra_value",
          ],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.assets",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.assets || []).length,
        })),
      );

      // 12. lore_entries (PK: character_id, position)
      await bulkInsert(
        client,
        "character.lore_entries",
        [
          "character_id",
          "position",
          "lore_id",
          "primary_key",
          "secondary_key",
          "insert_order",
          "comment",
          "content",
          "mode",
          "always_active",
          "selective",
          "case_sensitive",
          "activation_percent",
          "use_regex",
          "book_version",
          "folder",
          "cache_payload",
        ],
        [
          "text",
          "integer",
          "text",
          "text",
          "text",
          "integer",
          "text",
          "text",
          "text",
          "boolean",
          "boolean",
          "boolean",
          "double precision",
          "boolean",
          "integer",
          "text",
          "jsonb",
        ],
        characterRows("lore"),
        buildUpsertClause(
          "character.lore_entries",
          ["character_id", "position"],
          [
            "lore_id",
            "primary_key",
            "secondary_key",
            "insert_order",
            "comment",
            "content",
            "mode",
            "always_active",
            "selective",
            "case_sensitive",
            "activation_percent",
            "use_regex",
            "book_version",
            "folder",
            "cache_payload",
          ],
        ),
      );
      await prunePositionalChildren(
        client,
        "character.lore_entries",
        "character_id",
        splitCharacters.map((c) => ({
          ownerId: c.core.id,
          length: (c.lore || []).length,
        })),
      );

      if (payload.characterTouches.length > 0) {
        for (const touch of payload.characterTouches) {
          await client.query(
            `UPDATE character.characters
                         SET last_interaction_time = $2, updated_at = NOW()
                         WHERE id = $1`,
            [touch.id, touch.lastInteraction],
          );
        }
      }

      onProgress?.({
        stage: "chats",
        message: `Syncing chats (${payload.chats.length})`,
        count: payload.chats.length,
      });
      const splitChats: ChatSplit[] = payload.chats.map(splitChat);
      const chatColumns = [
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
      await bulkInsert(
        client,
        "chat.chats",
        chatColumns,
        [
          "text",
          "text",
          "integer",
          "text",
          "text",
          "text",
          "text",
          "text",
          "boolean",
          "text",
          "text",
          "integer",
          "text",
        ],
        splitChats.map((item) => item.core),
        buildUpsertClause("chat.chats", ["id"], chatColumns.slice(1), true),
      );

      const chatRows = (name: ChatRelationName): SqlStorageRow[] =>
        splitChats.flatMap((item) => [...item[name]]);

      // 1. attributes (PK: chat_id, key)
      const chatAttrRows: ChatAttributeRow[] = splitChats.flatMap((item) =>
        item.attributes.map((row) => ({ ...row, chat_id: item.core.id })),
      );
      await bulkInsert(
        client,
        "chat.attributes",
        ["chat_id", "key", "value"],
        ["text", "text", "jsonb"],
        chatAttrRows,
        buildUpsertClause("chat.attributes", ["chat_id", "key"], ["value"]),
      );
      await pruneKeyedChildren(
        client,
        "chat.attributes",
        "chat_id",
        "key",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          keys: (c.attributes || []).map((a) => a.key),
        })),
      );

      // 2. suggestions (PK: chat_id, position)
      await bulkInsert(
        client,
        "chat.suggestions",
        ["chat_id", "position", "content"],
        ["text", "integer", "text"],
        chatRows("suggestions"),
        buildUpsertClause(
          "chat.suggestions",
          ["chat_id", "position"],
          ["content"],
        ),
      );
      await prunePositionalChildren(
        client,
        "chat.suggestions",
        "chat_id",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          length: (c.suggestions || []).length,
        })),
      );

      // 3. modules (PK: chat_id, position)
      await bulkInsert(
        client,
        "chat.modules",
        ["chat_id", "position", "module_id"],
        ["text", "integer", "text"],
        chatRows("modules"),
        buildUpsertClause(
          "chat.modules",
          ["chat_id", "position"],
          ["module_id"],
        ),
      );
      await prunePositionalChildren(
        client,
        "chat.modules",
        "chat_id",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          length: (c.modules || []).length,
        })),
      );

      // 4. script_state (PK: chat_id, key)
      await bulkInsert(
        client,
        "chat.script_state",
        [
          "chat_id",
          "key",
          "value_type",
          "text_value",
          "number_value",
          "boolean_value",
        ],
        ["text", "text", "text", "text", "double precision", "boolean"],
        chatRows("scriptState"),
        buildUpsertClause(
          "chat.script_state",
          ["chat_id", "key"],
          ["value_type", "text_value", "number_value", "boolean_value"],
        ),
      );
      await pruneKeyedChildren(
        client,
        "chat.script_state",
        "chat_id",
        "key",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          keys: (c.scriptState || []).map((state) => state.key),
        })),
      );

      // 5. bookmarks (PK: chat_id, position)
      await bulkInsert(
        client,
        "chat.bookmarks",
        ["chat_id", "position", "message_id", "name"],
        ["text", "integer", "text", "text"],
        chatRows("bookmarks"),
        buildUpsertClause(
          "chat.bookmarks",
          ["chat_id", "position"],
          ["message_id", "name"],
        ),
      );
      await prunePositionalChildren(
        client,
        "chat.bookmarks",
        "chat_id",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          length: (c.bookmarks || []).length,
        })),
      );

      // 6. memory (PK: chat_id, memory_type)
      await bulkInsert(
        client,
        "chat.memory",
        ["chat_id", "memory_type", "payload"],
        ["text", "text", "jsonb"],
        chatRows("memory"),
        buildUpsertClause(
          "chat.memory",
          ["chat_id", "memory_type"],
          ["payload"],
        ),
      );
      await pruneKeyedChildren(
        client,
        "chat.memory",
        "chat_id",
        "memory_type",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          keys: (c.memory || []).map((entry) => entry.memory_type),
        })),
      );

      // 7. lore_entries (PK: chat_id, position)
      await bulkInsert(
        client,
        "chat.lore_entries",
        [
          "chat_id",
          "position",
          "lore_id",
          "primary_key",
          "secondary_key",
          "insert_order",
          "comment",
          "content",
          "mode",
          "always_active",
          "selective",
          "case_sensitive",
          "activation_percent",
          "use_regex",
          "book_version",
          "folder",
          "cache_payload",
        ],
        [
          "text",
          "integer",
          "text",
          "text",
          "text",
          "integer",
          "text",
          "text",
          "text",
          "boolean",
          "boolean",
          "boolean",
          "double precision",
          "boolean",
          "integer",
          "text",
          "jsonb",
        ],
        chatRows("lore"),
        buildUpsertClause(
          "chat.lore_entries",
          ["chat_id", "position"],
          [
            "lore_id",
            "primary_key",
            "secondary_key",
            "insert_order",
            "comment",
            "content",
            "mode",
            "always_active",
            "selective",
            "case_sensitive",
            "activation_percent",
            "use_regex",
            "book_version",
            "folder",
            "cache_payload",
          ],
        ),
      );
      await prunePositionalChildren(
        client,
        "chat.lore_entries",
        "chat_id",
        splitChats.map((c) => ({
          ownerId: c.core.id,
          length: (c.lore || []).length,
        })),
      );

      onProgress?.({
        stage: "messages",
        message: `Syncing messages (${payload.messages.length})`,
        count: payload.messages.length,
      });
      const splitMessages: MessageSplit[] = payload.messages.map(splitMessage);
      const affectedMessageChatIds = collectAffectedMessageChatIds(payload);
      await this.ensureChatBranchGraphs(
        client,
        splitMessages.map((item) => item.core.chat_id),
      );
      const messageColumns = [
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
      await bulkInsert(
        client,
        "chat.messages",
        messageColumns,
        [
          "text",
          "text",
          "integer",
          "text",
          "text",
          "bytea",
          "text",
          "bigint",
          "text",
          "boolean",
          "text",
          "boolean",
        ],
        splitMessages.map((item) => item.core),
        buildUpsertClause(
          "chat.messages",
          ["chat_id", "id"],
          messageColumns.slice(2),
          true,
        ),
      );
      if (!external?.storageSyncImport) {
        await this.linkIncomingMessagesToActiveBranches(client, splitMessages);
      }

      // 1. message_attributes
      const msgAttrRows: MessageAttributeRow[] = splitMessages.flatMap((item) =>
        item.attributes.map((row) => ({
          ...row,
          chat_id: item.core.chat_id,
          message_id: item.core.id,
        })),
      );
      await bulkInsert(
        client,
        "chat.message_attributes",
        ["chat_id", "message_id", "key", "value"],
        ["text", "text", "text", "jsonb"],
        msgAttrRows,
        buildUpsertClause(
          "chat.message_attributes",
          ["chat_id", "message_id", "key"],
          ["value"],
        ),
      );
      for (const item of splitMessages) {
        const keys = (item.attributes || []).map((attribute) => attribute.key);
        if (keys.length === 0) {
          await client.query(
            "DELETE FROM chat.message_attributes WHERE chat_id = $1 AND message_id = $2",
            [item.core.chat_id, item.core.id],
          );
        } else {
          await client.query(
            "DELETE FROM chat.message_attributes WHERE chat_id = $1 AND message_id = $2 AND NOT (key = ANY($3::text[]))",
            [item.core.chat_id, item.core.id, keys],
          );
        }
      }

      // 2. message_generation
      const genRows = splitMessages.flatMap((item) =>
        item.generation ? [item.generation] : [],
      );
      await bulkInsert(
        client,
        "chat.message_generation",
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
        [
          "text",
          "text",
          "text",
          "text",
          "integer",
          "integer",
          "integer",
          "double precision",
          "double precision",
          "double precision",
          "double precision",
        ],
        genRows,
        buildUpsertClause(
          "chat.message_generation",
          ["chat_id", "message_id"],
          [
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
        ),
      );
      const msgsWithoutGen = splitMessages.filter((m) => !m.generation);
      if (msgsWithoutGen.length > 0) {
        await client.query(
          `DELETE FROM chat.message_generation AS target
                     USING UNNEST($1::text[], $2::text[]) AS spec(chat_id, message_id)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id`,
          [
            msgsWithoutGen.map((m) => m.core.chat_id),
            msgsWithoutGen.map((m) => m.core.id),
          ],
        );
      }

      // 3. message_prompt_info
      const promptInfoRows = splitMessages.flatMap((item) =>
        item.prompt ? [item.prompt.info] : [],
      );
      await bulkInsert(
        client,
        "chat.message_prompt_info",
        ["chat_id", "message_id", "prompt_name"],
        ["text", "text", "text"],
        promptInfoRows,
        buildUpsertClause(
          "chat.message_prompt_info",
          ["chat_id", "message_id"],
          ["prompt_name"],
        ),
      );
      const msgsWithoutPrompt = splitMessages.filter((m) => !m.prompt?.info);
      if (msgsWithoutPrompt.length > 0) {
        await client.query(
          `DELETE FROM chat.message_prompt_info AS target
                     USING UNNEST($1::text[], $2::text[]) AS spec(chat_id, message_id)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id`,
          [
            msgsWithoutPrompt.map((m) => m.core.chat_id),
            msgsWithoutPrompt.map((m) => m.core.id),
          ],
        );
      }

      // 4. message_prompt_toggles
      const toggleRows = splitMessages.flatMap(
        (item) => item.prompt?.toggles || [],
      );
      await bulkInsert(
        client,
        "chat.message_prompt_toggles",
        ["chat_id", "message_id", "position", "toggle_key", "toggle_value"],
        ["text", "text", "integer", "text", "text"],
        toggleRows,
        buildUpsertClause(
          "chat.message_prompt_toggles",
          ["chat_id", "message_id", "position"],
          ["toggle_key", "toggle_value"],
        ),
      );
      if (splitMessages.length > 0) {
        await client.query(
          `DELETE FROM chat.message_prompt_toggles AS target
                     USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(chat_id, message_id, target_len)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id AND target.position >= spec.target_len`,
          [
            splitMessages.map((m) => m.core.chat_id),
            splitMessages.map((m) => m.core.id),
            splitMessages.map((m) => (m.prompt?.toggles || []).length),
          ],
        );
      }

      // 5. message_prompt_items
      const promptItemRows = splitMessages.flatMap(
        (item) => item.prompt?.items || [],
      );
      await bulkInsert(
        client,
        "chat.message_prompt_items",
        ["chat_id", "message_id", "position", "payload"],
        ["text", "text", "integer", "jsonb"],
        promptItemRows,
        buildUpsertClause(
          "chat.message_prompt_items",
          ["chat_id", "message_id", "position"],
          ["payload"],
        ),
      );
      if (splitMessages.length > 0) {
        await client.query(
          `DELETE FROM chat.message_prompt_items AS target
                     USING UNNEST($1::text[], $2::text[], $3::integer[]) AS spec(chat_id, message_id, target_len)
                     WHERE target.chat_id = spec.chat_id AND target.message_id = spec.message_id AND target.position >= spec.target_len`,
          [
            splitMessages.map((m) => m.core.chat_id),
            splitMessages.map((m) => m.core.id),
            splitMessages.map((m) => (m.prompt?.items || []).length),
          ],
        );
      }

      if (payload.characterDeletes?.length) {
        await client.query(
          "DELETE FROM character.characters WHERE id = ANY($1::text[])",
          [payload.characterDeletes],
        );
      }
      if (payload.chatDeletes?.length) {
        await client.query(
          "DELETE FROM chat.chats WHERE id = ANY($1::text[])",
          [payload.chatDeletes],
        );
      }
      if (payload.messageDeletes) {
        await this.detachMessagesFromBranchGraph(
          client,
          payload.messageDeletes,
        );
        for (const del of payload.messageDeletes) {
          if (del.ids.length > 0) {
            await client.query(
              `DELETE FROM chat.messages
                             WHERE chat_id = $1 AND id = ANY($2::text[])`,
              [del.chatId, del.ids],
            );
          }
        }
      }
      if (affectedMessageChatIds.size > 0) {
        await client.query(
          `UPDATE chat.chats AS ch
                        SET last_message_time = (
                            SELECT m.sent_time
                              FROM chat.messages AS m
                             WHERE m.chat_id = ch.id
                             ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                             LIMIT 1
                        ), updated_at = NOW()
                      WHERE ch.id = ANY($1::text[])`,
          [Array.from(affectedMessageChatIds)],
        );
      }

      if (ownsTransaction) {
        onProgress?.({
          stage: "finalizing",
          message: "Updating metadata and committing",
        });
        await client.query(
          `UPDATE system.storage_meta
                   SET revision = $1, initialized = TRUE, updated_at = NOW()
                   WHERE singleton = TRUE`,
          [nextRevision],
        );
        await authorNoteSql.writeAuthorNoteReceipt(noteDb, payload, {
          revision: nextRevision,
          authorNotes: summarizeAuthorNotes(authorNotes),
        });
        await client.query("COMMIT");
      }
      invalidateSyncCaches(this, payload);
      return buildSyncResult({
        payload,
        revision: nextRevision,
        authorNotes,
      });
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      ownedClient?.release();
    }
  }

  async listRecentChats(rawLimit: unknown, activeChatId: unknown = null) {
    this.assertEnabled();
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;
    const result = await this.pool.query<RecentChatRow>(
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
                       FROM chat.messages AS m
                      WHERE m.chat_id = ch.id
                      ORDER BY m.position DESC, m.sent_time DESC NULLS LAST, m.id DESC
                      LIMIT 1) AS last_message_text
               FROM chat.chats AS ch
               JOIN character.characters AS c ON c.id = ch.character_id
              WHERE c.trash_time IS NULL
              ORDER BY CASE WHEN ch.id = $2 THEN 1 ELSE 0 END DESC,
                       CASE
                         WHEN ch.id = $2 THEN GREATEST(COALESCE(ch.last_message_time, 0), COALESCE(c.last_interaction_time, 0), 0)
                         WHEN ch.last_message_time IS NOT NULL THEN ch.last_message_time
                         WHEN ch.position = 0 THEN COALESCE(c.last_interaction_time, 0)
                         ELSE 0
                       END DESC, ch.id
              LIMIT $1`,
      [limit, activeChatId],
    );
    return result.rows.map((row) => mapRecentChatRow(row));
  }

  async searchMessages(rawQuery: unknown, rawScope = "all", rawLimit = 50) {
    this.assertEnabled();
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query) {
      throw new PostgresPayloadError("search query must be a non-empty string");
    }
    if (query.length > 1024) {
      throw new PostgresPayloadError(
        "search query must be at most 1024 characters",
      );
    }
    const scope =
      rawScope === "active" || rawScope === "cold" ? rawScope : "all";
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 50;

    const result = await this.pool.query<MessageSearchRow>(
      `SELECT
                 m.storage_state,
                 m.archive_id,
                 COALESCE(ch.character_id, a.owner_character_id) AS character_id,
                 COALESCE(c.name, a.character_name) AS character_name,
                 m.chat_id,
                 COALESCE(ch.name, '') AS chat_name,
                 m.message_id,
                 m.position,
                 m.role,
                 m.sent_time,
                 m.sender_name,
                 ts_headline('simple', m.content_text, websearch_to_tsquery('simple', $1),
                     'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=12') AS snippet
             FROM chat.all_messages AS m
             LEFT JOIN chat.chats AS ch
                 ON m.storage_state = 'active' AND ch.id = m.chat_id
             LEFT JOIN character.characters AS c ON c.id = ch.character_id
             LEFT JOIN cold.archives AS a
                 ON m.storage_state = 'cold' AND a.id = m.archive_id
             WHERE m.content_text IS NOT NULL
               AND to_tsvector('simple', m.content_text) @@ websearch_to_tsquery('simple', $1)
               AND ($2::text = 'all' OR m.storage_state = $2)
             ORDER BY ts_rank(to_tsvector('simple', m.content_text), websearch_to_tsquery('simple', $1)) DESC,
                      m.sent_time DESC
             LIMIT $3`,
      [query, scope, limit],
    );
    return result.rows.map((row) => ({
      storageState: row.storage_state,
      archiveId: row.archive_id,
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
  }

  async getTokenUsage() {
    this.assertEnabled();
    const result = await this.pool.query<TokenUsageRow>(
      `SELECT model,
                    COUNT(*)::integer AS message_count,
                    COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
                    COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens
             FROM (
                 SELECT model, input_tokens, output_tokens FROM chat.message_generation
                 UNION ALL
                 SELECT model, input_tokens, output_tokens FROM cold.message_generation
             ) AS generation
             WHERE model IS NOT NULL
             GROUP BY model
             ORDER BY total_output_tokens DESC, total_input_tokens DESC`,
    );
    return result.rows.map((row) => mapTokenUsageRow(row));
  }

  async getBotChatStats() {
    this.assertEnabled();
    const result = await this.pool.query<BotChatStatsRow>(
      `WITH session_counts AS (
                SELECT
                    ch.character_id,
                    ch.id AS chat_id,
                    COUNT(m.id)::integer AS session_msgs,
                    MAX(m.sent_time)::bigint AS max_sent_time,
                    MAX(ch.last_message_time)::bigint AS last_msg_time
                FROM chat.chats ch
                LEFT JOIN chat.messages m ON m.chat_id = ch.id
                GROUP BY ch.character_id, ch.id
            ),
            char_msg_stats AS (
                SELECT
                    ch.character_id,
                    COUNT(m.id)::integer AS total_messages,
                    COUNT(CASE WHEN m.role = 'user' THEN 1 END)::integer AS user_messages,
                    COUNT(CASE WHEN m.role = 'char' THEN 1 END)::integer AS bot_messages,
                    AVG(CASE WHEN m.role = 'char' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END)::double precision AS avg_bot_len,
                    AVG(CASE WHEN m.role = 'user' AND m.content_text IS NOT NULL THEN LENGTH(m.content_text) END)::double precision AS avg_user_len
                FROM chat.chats ch
                JOIN chat.messages m ON m.chat_id = ch.id
                GROUP BY ch.character_id
            )
            SELECT
                c.id,
                c.name,
                c.image,
                c.kind,
                COUNT(sc.chat_id)::integer AS total_sessions,
                COALESCE(cms.total_messages, 0)::integer AS total_messages,
                COALESCE(cms.user_messages, 0)::integer AS user_messages,
                COALESCE(cms.bot_messages, 0)::integer AS bot_messages,
                COALESCE(MAX(sc.session_msgs), 0)::integer AS longest_session_messages,
                COALESCE(MAX(sc.max_sent_time), MAX(sc.last_msg_time), c.last_interaction_time)::bigint AS last_active_date,
                ROUND(COALESCE(cms.avg_bot_len, 0))::integer AS avg_bot_message_len,
                ROUND(COALESCE(cms.avg_user_len, 0))::integer AS avg_user_message_len
            FROM character.characters c
            LEFT JOIN session_counts sc ON sc.character_id = c.id
            LEFT JOIN char_msg_stats cms ON cms.character_id = c.id
            GROUP BY c.id, c.name, c.image, c.kind, c.position, c.last_interaction_time, cms.total_messages, cms.user_messages, cms.bot_messages, cms.avg_bot_len, cms.avg_user_len
            ORDER BY c.position ASC`,
    );
    return result.rows.map((row) => mapBotChatStatsRow(row));
  }

  async searchCharactersByTag(rawTag: unknown, rawLimit = 100) {
    this.assertEnabled();
    const tag = typeof rawTag === "string" ? rawTag.trim() : "";
    if (!tag) {
      throw new PostgresPayloadError("tag must be a non-empty string");
    }
    if (tag.length > 256) {
      throw new PostgresPayloadError("tag must be at most 256 characters");
    }
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const result = await this.pool.query<CharacterSummaryRow>(
      `SELECT c.id, c.name, c.image, c.kind
             FROM character.tags AS t
             JOIN character.characters AS c ON c.id = t.character_id
             WHERE t.tag ILIKE '%' || $1 || '%'
             ORDER BY c.name
             LIMIT $2`,
      [tag, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      image: row.image,
      kind: row.kind,
    }));
  }

  async searchCharactersByName(rawName: unknown, rawLimit = 100) {
    this.assertEnabled();
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      throw new PostgresPayloadError("name must be a non-empty string");
    }
    if (name.length > 256) {
      throw new PostgresPayloadError("name must be at most 256 characters");
    }
    const parsedLimit = Number.parseInt(String(rawLimit), 10);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const result = await this.pool.query<CharacterSummaryRow>(
      `SELECT id, name, image, kind
             FROM character.characters
             WHERE LOWER(name) LIKE '%' || LOWER($1) || '%'
             ORDER BY name
             LIMIT $2`,
      [name, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      image: row.image,
      kind: row.kind,
    }));
  }

  async listDbExplorerTables() {
    this.assertEnabled();
    const result = await this.pool.query<{ table_name: string }>(
      `SELECT (table_schema || '.' || table_name) AS table_name
             FROM information_schema.tables
             WHERE table_schema IN ('system', 'character', 'chat', 'cold') AND table_type = 'BASE TABLE'
             ORDER BY table_schema, table_name`,
    );
    const tables = result.rows.map((row) =>
      assertDbExplorerIdentifier(row.table_name, "table name"),
    );
    const counts = new Map<string, unknown>();
    for (let i = 0; i < tables.length; i += 25) {
      const union = tables
        .slice(i, i + 25)
        .map(
          (name) =>
            `SELECT '${name}' AS table_name, COUNT(*)::text AS row_count FROM ${assertSqlIdentifier(name)}`,
        )
        .join(" UNION ALL ");
      const countResult = await this.pool.query<{
        table_name: string;
        row_count: string | number;
      }>(union);
      for (const row of countResult.rows) {
        counts.set(row.table_name, row.row_count);
      }
    }
    return tables.map((name) => ({
      name,
      rowCount: Number(counts.get(name) ?? "0"),
    }));
  }

  async getDbExplorerTableColumns(table: unknown): Promise<ExplorerColumn[]> {
    this.assertEnabled();
    const validated = assertDbExplorerIdentifier(table, "table name");
    const parts = validated.split(".");
    const schemaName = parts.length === 2 ? parts[0] : "public";
    const tableName = parts.length === 2 ? parts[1] : parts[0];

    const exists = await this.pool.query(
      `SELECT 1
             FROM information_schema.tables
             WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name = $2`,
      [schemaName, tableName],
    );
    if (exists.rows.length === 0) {
      throw new PostgresPayloadError("table was not found");
    }
    const columns = await this.pool.query<ExplorerColumnRow>(
      `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
      [schemaName, tableName],
    );
    const primaryKeyResult = await this.pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
             FROM pg_index AS i
             JOIN pg_class AS c ON c.oid = i.indrelid
             JOIN pg_namespace AS n ON n.oid = c.relnamespace
             JOIN pg_attribute AS a
                 ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
             WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
      [schemaName, tableName],
    );
    const primaryKeys = new Set<string>(
      primaryKeyResult.rows.map((row) => row.column_name),
    );
    return columns.rows.map((row) => ({
      name: assertDbExplorerIdentifier(row.column_name, "column name"),
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      primaryKey: primaryKeys.has(row.column_name),
    }));
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
    const quotedTable = assertSqlIdentifier(validated);
    const columns = await this.getDbExplorerTableColumns(table);
    if (columns.length === 0) {
      throw new PostgresPayloadError("table has no columns");
    }

    let visibleColumns = columns;
    if (rawColumns !== null && rawColumns !== undefined) {
      if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
        throw new PostgresPayloadError("column list must not be empty");
      }
      const visibleNames: string[] = [];
      for (const name of rawColumns) {
        const validatedCol = assertDbExplorerIdentifier(name, "column name");
        const match = columns.find((column) => column.name === validatedCol);
        if (!match) {
          throw new PostgresPayloadError("column was not found in the table");
        }
        if (!visibleNames.includes(validatedCol)) {
          visibleNames.push(validatedCol);
        }
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
      if (!match) {
        throw new PostgresPayloadError(
          "sort column was not found in the table",
        );
      }
      sortColumn = match.name;
    }
    const sortOrder = rawSortOrder === "desc" ? "DESC" : "ASC";

    const selectList = visibleColumns
      .map((column) => dbExplorerSelectExpression(column.name, column.dataType))
      .join(", ");

    const searchTerms: SqlParameter[] = [];
    let whereClause = "";
    if (searchTerm.length > 0) {
      const escaped = searchTerm.replace(/([%_\\])/g, "\\$1");
      const conditions = visibleColumns
        .map((column) => `("${column.name}")::text ILIKE $1`)
        .join(" OR ");
      whereClause = ` WHERE (${conditions})`;
      searchTerms.push(`%${escaped}%`);
    }
    const rowParams = [...searchTerms, limit, offset];
    const rows = await this.pool.query(
      `SELECT ${selectList}
             FROM ${quotedTable}${whereClause}
             ORDER BY "${sortColumn}" ${sortOrder} NULLS LAST
             LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
      rowParams,
    );
    const count = await this.pool.query<{ total: string | number }>(
      `SELECT COUNT(*)::text AS total FROM ${quotedTable}${whereClause}`,
      searchTerms,
    );
    return {
      table,
      columns: visibleColumns,
      allColumns: columns,
      rows: rows.rows,
      offset,
      limit,
      total: Number(count.rows[0].total),
    };
  }
}

export type { SqlStorageRow };

export {
  DEFERRED_SETTING_KEYS,
  PostgresPayloadError,
  PostgresRevisionConflictError,
  PostgresStorage,
  buildUpsertClause,
  decodePostgresJsonValue,
  encodePostgresJsonValue,
  normalizeColdStorageKey,
  validateColdStorageKeys,
  validateColdStorageValue,
  validateSyncPayload,
};
