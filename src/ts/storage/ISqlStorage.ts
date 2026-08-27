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
import type { SqlCommit, SqlCommitResult } from "./sqlCommit";
import type {
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresCharacterSearchResult,
  NodePostgresBotChatStats,
} from "./nodePostgresStorage";

export type SqlBackendKind =
  | "node"
  | "web-sqlite"
  | "tauri-sqlite"
  | "capacitor-sqlite";

export interface SqlLoadDatabaseOptions {
  shallow?: boolean;
}

export interface SqlLoadDatabaseResult {
  status: "ready" | "empty";
  revision: number;
  database: Database | null;
}

export interface SqlChatLoadOptions {
  messageLimit?: number;
}

export interface SqlMessagePage {
  messages: Message[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface SqlCharacterMetadata {
  chaId: string;
  name: string;
  image: string | null;
  type: "character" | "group";
  trashTime: number | null;
  creationTime: number | null;
  modificationTime: number | null;
  lastInteractionTime: number | null;
}

export interface SqlChatMetadata {
  id: string;
  name: string;
  note: string;
  folderId: string | null;
  lastDate: number | null;
}

export type StoredBotPreset = botPreset & { id: string };

export interface BotPresetSummary {
  id: string;
  position: number;
  name: string;
  image: string;
  apiType: string;
  aiModel: string;
  hash: string;
}

/**
 * Core SQL storage interface that every backend (Node server, web SQLite WASM,
 * Tauri SQLite) must implement. This is the single contract the rest of the
 * app talks to — no more database.bin / localForage / OPFS branching at the
 * call sites.
 *
 * Domain lazy-loading contract:
 *  - `loadDatabase({ shallow: true })` returns core settings + character/chat
 *    *metadata only* (no messages, no full character detail).
 *  - `loadCharacter(id)` returns a full character (with chats list but without
 *    message arrays).
 *  - `loadChat(id)` returns a full chat *with* its message array.
 *  - Domain loaders (`loadPersonas`, `listBotPresets`/`loadBotPreset`, …) fetch one domain at
 *    a time, allowing the adapter to keep unloaded domains out of memory.
 */
export interface ISqlStorage {
  readonly backendKind: SqlBackendKind;

  isEnabled(): boolean;
  getRevision(): number;

  // ── Lifecycle / config ──────────────────────────────────────────────

  /**
   * Initialise the backend (open DB, apply schema, connect to remote, …).
   * Must be idempotent. Resolves to `true` when the storage is ready to
   * serve reads/writes.
   */
  init(): Promise<boolean>;

  // ── Database-level load / save ───────────────────────────────────────

  loadDatabase(
    options?: SqlLoadDatabaseOptions,
  ): Promise<SqlLoadDatabaseResult | null>;

  commit(commit: SqlCommit): Promise<SqlCommitResult>;

  replaceDatabase(
    database: Database,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean>;

  // ── Per-entity lazy loaders ──────────────────────────────────────────

  loadCharacter(characterId: string): Promise<character | groupChat | null>;
  /** Lightweight character hydration for interactive selection. Chat rows may be summaries. */
  loadCharacterForSelection?(
    characterId: string,
  ): Promise<character | groupChat | null>;
  /**
   * Loads only the asset-bearing character fields (image, emotionImages,
   * additionalAssets, ccAssets, customBackground, gptSoVitsConfig, vits)
   * without hydrating chats or other metadata. Used by storage analyzers.
   */
  loadCharacterAssetFields?(
    characterId: string,
  ): Promise<Partial<character> | null>;
  loadChat(chatId: string, options?: SqlChatLoadOptions): Promise<Chat | null>;
  loadChatMessages(
    chatId: string,
    options?: { mode?: "full" | "generation" },
  ): Promise<Message[]>;
  loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage>;

  // ── Domain loaders (deferred by the adapter) ─────────────────────────

  loadPersonas(): Promise<RisuPersona[]>;
  listBotPresets(): Promise<BotPresetSummary[]>;
  loadBotPreset(id: string): Promise<StoredBotPreset | null>;
  loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]>;
  loadModules(): Promise<RisuModule[]>;
  loadPrompts(): Promise<Record<string, any>>;
  loadScripts(): Promise<customscript[]>;

  // ── Plugins ──────────────────────────────────────────────────────────

  loadPlugins(): Promise<any[] | null>;
  loadPluginCustomStorage(): Promise<Record<string, any> | null>;
  listPluginCustomStorageKeys(): Promise<string[]>;
  loadPluginCustomStorageKey(key: string): Promise<any>;

  // ── Settings ─────────────────────────────────────────────────────────

  loadSettingKey(key: string): Promise<any>;

  // ── Cold storage ─────────────────────────────────────────────────────

  getColdStorageItem(key: string): Promise<unknown | null>;
  listColdStorageItems(): Promise<{ items: string[] }>;
  setColdStorageItem(key: string, value: unknown): Promise<boolean>;
  removeColdStorageItems(keys: string[]): Promise<number>;
  pruneColdStorage(retainedKeys: string[]): Promise<number>;

  // ── Revisions / history ──────────────────────────────────────────────

  listRevisions(limit?: number): Promise<NodePostgresRevision[]>;
  getRevisionDetails?(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null>;
  getRevisionDiff?(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null>;
  previewRestoreRevision?(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null>;
  restoreRevision(
    revisionId: number,
  ): Promise<{ revision: number; revisionId: number }>;

  // ── Search ───────────────────────────────────────────────────────────

  searchMessages(
    query: string,
    scope?: "all" | "active" | "cold",
    limit?: number,
  ): Promise<NodePostgresMessageSearchResult[]>;
  getTokenUsage(): Promise<NodePostgresTokenUsage[]>;
  getBotChatStats(): Promise<NodePostgresBotChatStats[]>;
  searchCharactersByTag(
    tag: string,
    limit?: number,
  ): Promise<NodePostgresCharacterSearchResult[]>;
  searchCharactersByName(
    name: string,
    limit?: number,
  ): Promise<NodePostgresCharacterSearchResult[]>;

  // ── Optional table explorer ──────────────────────────────────────────

  listDbTables?(): Promise<
    import("./nodePostgresStorage").NodePostgresTableInfo[]
  >;
  getDbTableData?(
    table: string,
    options?: {
      offset?: number;
      limit?: number;
      sortColumn?: string;
      sortOrder?: "asc" | "desc";
      search?: string;
      columns?: string[];
    },
  ): Promise<import("./nodePostgresStorage").NodePostgresTableData>;
}

/**
 * Node-server-only operations (external PostgreSQL/Oracle/Azure config,
 * backup DB management, DB explorer table inspection). These are not part of
 * the core {@link ISqlStorage} contract because the browser/Tauri SQLite
 * backends are always "enabled" and have no external connection to configure.
 */
export interface INodeSqlStorageAdmin extends ISqlStorage {
  getServerConfig(): Promise<NodePostgresServerConfig>;
  configureServer(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig>;
  getDatabaseConfig(): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: import("./nodePostgresStorage").DbVendor | null;
    }
  >;
  applyDatabaseConfig(
    vendor: import("./nodePostgresStorage").DbVendor,
    params: Record<string, any>,
    migrate: boolean,
  ): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: import("./nodePostgresStorage").DbVendor | null;
    }
  >;
  testConnection(
    vendor: import("./nodePostgresStorage").DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }>;
  migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }>;
  listDbTables(): Promise<
    import("./nodePostgresStorage").NodePostgresTableInfo[]
  >;
  getDbTableData(
    table: string,
    options?: {
      offset?: number;
      limit?: number;
      sortColumn?: string;
      sortOrder?: "asc" | "desc";
      search?: string;
      columns?: string[];
    },
  ): Promise<import("./nodePostgresStorage").NodePostgresTableData>;
}

/**
 * Type guard: does the given storage expose Node-server admin operations?
 */
export function isNodeSqlStorageAdmin(
  storage: ISqlStorage,
): storage is INodeSqlStorageAdmin {
  return storage.backendKind === "node";
}
