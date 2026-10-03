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
import sqliteSchemaSql from "@risuai/storage-sqlite/schema/schema.sql?raw";
import {
  buildSqlReplaceCommit,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "../../sqlCommit";
import type { IPluginStorage } from "../../pluginStorage";
import { SqlitePluginStorage } from "../sqlitePluginStorage";
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
import * as sqliteSettings from "@risuai/storage-sqlite/queries/settings";
import * as sqliteSnapshot from "@risuai/storage-sqlite/queries/snapshot";
import * as sqliteStartup from "@risuai/storage-sqlite/queries/startup";
import * as nodeCodec from "@risuai/storage-sqlite/schema/codec";
import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
} from "@risuai/storage-sqlite/types";
import {
  AsyncSerialQueue,
  normalizeLimit,
  normalizePageEnd,
} from "@risuai/storage-sqlite/util";
import { createPortableDatabaseStreamSqliteSession } from "../portableDatabaseStreamSqliteRestore";
import type { PortableDatabaseStreamRestoreProgress } from "../../../backup/portableDatabaseStreamRestore";
import {
  rebuildBranchGraphMessages,
  rebuildMessageRows,
} from "../sqliteStorageUtils";

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
  readonly plugin: IPluginStorage = new SqlitePluginStorage(
    this,
    this.selectRows.bind(this) as SqliteSelectRows,
  );

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
    return await sqliteStartup.getSyncSummary(
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

  async close(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = null;
    this.initialized = false;
    this._enabled = false;
    if (!rpc) return;

    try {
      await rpc.close();
    } finally {
      rpc.terminate();
    }
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
      if (error instanceof nodeCodec.SchemaResetRequiredError) throw error;
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
    return sqliteNodes.loadValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      table,
      ownerWhere,
      bind,
    );
  }

  private loadSettingValue(key: string): Promise<unknown> {
    return sqliteNodes.loadSettingValue(
      this.selectRows.bind(this) as SqliteSelectRows,
      key,
    );
  }

  private rebuildGroupedNodeValues(
    rows: Record<string, unknown>[],
    ownerKey: string,
  ): Map<string, unknown> {
    return sqliteNodes.groupValues(rows, ownerKey);
  }

  private messageRowsStatement(
    chatId: string,
    limit?: number,
    offset = 0,
    newest = false,
    mode: sqliteMessages.LoadMode = "full",
  ): SqliteBatchStatement {
    return sqliteMessages.buildRowsQuery(chatId, limit, offset, newest, mode);
  }

  private async validatePresetCommit(commit: SqlCommit): Promise<void> {
    await sqliteCommitPrep.validatePresets(
      this.selectRows.bind(this) as SqliteSelectRows,
      commit,
    );
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const projection = await sqliteStartup.loadProjection(
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
    return (await sqliteSnapshot.exportDatabase({
      selectRows: this.selectRows.bind(this) as SqliteSelectRows,
      selectRowSets: ((queries) =>
        this.selectBatch(queries)) as SqliteSelectRowSets,
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
      await sqliteCommitPrep.prepareModules(
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
      await sqliteCommit.apply(commit, append);
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

  async beginPortableDatabaseStreamRestore(
    onProgress?: (progress: PortableDatabaseStreamRestoreProgress) => void,
  ) {
    if (!this._enabled && !(await this.init())) {
      throw new Error("SQLite storage is not enabled");
    }
    const baseRevision = this.revision;
    return await createPortableDatabaseStreamSqliteSession({
      baseRevision,
      onProgress,
      onCommitted: (revision) => {
        this.revision = revision;
      },
      runTransaction: (task) =>
        this.writeQueue.run(async () => {
          await this.run("BEGIN IMMEDIATE");
          try {
            const meta = await this.selectOne(
              "SELECT revision FROM system_storage_meta WHERE singleton = 1",
            );
            const currentRevision = Number(meta?.revision) || 0;
            if (currentRevision !== baseRevision) {
              throw new SqlRevisionConflictError(currentRevision);
            }
            const pending: SqliteBatchStatement[] = [];
            const flush = async () => {
              if (pending.length === 0) return;
              const chunk = pending.splice(0, pending.length);
              if (!this.rpc) throw new Error("Database not opened");
              await this.rpc.execBatch(chunk);
            };
            const revision = await task(async (sql, bind = []) => {
              pending.push({ sql, bind });
              if (pending.length >= 64) await flush();
            });
            await flush();
            await this.run("COMMIT");
            return revision;
          } catch (error) {
            try {
              await this.run("ROLLBACK");
            } catch {}
            throw error;
          }
        }),
    });
  }

  async loadCharacter(
    characterId: string,
  ): Promise<character | groupChat | null> {
    return (await sqliteEntity.loadCharacterDocument(
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
    const query = sqliteEntity.buildCharacterAssetFieldsQuery(characterId);
    const [nodeResult] = await this.selectBatchResults([
      { sql: query.sql, bind: query.bind, transform: "relational" },
    ]);
    return (nodeResult.value ?? {}) as Partial<character>;
  }

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    const plan = sqliteChat.buildLoadPlan(chatId, options?.messageLimit);
    const [
      chatResult,
      nodeResult,
      totalResult,
      messageResult,
      activeBranchResult,
      branchCountResult,
    ] = await this.selectBatchResults([
      plan.chat,
      { ...plan.extension, transform: "relational" },
      plan.total,
      { ...plan.messages, transform: "messages" },
      plan.activeBranch,
      plan.branchCount,
    ]);
    const chatRow = chatResult.rows?.[0] as sqliteChat.Row | undefined;
    if (!chatRow) return null;
    const activeBranch = activeBranchResult.rows?.[0] as
      { branch_id: string } | undefined;
    const branchCount = Number(branchCountResult.rows?.[0]?.total ?? 0);
    const extension = (nodeResult.value ?? {}) as Record<string, unknown>;
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
    const total = Number(totalResult.rows?.[0]?.total ?? 0);
    return sqliteChat.hydrateDocument(
      chatRow,
      extension,
      (messageResult.value ?? []) as Message[],
      total,
      activeBranch.branch_id,
    ) as unknown as Chat;
  }

  async loadChatMessages(
    chatId: string,
    options?: { mode?: sqliteMessages.LoadMode },
  ): Promise<Message[]> {
    await this.ensureBranchGraph(chatId);
    const query = sqliteMessages.buildBranchRowsQuery(
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
    const totalStatement = sqliteMessages.buildBranchCountQuery(chatId);
    const totalRow = await this.selectOne(
      totalStatement.sql,
      totalStatement.bind,
    );
    const page = sqliteChat.buildMessagePagePlan(
      chatId,
      before,
      Number(totalRow?.total ?? 0),
      limit,
    );
    const [result] = await this.selectBatchResults([
      { ...page.statement, transform: "messages" },
    ]);
    return {
      messages: (result.value ?? []) as Message[],
      offset: page.offset,
      total: page.total,
      hasMore: page.hasMore,
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
    const query = sqliteMessages.buildRowsQuery(
      chatId,
      undefined,
      0,
      false,
      "full",
    );
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
    await this.runBranchTransaction(
      sqliteBranch.buildLegacyMigrationStatements(chatId, chatData, plan),
    );
    return true;
  }

  private async ensureBranchGraph(chatId: string): Promise<void> {
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId)) return;
    await this.runBranchTransaction(sqliteBranch.ensureGraphStatements(chatId));
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
    const countRow = (await this.selectOne(
      countQuery.sql,
      countQuery.bind,
    )) as { total?: number } | null;
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
    options?: { messageLimit?: number; mode?: sqliteMessages.LoadMode },
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
    const [result] = await this.selectBatchResults([
      { ...query, transform: "messages" },
    ]);
    return (result.value ?? []) as Message[];
  }

  async createChatBranch(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary> {
    await this.ensureBranchGraph(input.chatId);
    const parentBranchId =
      input.parentBranchId ??
      (await sqliteBranch.getActiveId(
        this.selectRows.bind(this) as SqliteSelectRows,
        input.chatId,
      ));
    if (!parentBranchId) throw new Error("Chat branch root does not exist");
    await this.runBranchTransaction(
      sqliteBranch.buildCreateStatements(input, parentBranchId),
    );
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
    await this.runBranchTransaction([
      sqliteBranch.buildActivateStatement(chatId, branchId),
    ]);
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
        { name: string; data: loreBook[] }[] | undefined) ?? []
    );
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

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    return this.writeQueue.run(async () => {
      await this.run("BEGIN IMMEDIATE");
      try {
        await sqliteCommit.writeColdStorage(
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
    const statement = sqliteColdStorage.buildDelete(keys);
    if (!statement) return 0;
    return this.writeQueue.run(async () => {
      await this.run(statement.sql, statement.bind ?? []);
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
      await this.run(statement.sql, statement.bind ?? []);
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
    const selectRowSets: SqliteSelectRowSets = async (queries) =>
      (await this.selectBatchResults(queries)).map(
        (result) => result.rows ?? [],
      );
    return await sqliteAdmin.listTables(
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
    return await sqliteAdmin.getTableData(
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
