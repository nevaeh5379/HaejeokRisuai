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
} from "../postgres/nodePostgresStorage";
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
} from "./relationalNodeCodec";
import { applySqliteCommit, writeSqliteColdStorage } from "./sqliteCommit";
import {
  SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL,
  SQLITE_LAST_MESSAGE_TIME_TRIGGER_NAME,
} from "./sqliteLastMessageTime";
import {
  DEFERRED_STARTUP_SETTING_KEYS,
  SETTINGS_STORE_EXCLUDED_KEYS,
  LEGACY_PERSONA_MIRROR_KEYS,
} from "../sqlDeferredSettings";
import {
  AsyncSerialQueue,
  buildBranchGraphRowsQuery,
  buildBranchMessageCountQuery,
  buildBranchMessageRowsQuery,
  buildCharacterAssetFieldsQuery,
  buildMessageRowsQuery,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
  rebuildBranchGraphMessages,
  rebuildMessageRows,
  type SqliteTransactionStatement,
} from "./sqliteStorageUtils";
import {
  buildSqliteLegacyBranchMigrationStatements,
  ensureSqliteBranchGraphStatements,
  mapSqliteChatBranchRow,
  SQLITE_BRANCH_SCHEMA_STATEMENTS,
  type SqliteChatBranchRow,
} from "./sqliteBranchStorage";

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
      throw new Error("SQLite last_message_time trigger was not installed by the schema");
    }
    if (!existedBeforeSchemaApply) {
      await this.executeNativeTransaction(null, [
        { sql: SQLITE_LAST_MESSAGE_TIME_BACKFILL_SQL, bind: [] },
      ]);
    }
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
      sql: `SELECT s.key AS setting_key, s.domain AS setting_domain, s.value_type AS setting_value_type,
              s.text_value AS setting_text_value, s.encoded_text_value AS setting_encoded_text_value,
              s.number_value AS setting_number_value, s.boolean_value AS setting_boolean_value,
              n.node_id, n.parent_node_id, n.node_order,
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
    const rootRows = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = String(row.setting_key ?? "");
      if (!rootRows.has(key)) rootRows.set(key, row);
      if (Number(row.startup_oversized) === 1) deferredKeys.add(key);
      const nodes = grouped.get(key) ?? [];
      if (row.node_id !== null && row.node_id !== undefined) nodes.push(row);
      grouped.set(key, nodes);
    }
    const values = new Map<string, unknown>();
    for (const [key, nodes] of grouped) {
      if (deferredKeys.has(key)) continue;
      if (nodes.length) {
        values.set(key, rebuildRelationalValue(nodes));
      } else {
        const root = rootRows.get(key);
        if (!root) {
          values.set(key, undefined);
          continue;
        }
        const valType = root.setting_value_type ?? root.value_type;
        switch (valType) {
          case "string":
            values.set(
              key,
              decodedText(
                root.setting_text_value ?? root.text_value,
                root.setting_encoded_text_value ?? root.encoded_text_value,
              ),
            );
            break;
          case "number":
            values.set(
              key,
              Number(root.setting_number_value ?? root.number_value),
            );
            break;
          case "boolean":
            values.set(
              key,
              Boolean(root.setting_boolean_value ?? root.boolean_value),
            );
            break;
          case "null":
            values.set(key, null);
            break;
          case "undefined":
            values.set(key, undefined);
            break;
          default:
            values.set(key, undefined);
            break;
        }
      }
    }
    return { values, keyCount: grouped.size, deferredKeys };
  }


  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    if (!this._enabled) {
      const ok = await this.init();
      if (!ok) return null;
    }

    const deferredKeys = [...DEFERRED_STARTUP_SETTING_KEYS];
    const settingsStoreExcludedKeys = new Set<string>(
      SETTINGS_STORE_EXCLUDED_KEYS,
    );
    const excludedKeys = [
      ...new Set([...deferredKeys, ...SETTINGS_STORE_EXCLUDED_KEYS]),
    ];
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
      if (!settingsStoreExcludedKeys.has(key)) {
        (settings as Record<string, unknown>)[key] = value;
      }
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
        (key) => !settingsStoreExcludedKeys.has(key),
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
      (db as Record<string, unknown>)[key] = value;
    }

    // Merge plugin_custom_storage table
    const pluginStorageRows = await this.selectRows<{
      key: string;
      value: string;
    }>("SELECT key, value FROM plugin_custom_storage");
    const pluginCustomStorage: Record<string, unknown> = {};
    for (const row of pluginStorageRows) {
      try {
        pluginCustomStorage[row.key] = JSON.parse(row.value);
      } catch {
        pluginCustomStorage[row.key] = row.value;
      }
    }
    db.pluginCustomStorage = pluginCustomStorage;

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
      )) ?? {}) as character | groupChat;
      fullChar.chaId = row.id;
      fullChar.name = row.name ?? fullChar.name ?? "";
      fullChar.type = (row.kind as "character" | "group") ?? fullChar.type ?? "character";
      fullChar.image = row.image ?? fullChar.image ?? "";
      fullChar.trashTime = row.trash_time ?? fullChar.trashTime;
      fullChar.lastInteraction = row.last_interaction_time ?? fullChar.lastInteraction;
      if (fullChar.type === "character") {
        fullChar.creation_date = row.creation_time ?? fullChar.creation_date;
        fullChar.modification_date = row.modification_time ?? fullChar.modification_date;
      }
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
        const chatData = (chatValues.get(chatRow.id) ?? {}) as Chat;
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
        chat.message = await this.loadChatMessages(chat.id);
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

    const metaRow = metaRows[0] as { initialized?: number } | undefined;
    const isInitialized =
      metaRow?.initialized === 1 ||
      characters.length > 0 ||
      settings.keyCount > 0 ||
      (db.modules?.length ?? 0) > 0 ||
      (db.botPresets?.length ?? 0) > 0;

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
    const messageQuery = buildBranchMessageRowsQuery(chatId, undefined, limit);
    const totalQuery = buildBranchMessageCountQuery(chatId);
    const [chatRows, chatNodeRows, totalRows, messageRows, activeBranchRows, branchCountRows] = await this.selectRowSets([
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
      | { branch_id: string }
      | undefined;
    const branchCount = Number(
      (branchCountRows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    const chatData = (chatNodeRows.length
      ? rebuildRelationalValue(chatNodeRows)
      : {}) as any;
    if (await this.migrateLegacyBranchGraphIfNeeded(chatId, chatData, branchCount)) {
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

  private async loadLegacyChatExtension(chatId: string): Promise<Record<string, any>> {
    const rows = await this.selectRows(
      `SELECT node_id, parent_node_id, node_order, object_key,
              object_key_encoded, value_type, text_value, encoded_text_value,
              number_value, boolean_value
         FROM chat_extension_nodes WHERE chat_id = ? ORDER BY node_id`,
      [chatId],
    );
    return (rows.length ? rebuildRelationalValue(rows) : {}) as Record<string, any>;
  }

  private async migrateLegacyBranchGraphIfNeeded(
    chatId: string,
    knownChatData?: Record<string, any>,
    knownBranchCount?: number,
  ): Promise<boolean> {
    const branchCount = knownBranchCount ?? Number((await this.selectOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
      [chatId],
    ))?.total ?? 0);
    if (branchCount > 1) return false;
    const chatData = knownChatData ?? await this.loadLegacyChatExtension(chatId);
    if (!Array.isArray(chatData.branchState?.branches) || chatData.branchState.branches.length <= 1) {
      return false;
    }
    return this.writeQueue.run(async () => {
      const currentCount = Number((await this.selectOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM chat_branches WHERE chat_id = ?",
        [chatId],
      ))?.total ?? 0);
      if (currentCount > 1) return false;
      const plan = buildLegacyBranchMigrationPlan(
        { ...chatData, id: chatId, message: await this.loadLinearMessages(chatId) },
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
    const branchRows = await this.selectRows<SqliteChatBranchRow & { active_branch_id?: string }>(
      `SELECT branch.id, branch.chat_id, branch.parent_branch_id, branch.fork_message_id,
              branch.head_message_id, branch.reason, branch.created_at,
              active.branch_id AS active_branch_id
         FROM chat_branches branch
    LEFT JOIN chat_active_branches active ON active.chat_id = branch.chat_id
        WHERE branch.chat_id = ? ORDER BY branch.created_at, branch.id`,
      [chatId],
    );
    const graphQuery = buildBranchGraphRowsQuery(chatId);
    const graphRows = await this.selectRows<Record<string, unknown>>(graphQuery.sql, graphQuery.bind);
    return {
      branches: branchRows.map(mapSqliteChatBranchRow),
      activeBranchId: branchRows[0]?.active_branch_id ?? undefined,
      messages: rebuildBranchGraphMessages(graphRows),
      links: graphRows.map((row) => ({
        messageId: String(row.message_id),
        parentMessageId: row.graph_parent_message_id == null ? undefined : String(row.graph_parent_message_id),
        originBranchId: String(row.graph_origin_branch_id),
      })),
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
      options?.mode === "generation" ? "generation" : options?.mode === "graph" ? "graph" : "full",
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
                 ORDER BY m.position DESC, m.sent_time DESC, m.id DESC
                 LIMIT 1
              ), '') AS last_message_text
         FROM chats ch
         JOIN characters c ON c.id = ch.character_id
        WHERE c.trash_time IS NULL
        ORDER BY COALESCE(ch.last_message_time, c.last_interaction_time, 0) DESC, ch.id
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
    const rows = await this.selectRows<{ module_id: string }>(
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
    return rows.map(({ module_id }) => ({
      ...(values.get(module_id) as RisuModule),
      id: module_id,
    }));
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
