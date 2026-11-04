import type {
  DatabaseSettings,
  groupChat,
  Chat,
  Message,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "../../protocol/domain/database.ts";
import type { character } from "../../protocol/domain/legacy/character.ts";
import type { Database } from "../../protocol/domain/legacy/database.ts";
import type {
  AuthorNoteMetadata,
  AuthorNoteRow,
} from "../../protocol/src/authorNotes.ts";
import type { RisuModule } from "../../protocol/domain/modules.ts";
import type { IPluginStorage } from "../../protocol/domain/pluginStorage.ts";
import type { SqlCommit } from "../../protocol/domain/sqlCommit.ts";
import type { SqlCommitResult } from "../../protocol/src/sqlCommit.ts";

export type {
  IPluginScriptStorage,
  IPluginStorage,
  PluginLoadOptions,
} from "../../protocol/domain/pluginStorage.ts";
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
  NodePostgresTableData,
} from "../../protocol/databaseApi.ts";
import type {
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  DbVendor,
} from "../../protocol/storageConfig.ts";
import type {
  Character,
  CharacterFields,
  CharacterUpdate,
} from "../../protocol/domain/character.ts";

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
  /** Legacy aggregate export for compatibility; persona mirrors may be absent. */
  database: Database | null;
}

export interface SqlStorageSyncSummary {
  revision: number;
  initialized: boolean;
  records: {
    settings: number;
    characters: number;
    chats: number;
    messages: number;
    total: number;
  };
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
  position?: number;
  parentMessageId?: string;
  originBranchId: string;
}

export interface SqlChatBranchGraphData {
  branches: SqlChatBranchSummary[];
  activeBranchId?: string;
  messages: Message[];
  links: SqlChatBranchGraphLink[];
}

export interface SqlChatBranchGraphPage extends SqlChatBranchGraphData {
  offset: number;
  total: number;
  hasMore: boolean;
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
 *  - `character.document(id)` returns a full character (with chats list but without
 *    message arrays).
 *  - `chat.load(id)` returns a full chat *with* its message array.
 *  - Domain loaders (`persona.list`, `preset.list`/`preset.load`, …) fetch one domain at
 *    a time, allowing the adapter to keep unloaded domains out of memory.
 */
export interface ISqlStorage {
  table: {
    list(): Promise<NodePostgresTableInfo[]>;
    data(
      table: string,
      options?: {
        offset?: number;
        limit?: number;
        sortColumn?: string;
        sortOrder?: "asc" | "desc";
        search?: string;
        columns?: string[];
      },
    ): Promise<NodePostgresTableData>;
  };

  stats: {
    tokenUsage(): Promise<NodePostgresTokenUsage[]>;
    botChats(): Promise<NodePostgresBotChatStats[]>;
  };

  revision: {
    list(limit?: number): Promise<NodePostgresRevision[]>;
    details(revisionId: number): Promise<NodePostgresRevisionDetails | null>;
    diff(
      baseId: number,
      targetId: number,
    ): Promise<NodePostgresRevisionDiff | null>;
    previewRestore(
      revisionId: number,
    ): Promise<NodePostgresRestorePreview | null>;
    restore(
      revisionId: number,
    ): Promise<{ revision: number; revisionId: number }>;
  };

  chat: {
    load(chatId: string, options?: SqlChatLoadOptions): Promise<Chat | null>;
    /** Lightweight feed; activeChatId pins the opened chat ahead of the limit. */
    listRecent(
      limit?: number,
      activeChatId?: string,
    ): Promise<SqlRecentChatMetadata[]>;
  };

  message: {
    /** Saves one message through the revision-guarded commit path. */
    save(
      chatId: string,
      message: Message & { position: number },
    ): Promise<SqlCommitResult>;
    delete(chatId: string, messageId: string): Promise<SqlCommitResult>;
    list(
      chatId: string,
      options?: { mode?: "full" | "generation" },
    ): Promise<Message[]>;
    page(
      chatId: string,
      before: number | undefined,
      limit: number,
    ): Promise<SqlMessagePage>;
    search(
      query: string,
      scope?: "all" | "active" | "cold",
      limit?: number,
    ): Promise<NodePostgresMessageSearchResult[]>;
  };

  /** Persistent chat branch operations. */
  branch: {
    list(chatId: string): Promise<SqlChatBranchSummary[]>;
    graph(chatId: string): Promise<SqlChatBranchGraphData>;
    graphPage(
      chatId: string,
      offset: number,
      limit: number,
    ): Promise<SqlChatBranchGraphPage>;
    messages(
      chatId: string,
      branchId: string,
      options?: {
        messageLimit?: number;
        mode?: "full" | "generation" | "graph";
      },
    ): Promise<Message[]>;
    create(input: SqlCreateChatBranchInput): Promise<SqlChatBranchSummary>;
    activate(chatId: string, branchId: string): Promise<void>;
  };

  readonly backendKind: SqlBackendKind;
  readonly plugin: IPluginStorage;

  isEnabled(): boolean;
  getRevision(): number;

  // ── Lifecycle / config ──────────────────────────────────────────────

  /**
   * Initialise the backend (open DB, apply schema, connect to remote, …).
   * Must be idempotent. Resolves to `true` when the storage is ready to
   * serve reads/writes.
   */
  init(): Promise<boolean>;
  /** Release backend resources before a page reload or application shutdown. */
  close(): Promise<void>;

  // ── Startup / snapshot / save ───────────────────────────────────────

  loadStartupData(): Promise<SqlStartupDataResult | null>;
  getStorageSyncSummary(): Promise<SqlStorageSyncSummary | null>;
  exportSnapshot(): Promise<SqlDatabaseSnapshotResult | null>;

  commit(commit: SqlCommit): Promise<SqlCommitResult>;

  replace(
    database: Database,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean>;

  character: {
    searchByTag(
      tag: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]>;
    searchByName(
      name: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]>;
    document(characterId: string): Promise<character | groupChat | null>;
    /** Lightweight character hydration for interactive selection. Chat rows may be summaries. */
    forSelection(characterId: string): Promise<character | groupChat | null>;
    /**
     * Loads only the asset-bearing character fields (image, emotionImages,
     * additionalAssets, ccAssets, customBackground, gptSoVitsConfig, vits)
     * without hydrating chats or other metadata. Used by storage analyzers.
     */
    assetFields(characterId: string): Promise<Partial<character> | null>;

    /** Creates a reference without querying or checking whether the character exists. */
    ref(id: string): Character;
    /** Loads the canonical handle for the id; rejects if the ID is not a character. */
    load(id: string): Promise<Character>;
    create(name: string): Promise<Character>;
    /** Reads exactly the requested fields in one SQL statement (or zero on cache hit). */
    read<K extends keyof CharacterFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<CharacterFields, K>>;
    /** One statement; missing IDs and non-character IDs are omitted. */
    readMany?<K extends keyof CharacterFields>(
      ids: readonly string[],
      keys: readonly K[],
    ): Promise<Array<Pick<CharacterFields, K> & { chaId: string }>>;
    update(id: string, patch: CharacterUpdate): Promise<void>;
    position: { max(): Promise<number> };
  };

  authorNote: {
    list(): Promise<AuthorNoteMetadata[]>;
    get(id: string): Promise<AuthorNoteMetadata | null>;
    read(id: string): Promise<AuthorNoteRow | null>;
    scriptWrite(): Promise<boolean>;
  };

  persona: { list(): Promise<RisuPersona[]> };
  preset: {
    list(): Promise<BotPresetSummary[]>;
    load(id: string): Promise<StoredBotPreset | null>;
  };
  lorebook: { list(): Promise<{ name: string; data: loreBook[] }[]> };
  module: { list(): Promise<RisuModule[]> };
  prompt: { load(): Promise<Record<string, unknown>> };
  script: { list(): Promise<customscript[]> };

  pluginCustomStorage: {
    load(): Promise<Record<string, unknown> | null>;
    keys(): Promise<string[]>;
    get(key: string): Promise<unknown>;
  };

  setting: {
    get(key: string): Promise<unknown>;
    /** Enumerates every persisted root setting key without hydrating values. */
    keys(): Promise<string[]>;
    /** Batched multi-key read; backends may collapse it into one query. */
    getMany(keys: string[]): Promise<Map<string, unknown>>;
  };

  coldStorage: {
    get(key: string): Promise<unknown | null>;
    list(): Promise<{ items: string[] }>;
    set(key: string, value: unknown): Promise<boolean>;
    remove(keys: string[]): Promise<number>;
    prune(retainedKeys: string[]): Promise<number>;
  };
}

/**
 * Node-server-only operations (external PostgreSQL/Oracle/Azure config,
 * backup DB management, DB explorer table inspection). These are not part of
 * the core {@link ISqlStorage} contract because the browser/Tauri SQLite
 * backends are always "enabled" and have no external connection to configure.
 */
export interface INodeSqlStorageAdmin extends ISqlStorage {
  table: {
    list(): Promise<NodePostgresTableInfo[]>;
    data(
      table: string,
      options?: {
        offset?: number;
        limit?: number;
        sortColumn?: string;
        sortOrder?: "asc" | "desc";
        search?: string;
        columns?: string[];
      },
    ): Promise<NodePostgresTableData>;
  };

  getServerConfig(): Promise<NodePostgresServerConfig>;
  configureServer(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig>;
  getDatabaseConfig(): Promise<
    NodePostgresServerConfig & {
      params: Record<string, unknown>;
      storedVendor: import("../../protocol/storageConfig.ts").DbVendor | null;
    }
  >;
  applyDatabaseConfig(
    vendor: import("../../protocol/storageConfig.ts").DbVendor,
    params: Record<string, unknown>,
    migrate: boolean,
  ): Promise<
    NodePostgresServerConfig & {
      params: Record<string, unknown>;
      storedVendor: import("../../protocol/storageConfig.ts").DbVendor | null;
    }
  >;
  testConnection(
    vendor: import("../../protocol/storageConfig.ts").DbVendor,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }>;
  migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }>;
}

/**
 * Type guard: does the given storage expose Node-server admin operations?
 */
export function isNodeSqlStorageAdmin(
  storage: ISqlStorage,
): storage is INodeSqlStorageAdmin {
  return storage.backendKind === "node";
}
