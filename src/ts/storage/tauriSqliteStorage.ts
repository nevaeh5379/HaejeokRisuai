import type {
  Database as DatabaseType,
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
import { createSqlDatabaseAdapter } from "./databaseAdapters.svelte";
import { isTauri } from "../platform";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
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
  type SqliteTransactionStatement,
} from "./sqliteStorageUtils";

type SqlDatabase = import("@tauri-apps/plugin-sql").default;

// Lazily imported to avoid loading the plugin in non-Tauri environments
let SQL: typeof import("@tauri-apps/plugin-sql") | null = null;

async function getSQL() {
  if (!SQL) {
    SQL = await import("@tauri-apps/plugin-sql");
  }
  return SQL;
}

/**
 * Tauri desktop SQLite storage backend.
 *
 * Uses @tauri-apps/plugin-sql (tauri-plugin-sql) to manage a SQLite
 * database file in the app data directory. The Rust plugin handles
 * the native sqlite3 connection; this class issues SQL via the JS API.
 */
export class TauriSqliteStorage implements ISqlStorage {
  readonly backendKind = "tauri-sqlite" as const;

  private db: SqlDatabase | null = null;
  private dbPath: string | null = null;
  private revision = 0;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private readonly writeQueue = new AsyncSerialQueue();
  private _enabled = false;

  isEnabled(): boolean {
    return this._enabled;
  }

  getRevision(): number {
    return this.revision;
  }

  async init(): Promise<boolean> {
    if (this.initialized) return this._enabled;
    if (!isTauri) {
      this.initialized = true;
      this._enabled = false;
      return false;
    }
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<boolean> {
    try {
      const sql = await getSQL();
      const appDir = await appDataDir();
      this.dbPath = await join(appDir, "risuai-local.sqlite3");
      this.db = await sql.default.load(`sqlite:${this.dbPath}`);

      const existingMeta = await this.db.select<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_storage_meta'",
      );
      if (existingMeta.length) {
        const rows = await this.db.select<
          { schema_version: number; schema_layout: string }[]
        >(
          "SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1",
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
      }
      await this.db.execute(sqliteSchemaSql);
      const rows = await this.db.select<
        { initialized: number; revision: number }[]
      >(
        "SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1",
      );
      if (rows.length > 0) this.revision = Number(rows[0].revision) || 0;
      this._enabled = true;
      this.initialized = true;
      return true;
    } catch (error) {
      console.error("TauriSqliteStorage init failed:", error);
      try {
        await this.db?.close(this.db.path);
      } catch {
        // Ignore cleanup failures and preserve the initialization error.
      }
      this.db = null;
      this.dbPath = null;
      this.initialized = true;
      this._enabled = false;
      if (error instanceof SqlSchemaResetRequiredError) throw error;
      return false;
    }
  }

  // ── Low-level helpers ───────────────────────────────────────────────

  private async selectRows<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T[]> {
    if (!this.db) throw new Error("Database not opened");
    return this.db.select<T[]>(sql, bind);
  }

  private async selectOne<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.selectRows<T>(sql, bind);
    return rows[0] ?? null;
  }

  private async execute(sql: string, bind: unknown[] = []): Promise<void> {
    if (!this.db) throw new Error("Database not opened");
    await this.db.execute(sql, bind);
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

  private loadSettingValue(key: string): Promise<unknown> {
    return this.loadNodeValue("setting_extension_nodes", "setting_key = ?", [
      key,
    ]);
  }

  private async validatePresetCommit(commit: SqlCommit): Promise<void> {
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
    )
      throw new Error("Active bot preset does not exist");
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

  // ── Database-level load / save ───────────────────────────────────────

  async loadDatabase(
    options?: SqlLoadDatabaseOptions,
  ): Promise<SqlLoadDatabaseResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }

    const shallow = options?.shallow !== false;
    const db: DatabaseType = {} as any;

    // Load all settings
    const settingsRows = await this.selectRows<{ key: string }>(
      "SELECT key FROM system_settings",
    );
    for (const row of settingsRows) {
      (db as any)[row.key] = await this.loadSettingValue(row.key);
    }

    // Also merge plugin_custom_storage table if present
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

    // Load characters
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
      if (shallow) {
        characters.push({
          chaId: row.id,
          type: (row.kind as "character" | "group") ?? "character",
          name: row.name ?? "",
          image: row.image ?? "",
          trashTime: row.trash_time ?? undefined,
          creationDate: row.creation_time ?? undefined,
          modificationDate: row.modification_time ?? undefined,
          lastInteraction: row.last_interaction_time ?? undefined,
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
        const chatRows = await this.selectRows<{
          id: string;
          name: string;
          note: string;
          folder_id: string | null;
          last_message_time: number | null;
        }>(
          "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
          [row.id],
        );
        const chats: Chat[] = [];
        for (const chatRow of chatRows) {
          const chatData = ((await this.loadNodeValue(
            "chat_extension_nodes",
            "chat_id = ?",
            [chatRow.id],
          )) ?? {}) as any;
          chatData.id = chatRow.id;
          chatData.name = chatRow.name ?? "";
          chatData.note = chatRow.note ?? "";
          chatData.folderId = chatRow.folder_id ?? undefined;
          chatData.lastDate = chatRow.last_message_time ?? undefined;
          chatData.message = [];
          chatData.messagesLoaded = false;
          chatData.detailsLoaded = true;
          chats.push(chatData);
        }
        fullChar.chats = chats;
        characters.push(fullChar);
      }
    }
    db.characters = characters;

    const metaRow = await this.selectOne<{ initialized: number }>(
      "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
    );
    const isInitialized =
      metaRow?.initialized === 1 ||
      characters.length > 0 ||
      settingsRows.length > 0;

    if (!isInitialized) {
      return { status: "empty", revision: this.revision, database: null };
    }

    if (shallow) {
      const adapter = createSqlDatabaseAdapter(db, this, [
        "personas",
        "loreBook",
        "modules",
        "prompts",
        "scripts",
      ]);
      return { status: "ready", revision: this.revision, database: adapter };
    }

    return { status: "ready", revision: this.revision, database: db };
  }

  private async executeNativeTransaction(
    expectedRevision: number | null,
    statements: SqliteTransactionStatement[],
  ): Promise<void> {
    if (!this.dbPath) throw new Error("SQLite storage is not enabled");
    try {
      await invoke("sqlite_execute_transaction", {
        expectedRevision,
        statements,
      });
    } catch (error) {
      const message = String(error);
      const marker = "RISU_SQL_REVISION_CONFLICT:";
      const markerIndex = message.indexOf(marker);
      if (markerIndex >= 0) {
        const currentRevision = Number(message.slice(markerIndex + marker.length));
        if (Number.isFinite(currentRevision)) {
          throw new SqlRevisionConflictError(currentRevision);
        }
      }
      throw error;
    }
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    return this.writeQueue.run(() => this.commitInternal(commit));
  }

  private async commitInternal(commit: SqlCommit): Promise<SqlCommitResult> {
    if (!this._enabled || !this.db || !this.dbPath)
      throw new Error("SQLite storage is not enabled");
    const meta = await this.selectOne<{ revision: number }>(
      "SELECT revision FROM system_storage_meta WHERE singleton = 1",
    );
    const currentRevision = Number(meta?.revision) || 0;
    if (commit.baseRevision !== currentRevision)
      throw new SqlRevisionConflictError(currentRevision);
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
    const action = commit.action || (commit.replaceAll ? "replace-all" : "sync");
    await append(
      "INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))",
      [revision, action],
    );
    await this.executeNativeTransaction(currentRevision, statements);
    this.revision = revision;
    return { revision };
  }

  async replaceDatabase(
    database: DatabaseType,
    onProgress?: (status: string) => void,
  ): Promise<boolean> {
    onProgress?.("Replacing local database...");
    await this.commit(buildSqlReplaceCommit(database, this.revision));
    return true;
  }

  // ── Per-entity lazy loaders ──────────────────────────────────────────

  async loadCharacter(
    characterId: string,
  ): Promise<character | groupChat | null> {
    const row = await this.selectOne<{ id: string }>(
      "SELECT id FROM characters WHERE id = ?",
      [characterId],
    );
    if (!row) return null;
    const fullChar = ((await this.loadNodeValue(
      "character_extension_nodes",
      "character_id = ?",
      [characterId],
    )) ?? {}) as any;
    fullChar.chaId = characterId;
    fullChar.detailsLoaded = true;

    const chatRows = await this.selectRows<{
      id: string;
      name: string;
      note: string;
      folder_id: string | null;
      last_message_time: number | null;
    }>(
      "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
      [characterId],
    );
    const chats: Chat[] = [];
    for (const chatRow of chatRows) {
      const chatData = ((await this.loadNodeValue(
        "chat_extension_nodes",
        "chat_id = ?",
        [chatRow.id],
      )) ?? {}) as any;
      chatData.id = chatRow.id;
      chatData.name = chatRow.name ?? "";
      chatData.note = chatRow.note ?? "";
      chatData.folderId = chatRow.folder_id ?? undefined;
      chatData.lastDate = chatRow.last_message_time ?? undefined;
      chatData.message = [];
      chatData.messagesLoaded = false;
      chatData.detailsLoaded = true;
      chats.push(chatData);
    }
    fullChar.chats = chats;
    return fullChar;
  }

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    const chatRow = await this.selectOne<{
      id: string;
      name: string;
      note: string;
      folder_id: string | null;
      last_message_time: number | null;
    }>(
      "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE id = ?",
      [chatId],
    );
    if (!chatRow) return null;

    const chatData = ((await this.loadNodeValue(
      "chat_extension_nodes",
      "chat_id = ?",
      [chatId],
    )) ?? {}) as any;
    chatData.id = chatRow.id;
    chatData.name = chatRow.name ?? "";
    chatData.note = chatRow.note ?? "";
    chatData.folderId = chatRow.folder_id ?? undefined;
    chatData.lastDate = chatRow.last_message_time ?? undefined;

    const totalRow = await this.selectOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
      [chatId],
    );
    const total = Number(totalRow?.total ?? 0);
    const requestedLimit = options?.messageLimit;
    const limit =
      requestedLimit === undefined
        ? undefined
        : normalizeSqliteLimit(requestedLimit);
    const offset = limit === undefined ? 0 : Math.max(0, total - limit);
    const msgRows =
      limit === undefined
        ? await this.selectRows<{ id: string }>(
            "SELECT id FROM messages WHERE chat_id = ? ORDER BY position",
            [chatId],
          )
        : await this.selectRows<{ id: string }>(
            "SELECT id FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?",
            [chatId, limit, offset],
          );
    chatData.message = await Promise.all(
      msgRows.map((r) =>
        this.loadNodeValue(
          "message_extension_nodes",
          "chat_id = ? AND message_id = ?",
          [chatId, r.id],
        ),
      ),
    );
    chatData.messageOffset = offset;
    chatData.messageTotal = total;
    chatData.messagesFullyLoaded = offset === 0;
    chatData.messagesLoaded = true;
    chatData.detailsLoaded = true;
    return chatData;
  }

  async loadChatMessages(chatId: string): Promise<Message[]> {
    const msgRows = await this.selectRows<{ id: string }>(
      "SELECT id FROM messages WHERE chat_id = ? ORDER BY position",
      [chatId],
    );
    return Promise.all(
      msgRows.map(
        (r) =>
          this.loadNodeValue(
            "message_extension_nodes",
            "chat_id = ? AND message_id = ?",
            [chatId, r.id],
          ) as Promise<Message>,
      ),
    );
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    const totalRow = await this.selectOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
      [chatId],
    );
    const total = Number(totalRow?.total ?? 0);
    const end = normalizeSqlitePageEnd(before, total);
    const normalizedLimit = normalizeSqliteLimit(limit);
    const offset = Math.max(0, end - normalizedLimit);
    const msgRows = await this.selectRows<{ id: string }>(
      "SELECT id FROM messages WHERE chat_id = ? ORDER BY position LIMIT ? OFFSET ?",
      [chatId, end - offset, offset],
    );
    return {
      messages: await Promise.all(
        msgRows.map(
          (row) =>
            this.loadNodeValue(
              "message_extension_nodes",
              "chat_id = ? AND message_id = ?",
              [chatId, row.id],
            ) as Promise<Message>,
        ),
      ),
      offset,
      total,
      hasMore: offset > 0,
    };
  }

  // ── Domain loaders ───────────────────────────────────────────────────

  async loadPersonas(): Promise<RisuPersona[]> {
    return (
      ((await this.loadSettingValue("personas")) as
        RisuPersona[] | undefined) ?? []
    );
  }

  async listBotPresets(): Promise<BotPresetSummary[]> {
    const rows = await this.selectRows<{
      preset_id: string;
      position: number;
      name: string;
      image: string;
      api_type: string;
      ai_model: string;
      content_hash: string;
    }>(
      "SELECT preset_id, position, name, image, api_type, ai_model, content_hash FROM bot_presets ORDER BY position",
    );
    return rows.map((row) => ({
      id: row.preset_id,
      position: Number(row.position),
      name: row.name,
      image: row.image,
      apiType: row.api_type,
      aiModel: row.ai_model,
      hash: row.content_hash,
    }));
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    const row = await this.selectOne<{ data: string }>(
      "SELECT data FROM bot_presets WHERE preset_id = ?",
      [id],
    );
    if (!row) return null;
    return { ...(JSON.parse(row.data) as botPreset), id };
  }

  async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
    return (
      ((await this.loadSettingValue("loreBook")) as
        { name: string; data: loreBook[] }[] | undefined) ?? []
    );
  }

  async loadModules(): Promise<RisuModule[]> {
    return (
      ((await this.loadSettingValue("modules")) as RisuModule[] | undefined) ??
      []
    );
  }

  async loadPrompts(): Promise<Record<string, any>> {
    const rows = await this.selectRows<{ key: string }>(
      "SELECT key FROM system_settings WHERE domain = 'prompt'",
    );
    const prompts: Record<string, any> = {};
    for (const row of rows)
      prompts[row.key] = await this.loadSettingValue(row.key);
    return prompts;
  }

  async loadScripts(): Promise<customscript[]> {
    return (
      ((await this.loadSettingValue("globalscript")) as
        customscript[] | undefined) ?? []
    );
  }

  // ── Plugins ──────────────────────────────────────────────────────────

  async loadPlugins(): Promise<any[] | null> {
    return (
      ((await this.loadSettingValue("plugins")) as any[] | undefined) ?? null
    );
  }

  async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
    const rows = await this.selectRows<{ key: string; value: string }>(
      "SELECT key, value FROM plugin_custom_storage",
    );
    if (rows.length === 0) return null;
    const storage: Record<string, any> = {};
    for (const row of rows) {
      try {
        storage[row.key] = JSON.parse(row.value);
      } catch {
        storage[row.key] = row.value;
      }
    }
    return storage;
  }

  async listPluginCustomStorageKeys(): Promise<string[]> {
    const rows = await this.selectRows<{ key: string }>(
      "SELECT key FROM plugin_custom_storage ORDER BY key",
    );
    return rows.map((row) => row.key);
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    const row = await this.selectOne<{ value: string }>(
      "SELECT value FROM plugin_custom_storage WHERE key = ?",
      [key],
    );
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────

  async loadSettingKey(key: string): Promise<any> {
    return this.loadSettingValue(key);
  }

  // ── Cold storage ─────────────────────────────────────────────────────

  async getColdStorageItem(key: string): Promise<unknown | null> {
    const row = await this.selectOne<{ archive_id: string }>(
      "SELECT archive_id FROM cold_archives WHERE archive_id = ?",
      [key],
    );
    return row
      ? this.loadNodeValue("cold_extension_nodes", "archive_id = ?", [key])
      : null;
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    const rows = await this.selectRows<{ archive_id: string }>(
      "SELECT archive_id FROM cold_archives",
    );
    return { items: rows.map((r) => r.archive_id) };
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

  async removeColdStorageItems(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.writeQueue.run(async () => {
      const placeholders = keys.map(() => "?").join(",");
      await this.executeNativeTransaction(null, [
        {
          sql: `DELETE FROM cold_archives WHERE archive_id IN (${placeholders})`,
          bind: keys,
        },
      ]);
      return keys.length;
    });
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    return this.writeQueue.run(async () => {
      const allRows = await this.selectRows<{ archive_id: string }>(
        "SELECT archive_id FROM cold_archives",
      );
      const toDelete = allRows
        .map((r) => r.archive_id)
        .filter((k) => !retainedKeys.includes(k));
      if (toDelete.length === 0) return 0;
      const placeholders = toDelete.map(() => "?").join(",");
      await this.executeNativeTransaction(null, [
        {
          sql: `DELETE FROM cold_archives WHERE archive_id IN (${placeholders})`,
          bind: toDelete,
        },
      ]);
      return toDelete.length;
    });
  }

  // ── Revisions ────────────────────────────────────────────────────────

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    const normalizedLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? normalizeSqliteLimit(limit)
        : undefined;
    const sql =
      "SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at FROM system_revisions ORDER BY created_at DESC, id DESC" +
      (normalizedLimit !== undefined ? " LIMIT ?" : "");
    const rows = await this.selectRows<{
      id: number;
      storage_revision: number | null;
      database_initialized: number | null;
      scope: string;
      action: string;
      restored_from_revision: number | null;
      created_at: string;
    }>(sql, normalizedLimit !== undefined ? [normalizedLimit] : []);
    return rows.map((r) => ({
      id: Number(r.id),
      storage_revision:
        r.storage_revision != null ? Number(r.storage_revision) : null,
      database_initialized:
        r.database_initialized != null ? Boolean(r.database_initialized) : null,
      scope: r.scope as "database" | "cold-storage" | "restore",
      action: r.action,
      restored_from_revision:
        r.restored_from_revision != null
          ? Number(r.restored_from_revision)
          : null,
      created_at: r.created_at,
      change_count: 0,
    }));
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    const rows = await this.selectRows<{
      id: number;
      storage_revision: number | null;
      database_initialized: number | null;
      scope: string;
      action: string;
      restored_from_revision: number | null;
      created_at: string;
    }>(
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
      action: r.action,
      restored_from_revision:
        r.restored_from_revision != null
          ? Number(r.restored_from_revision)
          : null,
      created_at: r.created_at,
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

  // ── Search ───────────────────────────────────────────────────────────

  async searchMessages(
    query: string,
    scope: "all" | "active" | "cold" = "all",
    limit: number = 50,
  ): Promise<NodePostgresMessageSearchResult[]> {
    const rows = await this.selectRows<{
      chat_id: string;
      id: string;
      position: number;
      role: string;
      sent_time: number | null;
      sender_name: string | null;
      content_text: string | null;
    }>(
      `SELECT chat_id, id, position, role, sent_time, sender_name, content_text FROM messages WHERE content_text LIKE ? ORDER BY sent_time DESC LIMIT ?`,
      [`%${query}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => {
      return {
        storageState: "active" as const,
        archiveId: null,
        characterId: null,
        characterName: null,
        chatId: r.chat_id,
        chatName: "",
        messageId: r.id,
        position: Number(r.position),
        role: r.role as "user" | "char",
        sentTime: r.sent_time != null ? Number(r.sent_time) : null,
        senderName: r.sender_name ?? null,
        snippet: (r.content_text ?? "").slice(0, 200),
      };
    });
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    const rows = await this.selectRows<{
      model: string;
      message_count: number;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT COALESCE(generation_model, 'unknown') AS model, COUNT(*) AS message_count,
             COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
             FROM messages WHERE generation_model IS NOT NULL GROUP BY generation_model`,
    );
    return rows.map((row) => ({
      model: row.model,
      messageCount: Number(row.message_count),
      totalInputTokens: Number(row.input_tokens),
      totalOutputTokens: Number(row.output_tokens),
    }));
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    const chars = await this.selectRows<{
      id: string;
      name: string;
      image: string | null;
      kind: string;
      last_interaction_time: number | null;
    }>(
      "SELECT id, name, image, kind, last_interaction_time FROM characters ORDER BY position ASC",
    );
    const chatRows = await this.selectRows<{
      id: string;
      character_id: string;
      last_message_time: number | null;
    }>("SELECT id, character_id, last_message_time FROM chats");
    const msgRows = await this.selectRows<{
      chat_id: string;
      role: string;
      sent_time: number | null;
      content_length: number;
    }>(
      "SELECT chat_id, role, sent_time, length(COALESCE(content_text, content_encoded, '')) AS content_length FROM messages",
    );

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
    const rows = await this.selectRows<{
      id: string;
      name: string;
      image: string | null;
      kind: string;
    }>(
      `SELECT DISTINCT c.id, c.name, c.image, c.kind FROM characters c
             JOIN character_tags t ON t.character_id = c.id WHERE t.tag LIKE ? LIMIT ?`,
      [`%${tag}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      image: r.image ?? null,
      kind: (r.kind as "character" | "group") ?? "character",
    }));
  }

  async searchCharactersByName(
    name: string,
    limit: number = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    const rows = await this.selectRows<{
      id: string;
      name: string;
      image: string | null;
      kind: string;
    }>(
      `SELECT id, name, image, kind FROM characters WHERE name LIKE ? LIMIT ?`,
      [`%${name}%`, normalizeSqliteLimit(limit)],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      image: r.image ?? null,
      kind: (r.kind as "character" | "group") ?? "character",
    }));
  }
}
