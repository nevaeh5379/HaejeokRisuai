import * as authorNoteSql from "@risuai/protocol/src/authorNoteSql.ts";
import type {
  botPreset,
  character,
  Chat,
  customscript,
  CanonicalDatabase,
  Database as DatabaseType,
  DatabaseSettings,
  groupChat,
  loreBook,
  Message,
  RisuPersona,
} from "../../database/schema";
import type { RisuModule } from "../../../process/modules";
import { v4 as uuidv4 } from "uuid";
import { buildLegacyBranchMigrationPlan } from "@risuai/protocol/legacyBranchMigration.ts";
import type {
  ISqlStorage,
  BotPresetSummary,
  SqlStartupDataResult,
  SqlDatabaseSnapshotResult,
  SqlRecentChatMetadata,
  SqlChatBranchSummary,
  SqlCreateChatBranchInput,
  StoredBotPreset,
} from "../ISqlStorage";
import type {
  NodePostgresBotChatStats,
  NodePostgresCharacterSearchResult,
  NodePostgresMessageSearchResult,
  NodePostgresRestorePreview,
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresTokenUsage,
  NodePostgresColumnInfo,
  NodePostgresTableData,
  NodePostgresTableInfo,
} from "../postgres/nodeSqlStorage";
import {
  buildSqlReplaceCommit,
  type SqlCommit,
  type SqlCommitResult,
  SqlRevisionConflictError,
} from "../sqlCommit";
import type { IPluginStorage } from "../pluginStorage";
import { SqlitePluginStorage } from "./sqlitePluginStorage";
import * as sqliteCommit from "@risuai/storage-sqlite/commit/apply";
import * as sqliteCommitPrep from "@risuai/storage-sqlite/commit/prepare";
import * as sqliteAdmin from "@risuai/storage-sqlite/queries/admin";
import * as sqliteBranch from "@risuai/storage-sqlite/queries/branch";
import * as sqliteChat from "@risuai/storage-sqlite/queries/chat";
import * as sqliteColdStorage from "@risuai/storage-sqlite/queries/coldStorage";
import * as sqliteDocument from "@risuai/storage-sqlite/queries/document";
import * as sqliteEntity from "@risuai/storage-sqlite/queries/entity";
import * as sqliteMessages from "@risuai/storage-sqlite/queries/messages";
import * as sqliteNodes from "@risuai/storage-sqlite/queries/nodes";
import * as sqlitePlugin from "@risuai/storage-sqlite/queries/plugin";
import * as sqliteRevisions from "@risuai/storage-sqlite/queries/revisions";
import * as sqliteSnapshot from "@risuai/storage-sqlite/queries/snapshot";
import * as sqliteStartup from "@risuai/storage-sqlite/queries/startup";
import * as nodeCodec from "@risuai/storage-sqlite/schema/codec";
import * as lastMessageTime from "@risuai/storage-sqlite/schema/lastMessageTime";
import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
  SqliteStatement,
} from "@risuai/storage-sqlite/types";
import {
  AsyncSerialQueue,
  normalizeLimit,
  normalizePageEnd,
} from "@risuai/storage-sqlite/util";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
} from "../sqlDeferredSettings";
import {
  rebuildBranchGraphMessages,
  rebuildMessageRows,
} from "./sqliteStorageUtils";

export abstract class NativeSqliteStorageBase implements ISqlStorage {
  abstract readonly backendKind: "tauri-sqlite" | "capacitor-sqlite";

  readonly plugin: IPluginStorage = new SqlitePluginStorage(
    this,
    this.selectRows.bind(this) as SqliteSelectRows,
  );
  protected revision = 0;
  protected readonly writeQueue = new AsyncSerialQueue();
  protected _enabled = false;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private lastInitError: string | null = null;

  protected abstract readonly backendName: string;
  protected abstract isPlatformAvailable(): boolean;
  protected abstract openBackend(): Promise<void>;
  protected abstract applySchema(): Promise<void>;
  protected abstract cleanupBackend(): Promise<void>;
  protected abstract isStorageReady(): boolean;

  protected abstract selectRows<T extends Record<string, unknown>>(
    sql: string,
    bind?: unknown[],
  ): Promise<T[]>;

  protected async selectRowSets(
    queries: SqliteStatement[],
  ): Promise<Record<string, unknown>[][]> {
    const results: Record<string, unknown>[][] = [];
    for (const query of queries) {
      results.push(await this.selectRows(query.sql, query.bind ?? []));
    }
    return results;
  }

  protected abstract executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteStatement[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void>;

  getLastInitError(): string | null {
    return this.lastInitError;
  }

  async init(): Promise<boolean> {
    if (this.initialized) return this._enabled;
    if (!this.isPlatformAvailable()) {
      this.initialized = true;
      this._enabled = false;
      return false;
    }
    if (!this.initPromise) {
      this.initPromise = this.initializeStorage().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  private async initializeStorage(): Promise<boolean> {
    try {
      this.lastInitError = null;
      await this.openBackend();
      const existingSchema = await this.validateExistingSchema();
      const hadLastMessageTimeTrigger = existingSchema
        ? await this.hasLastMessageTimeTrigger()
        : false;
      if (existingSchema) this.revision = existingSchema.revision;
      // The schema is intentionally idempotent. Reapply it on startup so
      // additive DDL such as triggers reaches existing relational-schema-v3
      // databases without forcing a destructive schema-version migration.
      await this.applySchema();
      await authorNoteSql.ensureAuthorNoteReceipts({
        ...this.authorNoteDatabase(),
        execute: async (sql, bind = []) => {
          await this.executeNativeTransaction(null, [{ sql, bind }]);
        },
      });
      if (!existingSchema) await this.loadRevisionFromMeta();
      await this.ensurePerformanceIndexes();
      await this.ensureLastMessageTimeInvariant(hadLastMessageTimeTrigger);
      this._enabled = true;
      this.initialized = true;
      return true;
    } catch (error) {
      this.lastInitError =
        error instanceof Error ? error.message || error.name : String(error);
      console.error(`${this.backendName} init failed:`, error);
      try {
        await this.cleanupBackend();
      } catch {
        // Preserve the initialization error even if cleanup also fails.
      }
      this.initialized = true;
      this._enabled = false;
      if (error instanceof nodeCodec.SchemaResetRequiredError) throw error;
      return false;
    }
  }

  private async validateExistingSchema(): Promise<{ revision: number } | null> {
    const existingMeta = await this.selectRows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_storage_meta'",
    );
    if (existingMeta.length === 0) return null;

    const rows = await this.selectRows<{
      schema_version: number;
      schema_layout: string;
      revision: number;
    }>(
      "SELECT schema_version, schema_layout, revision FROM system_storage_meta WHERE singleton = 1",
    );
    const meta = rows[0];
    if (
      Number(meta?.schema_version) !== nodeCodec.SCHEMA_VERSION ||
      meta?.schema_layout !== nodeCodec.SCHEMA_LAYOUT
    ) {
      throw new nodeCodec.SchemaResetRequiredError(
        meta?.schema_version,
        meta?.schema_layout,
      );
    }
    return { revision: Number(meta.revision) || 0 };
  }

  private async loadRevisionFromMeta(): Promise<void> {
    const rows = await this.selectRows<{ revision: number }>(
      "SELECT revision FROM system_storage_meta WHERE singleton = 1",
    );
    if (rows.length > 0) this.revision = Number(rows[0].revision) || 0;
  }

  private async ensurePerformanceIndexes(): Promise<void> {
    await this.executeNativeTransaction(null, [
      {
        sql: "CREATE TABLE IF NOT EXISTS module_records (module_id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE CHECK (position >= 0), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
        bind: [],
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS module_records_position_idx ON module_records (position)",
        bind: [],
      },
      {
        sql: "CREATE TABLE IF NOT EXISTS module_extension_nodes (module_id TEXT NOT NULL REFERENCES module_records(module_id) ON DELETE CASCADE, node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0), object_key TEXT, object_key_encoded TEXT, value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')), text_value TEXT, encoded_text_value TEXT, number_value REAL, boolean_value INTEGER CHECK (boolean_value IN (0, 1)), PRIMARY KEY (module_id, node_id), FOREIGN KEY (module_id, parent_node_id) REFERENCES module_extension_nodes(module_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, CHECK (node_id = 0 OR parent_node_id IS NOT NULL), CHECK (text_value IS NULL OR encoded_text_value IS NULL), CHECK (object_key IS NULL OR object_key_encoded IS NULL))",
        bind: [],
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS module_nodes_parent_idx ON module_extension_nodes (module_id, parent_node_id, node_order)",
        bind: [],
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS chats_recent_idx ON chats (last_message_time DESC)",
        bind: [],
      },
      ...sqliteBranch.SCHEMA_STATEMENTS,
    ]);
  }

  private async hasLastMessageTimeTrigger(): Promise<boolean> {
    const existing = await this.selectRows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      [lastMessageTime.TRIGGER_NAME],
    );
    return existing.length > 0;
  }

  private async ensureLastMessageTimeInvariant(
    existedBeforeSchemaApply: boolean,
  ): Promise<void> {
    if (!(await this.hasLastMessageTimeTrigger())) {
      throw new Error(
        "SQLite last_message_time trigger was not installed by the schema",
      );
    }
    if (!existedBeforeSchemaApply) {
      await this.executeNativeTransaction(null, [
        { sql: lastMessageTime.BACKFILL_SQL, bind: [] },
      ]);
    }
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const projection = await sqliteStartup.loadProjection(
      this.selectRowSets.bind(this) as SqliteSelectRowSets,
      this.revision,
      DEFERRED_STARTUP_SETTING_KEYS,
      SETTINGS_STORE_EXCLUDED_KEYS,
    );
    return {
      status: projection.status,
      revision: projection.revision,
      settings: Object.fromEntries(
        projection.settings,
      ) as Partial<DatabaseSettings>,
      characters: projection.characters.map(
        (row) =>
          ({
            chaId: row.id,
            type: row.kind,
            name: row.name,
            image: row.image,
            trashTime: row.trashTime,
            creationDate: row.creationDate,
            modificationDate: row.modificationDate,
            lastInteraction: row.lastInteraction,
            detailsLoaded: false,
            chats: [],
            chatPage: 0,
          }) as unknown as character | groupChat,
      ),
      deferredSettingKeys: projection.deferredSettingKeys,
    };
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    return (await sqliteSnapshot.exportDatabase({
      selectRows: this.selectRows.bind(this) as SqliteSelectRows,
      selectRowSets: this.selectRowSets.bind(this) as SqliteSelectRowSets,
      revision: this.revision,
      legacyPersonaMirrorKeys: LEGACY_PERSONA_MIRROR_KEYS,
      loadChatMessages: (chatId) => this.loadChatMessages(chatId),
    })) as SqlDatabaseSnapshotResult;
  }

  protected async commitInternal(
    commit: SqlCommit,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<SqlCommitResult> {
    if (!this._enabled || !this.isStorageReady()) {
      throw new Error("SQLite storage is not enabled");
    }
    // Read 1 of 2: fail fast on a stale base revision before building the
    // statement list. The authoritative check happens inside the native
    // transaction (see executeNativeTransaction), which re-reads the revision
    // under BEGIN IMMEDIATE — this optimistic pre-check just avoids
    // serializing large commits that are doomed to conflict.
    const meta = await this.selectOne<{ revision: number }>(
      "SELECT revision FROM system_storage_meta WHERE singleton = 1",
    );
    const currentRevision = Number(meta?.revision) || 0;
    const receipt = await authorNoteSql.readAuthorNoteReceipt(
      this.authorNoteDatabase(),
      commit,
    );
    if (receipt) return receipt;
    if (commit.baseRevision !== currentRevision) {
      throw new SqlRevisionConflictError(currentRevision);
    }
    await this.prepareModuleCommit(commit);
    await this.validatePresetCommit(commit);

    const statements: SqliteStatement[] = [];
    const append = async (sql: string, bind: unknown[] = []) => {
      statements.push({ sql, bind });
    };
    if (commit.replaceAll) {
      await append("DELETE FROM system_settings");
      await append("DELETE FROM plugin_custom_storage");
      await append("DELETE FROM characters");
    }
    const authorNotes = await authorNoteSql.applyAuthorNotes(
      { ...this.authorNoteDatabase(), execute: append },
      commit.authorNotes,
    );
    await sqliteCommit.apply(commit, append);
    const revision = currentRevision + 1;
    await append(
      "UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1",
      [revision],
    );
    const action =
      commit.action || (commit.replaceAll ? "replace-all" : "sync");
    await append(
      "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
      [revision, action],
    );
    await authorNoteSql.writeAuthorNoteReceipt(
      { ...this.authorNoteDatabase(), execute: append },
      commit,
      {
        revision,
        authorNotes: authorNotes.map(({ id, contentHash, updatedAt }) => ({
          id,
          contentHash,
          updatedAt,
        })),
      },
    );
    await this.executeNativeTransaction(
      currentRevision,
      statements,
      onProgress,
    );
    this.revision = revision;
    return {
      revision,
      ...(authorNotes.length
        ? {
            authorNotes: authorNotes.map(({ id, contentHash, updatedAt }) => ({
              id,
              contentHash,
              updatedAt,
            })),
          }
        : {}),
    };
  }

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    return this.writeQueue.run(async () => {
      const statements: SqliteStatement[] = [];
      await sqliteCommit.writeColdStorage(
        async (sql, bind = []) => {
          statements.push({ sql, bind });
        },
        key,
        value,
      );
      await this.executeNativeTransaction(null, statements);
      return true;
    });
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  getRevision(): number {
    return this.revision;
  }

  async getStorageSyncSummary() {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    return await sqliteStartup.getSyncSummary(
      this.selectRows.bind(this) as SqliteSelectRows,
      this.revision,
    );
  }

  protected async selectOne<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.selectRows<T>(sql, bind);
    return rows[0] ?? null;
  }

  protected loadNodeValue(
    table: string,
    ownerWhere: string,
    bind: unknown[],
  ): Promise<unknown> {
    return sqliteNodes.loadValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      table,
      ownerWhere,
      bind,
    );
  }

  protected loadSettingValue(key: string): Promise<unknown> {
    return sqliteNodes.loadSettingValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  protected async prepareModuleCommit(commit: SqlCommit): Promise<void> {
    await sqliteCommitPrep.prepareModules(
      this.selectRows.bind(this) as SqliteSelectRows,
      commit,
    );
  }

  /**
   * Rebuilds one relational value per owner from a single grouped query.
   * Mirrors WebSqliteStorage's batching so native backends avoid one bridge
   * round trip per chat (N+1) when hydrating a character's chat metadata.
   */
  protected rebuildGroupedNodeValues(
    rows: Record<string, unknown>[],
    ownerKey: string,
  ): Map<string, unknown> {
    return sqliteNodes.groupValues(rows, ownerKey);
  }

  protected async validatePresetCommit(commit: SqlCommit): Promise<void> {
    await sqliteCommitPrep.validatePresets(
      this.selectRows.bind(this) as SqliteSelectRows,
      commit,
    );
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    return this.writeQueue.run(() => this.commitInternal(commit));
  }

  async replaceDatabase(
    database: DatabaseType,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean> {
    onProgress?.("Preparing local database...", 0);
    const commit = buildSqlReplaceCommit(database, this.revision);
    onProgress?.("Preparing SQL transaction...", 0.05);
    await this.writeQueue.run(() =>
      this.commitInternal(commit, (completed, total) => {
        const ratio = total > 0 ? completed / total : 1;
        onProgress?.(
          `Syncing database... (${completed}/${total})`,
          0.05 + ratio * 0.94,
        );
      }),
    );
    onProgress?.("Database sync complete", 1);
    return true;
  }

  async loadCharacter(
    characterId: string,
  ): Promise<character | groupChat | null> {
    return (await sqliteEntity.loadCharacterDocument(
      this.selectRows.bind(this) as SqliteSelectRows,
      characterId,
    )) as unknown as character | groupChat | null;
  }

  async loadCharacterAssetFields(
    characterId: string,
  ): Promise<Partial<character> | null> {
    const row = await this.selectOne<{ id: string }>(
      "SELECT id FROM characters WHERE id = ?",
      [characterId],
    );
    if (!row) return null;
    const query = sqliteEntity.buildCharacterAssetFieldsQuery(characterId);
    const rows = await this.selectRows(query.sql, query.bind);
    const assets = rows.length
      ? (nodeCodec.rebuild(rows as any) as Record<string, unknown>)
      : {};
    return assets as Partial<character>;
  }

  async loadCharacterForSelection(
    characterId: string,
  ): Promise<character | groupChat | null> {
    // Interactive selection only needs the character tree plus chat summary
    // rows. Hydrating every chat's extension nodes here would defeat lazy
    // loading on character switches. Keep the three independent reads in one
    // backend batch so Capacitor crosses the JS/native bridge only once.
    const [characterRows, characterNodeRows, chatRowsRaw] =
      await this.selectRowSets([
        {
          sql: "SELECT id FROM characters WHERE id = ?",
          bind: [characterId],
        },
        {
          sql: `SELECT node_id, parent_node_id, node_order, object_key,
                     object_key_encoded, value_type, text_value, encoded_text_value,
                     number_value, boolean_value
                FROM character_extension_nodes
               WHERE character_id = ?
               ORDER BY node_id`,
          bind: [characterId],
        },
        {
          sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
          bind: [characterId],
        },
      ]);
    if (characterRows.length === 0) return null;
    const fullChar = (
      characterNodeRows.length ? nodeCodec.rebuild(characterNodeRows) : {}
    ) as any;
    const chatRows = chatRowsRaw as Array<{
      id: string;
      name: string;
      note: string;
      folder_id: string | null;
      last_message_time: number | null;
    }>;
    fullChar.chaId = characterId;
    fullChar.detailsLoaded = true;
    fullChar.chats = chatRows.map((chatRow) => ({
      id: chatRow.id,
      name: chatRow.name ?? "",
      note: chatRow.note ?? "",
      folderId: chatRow.folder_id ?? undefined,
      lastDate: chatRow.last_message_time ?? undefined,
      message: [],
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    })) as Chat[];
    return fullChar;
  }

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    const plan = sqliteChat.buildLoadPlan(chatId, options?.messageLimit);
    const [
      chatRows,
      chatNodeRows,
      totalRows,
      messageRows,
      activeBranchRows,
      branchCountRows,
    ] = await this.selectRowSets(sqliteChat.loadStatements(plan));
    const chatRow = chatRows[0] as sqliteChat.Row | undefined;
    if (!chatRow) return null;
    const activeBranch = activeBranchRows[0] as
      { branch_id: string } | undefined;
    const branchCount = Number(
      (branchCountRows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    const extension = (
      chatNodeRows.length ? nodeCodec.rebuild(chatNodeRows) : {}
    ) as Record<string, unknown>;
    if (
      await this.migrateLegacyBranchGraphIfNeeded(
        chatId,
        extension,
        branchCount,
      )
    ) {
      return this.loadChat(chatId, options);
    }
    if (!activeBranch) {
      await this.ensureBranchGraph(chatId);
      return this.loadChat(chatId, options);
    }
    const total = Number(
      (totalRows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    return sqliteChat.hydrateDocument(
      chatRow,
      extension,
      rebuildMessageRows(messageRows),
      total,
      activeBranch.branch_id,
    ) as unknown as Chat;
  }

  async loadChatMessages(
    chatId: string,
    options?: { mode?: "full" | "generation" },
  ): Promise<Message[]> {
    await this.ensureBranchGraph(chatId);
    const query = sqliteMessages.buildBranchRowsQuery(
      chatId,
      undefined,
      undefined,
      options?.mode === "generation" ? "generation" : "full",
    );
    return rebuildMessageRows(await this.selectRows(query.sql, query.bind));
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    await this.ensureBranchGraph(chatId);
    const totalQuery = sqliteMessages.buildBranchCountQuery(chatId);
    const totalRow = await this.selectOne<{ total: number }>(
      totalQuery.sql,
      totalQuery.bind,
    );
    const page = sqliteChat.buildMessagePagePlan(
      chatId,
      before,
      Number(totalRow?.total ?? 0),
      limit,
    );
    return {
      messages: rebuildMessageRows(
        await this.selectRows(page.statement.sql, page.statement.bind),
      ),
      offset: page.offset,
      total: page.total,
      hasMore: page.hasMore,
    };
  }

  private async loadLinearMessages(chatId: string): Promise<Message[]> {
    const query = sqliteMessages.buildRowsQuery(
      chatId,
      undefined,
      0,
      false,
      "full",
    );
    return rebuildMessageRows(await this.selectRows(query.sql, query.bind));
  }

  private async loadLegacyChatExtension(
    chatId: string,
  ): Promise<Record<string, any>> {
    const rows = await this.selectRows(
      `SELECT node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
         FROM chat_extension_nodes WHERE chat_id = ? ORDER BY node_id`,
      [chatId],
    );
    return (rows.length ? nodeCodec.rebuild(rows) : {}) as Record<string, any>;
  }

  private async migrateLegacyBranchGraphIfNeeded(
    chatId: string,
    knownChatData?: Record<string, any>,
    knownBranchCount?: number,
  ): Promise<boolean> {
    const branchCount =
      knownBranchCount ??
      (await sqliteBranch.count(
        this.selectRows.bind(this) as SqliteSelectRows,
        chatId,
      ));
    if (branchCount > 1) return false;
    const chatData =
      knownChatData ?? (await this.loadLegacyChatExtension(chatId));
    if (
      !Array.isArray(chatData.branchState?.branches) ||
      chatData.branchState.branches.length <= 1
    ) {
      return false;
    }
    return this.writeQueue.run(async () => {
      const currentCount = await sqliteBranch.count(
        this.selectRows.bind(this) as SqliteSelectRows,
        chatId,
      );
      if (currentCount > 1) return false;
      const plan = buildLegacyBranchMigrationPlan(
        {
          ...chatData,
          id: chatId,
          message: await this.loadLinearMessages(chatId),
        },
        uuidv4,
      );
      if (!plan) return false;
      await this.executeNativeTransaction(
        null,
        sqliteBranch.buildLegacyMigrationStatements(chatId, chatData, plan),
      );
      return true;
    });
  }

  private async ensureBranchGraph(chatId: string): Promise<void> {
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId)) return;
    await this.writeQueue.run(() =>
      this.executeNativeTransaction(
        null,
        sqliteBranch.ensureGraphStatements(chatId),
      ),
    );
  }

  async listChatBranches(chatId: string): Promise<SqlChatBranchSummary[]> {
    await this.ensureBranchGraph(chatId);
    return (await sqliteBranch.list(
      this.selectRows.bind(this) as SqliteSelectRows,
      chatId,
    )) as SqlChatBranchSummary[];
  }

  async loadChatBranchGraph(chatId: string) {
    await this.ensureBranchGraph(chatId);
    const metadata = await sqliteBranch.loadMetadata(
      this.selectRows.bind(this) as SqliteSelectRows,
      chatId,
    );
    const graphQuery = sqliteMessages.buildGraphRowsQuery(chatId);
    const graphRows = await this.selectRows<Record<string, unknown>>(
      graphQuery.sql,
      graphQuery.bind,
    );
    return {
      branches: metadata.branches as SqlChatBranchSummary[],
      activeBranchId: metadata.activeBranchId,
      messages: rebuildBranchGraphMessages(graphRows),
      links: graphRows.map((row) => ({
        messageId: String(row.message_id),
        parentMessageId:
          row.graph_parent_message_id == null
            ? undefined
            : String(row.graph_parent_message_id),
        originBranchId: String(row.graph_origin_branch_id),
      })),
    };
  }

  async loadChatBranchGraphPage(chatId: string, offset: number, limit: number) {
    await this.ensureBranchGraph(chatId);
    const normalizedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const normalizedLimit = normalizeLimit(limit);
    const metadata = await sqliteBranch.loadMetadata(
      this.selectRows.bind(this) as SqliteSelectRows,
      chatId,
    );
    const countQuery = sqliteMessages.buildGraphCountQuery(chatId);
    const countRow = await this.selectOne<{ total: number }>(
      countQuery.sql,
      countQuery.bind,
    );
    const total = Number(countRow?.total ?? 0);
    const pageQuery = sqliteMessages.buildGraphPageQuery(
      chatId,
      normalizedOffset,
      normalizedLimit,
    );
    const rows = await this.selectRows<Record<string, unknown>>(
      pageQuery.sql,
      pageQuery.bind,
    );
    return {
      branches: metadata.branches as SqlChatBranchSummary[],
      activeBranchId: metadata.activeBranchId,
      messages: rebuildMessageRows(rows),
      links: sqliteMessages.rebuildGraphLinks(rows),
      offset: normalizedOffset,
      total,
      hasMore: normalizedOffset + normalizedLimit < total,
    };
  }

  async loadBranchMessages(
    chatId: string,
    branchId: string,
    options?: { messageLimit?: number; mode?: "full" | "generation" | "graph" },
  ): Promise<Message[]> {
    await this.ensureBranchGraph(chatId);
    const limit =
      options?.messageLimit === undefined
        ? undefined
        : normalizeLimit(options.messageLimit);
    const query = sqliteMessages.buildBranchRowsQuery(
      chatId,
      branchId,
      limit,
      options?.mode === "generation"
        ? "generation"
        : options?.mode === "graph"
          ? "graph"
          : "full",
    );
    return rebuildMessageRows(await this.selectRows(query.sql, query.bind));
  }

  async createChatBranch(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary> {
    await this.writeQueue.run(async () => {
      let parentBranchId =
        input.parentBranchId ??
        (await sqliteBranch.getActiveId(
          this.selectRows.bind(this) as SqliteSelectRows,
          input.chatId,
        ));
      if (!parentBranchId) {
        await this.executeNativeTransaction(
          null,
          sqliteBranch.ensureGraphStatements(input.chatId),
        );
        parentBranchId = await sqliteBranch.getActiveId(
          this.selectRows.bind(this) as SqliteSelectRows,
          input.chatId,
        );
      }
      if (!parentBranchId) throw new Error("Chat branch root does not exist");
      await this.executeNativeTransaction(
        null,
        sqliteBranch.buildCreateStatements(input, parentBranchId),
      );
    });
    const branch = await sqliteBranch.load(
      this.selectRows.bind(this) as SqliteSelectRows,
      input.chatId,
      input.id,
    );
    if (!branch) throw new Error("Failed to create chat branch");
    return branch as SqlChatBranchSummary;
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    await this.ensureBranchGraph(chatId);
    if (
      !(await sqliteBranch.exists(
        this.selectRows.bind(this) as SqliteSelectRows,
        chatId,
        branchId,
      ))
    ) {
      throw new Error("Chat branch does not exist");
    }
    await this.writeQueue.run(() =>
      this.executeNativeTransaction(null, [
        sqliteBranch.buildActivateStatement(chatId, branchId),
      ]),
    );
  }

  async listRecentChats(
    limit = 50,
    activeChatId?: string,
  ): Promise<SqlRecentChatMetadata[]> {
    return (await sqliteEntity.listRecentChats(
      this.selectRows.bind(this) as SqliteSelectRows,
      limit,
      activeChatId,
    )) as SqlRecentChatMetadata[];
  }

  async loadPersonas(): Promise<RisuPersona[]> {
    return (
      ((await this.loadSettingValue("personas")) as
        RisuPersona[] | undefined) ?? []
    );
  }

  /**
   * Reads several setting keys in one grouped query so native backends avoid
   * one bridge round trip per startup setting.
   */
  async loadSettingKeys(keys: string[]): Promise<Map<string, unknown>> {
    return await sqliteDocument.loadSettingValues(
      this.selectRows.bind(this) as SqliteSelectRows,
      keys,
    );
  }

  async listBotPresets(): Promise<BotPresetSummary[]> {
    return await sqliteDocument.listBotPresets(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    return await sqliteDocument.loadBotPreset<botPreset>(
      this.selectRows.bind(this) as SqliteSelectRows,
      id,
    );
  }

  async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
    return (
      ((await this.loadSettingValue("loreBook")) as
        | {
            name: string;
            data: loreBook[];
          }[]
        | undefined) ?? []
    );
  }

  protected authorNoteDatabase(): authorNoteSql.AuthorNoteSql {
    return {
      dialect: "sqlite",
      query: this.selectRows.bind(this),
      execute: async () => {
        throw new Error("Read-only note connection");
      },
    };
  }
  async listGlobalAuthorNotes() {
    return authorNoteSql.listAuthorNotes(this.authorNoteDatabase());
  }
  async getGlobalAuthorNote(id: string) {
    return authorNoteSql.getAuthorNote(this.authorNoteDatabase(), id);
  }
  async readGlobalAuthorNote(id: string) {
    return authorNoteSql.readAuthorNote(this.authorNoteDatabase(), id);
  }
  async getGlobalAuthorNoteScriptWrite() {
    return authorNoteSql.allowAuthorNoteScriptWrite(this.authorNoteDatabase());
  }

  async loadModules(): Promise<RisuModule[]> {
    return await sqliteDocument.loadModules<RisuModule>(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadPrompts(): Promise<Record<string, any>> {
    return await sqliteDocument.loadPrompts(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadScripts(): Promise<customscript[]> {
    return (
      ((await this.loadSettingValue("globalscript")) as
        customscript[] | undefined) ?? []
    );
  }

  async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
    return (await sqlitePlugin.loadCustomStorage(
      this.selectRows.bind(this) as SqliteSelectRows,
    )) as Record<string, any> | null;
  }

  async listPluginCustomStorageKeys(): Promise<string[]> {
    return await sqlitePlugin.listCustomStorageKeys(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    return await sqlitePlugin.loadCustomStorageKey(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  async listSettingKeys(): Promise<string[]> {
    return await sqliteDocument.listSettingKeys(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadSettingKey(key: string): Promise<any> {
    return this.loadSettingValue(key);
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    return await sqliteColdStorage.getItem(
      this.selectRows.bind(this) as SqliteSelectRows,
      this.loadNodeValue.bind(this),
      key,
    );
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    return await sqliteColdStorage.listItems(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    const statement = sqliteColdStorage.buildDelete(keys);
    if (!statement) return 0;
    return this.writeQueue.run(async () => {
      await this.executeNativeTransaction(null, [statement]);
      return keys.length;
    });
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    return this.writeQueue.run(async () => {
      const toDelete = await sqliteColdStorage.findPruneKeys(
        this.selectRows.bind(this) as SqliteSelectRows,
        retainedKeys,
      );
      const statement = sqliteColdStorage.buildDelete(toDelete);
      if (!statement) return 0;
      await this.executeNativeTransaction(null, [statement]);
      return toDelete.length;
    });
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    return await sqliteRevisions.list(
      this.selectRows.bind(this) as SqliteSelectRows,
      limit,
    );
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    return await sqliteRevisions.getDetails(
      this.selectRows.bind(this) as SqliteSelectRows,
      revisionId,
    );
  }

  async getRevisionDiff(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null> {
    return sqliteRevisions.getDiff(baseId, targetId);
  }

  async previewRestoreRevision(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null> {
    return sqliteRevisions.previewRestore(this.revision, revisionId);
  }

  async restoreRevision(
    revisionId: number,
  ): Promise<{ revision: number; revisionId: number }> {
    return { revision: this.revision, revisionId };
  }

  async searchMessages(
    query: string,
    scope: "all" | "active" | "cold" = "all",
    limit: number = 50,
  ): Promise<NodePostgresMessageSearchResult[]> {
    void scope;
    return await sqliteAdmin.searchMessages(
      this.selectRows.bind(this) as SqliteSelectRows,
      query,
      limit,
    );
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    return await sqliteAdmin.getTokenUsage(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    return await sqliteAdmin.getBotChatStats(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async listDbTables(): Promise<NodePostgresTableInfo[]> {
    if (!this._enabled && !(await this.init())) return [];
    return await sqliteAdmin.listTables(
      this.selectRows.bind(this) as SqliteSelectRows,
      this.selectRowSets.bind(this) as SqliteSelectRowSets,
    );
  }

  async getDbTableData(
    table: string,
    options: {
      offset?: number;
      limit?: number;
      sortColumn?: string;
      sortOrder?: "asc" | "desc";
      search?: string;
      columns?: string[];
    } = {},
  ): Promise<NodePostgresTableData> {
    if (!this._enabled && !(await this.init())) {
      throw new Error(`${this.backendName} is not available`);
    }
    return await sqliteAdmin.getTableData(
      this.selectRows.bind(this) as SqliteSelectRows,
      this.selectRowSets.bind(this) as SqliteSelectRowSets,
      table,
      options,
    );
  }

  async searchCharactersByTag(
    tag: string,
    limit: number = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    return await sqliteAdmin.searchCharacters(
      this.selectRows.bind(this) as SqliteSelectRows,
      "tag",
      tag,
      limit,
    );
  }

  async searchCharactersByName(
    name: string,
    limit: number = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    return await sqliteAdmin.searchCharacters(
      this.selectRows.bind(this) as SqliteSelectRows,
      "name",
      name,
      limit,
    );
  }
}
