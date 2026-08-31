import type { CanonicalDatabase, Database, DatabaseSettings, character, groupChat, Chat, Message, RisuPersona, botPreset, loreBook, customscript } from "../../../database/schema";
import type { RisuModule } from "../../../../process/modules";
import type {
  ISqlStorage,
  SqlStartupDataResult,
  SqlDatabaseSnapshotResult,
  BotPresetSummary,
  StoredBotPreset,
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
} from "../../postgres/nodePostgresStorage";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
  PROMPT_SETTING_KEYS,
} from "../../sqlDeferredSettings";
import sqliteSchemaSql from "../sqlite-schema.sql?raw";
import {
  buildSqlReplaceCommit,
  mergeLegacyModulesIntoCommit,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "../../sqlCommit";
import { applySqliteCommit, writeSqliteColdStorage } from "../sqliteCommit";
import {
  rebuildRelationalValue,
  RELATIONAL_SCHEMA_LAYOUT,
  SQLITE_SCHEMA_VERSION,
  SqlSchemaResetRequiredError,
  type RelationalNodeRow,
} from "../relationalNodeCodec";
import {
  AsyncSerialQueue,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
  buildDeferredSettingsQuery,
  groupSettingNodeRows,
  buildMessageRowsQuery,
  buildCharacterAssetFieldsQuery,
  type MessageLoadMode,
  type SettingNodeRow,
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

  private async loadNodeValue(
    table: string,
    ownerWhere: string,
    bind: unknown[],
  ): Promise<unknown> {
    const rows = await this.selectRows(
      `SELECT node_id, parent_node_id, node_order, object_key,
            object_key_encoded, value_type, text_value, encoded_text_value, number_value,
            boolean_value FROM ${table} WHERE ${ownerWhere} ORDER BY node_id`,
      bind,
    );
    return rows.length ? rebuildRelationalValue(rows) : undefined;
  }

  private async loadSettingValue(key: string): Promise<unknown> {
    return this.loadNodeValue("setting_extension_nodes", "setting_key = ?", [
      key,
    ]);
  }

  private rebuildGroupedNodeValues(
    rows: Record<string, unknown>[],
    ownerKey: string,
  ): Map<string, unknown> {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const owner = String(row[ownerKey] ?? "");
      if (!owner) continue;
      const list = grouped.get(owner) ?? [];
      list.push(row);
      grouped.set(owner, list);
    }
    return new Map(
      Array.from(grouped, ([owner, nodes]) => [
        owner,
        rebuildRelationalValue(nodes),
      ]),
    );
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

  private async loadMessagesBatch(
    chatId: string,
    limit?: number,
    offset = 0,
    mode: MessageLoadMode = "full",
  ): Promise<Message[]> {
    const statement = this.messageRowsStatement(chatId, limit, offset, false, mode);
    const [result] = await this.selectBatchResults([
      { ...statement, transform: "messages" },
    ]);
    return (result.value ?? []) as Message[];
  }

  private async loadCharacterChats(characterId: string): Promise<Chat[]> {
    const chatRows = await this.selectRows(
      "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
      [characterId],
    );
    if (chatRows.length === 0) return [];
    const nodeRows = await this.selectRows(
      `SELECT chat_id, node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
       FROM chat_extension_nodes
       WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)
       ORDER BY chat_id, node_id`,
      [characterId],
    );
    const values = this.rebuildGroupedNodeValues(nodeRows, "chat_id");
    return chatRows.map((row) => {
      const id = row.id as string;
      const loaded = values.get(id);
      const chat =
        loaded && typeof loaded === "object" ? (loaded as Chat) : ({} as Chat);
      chat.id = id;
      chat.name = (row.name as string) ?? "";
      chat.note = (row.note as string) ?? "";
      chat.folderId = (row.folder_id as string) ?? undefined;
      chat.lastDate = (row.last_message_time as number) ?? undefined;
      chat.message = [];
      chat.messagesLoaded = false;
      chat.detailsLoaded = true;
      return chat;
    });
  }

  private async validatePresetCommit(commit: SqlCommit): Promise<void> {
    if (!commit.presets) return;
    const originalIds = (
      await this.selectRows(
        "SELECT preset_id FROM bot_presets ORDER BY position",
      )
    ).map((row) => row.preset_id as string);
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
    )
      throw new Error("Active bot preset does not exist");
    if (commit.presets.activeId === undefined) {
      const current = (await this.loadSettingValue("activeBotPresetId")) as
        | string
        | undefined;
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

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }

    const settingsRows = await this.selectRows("SELECT key FROM system_settings");
    const deferredKeys = new Set<string>(DEFERRED_STARTUP_SETTING_KEYS);
    const settingsStoreExcludedKeys = new Set<string>(
      SETTINGS_STORE_EXCLUDED_KEYS,
    );
    const excludedKeys = [...deferredKeys, ...settingsStoreExcludedKeys];
    const settingNodeQuery = buildDeferredSettingsQuery(excludedKeys);
    const settingNodeRows = await this.selectRows(
      settingNodeQuery.sql,
      settingNodeQuery.bind,
    );
    const settingValues = groupSettingNodeRows(
      settingNodeRows as SettingNodeRow[],
    );
    const settings: Partial<DatabaseSettings> = {};
    for (const row of settingsRows) {
      const key = row.key as string;
      if (deferredKeys.has(key) || settingsStoreExcludedKeys.has(key)) continue;
      (settings as Record<string, unknown>)[key] = settingValues.get(key);
    }

    const charRows = await this.selectRows(
      "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
    );
    const characters: (character | groupChat)[] = charRows.map((row) => ({
      chaId: row.id as string,
      type: (row.kind as "character" | "group") ?? "character",
      name: (row.name as string) ?? "",
      image: (row.image as string) ?? "",
      trashTime: (row.trash_time as number) ?? undefined,
      creationDate: (row.creation_time as number) ?? undefined,
      modificationDate: (row.modification_time as number) ?? undefined,
      lastInteraction: (row.last_interaction_time as number) ?? undefined,
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    } as unknown as character | groupChat));

    const metaRow = await this.selectOne(
      "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
    );
    const initialized =
      metaRow?.initialized === 1 || characters.length > 0 || settingsRows.length > 0;
    return {
      status: initialized ? "ready" : "empty",
      revision: this.revision,
      settings,
      characters,
      deferredSettingKeys: [...deferredKeys],
    };
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const db: CanonicalDatabase = {} as CanonicalDatabase;

    const settingsRows = await this.selectRows("SELECT key FROM system_settings");
    const deferredKeyList = [...LEGACY_PERSONA_MIRROR_KEYS];
    const deferredKeys = new Set<string>(deferredKeyList);
    const settingNodeQuery = buildDeferredSettingsQuery(deferredKeyList);
    const settingNodeRows = await this.selectRows(
      settingNodeQuery.sql,
      settingNodeQuery.bind,
    );
    const settingValues = groupSettingNodeRows(
      settingNodeRows as SettingNodeRow[],
    );
    for (const row of settingsRows) {
      const key = row.key as string;
      if (deferredKeys.has(key)) continue;
      // The batched node read above already covers every non-deferred key;
      // a key without node rows simply stores `undefined`.
      (db as Record<string, unknown>)[key] = settingValues.get(key);
    }

    if (
      !db.pluginCustomStorage ||
      Object.keys(db.pluginCustomStorage).length === 0
    ) {
      const pluginStorageRows = await this.selectRows<{
        key: string;
        value: string;
      }>("SELECT key, value FROM plugin_custom_storage");
      if (pluginStorageRows.length > 0) {
        db.pluginCustomStorage = {};
        for (const row of pluginStorageRows) {
          try {
            db.pluginCustomStorage[row.key] = JSON.parse(row.value);
          } catch {
            db.pluginCustomStorage[row.key] = row.value;
          }
        }
      }
    }
    db.pluginCustomStorage ??= {};

    const charRows = await this.selectRows<{
      id: string;
      position: number;
      kind: string;
      name: string;
      image: string | null;
      trash_time: number | null;
      creation_time: number | null;
      modification_time: number | null;
      last_interaction_time: number | null;
      details_loaded: number;
    }>(
      "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
    );
    const characters: (character | groupChat)[] = [];
    for (const row of charRows) {
      const fullChar = ((await this.loadNodeValue(
        "character_extension_nodes",
        "character_id = ?",
        [row.id],
      )) ?? {}) as character | groupChat;
      fullChar.chaId = row.id;
      fullChar.detailsLoaded = true;
      const chats = await this.loadCharacterChats(row.id);
      for (const chat of chats) {
        if (!chat.id) continue;
        chat.message = await this.loadMessagesBatch(chat.id);
        chat.messageOffset = 0;
        chat.messageTotal = chat.message.length;
        chat.messagesLoaded = true;
        chat.messagesFullyLoaded = true;
        chat.detailsLoaded = true;
      }
      fullChar.chats = chats;
      characters.push(fullChar);
    }
    db.characters = characters;
    db.modules = await this.loadModules();

    const presetRows = await this.selectRows<{
      preset_id: string;
      data: string;
    }>("SELECT preset_id, data FROM bot_presets ORDER BY position");
    if (presetRows.length > 0) {
      const presets: botPreset[] = [];
      for (const row of presetRows) {
        try {
          presets.push(
            typeof row.data === "string"
              ? JSON.parse(row.data)
              : (row.data as botPreset),
          );
        } catch {}
      }
      db.botPresets = presets;
      if (db.activeBotPresetId) {
        const activeIndex = presetRows.findIndex(
          (row) => row.preset_id === db.activeBotPresetId,
        );
        db.botPresetsId = activeIndex >= 0 ? activeIndex : 0;
      } else {
        db.botPresetsId = 0;
      }
    } else {
      db.botPresets = [];
      db.botPresetsId = 0;
    }

    const metaRow = await this.selectOne(
      "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
    );
    const isInit =
      metaRow?.initialized === 1 ||
      characters.length > 0 ||
      settingsRows.length > 0 ||
      (db.modules?.length ?? 0) > 0 ||
      (db.botPresets?.length ?? 0) > 0;
    if (!isInit) return { revision: this.revision, database: null };
    return { revision: this.revision, database: db };
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    return this.writeQueue.run(() => this.commitInternal(commit));
  }

  private async commitInternal(
    commit: SqlCommit,
  ): Promise<SqlCommitResult> {
    if (!this._enabled) throw new Error("SQLite storage is not enabled");
    await this.run("BEGIN IMMEDIATE");
    try {
      const meta = await this.selectOne(
        "SELECT revision FROM system_storage_meta WHERE singleton = 1",
      );
      const currentRevision = Number(meta?.revision) || 0;
      if (commit.baseRevision !== currentRevision)
        throw new SqlRevisionConflictError(currentRevision);
      if (commit.modules && !commit.replaceAll) {
        const moduleCount = await this.selectOne(
          "SELECT COUNT(*) AS count FROM module_records",
        );
        if (Number(moduleCount?.count) === 0) {
          mergeLegacyModulesIntoCommit(
            commit,
            await this.loadSettingValue("modules"),
          );
        }
      }
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
    const row = await this.selectOne("SELECT id FROM characters WHERE id = ?", [
      characterId,
    ]);
    if (!row) return null;
    const fc = ((await this.loadNodeValue(
      "character_extension_nodes",
      "character_id = ?",
      [characterId],
    )) ?? {}) as any;
    fc.chaId = characterId;
    fc.detailsLoaded = true;
    fc.chats = await this.loadCharacterChats(characterId);
    return fc;
  }

  async loadCharacterForSelection(
    characterId: string,
  ): Promise<character | groupChat | null> {
    const [characterResult, nodeResult, chatResult] = await this.selectBatchResults([
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
    const [chatResult, nodeResult, totalResult, messageResult] =
      await this.selectBatchResults([
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
        {
          sql: "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
          bind: [chatId],
        },
        {
          ...this.messageRowsStatement(chatId, limit, 0, limit !== undefined),
          transform: "messages",
        },
      ]);
    const cr = chatResult.rows?.[0];
    if (!cr) return null;
    const cd = (nodeResult.value ?? {}) as any;
    cd.id = cr.id;
    cd.name = (cr.name as string) ?? "";
    cd.note = (cr.note as string) ?? "";
    cd.folderId = (cr.folder_id as string) ?? undefined;
    cd.lastDate = (cr.last_message_time as number) ?? undefined;
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
    return this.loadMessagesBatch(
      chatId,
      undefined,
      0,
      options?.mode === "generation" ? "generation" : "full",
    );
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    const totalRow = await this.selectOne(
      "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
      [chatId],
    );
    const total = Number(totalRow?.total ?? 0);
    const end = normalizeSqlitePageEnd(before, total);
    const normalizedLimit = normalizeSqliteLimit(limit);
    const offset = Math.max(0, end - normalizedLimit);
    const messages = await this.loadMessagesBatch(
      chatId,
      end - offset,
      offset,
    );
    return {
      messages,
      offset,
      total,
      hasMore: offset > 0,
    };
  }

  async loadPersonas(): Promise<RisuPersona[]> {
    return (
      ((await this.loadSettingValue("personas")) as
        | RisuPersona[]
        | undefined) ?? []
    );
  }
  async listBotPresets(): Promise<BotPresetSummary[]> {
    return (
      await this.selectRows(
        "SELECT preset_id, position, name, image, api_type, ai_model, content_hash FROM bot_presets ORDER BY position",
      )
    ).map((row) => ({
      id: row.preset_id as string,
      position: Number(row.position),
      name: row.name as string,
      image: row.image as string,
      apiType: row.api_type as string,
      aiModel: row.ai_model as string,
      hash: row.content_hash as string,
    }));
  }
  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    const row = await this.selectOne(
      "SELECT data FROM bot_presets WHERE preset_id = ?",
      [id],
    );
    if (!row) return null;
    return { ...(JSON.parse(row.data as string) as botPreset), id };
  }
  async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
    return (
      ((await this.loadSettingValue("loreBook")) as
        | { name: string; data: loreBook[] }[]
        | undefined) ?? []
    );
  }
  async loadModules(): Promise<RisuModule[]> {
    const rows = await this.selectRows(
      "SELECT module_id FROM module_records ORDER BY position",
    );
    if (rows.length === 0) {
      return (
        ((await this.loadSettingValue("modules")) as
          | RisuModule[]
          | undefined) ?? []
      );
    }
    const nodeRows = await this.selectRows(
      `SELECT module_id, node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
         FROM module_extension_nodes
        ORDER BY module_id, node_id`,
    );
    const values = this.rebuildGroupedNodeValues(nodeRows, "module_id");
    return rows.map((row) => {
      const id = row.module_id as string;
      return { ...(values.get(id) as RisuModule), id };
    });
  }
  async loadPrompts(): Promise<Record<string, any>> {
    const rows = await this.selectRows(
      "SELECT key FROM system_settings WHERE domain = 'prompt'",
    );
    if (rows.length === 0) return {};
    const nodeRows = await this.selectRows(
      `SELECT setting_key, node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
       FROM setting_extension_nodes
       WHERE setting_key IN (SELECT key FROM system_settings WHERE domain = 'prompt')
       ORDER BY setting_key, node_id`,
    );
    const values = this.rebuildGroupedNodeValues(nodeRows, "setting_key");
    const prompts: Record<string, any> = {};
    for (const row of rows) {
      const key = row.key as string;
      prompts[key] = values.has(key)
        ? values.get(key)
        : await this.loadSettingValue(key);
    }
    return prompts;
  }
  async loadScripts(): Promise<customscript[]> {
    return (
      ((await this.loadSettingValue("globalscript")) as
        | customscript[]
        | undefined) ?? []
    );
  }

  async loadPlugins(options?: { enabledOnly?: boolean }): Promise<any[] | null> {
    const plugins = ((await this.loadSettingValue("plugins")) as any[] | undefined) ?? null;
    return options?.enabledOnly && plugins ? plugins.filter((plugin) => plugin?.enabled) : plugins;
  }
  async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
    const rows = await this.selectRows(
      "SELECT key, value FROM plugin_custom_storage",
    );
    if (rows.length === 0) return null;
    const s: Record<string, any> = {};
    for (const r of rows) {
      try {
        s[r.key as string] = JSON.parse(r.value as string);
      } catch {
        s[r.key as string] = r.value;
      }
    }
    return s;
  }

  async listPluginCustomStorageKeys(): Promise<string[]> {
    return (
      await this.selectRows(
        "SELECT key FROM plugin_custom_storage ORDER BY key",
      )
    ).map((row) => row.key as string);
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    const row = await this.selectOne(
      "SELECT value FROM plugin_custom_storage WHERE key = ?",
      [key],
    );
    if (!row) return undefined;
    try {
      return JSON.parse(row.value as string);
    } catch {
      return row.value;
    }
  }

  async loadSettingKey(key: string): Promise<any> {
    return this.loadSettingValue(key);
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    const r = await this.selectOne(
      "SELECT archive_id FROM cold_archives WHERE archive_id = ?",
      [key],
    );
    return r
      ? this.loadNodeValue("cold_extension_nodes", "archive_id = ?", [key])
      : null;
  }
  async listColdStorageItems(): Promise<{ items: string[] }> {
    return {
      items: (
        await this.selectRows("SELECT archive_id FROM cold_archives")
      ).map((r) => r.archive_id as string),
    };
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
    if (keys.length === 0) return 0;
    return this.writeQueue.run(async () => {
      const ph = keys.map(() => "?").join(",");
      await this.run(
        `DELETE FROM cold_archives WHERE archive_id IN (${ph})`,
        keys,
      );
      return keys.length;
    });
  }
  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    return this.writeQueue.run(async () => {
      const all = (
        await this.selectRows("SELECT archive_id FROM cold_archives")
      ).map((r) => r.archive_id as string);
      const removed = all.filter((k) => !retainedKeys.includes(k));
      if (removed.length === 0) return 0;
      const ph = removed.map(() => "?").join(",");
      await this.run(
        `DELETE FROM cold_archives WHERE archive_id IN (${ph})`,
        removed,
      );
      return removed.length;
    });
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    const normalizedLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? normalizeSqliteLimit(limit)
        : undefined;
    const sql =
      "SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC" +
      (normalizedLimit !== undefined ? " LIMIT ?" : "");
    const rows = await this.selectRows(
      sql,
      normalizedLimit !== undefined ? [normalizedLimit] : [],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      storage_revision:
        r.storage_revision != null ? Number(r.storage_revision) : null,
      database_initialized:
        r.database_initialized != null ? Boolean(r.database_initialized) : null,
      scope: r.scope as "database" | "cold-storage" | "restore",
      action: r.action as string,
      restored_from_revision:
        r.restored_from_revision != null
          ? Number(r.restored_from_revision)
          : null,
      created_at: r.created_at as string,
      change_count: 0,
    }));
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    const rows = await this.selectRows(
      "SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions WHERE id = ?",
      [revisionId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      storage_revision:
        r.storage_revision != null ? Number(r.storage_revision) : null,
      database_initialized:
        r.database_initialized != null ? Boolean(r.database_initialized) : null,
      scope: r.scope as "database" | "cold-storage" | "restore",
      action: r.action as string,
      restored_from_revision:
        r.restored_from_revision != null
          ? Number(r.restored_from_revision)
          : null,
      created_at: r.created_at as string,
      change_count: 0,
      tableSummaries: [],
      auditLogs: [],
    };
  }

  async getRevisionDiff(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null> {
    return {
      baseRevisionId: baseId,
      targetRevisionId: targetId,
      totalChanges: 0,
      tables: [],
    };
  }

  async previewRestoreRevision(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null> {
    return {
      targetRevisionId: revisionId,
      currentRevisionId: this.revision,
      revisionsToRevert: Math.max(0, this.revision - revisionId),
      totalOperations: 0,
      restoreInsertCount: 0,
      restoreDeleteCount: 0,
      restoreUpdateCount: 0,
      affectedTables: [],
    };
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
    const rows = await this.selectRows(
      `SELECT chat_id, id, position, role, sent_time, sender_name, content_text
             FROM messages WHERE content_text LIKE ? ORDER BY sent_time DESC LIMIT ?`,
      [`%${query}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => {
      return {
        storageState: "active" as const,
        archiveId: null,
        characterId: null,
        characterName: null,
        chatId: r.chat_id as string,
        chatName: "",
        messageId: r.id as string,
        position: Number(r.position),
        role: r.role as "user" | "char",
        sentTime: r.sent_time != null ? Number(r.sent_time) : null,
        senderName: (r.sender_name as string) ?? null,
        snippet: String(r.content_text ?? "").slice(0, 200),
      };
    });
  }
  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    return (
      await this.selectRows(
        `SELECT COALESCE(generation_model, 'unknown') AS model,
            COUNT(*) AS message_count, COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens FROM messages
            WHERE generation_model IS NOT NULL GROUP BY generation_model`,
      )
    ).map((row) => ({
      model: row.model as string,
      messageCount: Number(row.message_count),
      totalInputTokens: Number(row.input_tokens),
      totalOutputTokens: Number(row.output_tokens),
    }));
  }
  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    const chars = (await this.selectRows(
      "SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position ASC",
    )) as {
      id: string;
      name: string;
      image: string | null;
      kind: string;
      last_interaction_time: number | null;
    }[];
    const chatRows = (await this.selectRows(
      "SELECT id, character_id, last_message_time FROM chats",
    )) as {
      id: string;
      character_id: string;
      last_message_time: number | null;
    }[];
    const msgRows = (await this.selectRows(
      "SELECT chat_id, role, sent_time, length(COALESCE(content_text, content_encoded, '')) AS content_length FROM messages",
    )) as {
      chat_id: string;
      role: string;
      sent_time: number | null;
      content_length: number;
    }[];

    const chatsByChar = new Map<
      string,
      { id: string; lastMessageTime: number | null }[]
    >();
    for (const ch of chatRows) {
      let list = chatsByChar.get(ch.character_id);
      if (!list) {
        list = [];
        chatsByChar.set(ch.character_id, list);
      }
      list.push({
        id: ch.id,
        lastMessageTime:
          ch.last_message_time != null ? Number(ch.last_message_time) : null,
      });
    }

    const msgsByChat = new Map<
      string,
      { role: string; sentTime: number | null; len: number }[]
    >();
    for (const m of msgRows) {
      let list = msgsByChat.get(m.chat_id);
      if (!list) {
        list = [];
        msgsByChat.set(m.chat_id, list);
      }
      list.push({
        role: m.role,
        sentTime: m.sent_time != null ? Number(m.sent_time) : null,
        len: Number(m.content_length),
      });
    }

    return chars.map((c) => {
      const charChats = chatsByChar.get(c.id) || [];
      let totalMessages = 0;
      let userMessages = 0;
      let botMessages = 0;
      let longestSessionMessages = 0;
      let lastActiveDate: number | null =
        c.last_interaction_time != null
          ? Number(c.last_interaction_time)
          : null;
      let totalBotLen = 0;
      let totalUserLen = 0;

      for (const ch of charChats) {
        if (
          ch.lastMessageTime != null &&
          (lastActiveDate == null || ch.lastMessageTime > lastActiveDate)
        ) {
          lastActiveDate = ch.lastMessageTime;
        }
        const msgs = msgsByChat.get(ch.id) || [];
        if (msgs.length > longestSessionMessages) {
          longestSessionMessages = msgs.length;
        }
        totalMessages += msgs.length;
        for (const m of msgs) {
          if (
            m.sentTime != null &&
            (lastActiveDate == null || m.sentTime > lastActiveDate)
          ) {
            lastActiveDate = m.sentTime;
          }
          if (m.role === "user") {
            userMessages++;
            totalUserLen += m.len;
          } else {
            botMessages++;
            totalBotLen += m.len;
          }
        }
      }

      const isGroup = c.kind === "group";
      const totalSessions = charChats.length;
      return {
        id: c.id,
        name: c.name || (isGroup ? "Group" : "Character"),
        avatarKey: c.image ?? undefined,
        image: c.image ?? undefined,
        isGroup,
        totalSessions,
        totalMessages,
        userMessages,
        botMessages,
        longestSessionMessages,
        lastActiveDate,
        avgBotMessageLen:
          botMessages > 0 ? Math.round(totalBotLen / botMessages) : 0,
        avgUserMessageLen:
          userMessages > 0 ? Math.round(totalUserLen / userMessages) : 0,
        avgMessagesPerSession:
          totalSessions > 0
            ? Number((totalMessages / totalSessions).toFixed(1))
            : 0,
      };
    });
  }
  private quoteExplorerIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private async getDbExplorerColumns(
    table: string,
  ): Promise<NodePostgresColumnInfo[]> {
    const exists = await this.selectOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? AND name NOT LIKE 'sqlite_%'",
      [table],
    );
    if (!exists) throw new Error(`SQLite table not found: ${table}`);
    const rows = await this.selectRows(
      `PRAGMA table_info(${this.quoteExplorerIdentifier(table)})`,
    );
    return rows.map((row) => ({
      name: String(row.name ?? ""),
      dataType: String(row.type ?? "UNKNOWN") || "UNKNOWN",
      nullable: Number(row.notnull ?? 0) === 0,
      primaryKey: Number(row.pk ?? 0) > 0,
    }));
  }

  async listDbTables(): Promise<NodePostgresTableInfo[]> {
    if (!this._enabled && !(await this.init())) return [];
    const rows = await this.selectRows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const results = await this.selectBatchResults(
      rows.map((row) => ({
        sql: `SELECT COUNT(*) AS total FROM ${this.quoteExplorerIdentifier(String(row.name))}`,
      })),
    );
    return rows.map((row, index) => ({
      name: String(row.name),
      rowCount: Number(results[index]?.rows?.[0]?.total ?? 0),
    }));
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
    const allColumns = await this.getDbExplorerColumns(table);
    const columnNames = new Set(allColumns.map((column) => column.name));
    const requestedColumns = options.columns?.filter((name) => columnNames.has(name));
    const columns = requestedColumns?.length
      ? allColumns.filter((column) => requestedColumns.includes(column.name))
      : allColumns;
    if (columns.length === 0) throw new Error(`SQLite table has no columns: ${table}`);

    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = normalizeSqliteLimit(options.limit ?? 50);
    const quotedTable = this.quoteExplorerIdentifier(table);
    const search = options.search?.trim() ?? "";
    const where = search
      ? ` WHERE ${allColumns
          .map((column) => `CAST(${this.quoteExplorerIdentifier(column.name)} AS TEXT) LIKE ? COLLATE NOCASE`)
          .join(" OR ")}`
      : "";
    const searchBinds = search ? allColumns.map(() => `%${search}%`) : [];
    const sortColumn = options.sortColumn && columnNames.has(options.sortColumn)
      ? options.sortColumn
      : "";
    const orderBy = sortColumn
      ? ` ORDER BY ${this.quoteExplorerIdentifier(sortColumn)} ${options.sortOrder === "desc" ? "DESC" : "ASC"}`
      : "";
    const selection = columns
      .map((column) => this.quoteExplorerIdentifier(column.name))
      .join(", ");

    const [countResult, rowsResult] = await this.selectBatchResults([
      { sql: `SELECT COUNT(*) AS total FROM ${quotedTable}${where}`, bind: searchBinds },
      {
        sql: `SELECT ${selection} FROM ${quotedTable}${where}${orderBy} LIMIT ? OFFSET ?`,
        bind: [...searchBinds, limit, offset],
      },
    ]);
    return {
      table,
      columns,
      allColumns,
      rows: rowsResult.rows ?? [],
      offset,
      limit,
      total: Number(countResult.rows?.[0]?.total ?? 0),
    };
  }

  async searchCharactersByTag(
    tag: string,
    limit: number = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    const rows = await this.selectRows(
      `SELECT DISTINCT c.id, c.name, c.image, c.kind FROM characters c
            JOIN character_tags t ON t.character_id = c.id WHERE t.tag LIKE ? LIMIT ?`,
      [`%${tag}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      image: (r.image as string) ?? null,
      kind: (r.kind as "character" | "group") ?? "character",
    }));
  }
  async searchCharactersByName(
    name: string,
    limit: number = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    const rows = await this.selectRows(
      "SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?",
      [`%${name}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      image: (r.image as string) ?? null,
      kind: (r.kind as "character" | "group") ?? "character",
    }));
  }
}
