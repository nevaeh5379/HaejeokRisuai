import type {
  Database,
  CanonicalDatabase,
  DatabaseSettings,
  character,
  groupChat,
  Chat,
  Message,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "../database/schema";
import type { RisuModule } from "../../process/modules";
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
} from "./postgres/nodePostgresStorage";

export type SqlBackendKind =
  "node" | "web-sqlite" | "tauri-sqlite" | "capacitor-sqlite";

export interface SqlStartupDataResult {
  status: "ready" | "empty";
  revision: number;
  /** Only SettingsStore-owned values are present here. */
  settings: Partial<DatabaseSettings>;
  /** Lightweight character shells owned by CharacterStore. */
  characters: (character | groupChat)[];
  /** Settings intentionally omitted from startup and loaded on first access. */
  deferredSettingKeys?: string[];
}

export interface SqlDatabaseSnapshotResult {
  revision: number;
  /** Canonical aggregate for storage/backup work; legacy persona mirrors are absent. */
  database: CanonicalDatabase | null;
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

export type SqlChatBranchReason = "root" | "manual" | "reroll";

/** Lightweight branch metadata. Branch messages are loaded separately. */
export interface SqlChatBranchSummary {
  id: string;
  chatId: string;
  parentBranchId?: string;
  forkMessageId?: string;
  headMessageId?: string;
  reason: SqlChatBranchReason;
  createdAt: number;
}

export interface SqlChatBranchGraphLink {
  messageId: string;
  parentMessageId?: string;
  originBranchId: string;
}

export interface SqlChatBranchGraphData {
  branches: SqlChatBranchSummary[];
  activeBranchId?: string;
  messages: Message[];
  links: SqlChatBranchGraphLink[];
}

export interface SqlCreateChatBranchInput {
  id: string;
  chatId: string;
  parentBranchId?: string;
  forkMessageId?: string;
  reason: Exclude<SqlChatBranchReason, "root">;
  createdAt: number;
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

export interface SqlRecentChatMetadata {
  characterId: string;
  characterName: string;
  characterImage: string | null;
  characterType: "character" | "group";
  chatId: string;
  chatPosition: number;
  chatName: string;
  folderId: string | null;
  lastDate: number | null;
  lastMessage: string;
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
 * Domain loading contract:
 *  - `loadStartupData()` returns SettingsStore-owned settings and lightweight
 *    character shells as separate domains.
 *  - `exportDatabaseSnapshot()` is the only aggregate Database read boundary.
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

  // ── Startup / snapshot / save ───────────────────────────────────────

  loadStartupData(): Promise<SqlStartupDataResult | null>;
  exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null>;

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
  /**
   * Persistent branch graph APIs. These remain optional only at the transport
   * boundary while remote SQL servers roll out the protocol. Runtime branch
   * features must require them and fail fast; they must never fall back to the
   * legacy in-memory branchState path.
   */
  listChatBranches?(chatId: string): Promise<SqlChatBranchSummary[]>;
  loadChatBranchGraph?(chatId: string): Promise<SqlChatBranchGraphData>;
  loadBranchMessages?(
    chatId: string,
    branchId: string,
    options?: { messageLimit?: number; mode?: "full" | "generation" | "graph" },
  ): Promise<Message[]>;
  createChatBranch?(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary>;
  activateChatBranch?(chatId: string, branchId: string): Promise<void>;
  /** Lightweight recent-chat feed; avoids hydrating character/chat trees. */
  listRecentChats?(limit?: number): Promise<SqlRecentChatMetadata[]>;

  // ── Domain loaders (deferred by the adapter) ─────────────────────────

  loadPersonas(): Promise<RisuPersona[]>;
  listBotPresets(): Promise<BotPresetSummary[]>;
  loadBotPreset(id: string): Promise<StoredBotPreset | null>;
  loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]>;
  loadModules(): Promise<RisuModule[]>;
  loadPrompts(): Promise<Record<string, any>>;
  loadScripts(): Promise<customscript[]>;

  // ── Plugins ──────────────────────────────────────────────────────────

  loadPlugins(options?: { enabledOnly?: boolean }): Promise<any[] | null>;
  setPluginEnabled?(pluginName: string, enabled: boolean): Promise<void>;
  loadPluginCustomStorage(): Promise<Record<string, any> | null>;
  listPluginCustomStorageKeys(): Promise<string[]>;
  loadPluginCustomStorageKey(key: string): Promise<any>;

  // ── Settings ─────────────────────────────────────────────────────────

  loadSettingKey(key: string): Promise<any>;
  /** Batched multi-key read; backends may collapse it into one query. */
  loadSettingKeys?(keys: string[]): Promise<Map<string, unknown>>;

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
    import("./postgres/nodePostgresStorage").NodePostgresTableInfo[]
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
  ): Promise<import("./postgres/nodePostgresStorage").NodePostgresTableData>;
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
      storedVendor: import("./postgres/nodePostgresStorage").DbVendor | null;
    }
  >;
  applyDatabaseConfig(
    vendor: import("./postgres/nodePostgresStorage").DbVendor,
    params: Record<string, any>,
    migrate: boolean,
  ): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: import("./postgres/nodePostgresStorage").DbVendor | null;
    }
  >;
  testConnection(
    vendor: import("./postgres/nodePostgresStorage").DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }>;
  migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }>;
  listDbTables(): Promise<
    import("./postgres/nodePostgresStorage").NodePostgresTableInfo[]
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
  ): Promise<import("./postgres/nodePostgresStorage").NodePostgresTableData>;
}

/**
 * Type guard: does the given storage expose Node-server admin operations?
 */
export function isNodeSqlStorageAdmin(
  storage: ISqlStorage,
): storage is INodeSqlStorageAdmin {
  return storage.backendKind === "node";
}
