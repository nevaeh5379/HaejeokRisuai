import type {
  Chat,
  ChatFields,
  ChatUpdate,
} from "../../protocol/domain/chat.ts";
import type {
  Message,
  botPreset,
  customscript,
} from "../../protocol/domain/database.ts";
import type { Database } from "../../protocol/domain/legacy/database.ts";
import type {
  AuthorNote,
  AuthorNoteFields,
  AuthorNoteUpdate,
} from "../../protocol/domain/authorNote.ts";
import type {
  Persona,
  PersonaFields,
  PersonaUpdate,
} from "../../protocol/domain/persona.ts";
import type {
  Preset,
  PresetFields,
  PresetUpdate,
} from "../../protocol/domain/preset.ts";
import type {
  LorebookFields,
  LorebookUpdate,
} from "../../protocol/domain/lorebook.ts";
import type {
  Module,
  ModuleFields,
  ModuleUpdate,
} from "../../protocol/domain/module.ts";
import type {
  PromptFields,
  PromptUpdate,
} from "../../protocol/domain/prompt.ts";
import type { PluginStorageValue } from "../../protocol/domain/pluginTypes.ts";
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
} from "../../protocol/storageConfig.ts";
import type {
  Character,
  CharacterFields,
  CharacterUpdate,
} from "../../protocol/domain/character.ts";

export type SqlBackendKind =
  "node" | "web-sqlite" | "tauri-sqlite" | "capacitor-sqlite";

/** Lightweight metadata only; reading this must not enumerate domain records. */
export interface State {
  revision: number;
  initialized: boolean;
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

/** Lightweight list row; image is an asset reference, never loaded image data. */
export interface SqlCharacterListItem {
  chaId: string;
  position: number;
  name: string;
  image: string | null;
  type: "character" | "group";
}

export interface RecentChat {
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
 *  - Domain mutations share the revision-guarded write path. Partial updates preserve omitted fields.
 *  - Collection moves update affected ordering atomically. Positions address the current order,
 *    not stable identities; resolve them again after reordering or a write conflict.
 *  - Initial loading is composed by the app from state, settings and character count APIs.
 *  - `exportDatabaseSnapshot()` is the only aggregate Database read boundary.
 *  - `chat.load(id)` returns a stateless handle; messages use the message APIs.
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
    /** Creates a handle without querying or checking existence. */
    ref(id: string): Chat;
    /** Checks existence and returns a handle; rejects for a missing chat. */
    load(id: string): Promise<Chat>;
    /** Reads only requested fields; does not hydrate messages or unrelated large fields. */
    read<K extends keyof ChatFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<ChatFields, K>>;
    /** Atomic patch: omitted fields survive; supplied collections replace only that field.
     * Explicit undefined clears an optional field. Uses the shared revision-guarded write path. */
    update(id: string, patch: ChatUpdate): Promise<void>;
    count(characterId: string): Promise<number>;
    /** Bounded range ordered by position then ID. Always returns ID and position.
     * No field values besides the explicitly requested keys are hydrated. */
    list(
      characterId: string,
      options?: { offset?: number; limit?: number },
    ): Promise<Array<Pick<ChatFields, "id" | "position">>>;
    /** Appends if position is omitted. Parent and initial chat state are persisted atomically. */
    create(characterId: string, name: string, position?: number): Promise<Chat>;
    /** Deletes the chat and its owned records atomically. Rejects for a missing chat. */
    delete(id: string): Promise<void>;
    /** Moves within the same character, updating affected sibling positions atomically. */
    move(id: string, position: number): Promise<void>;
    /** Lightweight feed; activeChatId pins the opened chat ahead of the limit. */
    listRecent(limit?: number, activeChatId?: string): Promise<RecentChat[]>;

    position: {
      /**
       * 
       * @param id character id
       */
      max(id: string): Promise<number>
    };
  }

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
  /** Reads authoritative metadata for initial loading and cross-query consistency checks. */
  getState(): Promise<State>;

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

  getStorageSyncSummary(): Promise<SqlStorageSyncSummary | null>;
  exportSnapshot(): Promise<SqlDatabaseSnapshotResult | null>;

  commit(commit: SqlCommit): Promise<SqlCommitResult>;

  replace(
    database: Database,
    onProgress?: (status: string, progress?: number) => void,
  ): Promise<boolean>;

  character: {
    /** Number of stored character and group rows, without hydrating documents. */
    count(): Promise<number>;
    /** Bounded range ordered by position, then ID; no chats or detailed fields. */
    list(options: {
      offset: number;
      limit: number;
    }): Promise<SqlCharacterListItem[]>;
    searchByTag(
      tag: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]>;
    searchByName(
      name: string,
      limit?: number,
    ): Promise<NodePostgresCharacterSearchResult[]>;
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
    /** Creates a handle without querying or checking existence. */
    ref(id: string): AuthorNote;
    /** Checks existence and returns a handle; rejects with AuthorNoteError("missing"). */
    load(id: string): Promise<AuthorNote>;
    /** Reads all note fields, including content. */
    read(id: string): Promise<AuthorNoteFields>;
    /** Atomic patch; unspecified fields are preserved. Uses the shared revision-guarded write path. */
    update(id: string, patch: AuthorNoteUpdate): Promise<void>;
    create(name: string, content?: string): Promise<AuthorNote>;
    /** Reserved NO_AUTHOR_NOTE cannot be modified or deleted. */
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    /** Bounded range ordered by name then ID; never loads content. */
    list<K extends "name" | "updatedAt" = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<Array<Pick<AuthorNoteFields, K> & { id: string }>>;
    scriptWrite: {
      get(): Promise<boolean>;
      set(enabled: boolean): Promise<void>;
    };
  };

  persona: {
    ref(id: string): Persona;
    /** Checks existence; rejects if missing. */
    load(id: string): Promise<Persona>;
    read(id: string): Promise<PersonaFields>;
    update(id: string, patch: PersonaUpdate): Promise<void>;
    create(name: string): Promise<Persona>;
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    /** Ordered by position then ID. No icon or embedded module is read unless requested. */
    list<K extends keyof PersonaFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<
      Array<Pick<PersonaFields, K> & { id: string; position: number }>
    >;
    move(id: string, position: number): Promise<void>;
    /** Persists selection by ID; converting legacy selectedPersona indices belongs to the adapter. */
    active: {
      get(): Promise<Persona | null>;
      set(id: string): Promise<void>;
    };
  };

  preset: {
    ref(id: string): Preset;
    /** Checks existence; rejects if missing. */
    load(id: string): Promise<Preset>;
    /** Reads only requested fields, excluding unrelated prompts and model settings. */
    read<K extends keyof PresetFields>(
      id: string,
      ...keys: [K, ...K[]]
    ): Promise<Pick<PresetFields, K>>;
    update(id: string, patch: PresetUpdate): Promise<void>;
    create(name: string): Promise<Preset>;
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    /** Ordered by position then ID; always includes identity and ordering. */
    list<K extends keyof PresetFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<Array<Pick<PresetFields, K> & { id: string; position: number }>>;
    move(id: string, position: number): Promise<void>;
    /** Persists the selected ID only. Applying preset values is app orchestration. */
    active: {
      get(): Promise<Preset | null>;
      set(id: string): Promise<void>;
    };
  };

  /** Global books have positional addresses, not stable IDs. Positions change after reordering. */
  lorebook: {
    count(): Promise<number>;
    /** Book names only; entries remain unloaded. Ordered by position. */
    list(options: {
      offset: number;
      limit: number;
    }): Promise<Array<Pick<LorebookFields, "position" | "name">>>;
    read(position: number): Promise<LorebookFields>;
    update(position: number, patch: LorebookUpdate): Promise<void>;
    /** Appends an empty book and returns its position. */
    create(name: string): Promise<number>;
    delete(position: number): Promise<void>;
    move(position: number, to: number): Promise<void>;
  };

  module: {
    ref(id: string): Module;
    /** Checks existence; rejects if missing. */
    load(id: string): Promise<Module>;
    read(id: string): Promise<ModuleFields>;
    update(id: string, patch: ModuleUpdate): Promise<void>;
    create(name: string): Promise<Module>;
    delete(id: string): Promise<void>;
    count(): Promise<number>;
    /** Ordered by position then ID. Scripts, lore and assets are read only if requested. */
    list<K extends keyof ModuleFields = never>(
      options: { offset: number; limit: number },
      ...keys: K[]
    ): Promise<Array<Pick<ModuleFields, K> & { id: string; position: number }>>;
    move(id: string, position: number): Promise<void>;
  };

  /** Typed view of the existing root prompt settings, not a second copy or a saved preset. */
  prompt: {
    read(): Promise<PromptFields>;
    update(patch: PromptUpdate): Promise<void>;
  };

  /** Global regex rules; positions refer to the current order, not stable identities. */
  script: {
    count(): Promise<number>;
    /** Ordered by position; rule input/output text is loaded only through read(). */
    list(options: { offset: number; limit: number }): Promise<
      Array<
        Pick<customscript, "comment" | "type" | "ableFlag"> & {
          position: number;
        }
      >
    >;
    read(position: number): Promise<customscript>;
    update(position: number, patch: Partial<customscript>): Promise<void>;
    /** Appends when position is omitted and returns the inserted position. */
    create(value: customscript, position?: number): Promise<number>;
    delete(position: number): Promise<void>;
    move(position: number, to: number): Promise<void>;
  };

  /** Arbitrary plugin-owned values; no aggregate load and no per-key handle objects. */
  pluginCustomStorage: {
    count(): Promise<number>;
    /** Keys only, ordered lexically. */
    keys(options: { offset: number; limit: number }): Promise<string[]>;
    /** Missing keys return undefined. */
    get(key: string): Promise<PluginStorageValue>;
    set(key: string, value: PluginStorageValue): Promise<void>;
    /** Missing keys are a no-op. */
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
  };

  /** Root setting values. Unknown is intentional for migration and extension keys. */
  setting: {
    /** Missing keys return undefined. */
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    /** Missing keys are a no-op. */
    delete(key: string): Promise<void>;
    /** Enumerates persisted root setting keys without hydrating values. */
    keys(): Promise<string[]>;
    /** Reads only requested keys; absent keys are omitted from the result. */
    getMany(keys: string[]): Promise<Map<string, unknown>>;
  };

  /** Archive payloads are read one key at a time, never through an aggregate loader. */
  coldStorage: {
    count(): Promise<number>;
    /** Keys only, ordered lexically. */
    keys(options: { offset: number; limit: number }): Promise<string[]>;
    /** Missing archives return null. */
    get(key: string): Promise<unknown | null>;
    set(key: string, value: unknown): Promise<void>;
    /** Deletes specified archives and returns the number removed; duplicate keys count once. */
    delete(keys: readonly string[]): Promise<number>;
    prune(retainedKeys: readonly string[]): Promise<number>;
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
