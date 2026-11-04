import type {
  AuthorNoteMetadata,
  AuthorNoteRow,
} from "@risuai/protocol/src/authorNotes.ts";
import { createSqlMessageMutations } from "../sqlCommitCoordinator";
import localforage from "localforage";

const SHARED_TEXT_ENCODER = new TextEncoder();
import { getNodeClientSessionId } from "../../../network/nodeClientSession";
import type {
  Database,
  DatabaseSettings,
  Message,
  character,
  groupChat,
  Chat,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "@risuai/protocol/domain/database.ts";
import type { RisuModule } from "@risuai/protocol/domain/modules.ts";
import type {
  INodeSqlStorageAdmin,
  SqlStartupDataResult,
  SqlDatabaseSnapshotResult,
  SqlRecentChatMetadata,
  SqlChatBranchSummary,
  SqlChatBranchGraphData,
  SqlChatBranchGraphPage,
  SqlCreateChatBranchInput,
  BotPresetSummary,
  StoredBotPreset,
} from "@risuai/storage-core/sqlStorage";
import {
  buildSqlReplaceCommit,
  type SqlCommit,
  type SqlCommitResult,
} from "../sqlCommit";
import { BoundedCache } from "../../../memory/boundedCache";
import {
  decodePluginStorageRecord,
  decodePluginStorageValue,
  encodePluginStorageValue,
} from "../pluginStorageValueCodec";
import {
  createSameOriginNodeApiClient,
  type NodeApiClient,
} from "@risuai/storage-remote/nodeApiClient";
import {
  RemoteDatabaseAdminClient,
  type RemoteDatabaseConfig,
} from "@risuai/storage-remote/remoteDatabaseAdminClient";
import { RemoteColdStorageClient } from "@risuai/storage-remote/remoteColdStorageClient";
import { RemoteDatabaseBackupClient } from "@risuai/storage-remote/remoteDatabaseBackupClient";
import { RemoteLocalBackupClient } from "@risuai/storage-remote/remoteLocalBackupClient";
import {
  RemoteSqlCommitClient,
  NodeSqlPayloadTooLargeError,
  NodeSqlRevisionConflictError,
} from "@risuai/storage-remote/remoteSqlCommitClient";
import { RemoteSqlReadClient } from "@risuai/storage-remote/remoteSqlReadClient";
import { RemoteSqlDocumentClient } from "@risuai/storage-remote/remoteSqlDocumentClient";
import type { IPluginStorage } from "@risuai/protocol/domain/pluginStorage.ts";
import { NodePluginStorage } from "./nodePluginStorage";
import { encodeStorageSyncValue } from "@risuai/protocol/storageSyncValueCodec.ts";
import {
  PortableDatabaseStreamValidator,
  type PortableDatabaseStreamRestoreProgress,
} from "../../backup/portableDatabaseStreamRestore";
import type {
  PortableDatabaseStreamFragment,
  PortableDatabaseStreamManifest,
} from "../../backup/portableDatabaseStream";

import type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  NodeSqlStorageRuntime,
  NodeSqlStorageRuntimeError,
} from "../../../../../packages/protocol/storageConfig.ts";
export type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  NodeSqlStorageRuntime,
  NodeSqlStorageRuntimeError,
} from "../../../../../packages/protocol/storageConfig.ts";

import type {
  NodePostgresRevision,
  NodePostgresAuditLogItem,
  NodePostgresTableSummary,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresBotChatStats,
  NodePostgresCharacterSearchResult,
  NodePostgresTableInfo,
  NodePostgresColumnInfo,
  NodePostgresTableData,
  NodeBackupMirroringConfig,
  NodeBackupSnapshotConfig,
  NodeBackupConfig,
  NodeBackupConfigUpdate,
  NodeBackupProgressEvent,
  NodeBackupFullSyncResult,
} from "../../../../../packages/protocol/databaseApi.ts";
export type {
  NodePostgresRevision,
  NodePostgresAuditLogItem,
  NodePostgresTableSummary,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresBotChatStats,
  NodePostgresCharacterSearchResult,
  NodePostgresTableInfo,
  NodePostgresColumnInfo,
  NodePostgresTableData,
  NodeBackupMirroringConfig,
  NodeBackupSnapshotConfig,
  NodeBackupConfig,
  NodeBackupConfigUpdate,
  NodeBackupProgressEvent,
  NodeBackupFullSyncResult,
} from "../../../../../packages/protocol/databaseApi.ts";

export interface SqlVendorFormValues {
  connectionString?: string;
  server?: string;
  database?: string;
  user?: string;
  password?: string;
  tnsAlias?: string;
  walletPath?: string;
  walletPassword?: string;
  port?: number;
  poolMax: number;
}

export function buildSqlVendorParams(
  vendor: DbVendor,
  values: SqlVendorFormValues,
): Record<string, unknown> {
  if (vendor === "postgres") {
    return {
      connectionString: values.connectionString?.trim() || "",
      poolMax: values.poolMax,
    };
  }
  if (vendor === "oracle") {
    return {
      user: values.user?.trim() || "",
      password: values.password || "",
      tnsAlias: values.tnsAlias?.trim() || "",
      walletPath: values.walletPath?.trim() || undefined,
      walletPassword: values.walletPassword || undefined,
      poolMax: values.poolMax,
    };
  }
  return {
    server: values.server?.trim() || "",
    database: values.database?.trim() || "",
    user: values.user?.trim() || "",
    password: values.password || "",
    port: values.port || 1433,
    poolMax: values.poolMax,
  };
}

export function isSqlVendorParamsComplete(
  vendor: DbVendor,
  values: SqlVendorFormValues,
): boolean {
  const params = buildSqlVendorParams(vendor, values);
  if (vendor === "postgres") {
    return Boolean(params.connectionString);
  }
  if (vendor === "oracle") {
    return Boolean(params.user && params.password && params.tnsAlias);
  }
  return Boolean(
    params.server && params.database && params.user && params.password,
  );
}

export {
  NodeSqlPayloadTooLargeError,
  NodeSqlRevisionConflictError,
} from "@risuai/storage-remote/remoteSqlCommitClient";

export class NodeSqlStorage implements INodeSqlStorageAdmin {
  table = {
    list: async (): Promise<NodePostgresTableInfo[]> => {
      if (!(await this.ensureEnabled())) return [];
      const tables = await this.databaseAdmin.listDbTables();
      if (tables === null) {
        this.status = "disabled";
        return [];
      }
      return tables;
    },
    data: async (
      table: string,
      options: {
        offset?: number;
        limit?: number;
        sortColumn?: string;
        sortOrder?: "asc" | "desc";
        search?: string;
        columns?: string[];
      } = {},
    ): Promise<NodePostgresTableData> => {
      if (!(await this.ensureEnabled())) {
        throw new Error("PostgreSQL storage is disabled");
      }
      const data = await this.databaseAdmin.getDbTableData(table, options);
      if (data === null) {
        this.status = "disabled";
        throw new Error("PostgreSQL storage is disabled");
      }
      return data;
    },
  };

  stats = {
    tokenUsage: async (): Promise<NodePostgresTokenUsage[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.getTokenUsage();
    },
    botChats: async (): Promise<NodePostgresBotChatStats[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.getBotChatStats();
    },
  };

  revision = {
    list: async (limit?: number): Promise<NodePostgresRevision[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.listRevisions(limit);
    },
    details: async (
      revisionId: number,
    ): Promise<NodePostgresRevisionDetails | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.databaseAdmin.getRevisionDetails(revisionId);
    },
    diff: async (
      baseId: number,
      targetId: number,
    ): Promise<NodePostgresRevisionDiff | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.databaseAdmin.getRevisionDiff(baseId, targetId);
    },
    previewRestore: async (
      revisionId: number,
    ): Promise<NodePostgresRestorePreview | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.databaseAdmin.previewRestoreRevision(revisionId);
    },
    restore: async (
      revisionId: number,
    ): Promise<{ revision: number; revisionId: number }> => {
      if (!(await this.ensureEnabled())) {
        throw new Error("PostgreSQL storage is disabled");
      }
      const result = await this.databaseAdmin.restoreRevision(revisionId);
      this.currentRevision = result.revision;
      return result;
    },
  };

  coldStorage = {
    get: async (key: string): Promise<unknown | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.coldStorageClient.getItem(key);
    },
    list: async (): Promise<{ items: string[] }> => {
      if (!(await this.ensureEnabled())) return { items: [] };
      return { items: await this.coldStorageClient.listItems() };
    },
    set: async (key: string, value: unknown): Promise<boolean> => {
      if (!(await this.ensureEnabled())) return false;
      await this.coldStorageClient.setItem(key, value);
      return true;
    },
    remove: async (keys: string[]): Promise<number> => {
      if (!(await this.ensureEnabled()) || keys.length === 0) return 0;
      return await this.coldStorageClient.removeItems(keys);
    },
    prune: async (retainedKeys: string[]): Promise<number> => {
      if (!(await this.ensureEnabled())) return 0;
      return await this.coldStorageClient.prune(retainedKeys);
    },
  };

  setting = {
    keys: async (): Promise<string[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.readClient.listSettingKeys();
    },
    get: async (key: string): Promise<unknown> => {
      if (!(await this.ensureEnabled())) return undefined;
      return await this.readClient.loadSettingKey(key);
    },
  };

  script = {
    list: async (): Promise<customscript[]> => {
      if (!(await this.ensureEnabled())) return [];
      let cached = this.memoryScriptsCache;
      if (!cached) {
        try {
          cached = await this.scriptsCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.loadScripts<customscript>(
        cached?.hash,
      );
      if (result.status === "not-modified" && cached)
        return cached.globalscript ?? [];
      if (result.status !== "ok") return [];
      const entry = {
        hash: result.body.hash,
        globalscript: result.body.globalscript ?? [],
      };
      this.memoryScriptsCache = entry;
      try {
        await this.scriptsCacheForage.setItem("cache", entry);
      } catch {}
      return entry.globalscript;
    },
  };

  prompt = {
    load: async (): Promise<Record<string, unknown>> => {
      if (!(await this.ensureEnabled())) return {};
      let cached = this.memoryPromptsCache;
      if (!cached) {
        try {
          cached = await this.promptsCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.loadPrompts<
        Record<string, unknown>
      >(cached?.hash);
      if (result.status === "not-modified" && cached)
        return cached.prompts ?? {};
      if (result.status !== "ok") return {};
      const entry = {
        hash: result.body.hash,
        prompts: result.body.prompts ?? {},
      };
      this.memoryPromptsCache = entry;
      try {
        await this.promptsCacheForage.setItem("cache", entry);
      } catch {}
      return entry.prompts;
    },
  };

  module = {
    list: async (): Promise<RisuModule[]> => {
      if (!(await this.ensureEnabled())) return [];
      let cached = this.memoryModulesCache;
      if (!cached) {
        try {
          cached = await this.modulesCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.loadModules<RisuModule>(
        cached?.hash,
      );
      if (result.status === "not-modified" && cached)
        return cached.modules ?? [];
      if (result.status !== "ok") return [];
      const entry = {
        hash: result.body.hash,
        modules: result.body.modules ?? [],
      };
      this.memoryModulesCache = entry;
      try {
        await this.modulesCacheForage.setItem("cache", entry);
      } catch {}
      return entry.modules;
    },
  };

  lorebook = {
    list: async (): Promise<{ name: string; data: loreBook[] }[]> => {
      if (!(await this.ensureEnabled())) return [];
      let cached = this.memoryLoreBookCache;
      if (!cached) {
        try {
          cached = await this.loreBookCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      type LorebookRecord = { name: string; data: loreBook[] };
      const result = await this.documentClient.loadLorebooks<LorebookRecord>(
        cached?.hash,
      );
      if (result.status === "not-modified" && cached)
        return cached.loreBook ?? [];
      if (result.status !== "ok") return [];
      const entry = {
        hash: result.body.hash,
        loreBook: result.body.loreBook ?? [],
      };
      this.memoryLoreBookCache = entry;
      try {
        await this.loreBookCacheForage.setItem("cache", entry);
      } catch {}
      return entry.loreBook;
    },
  };

  preset = {
    list: async (): Promise<BotPresetSummary[]> => {
      if (!(await this.ensureEnabled())) return [];
      let cached = this.memoryBotPresetsCache;
      if (!cached) {
        try {
          cached = await this.botPresetsCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.listBotPresets<BotPresetSummary>(
        cached?.hash,
      );
      if (result.status === "not-modified" && cached)
        return cached.presets ?? [];
      if (result.status !== "ok") return [];
      const entry = {
        hash: result.body.hash,
        presets: result.body.presets ?? [],
      };
      this.memoryBotPresetsCache = entry;
      try {
        await this.botPresetsCacheForage.setItem("cache", entry);
      } catch {}
      return entry.presets;
    },
    load: async (id: string): Promise<StoredBotPreset | null> => {
      if (!(await this.ensureEnabled())) return null;
      let cached = this.memoryBotPresetCache.get(id);
      if (!cached) {
        try {
          cached =
            (await this.botPresetsCacheForage.getItem(`preset:${id}`)) ??
            undefined;
        } catch {}
      }
      const result = await this.documentClient.loadBotPreset<StoredBotPreset>(
        id,
        cached?.hash,
      );
      if (result.status === "not-modified" && cached) return cached.preset;
      if (result.status !== "ok") return null;
      const entry = { hash: result.body.hash, preset: result.body.preset };
      this.memoryBotPresetCache.set(id, entry);
      void this.botPresetsCacheForage
        .setItem(`preset:${id}`, entry)
        .catch(() => {});
      return entry.preset;
    },
  };

  persona = {
    list: async (): Promise<RisuPersona[]> => {
      if (!(await this.ensureEnabled())) return [];
      let cached = this.memoryPersonasCache;
      if (!cached) {
        try {
          cached = await this.personasCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.loadPersonas<RisuPersona>(
        cached?.hash,
      );
      if (result.status === "not-modified" && cached)
        return cached.personas ?? [];
      if (result.status !== "ok") return [];
      const entry = {
        hash: result.body.hash,
        personas: result.body.personas ?? [],
      };
      this.memoryPersonasCache = entry;
      try {
        await this.personasCacheForage.setItem("cache", entry);
      } catch {}
      return entry.personas;
    },
  };

  pluginCustomStorage = {
    load: async (): Promise<Record<string, unknown> | null> => {
      if (!(await this.ensureEnabled())) return null;
      let cached = this.memoryPluginStorageCache;
      if (!cached) {
        try {
          cached = await this.pluginStorageCacheForage.getItem("cache");
        } catch {
          cached = null;
        }
      }
      const result = await this.documentClient.loadPluginStorage(cached?.hash);
      if (result.status === "not-modified" && cached) {
        this.memoryPluginStorageCache = cached;
        return cached.pluginCustomStorage ?? {};
      }
      if (result.status !== "ok") return null;
      const pluginCustomStorage = decodePluginStorageRecord(
        result.body.pluginCustomStorage ?? {},
      );
      const entry = {
        hash: result.body.hash,
        pluginCustomStorage,
      };
      this.memoryPluginStorageCache = entry;
      try {
        await this.pluginStorageCacheForage.setItem("cache", entry);
      } catch {}
      return entry.pluginCustomStorage;
    },
    keys: async (): Promise<string[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.documentClient.listPluginStorageKeys();
    },
    get: async (key: string): Promise<unknown> => {
      if (!(await this.ensureEnabled())) return undefined;
      let cached = this.memoryPluginKeyCache.get(key);
      if (!cached) {
        try {
          cached = (await this.pluginKeyCacheForage.getItem(key)) ?? undefined;
        } catch {
          cached = undefined;
        }
      }
      const result = await this.documentClient.loadPluginStorageKey(
        key,
        cached?.hash,
      );
      if (result.status === "not-modified" && cached) return cached.value;
      if (result.status !== "ok") return undefined;
      const entry = {
        hash: result.body.hash,
        value: decodePluginStorageValue(result.body.value),
      };
      this.memoryPluginKeyCache.set(key, entry);
      try {
        await this.pluginKeyCacheForage.setItem(key, entry);
      } catch {}
      return entry.value;
    },
  };

  character = {
    searchByTag: async (
      tag: string,
      limit = 100,
    ): Promise<NodePostgresCharacterSearchResult[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.searchCharacters("tag", tag, limit);
    },
    searchByName: async (
      name: string,
      limit = 100,
    ): Promise<NodePostgresCharacterSearchResult[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.searchCharacters("name", name, limit);
    },

    document: async (
      characterId: string,
    ): Promise<character | groupChat | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.readClient.loadCharacter<character | groupChat>(
        characterId,
      );
    },
    assetFields: async (
      characterId: string,
    ): Promise<Partial<character> | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.readClient.loadCharacterAssetFields<Partial<character>>(
        characterId,
      );
    },
  };

  authorNote = {
    list: async () => {
      return this.requestAuthorNote<AuthorNoteMetadata[]>("");
    },
    get: async (id: string) => {
      return this.requestAuthorNote<AuthorNoteMetadata | null>(
        `/${encodeURIComponent(id)}`,
      );
    },
    read: async (id: string) => {
      return this.requestAuthorNote<AuthorNoteRow | null>(
        `/${encodeURIComponent(id)}/content`,
      );
    },
    scriptWrite: async () => {
      return this.requestAuthorNote<boolean>("/script-write");
    },
  };

  chat = {
    load: async (
      chatId: string,
      options?: { messageLimit?: number },
    ): Promise<Chat | null> => {
      if (!(await this.ensureEnabled())) return null;
      return await this.readClient.loadChat<Chat>(chatId, options);
    },
    listRecent: async (
      limit?: number,
      activeChatId?: string,
    ): Promise<SqlRecentChatMetadata[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.readClient.listRecentChats<SqlRecentChatMetadata>(
        limit,
        activeChatId,
      );
    },
  };

  message = {
    ...createSqlMessageMutations(this),
    list: async (
      chatId: string,
      options: { mode?: "full" | "generation" } = {},
    ): Promise<Message[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.readClient.loadChatMessages<Message>(chatId, options);
    },
    page: async (chatId: string, before: number | undefined, limit: number) => {
      if (!(await this.ensureEnabled())) {
        return { messages: [], offset: 0, total: 0, hasMore: false };
      }
      return await this.readClient.loadChatMessagePage<{
        messages: Message[];
        offset: number;
        total: number;
        hasMore: boolean;
      }>(chatId, before, limit);
    },
    search: async (
      query: string,
      scope: "all" | "active" | "cold" = "all",
      limit = 50,
    ): Promise<NodePostgresMessageSearchResult[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.databaseAdmin.searchMessages(query, scope, limit);
    },
  };

  branch = {
    list: async (chatId: string): Promise<SqlChatBranchSummary[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.readClient.listChatBranches<SqlChatBranchSummary>(
        chatId,
      );
    },
    graph: async (chatId: string): Promise<SqlChatBranchGraphData> => {
      if (!(await this.ensureEnabled())) {
        return { branches: [], messages: [], links: [] };
      }
      return (
        (await this.readClient.loadChatBranchGraph<SqlChatBranchGraphData>(
          chatId,
        )) ?? { branches: [], messages: [], links: [] }
      );
    },
    graphPage: async (
      chatId: string,
      offset: number,
      limit: number,
    ): Promise<SqlChatBranchGraphPage> => {
      const empty = {
        branches: [],
        messages: [],
        links: [],
        offset: 0,
        total: 0,
        hasMore: false,
      };
      if (!(await this.ensureEnabled())) return empty;
      return (
        (await this.readClient.loadChatBranchGraphPage<SqlChatBranchGraphPage>(
          chatId,
          offset,
          limit,
        )) ?? empty
      );
    },
    messages: async (
      chatId: string,
      branchId: string,
      options: {
        messageLimit?: number;
        mode?: "full" | "generation" | "graph";
      } = {},
    ): Promise<Message[]> => {
      if (!(await this.ensureEnabled())) return [];
      return await this.readClient.loadBranchMessages<Message>(
        chatId,
        branchId,
        options,
      );
    },
    create: async (
      input: SqlCreateChatBranchInput,
    ): Promise<SqlChatBranchSummary> => {
      if (!(await this.ensureEnabled())) {
        throw new Error("SQL storage is not enabled");
      }
      return await this.readClient.createChatBranch<SqlChatBranchSummary>(
        input,
      );
    },
    activate: async (chatId: string, branchId: string): Promise<void> => {
      if (!(await this.ensureEnabled())) {
        throw new Error("SQL storage is not enabled");
      }
      await this.readClient.activateChatBranch(chatId, branchId);
    },
  };

  readonly backendKind = "node" as const;
  readonly plugin: IPluginStorage;
  private status: "unknown" | "enabled" | "disabled" | "degraded" = "unknown";
  private currentRevision = 0;
  private readonly clientId = getNodeClientSessionId();
  private readonly databaseAdmin: RemoteDatabaseAdminClient;
  private readonly coldStorageClient: RemoteColdStorageClient;
  private readonly backupClient: RemoteDatabaseBackupClient;
  private readonly localBackupClient: RemoteLocalBackupClient;
  private readonly commitClient: RemoteSqlCommitClient;
  private readonly readClient: RemoteSqlReadClient;
  private readonly documentClient: RemoteSqlDocumentClient;
  private pluginStorageCacheForage = localforage.createInstance({
    name: "risuaiPostgresPluginStorage",
  });

  private personasCacheForage = localforage.createInstance({
    name: "risuaiPostgresPersonas",
  });
  private botPresetsCacheForage = localforage.createInstance({
    name: "risuaiPostgresBotPresets",
  });
  private loreBookCacheForage = localforage.createInstance({
    name: "risuaiPostgresLoreBook",
  });
  private modulesCacheForage = localforage.createInstance({
    name: "risuaiPostgresModules",
  });
  private promptsCacheForage = localforage.createInstance({
    name: "risuaiPostgresPrompts",
  });
  private scriptsCacheForage = localforage.createInstance({
    name: "risuaiPostgresScripts",
  });

  private memoryPluginStorageCache: {
    hash: string;
    pluginCustomStorage: Record<string, unknown>;
  } | null = null;
  private memoryPersonasCache: {
    hash: string;
    personas: RisuPersona[];
  } | null = null;
  private memoryBotPresetsCache: {
    hash: string;
    presets: BotPresetSummary[];
  } | null = null;
  private memoryBotPresetCache = new BoundedCache<
    string,
    { hash: string; preset: StoredBotPreset }
  >({ maxEntries: 8 });
  private memoryLoreBookCache: {
    hash: string;
    loreBook: { name: string; data: loreBook[] }[];
  } | null = null;
  private memoryModulesCache: { hash: string; modules: RisuModule[] } | null =
    null;
  private memoryPromptsCache: {
    hash: string;
    prompts: Record<string, unknown>;
  } | null = null;
  private memoryScriptsCache: {
    hash: string;
    globalscript: customscript[];
  } | null = null;

  constructor(
    private readonly getAuth: () => Promise<string>,
    private readonly apiClient: NodeApiClient = createSameOriginNodeApiClient(),
  ) {
    this.databaseAdmin = new RemoteDatabaseAdminClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.coldStorageClient = new RemoteColdStorageClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.backupClient = new RemoteDatabaseBackupClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.localBackupClient = new RemoteLocalBackupClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.commitClient = new RemoteSqlCommitClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.readClient = new RemoteSqlReadClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.documentClient = new RemoteSqlDocumentClient(
      this.apiClient,
      this.getAuth,
      this.clientId,
    );
    this.plugin = new NodePluginStorage(this, this.documentClient);
  }

  isEnabled() {
    return this.status === "enabled";
  }

  async init(): Promise<boolean> {
    if (this.status === "unknown") {
      try {
        const config = await this.getDatabaseConfig();
        this.status =
          config.runtime?.status === "ready"
            ? "enabled"
            : config.runtime?.status === "degraded"
              ? "degraded"
              : "disabled";
      } catch {
        this.status = "disabled";
        return false;
      }
    }
    return this.status === "enabled";
  }

  getClientId(): string {
    return this.clientId;
  }

  applyRemoteRevision(revision: number): void {
    if (Number.isSafeInteger(revision) && revision > this.currentRevision) {
      this.currentRevision = revision;
    }
  }

  private async ensureEnabled() {
    if (this.status === "unknown") await this.init();
    return this.status === "enabled";
  }

  async getServerConfig(): Promise<NodePostgresServerConfig> {
    const config = await this.databaseAdmin.getPostgresConfig();
    this.status = config.enabled ? "enabled" : "disabled";
    this.currentRevision = config.revision ?? 0;
    return config;
  }

  async configureServer(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig> {
    const config = await this.databaseAdmin.configurePostgres(update);
    this.status = config.enabled ? "enabled" : "disabled";
    this.currentRevision = config.revision ?? 0;
    return config;
  }

  // ── 범용 DB 설정 API (postgres / oracle / azure 공통) ──

  async getDatabaseConfig(): Promise<RemoteDatabaseConfig> {
    const config = await this.databaseAdmin.getDatabaseConfig();
    this.status =
      config.runtime?.status === "ready"
        ? "enabled"
        : config.runtime?.status === "degraded"
          ? "degraded"
          : config.enabled
            ? "enabled"
            : "disabled";
    if (config.revision != null) this.currentRevision = config.revision;
    return config;
  }

  async applyDatabaseConfig(
    vendor: DbVendor,
    params: Record<string, any>,
    migrate = false,
  ): Promise<RemoteDatabaseConfig> {
    const config = await this.databaseAdmin.applyDatabaseConfig(
      vendor,
      params,
      migrate,
    );
    this.status =
      config.runtime?.status === "ready" || config.enabled
        ? "enabled"
        : config.runtime?.status === "degraded"
          ? "degraded"
          : "disabled";
    if (config.revision != null) this.currentRevision = config.revision;
    return config;
  }

  async retryDatabaseConnection(): Promise<RemoteDatabaseConfig> {
    const config = await this.databaseAdmin.retryDatabaseConnection();
    this.status = config.runtime?.status === "ready" ? "enabled" : "degraded";
    if (config.revision != null) this.currentRevision = config.revision;
    return config;
  }

  async testConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    return await this.databaseAdmin.testConnection(vendor, params);
  }

  async migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    return await this.databaseAdmin.migrateLegacyData();
  }

  getRevision(): number {
    return this.currentRevision;
  }

  async getStorageSyncSummary() {
    const summary = await this.apiClient.getStorageSyncSummary(
      await this.getAuth(),
    );
    this.currentRevision = summary.revision;
    return {
      revision: summary.revision,
      initialized: summary.initialized,
      records: summary.records,
    };
  }

  private pluginKeyCacheForage = localforage.createInstance({
    name: "risuaiPostgresPluginKeyStorage",
  });
  private memoryPluginKeyCache = new BoundedCache<
    string,
    { hash: string; value: unknown }
  >({ maxEntries: 64 });

  private async requestAuthorNote<T>(path: string): Promise<T> {
    if (!(await this.ensureEnabled()))
      throw new Error("SQL storage is not enabled");
    const response = await this.apiClient.request(
      `/api/database-v2/author-notes${path}`,
      { headers: { "risu-auth": await this.getAuth() }, cache: "no-store" },
    );
    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => null))?.error ||
          "Author note query failed",
      );
    return (await response.json()).value as T;
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    const body = await this.readClient.loadStartupData<SqlStartupDataResult>();
    if (body === null) {
      this.status = "disabled";
      return null;
    }
    this.status = "enabled";
    this.currentRevision = body.revision;
    return body;
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!(await this.ensureEnabled())) return null;
    const body =
      await this.readClient.exportDatabaseSnapshot<SqlDatabaseSnapshotResult>();
    if (body.database?.pluginCustomStorage) {
      body.database.pluginCustomStorage = decodePluginStorageRecord(
        body.database.pluginCustomStorage,
      );
    }
    this.currentRevision = body.revision;
    return body;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    const wireCommit = commit.pluginStorage
      ? {
          ...commit,
          pluginStorage: {
            ...commit.pluginStorage,
            upserts: commit.pluginStorage.upserts.map((upsert) => ({
              ...upsert,
              value: encodePluginStorageValue(upsert.value),
            })),
          },
        }
      : commit;
    const result = await this.commitClient.commit(
      wireCommit,
      this.currentRevision,
    );
    this.currentRevision = result.revision;
    return result;
  }

  async replaceDatabase(
    database: Database,
    onProgress?: (status: string) => void,
  ) {
    onProgress?.("Replacing SQL database...");
    await this.commit(buildSqlReplaceCommit(database, this.currentRevision));
    return true;
  }

  async beginPortableDatabaseStreamRestore(
    onProgress?: (progress: PortableDatabaseStreamRestoreProgress) => void,
  ) {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }

    const remoteSession =
      await this.localBackupClient.createDatabaseStreamSession();
    const validator = new PortableDatabaseStreamValidator();
    const maxBatchRecords = 64;
    const maxBatchBytes = 4 * 1024 * 1024;
    const maxRecordBytes = 16 * 1024 * 1024;
    let closed = false;

    const sendRecords = async (
      fragmentIndex: number,
      records: unknown[],
      fragmentComplete: boolean,
    ) => {
      if (closed) {
        throw new Error("Portable database restore session is already closed");
      }
      const state = await this.localBackupClient.appendDatabaseStreamRecords(
        remoteSession.id,
        { fragmentIndex, records, fragmentComplete },
      );
      onProgress?.({ appliedRecords: state.recordCount });
    };

    return {
      writeFragment: async (fragment: PortableDatabaseStreamFragment) => {
        validator.acceptFragment(fragment);

        let batch: unknown[] = [];
        let batchBytes = 0;
        const flush = async (fragmentComplete: boolean) => {
          if (batch.length === 0) return;
          const records = batch;
          batch = [];
          batchBytes = 0;
          await sendRecords(fragment.index, records, fragmentComplete);
        };

        for (let index = 0; index < fragment.records.length; index++) {
          const record = fragment.records[index];
          const encoded = encodeStorageSyncValue(record);
          const serialized = JSON.stringify(encoded);
          const recordBytes =
            typeof Buffer !== "undefined"
              ? Buffer.byteLength(serialized, "utf8")
              : SHARED_TEXT_ENCODER.encode(serialized).byteLength;
          if (recordBytes > maxRecordBytes) {
            throw new Error(
              `Portable database record exceeds ${maxRecordBytes} bytes`,
            );
          }
          if (
            batch.length > 0 &&
            (batch.length >= maxBatchRecords ||
              batchBytes + recordBytes > maxBatchBytes)
          ) {
            await flush(false);
          }
          batch.push(encoded);
          batchBytes += recordBytes;
          if (batch.length >= maxBatchRecords) {
            await flush(index === fragment.records.length - 1);
          }
        }
        if (batch.length > 0) {
          await flush(true);
        }
      },
      finish: async (manifest: PortableDatabaseStreamManifest) => {
        if (closed) {
          throw new Error(
            "Portable database restore session is already closed",
          );
        }
        validator.finish(manifest);
        const result = await this.localBackupClient.finalizeDatabaseStream(
          remoteSession.id,
          manifest,
        );
        closed = true;
        this.currentRevision = result.revision;
      },
      abort: async () => {
        if (closed) return;
        closed = true;
        await this.localBackupClient
          .cancelDatabaseStream(remoteSession.id)
          .catch(() => {});
      },
    };
  }

  // ── 백업 데이터베이스 API ──

  async getBackupStatus(): Promise<NodeBackupConfig> {
    return await this.backupClient.getStatus();
  }

  async testBackupConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    return await this.backupClient.testConnection(vendor, params);
  }

  async configureBackup(
    update: NodeBackupConfigUpdate,
  ): Promise<NodeBackupConfig> {
    return await this.backupClient.configure(update);
  }

  async resyncBackup(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    return await this.backupClient.resync(onProgress);
  }

  async restoreFromBackup(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    return await this.backupClient.restore(onProgress);
  }

  async removeBackup(): Promise<NodeBackupConfig> {
    return await this.backupClient.remove();
  }
}
