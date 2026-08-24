import type {
  Database,
  character,
  groupChat,
  Chat,
  Message,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "./database.svelte";
import type { RisuModule } from "../process/modules";
import type {
  ISqlStorage,
  SqlLoadDatabaseOptions,
  SqlLoadDatabaseResult,
  BotPresetSummary,
  StoredBotPreset,
} from "./ISqlStorage";
import type {
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresCharacterSearchResult,
  NodePostgresBotChatStats,
} from "./nodePostgresStorage";
import {
  createSqlDatabaseAdapter,
  PROMPT_SETTING_KEYS,
} from "./databaseAdapters.svelte";
import sqliteSchemaSql from "./sqlite-schema.sql?raw";
import {
  buildSqlReplaceCommit,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import { applySqliteCommit, writeSqliteColdStorage } from "./sqliteCommit";
import {
  rebuildRelationalValue,
  RELATIONAL_SCHEMA_LAYOUT,
  SQLITE_SCHEMA_VERSION,
  SqlSchemaResetRequiredError,
} from "./relationalNodeCodec";
import {
  AsyncSerialQueue,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
} from "./sqliteStorageUtils";

// ── Worker RPC plumbing ──────────────────────────────────────────────

type SqliteBatchStatement = { sql: string; bind?: unknown[] };

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
  init(): Promise<{ enabled: boolean; revision: number }>;
  exec(sql: string, bind?: unknown[]): Promise<void>;
  execBatch(statements: SqliteBatchStatement[]): Promise<void>;
  selectBatch(
    statements: SqliteBatchStatement[],
  ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }[]>;
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
    init: () => call<{ enabled: boolean; revision: number }>({ type: "init" }),
    exec: (sql, bind) =>
      call<void>({ type: "exec", sql, bind }).then(() => undefined),
    execBatch: (statements) =>
      call<void>({ type: "execBatch", statements }).then(() => undefined),
    selectBatch: (statements) =>
      call<{ rows: Record<string, unknown>[]; columns: string[] }[]>({
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
const DEFERRED_STARTUP_SETTING_KEYS = [
  "personas",
  "loreBook",
  "modules",
  "globalscript",
  "pluginCustomStorage",
  ...PROMPT_SETTING_KEYS,
] as const;

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
      this.initialized = true;
      return result.enabled;
    } catch (error) {
      console.error("WebSqliteStorage init failed:", error);
      this.initialized = true;
      this._enabled = false;
      if (error instanceof SqlSchemaResetRequiredError) throw error;
      return false;
    }
  }

  private async selectRows(
    sql: string,
    bind: unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    if (!this.rpc) throw new Error("Database not opened");
    return (await this.rpc.select(sql, bind)).rows;
  }

  private async selectOne(
    sql: string,
    bind: unknown[] = [],
  ): Promise<Record<string, unknown> | null> {
    if (!this.rpc) throw new Error("Database not opened");
    return this.rpc.selectOne(sql, bind);
  }

  private async selectBatch(
    statements: SqliteBatchStatement[],
  ): Promise<Record<string, unknown>[][]> {
    if (!this.rpc) throw new Error("Database not opened");
    const results = await this.rpc.selectBatch(statements);
    return results.map((result) => result.rows);
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

  private rebuildMessagesFromRows(
    rows: Record<string, unknown>[],
  ): Message[] {
    const nodeGroups = new Map<string, Record<string, unknown>[]>();
    const coreRows = new Map<string, Record<string, unknown>>();
    const orderedIds: string[] = [];
    for (const row of rows) {
      const id = String(row.message_id);
      if (!coreRows.has(id)) {
        coreRows.set(id, row);
        orderedIds.push(id);
      }
      if (row.node_id === null || row.node_id === undefined) continue;
      const nodes = nodeGroups.get(id) ?? [];
      nodes.push(row);
      nodeGroups.set(id, nodes);
    }
    return orderedIds.map((id) => {
      const nodes = nodeGroups.get(id);
      const core = coreRows.get(id)!;
      const rebuilt = nodes?.length
        ? rebuildRelationalValue(nodes)
        : {
            role: String(core.message_role ?? "char"),
            data: String(core.message_content_text ?? ""),
            ...(core.message_sender_name != null
              ? { name: String(core.message_sender_name) }
              : {}),
            ...(core.message_sent_time != null
              ? { time: Number(core.message_sent_time) }
              : {}),
          };
      const message =
        rebuilt && typeof rebuilt === "object"
          ? (rebuilt as Message)
          : ({ role: "char", data: String(rebuilt ?? "") } as Message);
      message.chatId = id;
      return message;
    });
  }

  private messageRowsStatement(
    chatId: string,
    limit?: number,
    offset = 0,
    newest = false,
  ): SqliteBatchStatement {
    let selectedSql =
      "SELECT chat_id, id, position, role, content_text, sender_name, sent_time FROM messages WHERE chat_id = ?";
    const bind: unknown[] = [chatId];
    if (limit === undefined) {
      selectedSql += " ORDER BY position";
    } else if (newest) {
      selectedSql = `SELECT * FROM (${selectedSql} ORDER BY position DESC LIMIT ?) ORDER BY position`;
      bind.push(limit);
    } else {
      selectedSql += " ORDER BY position LIMIT ? OFFSET ?";
      bind.push(limit, offset);
    }
    return {
      sql: `WITH selected AS (${selectedSql})
       SELECT selected.id AS message_id, selected.position AS message_position,
              selected.role AS message_role, selected.content_text AS message_content_text,
              selected.sender_name AS message_sender_name, selected.sent_time AS message_sent_time,
              n.node_id, n.parent_node_id, n.node_order, n.object_key,
              n.object_key_encoded, n.value_type, n.text_value, n.encoded_text_value,
              n.number_value, n.boolean_value
       FROM selected
       LEFT JOIN message_extension_nodes n
         ON n.chat_id = selected.chat_id AND n.message_id = selected.id
       ORDER BY selected.position, n.node_id`,
      bind,
    };
  }

  private async loadMessagesBatch(
    chatId: string,
    limit?: number,
    offset = 0,
  ): Promise<Message[]> {
    const statement = this.messageRowsStatement(chatId, limit, offset);
    const rows = await this.selectRows(statement.sql, statement.bind);
    return this.rebuildMessagesFromRows(rows);
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

  async loadDatabase(
    options?: SqlLoadDatabaseOptions,
  ): Promise<SqlLoadDatabaseResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }
    const shallow = options?.shallow !== false;
    const db: Database = {} as any;

    const settingsRows = await this.selectRows("SELECT key FROM system_settings");
    const deferredKeyList = shallow ? [...DEFERRED_STARTUP_SETTING_KEYS] : [];
    const deferredKeys = new Set<string>(deferredKeyList);
    const deferredWhere = deferredKeyList.length
      ? ` WHERE setting_key NOT IN (${deferredKeyList.map(() => "?").join(",")})`
      : "";
    const settingNodeRows = await this.selectRows(
      `SELECT setting_key, node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
       FROM setting_extension_nodes${deferredWhere}
       ORDER BY setting_key, node_id`,
      deferredKeyList,
    );
    const settingValues = this.rebuildGroupedNodeValues(
      settingNodeRows,
      "setting_key",
    );
    for (const row of settingsRows) {
      const key = row.key as string;
      if (deferredKeys.has(key)) continue;
      (db as any)[key] = settingValues.has(key)
        ? settingValues.get(key)
        : await this.loadSettingValue(key);
    }

    // A shallow startup only needs plugin-storage keys, which are loaded via
    // the dedicated API later. Pulling every plugin value here defeats lazy
    // loading and can clone a large payload across the Worker boundary.
    if (
      !shallow &&
      (!db.pluginCustomStorage ||
        Object.keys(db.pluginCustomStorage).length === 0)
    ) {
      const pluginStorageRows = await this.selectRows(
        "SELECT key, value FROM plugin_custom_storage",
      );
      if (pluginStorageRows.length > 0) {
        db.pluginCustomStorage = {};
        for (const row of pluginStorageRows) {
          try {
            db.pluginCustomStorage[row.key as string] = JSON.parse(
              row.value as string,
            );
          } catch {
            db.pluginCustomStorage[row.key as string] = row.value;
          }
        }
      }
    }
    db.pluginCustomStorage ??= {};

    const charRows = await this.selectRows(
      "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
    );
    const characters: (character | groupChat)[] = [];
    for (const row of charRows) {
      if (shallow) {
        characters.push({
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
        } as any);
      } else {
        const fullChar = ((await this.loadNodeValue(
          "character_extension_nodes",
          "character_id = ?",
          [row.id],
        )) ?? {}) as any;
        fullChar.chaId = row.id;
        fullChar.detailsLoaded = true;
        fullChar.chats = await this.loadCharacterChats(row.id as string);
        characters.push(fullChar);
      }
    }
    db.characters = characters;

    const metaRow = await this.selectOne(
      "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
    );
    const isInit =
      metaRow?.initialized === 1 ||
      characters.length > 0 ||
      settingsRows.length > 0;
    if (!isInit)
      return { status: "empty", revision: this.revision, database: null };
    if (shallow) {
      const adapter = createSqlDatabaseAdapter(db, this);
      return { status: "ready", revision: this.revision, database: adapter };
    }
    return { status: "ready", revision: this.revision, database: db };
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
      await append(
        "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
        [revision, action],
      );
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
    const [characterRows, nodeRows, chatRows] = await this.selectBatch([
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
      },
      {
        sql: "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
        bind: [characterId],
      },
    ]);
    if (characterRows.length === 0) return null;
    const characterData = (nodeRows.length
      ? rebuildRelationalValue(nodeRows)
      : {}) as any;
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

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    const requestedLimit = options?.messageLimit;
    const limit =
      requestedLimit === undefined
        ? undefined
        : normalizeSqliteLimit(requestedLimit);
    const [chatRows, nodeRows, totalRows, messageRows] = await this.selectBatch([
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
      },
      {
        sql: "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
        bind: [chatId],
      },
      this.messageRowsStatement(chatId, limit, 0, limit !== undefined),
    ]);
    const cr = chatRows[0];
    if (!cr) return null;
    const cd = (nodeRows.length ? rebuildRelationalValue(nodeRows) : {}) as any;
    cd.id = cr.id;
    cd.name = (cr.name as string) ?? "";
    cd.note = (cr.note as string) ?? "";
    cd.folderId = (cr.folder_id as string) ?? undefined;
    cd.lastDate = (cr.last_message_time as number) ?? undefined;
    const total = Number(totalRows[0]?.total ?? 0);
    cd.message = this.rebuildMessagesFromRows(messageRows);
    const offset = Math.max(0, total - cd.message.length);
    cd.messageOffset = offset;
    cd.messageTotal = total;
    cd.messagesFullyLoaded = offset === 0;
    cd.messagesLoaded = true;
    cd.detailsLoaded = true;
    return cd;
  }

  async loadChatMessages(chatId: string): Promise<Message[]> {
    return this.loadMessagesBatch(chatId);
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
    return (
      ((await this.loadSettingValue("modules")) as
        | RisuModule[]
        | undefined) ?? []
    );
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

  async loadPlugins(): Promise<any[] | null> {
    return ((await this.loadSettingValue("plugins")) as any[] | undefined) ?? null;
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