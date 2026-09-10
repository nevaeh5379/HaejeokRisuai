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
import { buildLegacyBranchMigrationPlan } from "@risuai/protocol/legacyBranchMigration.cjs";
import type {
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
  mergeLegacyModulesIntoCommit,
  type SqlCommit,
  type SqlCommitResult,
  SqlRevisionConflictError,
} from "../sqlCommit";
import {
  rebuildRelationalValue,
  decodedText,
  RELATIONAL_SCHEMA_LAYOUT,
  SQLITE_SCHEMA_VERSION,
  SqlSchemaResetRequiredError,
} from "@risuai/storage-sqlite/relationalNodeCodec";
import {
  applySqliteCommit,
  writeSqliteColdStorage,
} from "@risuai/storage-sqlite/sqliteCommit";
import {
  SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL,
  SQLITE_LAST_MESSAGE_TIME_TRIGGER_NAME,
} from "@risuai/storage-sqlite/sqliteLastMessageTime";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
} from "../sqlDeferredSettings";
import {
  AsyncSerialQueue,
  buildBranchGraphRowsQuery,
  buildBranchGraphMessageCountQuery,
  buildBranchGraphMessageRowsPageQuery,
  buildBranchMessageCountQuery,
  buildBranchMessageRowsQuery,
  buildCharacterAssetFieldsQuery,
  buildMessageRowsQuery,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
  rebuildBranchGraphLinks,
  type SqliteTransactionStatement,
} from "@risuai/storage-sqlite/sqliteQueries";
import {
  getSqliteBotChatStats,
  getSqliteDbTableData,
  getSqliteTokenUsage,
  listSqliteDbTables,
  searchSqliteCharacters,
  searchSqliteMessages,
  type SqliteSelectRowSets,
  type SqliteSelectRows,
} from "@risuai/storage-sqlite/sqliteAdminQueries";
import {
  buildSqliteColdStorageDelete,
  findSqliteColdStoragePruneKeys,
  getSqliteColdStorageItem,
  getSqliteRevisionDetails,
  getSqliteRevisionDiff,
  listSqliteColdStorageItems,
  listSqlitePluginCustomStorageKeys,
  listSqliteRevisions,
  loadSqlitePluginCustomStorage,
  loadSqlitePluginCustomStorageKey,
  previewSqliteRevisionRestore,
} from "@risuai/storage-sqlite/sqlitePersistenceQueries";
import {
  groupSqliteNodeValues,
  loadSqliteNodeValue,
  loadSqliteSettingValue,
} from "@risuai/storage-sqlite/sqliteNodeValues";
import {
  listSqliteBotPresets,
  listSqliteSettingKeys,
  loadSqliteBotPreset,
  loadSqliteModules,
  loadSqlitePrompts,
  loadSqliteSettingValues,
} from "@risuai/storage-sqlite/sqliteDocumentQueries";
import {
  buildSqliteSettingRowsQuery,
  getSqliteStorageSyncSummary,
  loadSqliteStartupProjection,
  rebuildSqliteSettingRows,
} from "@risuai/storage-sqlite/sqliteStartupQueries";
import { exportSqliteDatabaseSnapshot } from "@risuai/storage-sqlite/sqliteSnapshotQueries";
import {
  listSqliteRecentChats,
  loadSqliteCharacterDocument,
} from "@risuai/storage-sqlite/sqliteEntityQueries";
import {
  rebuildBranchGraphMessages,
  rebuildMessageRows,
} from "./sqliteStorageUtils";
import {
  buildSqliteLegacyBranchMigrationStatements,
  ensureSqliteBranchGraphStatements,
  mapSqliteChatBranchRow,
  SQLITE_BRANCH_SCHEMA_STATEMENTS,
  type SqliteChatBranchRow,
} from "@risuai/storage-sqlite/sqliteBranchStorage";

export abstract class NativeSqliteStorageBase {
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
    queries: SqliteTransactionStatement[],
  ): Promise<Record<string, unknown>[][]> {
    const results: Record<string, unknown>[][] = [];
    for (const query of queries) {
      results.push(await this.selectRows(query.sql, query.bind ?? []));
    }
    return results;
  }

  protected abstract executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteTransactionStatement[],
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
      if (error instanceof SqlSchemaResetRequiredError) throw error;
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
      Number(meta?.schema_version) !== SQLITE_SCHEMA_VERSION ||
      meta?.schema_layout !== RELATIONAL_SCHEMA_LAYOUT
    ) {
      throw new SqlSchemaResetRequiredError(
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
      ...SQLITE_BRANCH_SCHEMA_STATEMENTS,
    ]);
  }

  private async hasLastMessageTimeTrigger(): Promise<boolean> {
    const existing = await this.selectRows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      [SQLITE_LAST_MESSAGE_TIME_TRIGGER_NAME],
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
        { sql: SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL, bind: [] },
      ]);
    }
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const projection = await loadSqliteStartupProjection(
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
    return (await exportSqliteDatabaseSnapshot({
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
    if (commit.baseRevision !== currentRevision) {
      throw new SqlRevisionConflictError(currentRevision);
    }
    await this.prepareModuleCommit(commit);
    await this.validatePresetCommit(commit);

    const statements: SqliteTransactionStatement[] = [];
    const append = async (sql: string, bind: unknown[] = []) => {
      statements.push({ sql, bind });
    };
    if (commit.replaceAll) {
      await append("DELETE FROM system_settings");
      await append("DELETE FROM plugin_custom_storage");
      await append("DELETE FROM characters");
    }
    await applySqliteCommit(commit, append);
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
    await this.executeNativeTransaction(
      currentRevision,
      statements,
      onProgress,
    );
    this.revision = revision;
    return { revision };
  }

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    return this.writeQueue.run(async () => {
      const statements: SqliteTransactionStatement[] = [];
      await writeSqliteColdStorage(
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
    return await getSqliteStorageSyncSummary(
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
    return loadSqliteNodeValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      table,
      ownerWhere,
      bind,
    );
  }

  protected loadSettingValue(key: string): Promise<unknown> {
    return loadSqliteSettingValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  protected async prepareModuleCommit(commit: SqlCommit): Promise<void> {
    if (!commit.modules || commit.replaceAll) return;
    const moduleCount = await this.selectOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM module_records",
    );
    if (Number(moduleCount?.count) === 0) {
      mergeLegacyModulesIntoCommit(
        commit,
        await this.loadSettingValue("modules"),
      );
    }
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
    return groupSqliteNodeValues(rows, ownerKey);
  }

  protected async validatePresetCommit(commit: SqlCommit): Promise<void> {
    if (!commit.presets) return;
    const originalIds = (
      await this.selectRows<{ preset_id: string }>(
        "SELECT preset_id FROM bot_presets ORDER BY position",
      )
    ).map((row) => row.preset_id);
    const ids = new Set(originalIds);
    if (commit.replaceAll) ids.clear();
    for (const id of commit.presets.deletes) ids.delete(id);
    for (const entry of commit.presets.upserts) ids.add(entry.id);
    if (ids.size === 0) throw new Error("At least one bot preset must remain");
    if (
      commit.presets.order &&
      (commit.presets.order.length !== ids.size ||
        new Set(commit.presets.order).size !== ids.size ||
        commit.presets.order.some((id) => !ids.has(id)))
    ) {
      throw new Error("Preset order must contain every preset ID exactly once");
    }
    if (
      commit.presets.activeId !== undefined &&
      !ids.has(commit.presets.activeId)
    ) {
      throw new Error("Active bot preset does not exist");
    }
    if (commit.presets.activeId === undefined) {
      const current = (await this.loadSettingValue("activeBotPresetId")) as
        string | undefined;
      if (!current || !ids.has(current)) {
        const index = originalIds.indexOf(current ?? "");
        commit.presets.activeId =
          originalIds.slice(index + 1).find((id) => ids.has(id)) ||
          originalIds
            .slice(0, Math.max(0, index))
            .reverse()
            .find((id) => ids.has(id)) ||
          (commit.presets.order || Array.from(ids))[0];
      }
    }
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
    return (await loadSqliteCharacterDocument(
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
    const query = buildCharacterAssetFieldsQuery(characterId);
    const rows = await this.selectRows(query.sql, query.bind);
    const assets = rows.length
      ? (rebuildRelationalValue(rows as any) as Record<string, unknown>)
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
      characterNodeRows.length ? rebuildRelationalValue(characterNodeRows) : {}
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
    const requestedLimit = options?.messageLimit;
    const limit =
      requestedLimit === undefined
        ? undefined
        : normalizeSqliteLimit(requestedLimit);
    // For a paged initial load, selecting the newest N rows does not require
    // knowing the total first. That lets chat core metadata, extension nodes,
    // count, and recent messages share one native query batch.
    const messageQuery = buildBranchMessageRowsQuery(chatId, undefined, limit);
    const totalQuery = buildBranchMessageCountQuery(chatId);
    const [
      chatRows,
      chatNodeRows,
      totalRows,
      messageRows,
      activeBranchRows,
      branchCountRows,
    ] = await this.selectRowSets([
      {
        sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE id = ?",
        bind: [chatId],
      },
      {
        sql: `SELECT node_id, parent_node_id, node_order, object_key,
                     object_key_encoded, value_type, text_value, encoded_text_value,
                     number_value, boolean_value
                FROM chat_extension_nodes
               WHERE chat_id = ?
               ORDER BY node_id`,
        bind: [chatId],
      },
      totalQuery,
      messageQuery,
      {
        sql: "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
        bind: [chatId],
      },
      {
        sql: "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
        bind: [chatId],
      },
    ]);
    const chatRow = chatRows[0] as
      | {
          id: string;
          name: string;
          note: string;
          folder_id: string | null;
          last_message_time: number | null;
        }
      | undefined;
    if (!chatRow) return null;
    const activeBranch = activeBranchRows[0] as
      { branch_id: string } | undefined;
    const branchCount = Number(
      (branchCountRows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    const chatData = (
      chatNodeRows.length ? rebuildRelationalValue(chatNodeRows) : {}
    ) as any;
    if (
      await this.migrateLegacyBranchGraphIfNeeded(chatId, chatData, branchCount)
    ) {
      return this.loadChat(chatId, options);
    }
    if (!activeBranch) {
      await this.ensureBranchGraph(chatId);
      return this.loadChat(chatId, options);
    }
    chatData.id = chatRow.id;
    chatData.name = chatRow.name ?? "";
    chatData.note = chatRow.note ?? "";
    chatData.folderId = chatRow.folder_id ?? undefined;
    chatData.lastDate = chatRow.last_message_time ?? undefined;
    chatData.activeBranchId = activeBranch?.branch_id;
    if (activeBranch) delete chatData.branchState;

    const total = Number(
      (totalRows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    chatData.message = rebuildMessageRows(messageRows);
    const offset = Math.max(0, total - chatData.message.length);
    chatData.messageOffset = offset;
    chatData.messageTotal = total;
    chatData.messagesFullyLoaded = offset === 0;
    chatData.messagesLoaded = true;
    chatData.detailsLoaded = true;
    return chatData;
  }

  async loadChatMessages(
    chatId: string,
    options?: { mode?: "full" | "generation" },
  ): Promise<Message[]> {
    await this.ensureBranchGraph(chatId);
    const query = buildBranchMessageRowsQuery(
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
    const totalQuery = buildBranchMessageCountQuery(chatId);
    const totalRow = await this.selectOne<{ total: number }>(
      totalQuery.sql,
      totalQuery.bind,
    );
    const total = Number(totalRow?.total ?? 0);
    const end = normalizeSqlitePageEnd(before, total);
    const normalizedLimit = normalizeSqliteLimit(limit);
    const offset = Math.max(0, end - normalizedLimit);
    const pageQuery = buildBranchMessageRowsQuery(
      chatId,
      undefined,
      end - offset,
      "full",
      offset,
    );
    const messages = rebuildMessageRows(
      await this.selectRows(pageQuery.sql, pageQuery.bind),
    );
    return {
      messages,
      offset,
      total,
      hasMore: offset > 0,
    };
  }

  private async loadLinearMessages(chatId: string): Promise<Message[]> {
    const query = buildMessageRowsQuery(chatId, undefined, 0, false, "full");
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
    return (rows.length ? rebuildRelationalValue(rows) : {}) as Record<
      string,
      any
    >;
  }

  private async migrateLegacyBranchGraphIfNeeded(
    chatId: string,
    knownChatData?: Record<string, any>,
    knownBranchCount?: number,
  ): Promise<boolean> {
    const branchCount =
      knownBranchCount ??
      Number(
        (
          await this.selectOne<{ total: number }>(
            "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
            [chatId],
          )
        )?.total ?? 0,
      );
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
      const currentCount = Number(
        (
          await this.selectOne<{ total: number }>(
            "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
            [chatId],
          )
        )?.total ?? 0,
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
        buildSqliteLegacyBranchMigrationStatements(chatId, chatData, plan),
      );
      return true;
    });
  }

  private async ensureBranchGraph(chatId: string): Promise<void> {
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId)) return;
    await this.writeQueue.run(() =>
      this.executeNativeTransaction(
        null,
        ensureSqliteBranchGraphStatements(chatId),
      ),
    );
  }

  async listChatBranches(chatId: string): Promise<SqlChatBranchSummary[]> {
    await this.ensureBranchGraph(chatId);
    const rows = await this.selectRows<SqliteChatBranchRow>(
      `SELECT id, chat_id, parent_branch_id, fork_message_id,
              head_message_id, reason, created_at
         FROM chat_branches WHERE chat_id = ? ORDER BY created_at, id`,
      [chatId],
    );
    return rows.map(mapSqliteChatBranchRow);
  }

  async loadChatBranchGraph(chatId: string) {
    await this.ensureBranchGraph(chatId);
    const branchRows = await this.selectRows<
      SqliteChatBranchRow & { active_branch_id?: string }
    >(
      `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
              branch.head_message_id, branch.reason, branch.created_at,
              active.branch_id AS active_branch_id
         FROM chat_branches branch
    LEFT JOIN chat_active_branches active ON active.chat_id = branch.chat_id
        WHERE branch.chat_id = ? ORDER BY branch.created_at, branch.id`,
      [chatId],
    );
    const graphQuery = buildBranchGraphRowsQuery(chatId);
    const graphRows = await this.selectRows<Record<string, unknown>>(
      graphQuery.sql,
      graphQuery.bind,
    );
    return {
      branches: branchRows.map(mapSqliteChatBranchRow),
      activeBranchId: branchRows[0]?.active_branch_id ?? undefined,
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
    const normalizedLimit = normalizeSqliteLimit(limit);
    const branchRows = await this.selectRows<
      SqliteChatBranchRow & { active_branch_id?: string }
    >(
      `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
              branch.head_message_id, branch.reason, branch.created_at,
              active.branch_id AS active_branch_id
         FROM chat_branches branch
    LEFT JOIN chat_active_branches active ON active.chat_id = branch.chat_id
        WHERE branch.chat_id = ? ORDER BY branch.created_at, branch.id`,
      [chatId],
    );
    const countQuery = buildBranchGraphMessageCountQuery(chatId);
    const countRow = await this.selectOne<{ total: number }>(
      countQuery.sql,
      countQuery.bind,
    );
    const total = Number(countRow?.total ?? 0);
    const pageQuery = buildBranchGraphMessageRowsPageQuery(
      chatId,
      normalizedOffset,
      normalizedLimit,
    );
    const rows = await this.selectRows<Record<string, unknown>>(
      pageQuery.sql,
      pageQuery.bind,
    );
    return {
      branches: branchRows.map(mapSqliteChatBranchRow),
      activeBranchId: branchRows[0]?.active_branch_id ?? undefined,
      messages: rebuildMessageRows(rows),
      links: rebuildBranchGraphLinks(rows),
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
        : normalizeSqliteLimit(options.messageLimit);
    const query = buildBranchMessageRowsQuery(
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
      const active = await this.selectOne<{ branch_id: string }>(
        "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
        [input.chatId],
      );
      const parentBranchId = input.parentBranchId ?? active?.branch_id;
      if (!parentBranchId) {
        await this.executeNativeTransaction(
          null,
          ensureSqliteBranchGraphStatements(input.chatId),
        );
      }
      const resolvedParent =
        parentBranchId ??
        (
          await this.selectOne<{ branch_id: string }>(
            "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
            [input.chatId],
          )
        )?.branch_id;
      if (!resolvedParent) throw new Error("Chat branch root does not exist");
      await this.executeNativeTransaction(null, [
        {
          sql: `INSERT INTO chat_branches
                  (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          bind: [
            input.chatId,
            input.id,
            resolvedParent,
            input.forkMessageId ?? null,
            input.forkMessageId ?? null,
            input.reason,
            input.createdAt,
          ],
        },
        {
          sql: `INSERT INTO chat_active_branches (chat_id, branch_id) VALUES (?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET branch_id=excluded.branch_id`,
          bind: [input.chatId, input.id],
        },
      ]);
    });
    const row = await this.selectOne<SqliteChatBranchRow>(
      `SELECT id, chat_id, parent_branch_id, fork_message_id,
              head_message_id, reason, created_at
         FROM chat_branches WHERE chat_id = ? AND id = ?`,
      [input.chatId, input.id],
    );
    if (!row) throw new Error("Failed to create chat branch");
    return mapSqliteChatBranchRow(row);
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    await this.ensureBranchGraph(chatId);
    const exists = await this.selectOne<{ id: string }>(
      "SELECT id FROM chat_branches WHERE chat_id = ? AND id = ?",
      [chatId, branchId],
    );
    if (!exists) throw new Error("Chat branch does not exist");
    await this.writeQueue.run(() =>
      this.executeNativeTransaction(null, [
        {
          sql: "UPDATE chat_active_branches SET branch_id = ? WHERE chat_id = ?",
          bind: [branchId, chatId],
        },
      ]),
    );
  }

  async listRecentChats(
    limit = 50,
    activeChatId?: string,
  ): Promise<SqlRecentChatMetadata[]> {
    return (await listSqliteRecentChats(
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
    return await loadSqliteSettingValues(
      this.selectRows.bind(this) as SqliteSelectRows,
      keys,
    );
  }

  async listBotPresets(): Promise<BotPresetSummary[]> {
    return await listSqliteBotPresets(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    return await loadSqliteBotPreset<botPreset>(
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

  async loadModules(): Promise<RisuModule[]> {
    return await loadSqliteModules<RisuModule>(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadPrompts(): Promise<Record<string, any>> {
    return await loadSqlitePrompts(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadScripts(): Promise<customscript[]> {
    return (
      ((await this.loadSettingValue("globalscript")) as
        customscript[] | undefined) ?? []
    );
  }

  async loadPlugins(options?: {
    enabledOnly?: boolean;
  }): Promise<any[] | null> {
    const plugins =
      ((await this.loadSettingValue("plugins")) as any[] | undefined) ?? null;
    return options?.enabledOnly && plugins
      ? plugins.filter((plugin) => plugin?.enabled)
      : plugins;
  }

  async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
    return (await loadSqlitePluginCustomStorage(
      this.selectRows.bind(this) as SqliteSelectRows,
    )) as Record<string, any> | null;
  }

  async listPluginCustomStorageKeys(): Promise<string[]> {
    return await listSqlitePluginCustomStorageKeys(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    return await loadSqlitePluginCustomStorageKey(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  async listSettingKeys(): Promise<string[]> {
    return await listSqliteSettingKeys(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async loadSettingKey(key: string): Promise<any> {
    return this.loadSettingValue(key);
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    return await getSqliteColdStorageItem(
      this.selectRows.bind(this) as SqliteSelectRows,
      this.loadNodeValue.bind(this),
      key,
    );
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    return await listSqliteColdStorageItems(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    const statement = buildSqliteColdStorageDelete(keys);
    if (!statement) return 0;
    return this.writeQueue.run(async () => {
      await this.executeNativeTransaction(null, [statement]);
      return keys.length;
    });
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    return this.writeQueue.run(async () => {
      const toDelete = await findSqliteColdStoragePruneKeys(
        this.selectRows.bind(this) as SqliteSelectRows,
        retainedKeys,
      );
      const statement = buildSqliteColdStorageDelete(toDelete);
      if (!statement) return 0;
      await this.executeNativeTransaction(null, [statement]);
      return toDelete.length;
    });
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    return await listSqliteRevisions(
      this.selectRows.bind(this) as SqliteSelectRows,
      limit,
    );
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    return await getSqliteRevisionDetails(
      this.selectRows.bind(this) as SqliteSelectRows,
      revisionId,
    );
  }

  async getRevisionDiff(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null> {
    return getSqliteRevisionDiff(baseId, targetId);
  }

  async previewRestoreRevision(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null> {
    return previewSqliteRevisionRestore(this.revision, revisionId);
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
    return await searchSqliteMessages(
      this.selectRows.bind(this) as SqliteSelectRows,
      query,
      limit,
    );
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    return await getSqliteTokenUsage(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    return await getSqliteBotChatStats(
      this.selectRows.bind(this) as SqliteSelectRows,
    );
  }

  async listDbTables(): Promise<NodePostgresTableInfo[]> {
    if (!this._enabled && !(await this.init())) return [];
    return await listSqliteDbTables(
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
    return await getSqliteDbTableData(
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
    return await searchSqliteCharacters(
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
    return await searchSqliteCharacters(
      this.selectRows.bind(this) as SqliteSelectRows,
      "name",
      name,
      limit,
    );
  }
}
