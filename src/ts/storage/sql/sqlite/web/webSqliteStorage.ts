import { v4 as uuidv4 } from "uuid";
import { buildLegacyBranchMigrationPlan } from "@risuai/protocol/legacyBranchMigration.cjs";
import type {
  CanonicalDatabase,
  Database,
  DatabaseSettings,
  character,
  groupChat,
  Chat,
  Message,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "../../../database/schema";
import type { RisuModule } from "../../../../process/modules";
import type {
  ISqlStorage,
  SqlStartupDataResult,
  SqlDatabaseSnapshotResult,
  BotPresetSummary,
  SqlChatBranchSummary,
  SqlCreateChatBranchInput,
  StoredBotPreset,
  SqlRecentChatMetadata,
} from "../../ISqlStorage";
import type {
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresCharacterSearchResult,
  NodePostgresBotChatStats,
  NodePostgresTableInfo,
  NodePostgresColumnInfo,
  NodePostgresTableData,
} from "../../postgres/nodeSqlStorage";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  PROMPT_SETTING_KEYS,
} from "../../sqlDeferredSettings";
import sqliteSchemaSql from "@risuai/storage-sqlite/sqlite-schema.sql?raw";
import {
  buildSqlReplaceCommit,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "../../sqlCommit";
import {
  applySqliteCommit,
  writeSqliteColdStorage,
} from "@risuai/storage-sqlite/sqliteCommit";
import {
  rebuildRelationalValue,
  decodedText,
  RELATIONAL_SCHEMA_LAYOUT,
  SQLITE_SCHEMA_VERSION,
  SqlSchemaResetRequiredError,
  type RelationalNodeRow,
} from "@risuai/storage-sqlite/relationalNodeCodec";
import {
  AsyncSerialQueue,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
  buildDeferredSettingsQuery,
  groupSettingNodeRows,
  buildBranchGraphRowsQuery,
  buildBranchGraphMessageCountQuery,
  buildBranchGraphMessageRowsPageQuery,
  buildBranchMessageCountQuery,
  buildBranchMessageRowsQuery,
  buildMessageRowsQuery,
  buildCharacterAssetFieldsQuery,
  rebuildBranchGraphLinks,
  type MessageLoadMode,
  type SettingNodeRow,
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
  getSqliteStorageSyncSummary,
  loadSqliteStartupProjection,
} from "@risuai/storage-sqlite/sqliteStartupQueries";
import { exportSqliteDatabaseSnapshot } from "@risuai/storage-sqlite/sqliteSnapshotQueries";
import {
  prepareSqliteModuleCommit,
  validateSqlitePresetCommit,
} from "@risuai/storage-sqlite/sqliteCommitPreparation";
import {
  listSqliteRecentChats,
  loadSqliteCharacterDocument,
} from "@risuai/storage-sqlite/sqliteEntityQueries";
import {
  rebuildBranchGraphMessages,
  rebuildMessageRows,
} from "../sqliteStorageUtils";
import {
  buildSqliteLegacyBranchMigrationStatements,
  ensureSqliteBranchGraphStatements,
  mapSqliteChatBranchRow,
  type SqliteChatBranchRow,
} from "@risuai/storage-sqlite/sqliteBranchStorage";

// ── Worker RPC plumbing ──────────────────────────────────────────────

type SqliteBatchStatement = {
  sql: string;
  bind?: unknown[];
  transform?: "relational" | "messages";
};

type SqliteBatchResult = {
  rows?: Record<string, unknown>[];
  columns?: string[];
  value?: unknown;
};

type ReqMsg =
  | { id: number; type: "init" }
  | { id: number; type: "exec"; sql: string; bind?: unknown[] }
  | { id: number; type: "execBatch"; statements: SqliteBatchStatement[] }
  | { id: number; type: "selectBatch"; statements: SqliteBatchStatement[] }
  | { id: number; type: "select"; sql: string; bind?: unknown[] }
  | { id: number; type: "selectOne"; sql: string; bind?: unknown[] }
  | { id: number; type: "close" };

interface ResMsg {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type ReqMsgWithoutId =
  | { type: "init" }
  | { type: "exec"; sql: string; bind?: unknown[] }
  | { type: "execBatch"; statements: SqliteBatchStatement[] }
  | { type: "selectBatch"; statements: SqliteBatchStatement[] }
  | { type: "select"; sql: string; bind?: unknown[] }
  | { type: "selectOne"; sql: string; bind?: unknown[] }
  | { type: "close" };

interface WorkerRpc {
  init(): Promise<{
    enabled: boolean;
    revision: number;
    vfs: "opfs-sahpool" | "opfs" | null;
  }>;
  exec(sql: string, bind?: unknown[]): Promise<void>;
  execBatch(statements: SqliteBatchStatement[]): Promise<void>;
  selectBatch(statements: SqliteBatchStatement[]): Promise<SqliteBatchResult[]>;
  select(
    sql: string,
    bind?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  selectOne(
    sql: string,
    bind?: unknown[],
  ): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
  terminate(): void;
}

let workerSingleton: Worker | null = null;
let rpcSingleton: WorkerRpc | null = null;
let workerInitFailed = false;

function getWorkerRpc(): WorkerRpc {
  if (workerInitFailed) {
    throw new Error("SQLite WASM worker is not available");
  }
  if (rpcSingleton) return rpcSingleton;

  // Vite understands `new Worker(new URL(..., import.meta.url), { type: 'module' })`
  // and bundles the worker module + its WASM dependency correctly.
  workerSingleton = new Worker(
    new URL("./webSqliteWorker.ts", import.meta.url),
    { type: "module" },
  );

  const pending = new Map<number, (res: ResMsg) => void>();
  let nextId = 1;

  workerSingleton.onmessage = (e: MessageEvent<ResMsg>) => {
    const res = e.data;
    const resolver = pending.get(res.id);
    if (resolver) {
      pending.delete(res.id);
      resolver(res);
    }
  };

  workerSingleton.onerror = (e) => {
    console.error("SQLite WASM worker error:", e.message ?? e);
    workerInitFailed = true;
    // Reject all pending requests.
    for (const resolver of pending.values()) {
      resolver({ id: 0, ok: false, error: "Worker crashed" });
    }
    pending.clear();
  };

  function call<T>(msg: ReqMsgWithoutId): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, (res: ResMsg) => {
        if (res.ok) resolve(res.result as T);
        else reject(new Error(res.error ?? "Unknown worker error"));
      });
      const full: ReqMsg = { ...msg, id } as ReqMsg;
      workerSingleton!.postMessage(full);
    });
  }

  rpcSingleton = {
    init: () =>
      call<{
        enabled: boolean;
        revision: number;
        vfs: "opfs-sahpool" | "opfs" | null;
      }>({ type: "init" }),
    exec: (sql, bind) =>
      call<void>({ type: "exec", sql, bind }).then(() => undefined),
    execBatch: (statements) =>
      call<void>({ type: "execBatch", statements }).then(() => undefined),
    selectBatch: (statements) =>
      call<SqliteBatchResult[]>({
        type: "selectBatch",
        statements,
      }),
    select: (sql, bind) =>
      call<{ rows: Record<string, unknown>[]; columns: string[] }>({
        type: "select",
        sql,
        bind,
      }),
    selectOne: (sql, bind) =>
      call<Record<string, unknown> | null>({ type: "selectOne", sql, bind }),
    close: () => call<void>({ type: "close" }),
    terminate: () => {
      workerSingleton?.terminate();
      workerSingleton = null;
      rpcSingleton = null;
    },
  };

  return rpcSingleton;
}

// ── Storage implementation ────────────────────────────────────────────

const DB_FILE = "/risuai-local.sqlite3";
export class WebSqliteStorage implements ISqlStorage {
  readonly backendKind = "web-sqlite" as const;

  private revision = 0;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private readonly writeQueue = new AsyncSerialQueue();
  private _enabled = false;
  private rpc: WorkerRpc | null = null;

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

  async init(): Promise<boolean> {
    if (this.initialized) return this._enabled;
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<boolean> {
    try {
      const rpc = getWorkerRpc();
      this.rpc = rpc;
      const result = await rpc.init();
      this._enabled = result.enabled;
      this.revision = result.revision;
      console.info(`[WebSqliteStorage] SQLite VFS: ${result.vfs ?? "unknown"}`);
      this.initialized = true;
      return result.enabled;
    } catch (error) {
      console.error("WebSqliteStorage init failed:", error);
      this.initialized = true;
      this._enabled = false;
      if (error instanceof SqlSchemaResetRequiredError) throw error;
      if (
        error instanceof Error &&
        error.message.includes("Failed to acquire SQLite SAH pool")
      ) {
        throw error;
      }
      return false;
    }
  }

  private async selectRows<T = Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T[]> {
    if (!this.rpc) throw new Error("Database not opened");
    return (await this.rpc.select(sql, bind)).rows as T[];
  }

  private async selectOne(
    sql: string,
    bind: unknown[] = [],
  ): Promise<Record<string, unknown> | null> {
    if (!this.rpc) throw new Error("Database not opened");
    return this.rpc.selectOne(sql, bind);
  }

  private async selectBatchResults(
    statements: SqliteBatchStatement[],
  ): Promise<SqliteBatchResult[]> {
    if (!this.rpc) throw new Error("Database not opened");
    return this.rpc.selectBatch(statements);
  }

  private async selectBatch(
    statements: SqliteBatchStatement[],
  ): Promise<Record<string, unknown>[][]> {
    const results = await this.selectBatchResults(statements);
    return results.map((result) => result.rows ?? []);
  }

  private async run(sql: string, bind: unknown[] = []): Promise<void> {
    if (!this.rpc) throw new Error("Database not opened");
    await this.rpc.exec(sql, bind);
  }

  private loadNodeValue(
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

  private loadSettingValue(key: string): Promise<unknown> {
    return loadSqliteSettingValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  private rebuildGroupedNodeValues(
    rows: Record<string, unknown>[],
    ownerKey: string,
  ): Map<string, unknown> {
    return groupSqliteNodeValues(rows, ownerKey);
  }

  private messageRowsStatement(
    chatId: string,
    limit?: number,
    offset = 0,
    newest = false,
    mode: MessageLoadMode = "full",
  ): SqliteBatchStatement {
    return buildMessageRowsQuery(chatId, limit, offset, newest, mode);
  }

  private async validatePresetCommit(commit: SqlCommit): Promise<void> {
    await validateSqlitePresetCommit(
      this.selectRows.bind(this) as SqliteSelectRows,
      commit,
    );
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const projection = await loadSqliteStartupProjection(
      ((queries) => this.selectBatch(queries)) as SqliteSelectRowSets,
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
      selectRowSets: ((queries) => this.selectBatch(queries)) as SqliteSelectRowSets,
      revision: this.revision,
      legacyPersonaMirrorKeys: LEGACY_PERSONA_MIRROR_KEYS,
      loadChatMessages: (chatId) => this.loadChatMessages(chatId),
    })) as SqlDatabaseSnapshotResult;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    return this.writeQueue.run(() => this.commitInternal(commit));
  }

  private async commitInternal(commit: SqlCommit): Promise<SqlCommitResult> {
    if (!this._enabled) throw new Error("SQLite storage is not enabled");
    await this.run("BEGIN IMMEDIATE");
    try {
      const meta = await this.selectOne(
        "SELECT revision FROM system_storage_meta WHERE singleton = 1",
      );
      const currentRevision = Number(meta?.revision) || 0;
      if (commit.baseRevision !== currentRevision)
        throw new SqlRevisionConflictError(currentRevision);
      await prepareSqliteModuleCommit(
        this.selectRows.bind(this) as SqliteSelectRows,
        commit,
      );
      await this.validatePresetCommit(commit);
      const statements: SqliteBatchStatement[] = [];
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
      // Interaction timestamps are high-frequency housekeeping, not useful local
      // restore points. Skipping their audit row avoids touching the revisions
      // table, its index, and AUTOINCREMENT state on routine character switches.
      if (action !== "character-touch") {
        await append(
          "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
          [revision, action],
        );
      }
      if (!this.rpc) throw new Error("Database not opened");
      await this.rpc.execBatch(statements);
      await this.run("COMMIT");
      this.revision = revision;
      return { revision };
    } catch (error) {
      try {
        await this.run("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  async replaceDatabase(
    database: Database,
    onProgress?: (status: string) => void,
  ): Promise<boolean> {
    onProgress?.("Replacing local database...");
    await this.commit(buildSqlReplaceCommit(database, this.revision));
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

  async loadCharacterForSelection(
    characterId: string,
  ): Promise<character | groupChat | null> {
    const [characterResult, nodeResult, chatResult] =
      await this.selectBatchResults([
        {
          sql: "SELECT id FROM characters WHERE id = ?",
          bind: [characterId],
        },
        {
          sql: `SELECT node_id, parent_node_id, node_order, object_key,
                     object_key_encoded, value_type, text_value, encoded_text_value,
                     number_value, boolean_value
              FROM character_extension_nodes
              WHERE character_id = ? ORDER BY node_id`,
          bind: [characterId],
          transform: "relational",
        },
        {
          sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
          bind: [characterId],
        },
      ]);
    const characterRows = characterResult.rows ?? [];
    const chatRows = chatResult.rows ?? [];
    if (characterRows.length === 0) return null;
    // Rebuild large relational trees in the SQLite Worker so the UI thread
    // receives the final object instead of cloning thousands of node rows.
    const characterData = (nodeResult.value ?? {}) as any;
    characterData.chaId = characterId;
    characterData.detailsLoaded = true;
    characterData.chats = chatRows.map((row) => ({
      id: row.id as string,
      name: (row.name as string) ?? "",
      note: (row.note as string) ?? "",
      folderId: (row.folder_id as string) ?? undefined,
      lastDate: (row.last_message_time as number) ?? undefined,
      message: [],
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    })) as Chat[];
    return characterData;
  }

  async loadCharacterAssetFields(
    characterId: string,
  ): Promise<Partial<character> | null> {
    const row = await this.selectOne("SELECT id FROM characters WHERE id = ?", [
      characterId,
    ]);
    if (!row) return null;
    const query = buildCharacterAssetFieldsQuery(characterId);
    const [nodeResult] = await this.selectBatchResults([
      { sql: query.sql, bind: query.bind, transform: "relational" },
    ]);
    return (nodeResult.value ?? {}) as Partial<character>;
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
    const messageStatement = buildBranchMessageRowsQuery(
      chatId,
      undefined,
      limit,
    );
    const totalStatement = buildBranchMessageCountQuery(chatId);
    const [
      chatResult,
      nodeResult,
      totalResult,
      messageResult,
      activeBranchResult,
      branchCountResult,
    ] = await this.selectBatchResults([
      {
        sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE id = ?",
        bind: [chatId],
      },
      {
        sql: `SELECT node_id, parent_node_id, node_order, object_key,
                       object_key_encoded, value_type, text_value, encoded_text_value,
                       number_value, boolean_value
                FROM chat_extension_nodes WHERE chat_id = ? ORDER BY node_id`,
        bind: [chatId],
        transform: "relational",
      },
      totalStatement,
      {
        ...messageStatement,
        transform: "messages",
      },
      {
        sql: "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
        bind: [chatId],
      },
      {
        sql: "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
        bind: [chatId],
      },
    ]);
    const cr = chatResult.rows?.[0];
    if (!cr) return null;
    const activeBranch = activeBranchResult.rows?.[0] as
      { branch_id: string } | undefined;
    const branchCount = Number(branchCountResult.rows?.[0]?.total ?? 0);
    const cd = (nodeResult.value ?? {}) as any;
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId, cd, branchCount)) {
      return this.loadChat(chatId, options);
    }
    if (!activeBranch) {
      await this.ensureBranchGraph(chatId);
      return this.loadChat(chatId, options);
    }
    cd.id = cr.id;
    cd.name = (cr.name as string) ?? "";
    cd.note = (cr.note as string) ?? "";
    cd.folderId = (cr.folder_id as string) ?? undefined;
    cd.lastDate = (cr.last_message_time as number) ?? undefined;
    cd.activeBranchId = activeBranch?.branch_id;
    if (activeBranch) delete cd.branchState;
    const total = Number(totalResult.rows?.[0]?.total ?? 0);
    cd.message = (messageResult.value ?? []) as Message[];
    const offset = Math.max(0, total - cd.message.length);
    cd.messageOffset = offset;
    cd.messageTotal = total;
    cd.messagesFullyLoaded = offset === 0;
    cd.messagesLoaded = true;
    cd.detailsLoaded = true;
    return cd;
  }

  async loadChatMessages(
    chatId: string,
    options?: { mode?: MessageLoadMode },
  ): Promise<Message[]> {
    await this.ensureBranchGraph(chatId);
    const query = buildBranchMessageRowsQuery(
      chatId,
      undefined,
      undefined,
      options?.mode === "generation" ? "generation" : "full",
    );
    const [result] = await this.selectBatchResults([
      { ...query, transform: "messages" },
    ]);
    return (result.value ?? []) as Message[];
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    await this.ensureBranchGraph(chatId);
    const totalStatement = buildBranchMessageCountQuery(chatId);
    const totalRow = await this.selectOne(
      totalStatement.sql,
      totalStatement.bind,
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
    const [result] = await this.selectBatchResults([
      { ...pageQuery, transform: "messages" },
    ]);
    return {
      messages: (result.value ?? []) as Message[],
      offset,
      total,
      hasMore: offset > 0,
    };
  }

  private async runBranchTransaction(
    statements: { sql: string; bind?: unknown[] }[],
  ): Promise<void> {
    await this.writeQueue.run(async () => {
      await this.run("BEGIN IMMEDIATE");
      try {
        if (!this.rpc) throw new Error("Database not opened");
        await this.rpc.execBatch(statements);
        await this.run("COMMIT");
      } catch (error) {
        await this.run("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async loadLinearMessages(chatId: string): Promise<Message[]> {
    const query = buildMessageRowsQuery(chatId, undefined, 0, false, "full");
    const [result] = await this.selectBatchResults([
      { ...query, transform: "messages" },
    ]);
    return (result.value ?? []) as Message[];
  }

  private async loadLegacyChatExtension(
    chatId: string,
  ): Promise<Record<string, any>> {
    const [result] = await this.selectBatchResults([
      {
        sql: `SELECT node_id, parent_node_id, node_order, object_key,
                   object_key_encoded, value_type, text_value, encoded_text_value,
                   number_value, boolean_value
              FROM chat_extension_nodes WHERE chat_id = ? ORDER BY node_id`,
        bind: [chatId],
        transform: "relational",
      },
    ]);
    return (result.value ?? {}) as Record<string, any>;
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
          await this.selectOne(
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
    const currentCount = Number(
      (
        await this.selectOne(
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
    await this.runBranchTransaction(
      buildSqliteLegacyBranchMigrationStatements(chatId, chatData, plan),
    );
    return true;
  }

  private async ensureBranchGraph(chatId: string): Promise<void> {
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId)) return;
    await this.runBranchTransaction(ensureSqliteBranchGraphStatements(chatId));
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
    const countRow = (await this.selectOne(
      countQuery.sql,
      countQuery.bind,
    )) as { total?: number } | null;
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
    options?: { messageLimit?: number; mode?: MessageLoadMode },
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
    const [result] = await this.selectBatchResults([
      { ...query, transform: "messages" },
    ]);
    return (result.value ?? []) as Message[];
  }

  async createChatBranch(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary> {
    await this.ensureBranchGraph(input.chatId);
    const active = (await this.selectOne(
      "SELECT branch_id FROM chat_active_branches WHERE chat_id = ?",
      [input.chatId],
    )) as { branch_id: string } | null;
    const parentBranchId = input.parentBranchId ?? active?.branch_id;
    if (!parentBranchId) throw new Error("Chat branch root does not exist");
    await this.runBranchTransaction([
      {
        sql: `INSERT INTO chat_branches
                (chat_id, id, parent_branch_id, fork_message_id, head_message_id, reason, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          input.chatId,
          input.id,
          parentBranchId,
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
    const row = await this.selectOne(
      `SELECT id, chat_id, parent_branch_id, fork_message_id,
              head_message_id, reason, created_at
         FROM chat_branches WHERE chat_id = ? AND id = ?`,
      [input.chatId, input.id],
    );
    if (!row) throw new Error("Failed to create chat branch");
    return mapSqliteChatBranchRow(row as SqliteChatBranchRow);
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    await this.ensureBranchGraph(chatId);
    const exists = await this.selectOne(
      "SELECT id FROM chat_branches WHERE chat_id = ? AND id = ?",
      [chatId, branchId],
    );
    if (!exists) throw new Error("Chat branch does not exist");
    await this.runBranchTransaction([
      {
        sql: "UPDATE chat_active_branches SET branch_id = ? WHERE chat_id = ?",
        bind: [branchId, chatId],
      },
    ]);
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
        { name: string; data: loreBook[] }[] | undefined) ?? []
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

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    return this.writeQueue.run(async () => {
      await this.run("BEGIN IMMEDIATE");
      try {
        await writeSqliteColdStorage(
          (sql, bind = []) => this.run(sql, bind),
          key,
          value,
        );
        await this.run("COMMIT");
        return true;
      } catch (error) {
        try {
          await this.run("ROLLBACK");
        } catch {
          // Preserve the original cold-storage error.
        }
        throw error;
      }
    });
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    const statement = buildSqliteColdStorageDelete(keys);
    if (!statement) return 0;
    return this.writeQueue.run(async () => {
      await this.run(statement.sql, statement.bind ?? []);
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
      await this.run(statement.sql, statement.bind ?? []);
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
    const selectRowSets: SqliteSelectRowSets = async (queries) =>
      (await this.selectBatchResults(queries)).map(
        (result) => result.rows ?? [],
      );
    return await listSqliteDbTables(
      this.selectRows.bind(this) as SqliteSelectRows,
      selectRowSets,
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
      throw new Error("Browser SQLite storage is not available");
    }
    const selectRowSets: SqliteSelectRowSets = async (queries) =>
      (await this.selectBatchResults(queries)).map(
        (result) => result.rows ?? [],
      );
    return await getSqliteDbTableData(
      this.selectRows.bind(this) as SqliteSelectRows,
      selectRowSets,
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
