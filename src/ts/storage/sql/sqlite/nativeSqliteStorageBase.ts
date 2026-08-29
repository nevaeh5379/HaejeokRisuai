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
import type {
  BotPresetSummary,
  SqlStartupDataResult,
  SqlDatabaseSnapshotResult,
  SqlRecentChatMetadata,
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
} from "../postgres/nodePostgresStorage";
import {
  buildSqlReplaceCommit,
  type SqlCommit,
  type SqlCommitResult,
  SqlRevisionConflictError,
} from "../sqlCommit";
import {
  rebuildRelationalValue,
  RELATIONAL_SCHEMA_LAYOUT,
  SQLITE_SCHEMA_VERSION,
  SqlSchemaResetRequiredError,
} from "./relationalNodeCodec";
import { applySqliteCommit, writeSqliteColdStorage } from "./sqliteCommit";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  DOMAIN_STORE_SETTING_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
} from "../sqlDeferredSettings";
import {
  AsyncSerialQueue,
  buildCharacterAssetFieldsQuery,
  buildMessageRowsQuery,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
  rebuildMessageRows,
  type SqliteTransactionStatement,
} from "./sqliteStorageUtils";

const STARTUP_SETTING_TEXT_LIMIT = 256 * 1024;

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
      if (existingSchema) {
        this.revision = existingSchema.revision;
      } else {
        await this.applySchema();
        await this.loadRevisionFromMeta();
      }
      await this.ensurePerformanceIndexes();
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
        sql: "CREATE INDEX IF NOT EXISTS chats_recent_idx ON chats (last_message_time DESC)",
        bind: [],
      },
    ]);
  }

  private buildSettingRowsQuery(
    deferredKeyList: readonly string[] = [],
    shallow = false,
  ): SqliteTransactionStatement {
    const textValue = shallow
      ? `CASE WHEN length(n.text_value) > ${STARTUP_SETTING_TEXT_LIMIT} THEN NULL ELSE n.text_value END`
      : "n.text_value";
    const encodedTextValue = shallow
      ? `CASE WHEN length(n.encoded_text_value) > ${STARTUP_SETTING_TEXT_LIMIT} THEN NULL ELSE n.encoded_text_value END`
      : "n.encoded_text_value";
    const objectKey = shallow
      ? `CASE WHEN length(n.object_key) > ${STARTUP_SETTING_TEXT_LIMIT} THEN NULL ELSE n.object_key END`
      : "n.object_key";
    const encodedObjectKey = shallow
      ? `CASE WHEN length(n.object_key_encoded) > ${STARTUP_SETTING_TEXT_LIMIT} THEN NULL ELSE n.object_key_encoded END`
      : "n.object_key_encoded";
    const oversizedMarker = shallow
      ? `CASE WHEN length(n.text_value) > ${STARTUP_SETTING_TEXT_LIMIT}
                    OR length(n.encoded_text_value) > ${STARTUP_SETTING_TEXT_LIMIT}
                    OR length(n.object_key) > ${STARTUP_SETTING_TEXT_LIMIT}
                    OR length(n.object_key_encoded) > ${STARTUP_SETTING_TEXT_LIMIT}
               THEN 1 ELSE 0 END AS startup_oversized,`
      : "";
    return {
      sql: `SELECT s.key AS setting_key, n.node_id, n.parent_node_id, n.node_order,
              ${objectKey} AS object_key, ${encodedObjectKey} AS object_key_encoded,
              n.value_type, ${textValue} AS text_value,
              ${encodedTextValue} AS encoded_text_value, n.number_value, n.boolean_value,
              ${oversizedMarker}
              0 AS startup_projection
         FROM system_settings s
         LEFT JOIN setting_extension_nodes n ON n.setting_key = s.key${
           deferredKeyList.length
             ? ` AND s.key NOT IN (${deferredKeyList.map(() => "?").join(",")})`
             : ""
         }
         ORDER BY s.key, n.node_id`,
      bind: [...deferredKeyList],
    };
  }

  private rebuildSettingRows(
    rows: Record<string, unknown>[],
    deferredKeyList: readonly string[] = [],
  ): { values: Map<string, unknown>; keyCount: number; deferredKeys: Set<string> } {
    const deferredKeys = new Set(deferredKeyList);
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = String(row.setting_key ?? "");
      if (Number(row.startup_oversized) === 1) deferredKeys.add(key);
      const nodes = grouped.get(key) ?? [];
      if (row.node_id !== null) nodes.push(row);
      grouped.set(key, nodes);
    }
    const values = new Map<string, unknown>();
    for (const [key, nodes] of grouped) {
      if (deferredKeys.has(key)) continue;
      values.set(key, nodes.length ? rebuildRelationalValue(nodes) : undefined);
    }
    return { values, keyCount: grouped.size, deferredKeys };
  }


  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }

    const deferredKeys = [...DEFERRED_STARTUP_SETTING_KEYS];
    const domainKeys = new Set<string>(DOMAIN_STORE_SETTING_KEYS);
    const excludedKeys = [...new Set([...deferredKeys, ...DOMAIN_STORE_SETTING_KEYS])];
    const settingQuery = this.buildSettingRowsQuery(excludedKeys, true);
    const characterQuery: SqliteTransactionStatement = {
      sql: "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
      bind: [],
    };
    const metaQuery: SqliteTransactionStatement = {
      sql: "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
      bind: [],
    };
    const [settingRows, characterRows, metaRows] = await this.selectRowSets([
      settingQuery,
      characterQuery,
      metaQuery,
    ]);
    const rebuilt = this.rebuildSettingRows(settingRows, excludedKeys);
    const settings: Partial<DatabaseSettings> = {};
    for (const [key, value] of rebuilt.values) {
      if (!domainKeys.has(key)) (settings as Record<string, unknown>)[key] = value;
    }
    const characters = (characterRows as Array<Record<string, unknown>>).map(
      (row) => ({
        chaId: String(row.id ?? ""),
        type: (row.kind as "character" | "group") ?? "character",
        name: String(row.name ?? ""),
        image: String(row.image ?? ""),
        trashTime: (row.trash_time as number | null) ?? undefined,
        creationDate: (row.creation_time as number | null) ?? undefined,
        modificationDate: (row.modification_time as number | null) ?? undefined,
        lastInteraction: (row.last_interaction_time as number | null) ?? undefined,
        detailsLoaded: false,
        chats: [],
        chatPage: 0,
      }) as unknown as character | groupChat,
    );
    const metaRow = metaRows[0] as { initialized?: number } | undefined;
    const initialized =
      metaRow?.initialized === 1 || characters.length > 0 || rebuilt.keyCount > 0;
    return {
      status: initialized ? "ready" : "empty",
      revision: this.revision,
      settings,
      characters,
      deferredSettingKeys: [...rebuilt.deferredKeys].filter(
        (key) => !domainKeys.has(key),
      ),
    };
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }

    const db: CanonicalDatabase = {} as CanonicalDatabase;

    const deferredKeyList = [...LEGACY_PERSONA_MIRROR_KEYS];
    const settingQuery = this.buildSettingRowsQuery(deferredKeyList);
    const characterQuery: SqliteTransactionStatement = {
      sql: "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
      bind: [],
    };
    const metaQuery: SqliteTransactionStatement = {
      sql: "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
      bind: [],
    };

    // Backends may collapse these independent startup reads into one native
    // bridge call. Capacitor does so to avoid three serial JS/native hops.
    const [settingRows, characterRows, metaRows] = await this.selectRowSets([
      settingQuery,
      characterQuery,
      metaQuery,
    ]);
    const settings = this.rebuildSettingRows(settingRows, deferredKeyList);
    for (const [key, value] of settings.values) {
      (db as any)[key] = value;
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
    const charRows = characterRows as Array<{
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
    }>;

    const characters: (character | groupChat)[] = [];
    for (const row of charRows) {
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
      const chatValues = chatRows.length
        ? await this.rebuildGroupedNodeValues(
            await this.selectRows(
              `SELECT chat_id, node_id, parent_node_id, node_order, object_key,
                      object_key_encoded, value_type, text_value, encoded_text_value,
                      number_value, boolean_value
               FROM chat_extension_nodes
               WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)
               ORDER BY chat_id, node_id`,
              [row.id],
            ),
            "chat_id",
          )
        : new Map<string, unknown>();
      const chats: Chat[] = chatRows.map((chatRow) => {
        const chatData = (chatValues.get(chatRow.id) ?? {}) as any;
        chatData.id = chatRow.id;
        chatData.name = chatRow.name ?? "";
        chatData.note = chatRow.note ?? "";
        chatData.folderId = chatRow.folder_id ?? undefined;
        chatData.lastDate = chatRow.last_message_time ?? undefined;
        chatData.message = [];
        chatData.messagesLoaded = false;
        chatData.detailsLoaded = true;
        return chatData;
      });
      for (const chat of chats) {
        if (!chat.id) continue;
        chat.message = await this.loadMessageRowsBatch(
          chat.id,
          undefined,
          0,
          false,
        );
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

    const metaRow = metaRows[0] as { initialized?: number } | undefined;
    const isInitialized =
      metaRow?.initialized === 1 ||
      characters.length > 0 ||
      settings.keyCount > 0;

    if (!isInitialized) {
      return { revision: this.revision, database: null };
    }
    return { revision: this.revision, database: db };
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

  protected async selectOne<T extends Record<string, unknown>>(
    sql: string,
    bind: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.selectRows<T>(sql, bind);
    return rows[0] ?? null;
  }

  protected async loadNodeValue(
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

  protected loadSettingValue(key: string): Promise<unknown> {
    return this.loadNodeValue("setting_extension_nodes", "setting_key = ?", [
      key,
    ]);
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
    // One grouped query for every chat's extension nodes instead of one
    // bridge round trip per chat.
    const chatValues = chatRows.length
      ? await this.rebuildGroupedNodeValues(
          await this.selectRows(
            `SELECT chat_id, node_id, parent_node_id, node_order, object_key,
                    object_key_encoded, value_type, text_value, encoded_text_value,
                    number_value, boolean_value
             FROM chat_extension_nodes
             WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)
             ORDER BY chat_id, node_id`,
            [characterId],
          ),
          "chat_id",
        )
      : new Map<string, unknown>();
    const chats: Chat[] = chatRows.map((chatRow) => {
      const chatData = (chatValues.get(chatRow.id) ?? {}) as any;
      chatData.id = chatRow.id;
      chatData.name = chatRow.name ?? "";
      chatData.note = chatRow.note ?? "";
      chatData.folderId = chatRow.folder_id ?? undefined;
      chatData.lastDate = chatRow.last_message_time ?? undefined;
      chatData.message = [];
      chatData.messagesLoaded = false;
      chatData.detailsLoaded = true;
      return chatData;
    });
    fullChar.chats = chats;
    return fullChar;
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
    const [characterRows, characterNodeRows, chatRowsRaw] = await this.selectRowSets([
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
    const fullChar = (characterNodeRows.length
      ? rebuildRelationalValue(characterNodeRows)
      : {}) as any;
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
    const messageQuery = buildMessageRowsQuery(
      chatId,
      limit,
      0,
      limit !== undefined,
      "full",
    );
    const [chatRows, chatNodeRows, totalRows, messageRows] = await this.selectRowSets([
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
      {
        sql: "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?",
        bind: [chatId],
      },
      messageQuery,
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

    const chatData = (chatNodeRows.length
      ? rebuildRelationalValue(chatNodeRows)
      : {}) as any;
    chatData.id = chatRow.id;
    chatData.name = chatRow.name ?? "";
    chatData.note = chatRow.note ?? "";
    chatData.folderId = chatRow.folder_id ?? undefined;
    chatData.lastDate = chatRow.last_message_time ?? undefined;

    const total = Number((totalRows[0] as { total?: number } | undefined)?.total ?? 0);
    chatData.message = rebuildMessageRows(messageRows);
    const offset = Math.max(0, total - chatData.message.length);
    chatData.messageOffset = offset;
    chatData.messageTotal = total;
    chatData.messagesFullyLoaded = offset === 0;
    chatData.messagesLoaded = true;
    chatData.detailsLoaded = true;
    return chatData;
  }

  private async loadMessageRowsBatch(
    chatId: string,
    limit: number | undefined,
    offset: number,
    newest: boolean,
    mode: "full" | "generation" = "full",
  ): Promise<Message[]> {
    const query = buildMessageRowsQuery(chatId, limit, offset, newest, mode);
    const rows = await this.selectRows(query.sql, query.bind);
    return rebuildMessageRows(rows);
  }

  async loadChatMessages(
    chatId: string,
    options?: { mode?: "full" | "generation" },
  ): Promise<Message[]> {
    return this.loadMessageRowsBatch(
      chatId,
      undefined,
      0,
      false,
      options?.mode === "generation" ? "generation" : "full",
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
    const messages = await this.loadMessageRowsBatch(
      chatId,
      end - offset,
      offset,
      false,
    );
    return {
      messages,
      offset,
      total,
      hasMore: offset > 0,
    };
  }

  async listRecentChats(limit = 50): Promise<SqlRecentChatMetadata[]> {
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const rows = await this.selectRows<{
      character_id: string;
      character_name: string;
      character_image: string | null;
      character_kind: string;
      chat_id: string;
      chat_position: number;
      chat_name: string;
      folder_id: string | null;
      last_message_time: number | null;
      last_message_text: string | null;
    }>(
      `SELECT c.id AS character_id,
              c.name AS character_name,
              c.image AS character_image,
              c.kind AS character_kind,
              ch.id AS chat_id,
              ch.position AS chat_position,
              ch.name AS chat_name,
              ch.folder_id AS folder_id,
              ch.last_message_time AS last_message_time,
              COALESCE((
                SELECT m.content_text
                  FROM messages m
                 WHERE m.chat_id = ch.id
                 ORDER BY m.position DESC
                 LIMIT 1
              ), '') AS last_message_text
         FROM chats ch
         JOIN characters c ON c.id = ch.character_id
        WHERE c.trash_time IS NULL
        ORDER BY ch.last_message_time DESC
        LIMIT ?`,
      [normalizedLimit],
    );
    return rows.map((row) => ({
      characterId: row.character_id,
      characterName: row.character_name ?? "",
      characterImage: row.character_image ?? null,
      characterType: row.character_kind === "group" ? "group" : "character",
      chatId: row.chat_id,
      chatPosition: Number(row.chat_position) || 0,
      chatName: row.chat_name ?? "",
      folderId: row.folder_id ?? null,
      lastDate:
        row.last_message_time == null ? null : Number(row.last_message_time),
      lastMessage: row.last_message_text ?? "",
    }));
  }

  async loadPersonas(): Promise<RisuPersona[]> {
    return (
      ((await this.loadSettingValue("personas")) as
        RisuPersona[] | undefined) ?? []
    );
  }

  /**
   * Reads several setting keys in one grouped query. Startup previously
   * issued one bridge round trip per key (personas, personaPrompt,
   * customModels, modules, plugins); this collapses them into a single
   * native query on Android/Tauri.
   */
  async loadSettingKeys(keys: string[]): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();
    const rows = await this.selectRows(
      `SELECT s.key AS setting_key, n.node_id, n.parent_node_id, n.node_order,
              n.object_key, n.object_key_encoded, n.value_type, n.text_value,
              n.encoded_text_value, n.number_value, n.boolean_value
         FROM system_settings s
         LEFT JOIN setting_extension_nodes n ON n.setting_key = s.key
        WHERE s.key IN (${keys.map(() => "?").join(",")})
        ORDER BY s.key, n.node_id`,
      [...keys],
    );
    const grouped = this.rebuildGroupedNodeValues(rows, "setting_key");
    const result = new Map<string, unknown>();
    for (const key of keys) {
      result.set(key, grouped.has(key) ? grouped.get(key) : undefined);
    }
    return result;
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
        | {
            name: string;
            data: loreBook[];
          }[]
        | undefined) ?? []
    );
  }

  async loadModules(): Promise<RisuModule[]> {
    return (
      ((await this.loadSettingValue("modules")) as RisuModule[] | undefined) ??
      []
    );
  }

  async loadPrompts(): Promise<Record<string, any>> {
    // Single grouped query instead of one bridge round trip per prompt key.
    const rows = await this.selectRows(
      `SELECT s.key AS setting_key, n.node_id, n.parent_node_id, n.node_order,
              n.object_key, n.object_key_encoded, n.value_type, n.text_value,
              n.encoded_text_value, n.number_value, n.boolean_value
         FROM system_settings s
         LEFT JOIN setting_extension_nodes n ON n.setting_key = s.key
        WHERE s.domain = 'prompt'
        ORDER BY s.key, n.node_id`,
    );
    const prompts: Record<string, any> = {};
    for (const [key, value] of this.rebuildGroupedNodeValues(
      rows,
      "setting_key",
    )) {
      prompts[key] = value;
    }
    return prompts;
  }

  async loadScripts(): Promise<customscript[]> {
    return (
      ((await this.loadSettingValue("globalscript")) as
        customscript[] | undefined) ?? []
    );
  }

  async loadPlugins(options?: { enabledOnly?: boolean }): Promise<any[] | null> {
    const plugins =
      ((await this.loadSettingValue("plugins")) as any[] | undefined) ?? null;
    return options?.enabledOnly && plugins
      ? plugins.filter((plugin) => plugin?.enabled)
      : plugins;
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

  async loadSettingKey(key: string): Promise<any> {
    return this.loadSettingValue(key);
  }

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
