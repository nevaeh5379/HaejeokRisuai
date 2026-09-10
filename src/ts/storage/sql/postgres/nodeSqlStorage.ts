import localforage from "localforage";
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
} from "../../database/schema";
import type { RisuModule } from "../../../process/modules";
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
} from "../ISqlStorage";
import {
  buildSqlReplaceCommit,
  type SqlCommit,
  type SqlCommitResult,
} from "../sqlCommit";
import { BoundedCache } from "../../../memory/boundedCache";
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
import {
  RemoteSqlCommitClient,
  NodeSqlPayloadTooLargeError,
  NodeSqlRevisionConflictError,
} from "@risuai/storage-remote/remoteSqlCommitClient";
import { RemoteSqlReadClient } from "@risuai/storage-remote/remoteSqlReadClient";
import { RemoteSqlDocumentClient } from "@risuai/storage-remote/remoteSqlDocumentClient";

import type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  NodeSqlStorageRuntime,
  NodeSqlStorageRuntimeError,
} from "../../../../../packages/protocol/storageConfig.cjs";
export type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
  NodeSqlStorageRuntime,
  NodeSqlStorageRuntimeError,
} from "../../../../../packages/protocol/storageConfig.cjs";

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
} from "../../../../../packages/protocol/databaseApi.cjs";
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
} from "../../../../../packages/protocol/databaseApi.cjs";

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
  readonly backendKind = "node" as const;
  private status: "unknown" | "enabled" | "disabled" | "degraded" = "unknown";
  private revision = 0;
  private readonly clientId = getNodeClientSessionId();
  private readonly databaseAdmin: RemoteDatabaseAdminClient;
  private readonly coldStorageClient: RemoteColdStorageClient;
  private readonly backupClient: RemoteDatabaseBackupClient;
  private readonly commitClient: RemoteSqlCommitClient;
  private readonly readClient: RemoteSqlReadClient;
  private readonly documentClient: RemoteSqlDocumentClient;
  private pluginsCacheForage = localforage.createInstance({
    name: "risuaiPostgresPlugins",
  });
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

  private memoryPluginsCache: { hash: string; plugins: any[] } | null = null;
  private memoryRuntimePluginsCache: { hash: string; plugins: any[] } | null =
    null;
  private memoryPluginStorageCache: {
    hash: string;
    pluginCustomStorage: Record<string, any>;
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
    prompts: Record<string, any>;
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
    if (Number.isSafeInteger(revision) && revision > this.revision) {
      this.revision = revision;
    }
  }

  private async ensureEnabled() {
    if (this.status === "unknown") await this.init();
    return this.status === "enabled";
  }

  async getServerConfig(): Promise<NodePostgresServerConfig> {
    const config = await this.databaseAdmin.getPostgresConfig();
    this.status = config.enabled ? "enabled" : "disabled";
    this.revision = config.revision ?? 0;
    return config;
  }

  async configureServer(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig> {
    const config = await this.databaseAdmin.configurePostgres(update);
    this.status = config.enabled ? "enabled" : "disabled";
    this.revision = config.revision ?? 0;
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
    if (config.revision != null) this.revision = config.revision;
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
    if (config.revision != null) this.revision = config.revision;
    return config;
  }

  async retryDatabaseConnection(): Promise<RemoteDatabaseConfig> {
    const config = await this.databaseAdmin.retryDatabaseConnection();
    this.status = config.runtime?.status === "ready" ? "enabled" : "degraded";
    if (config.revision != null) this.revision = config.revision;
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
    return this.revision;
  }

  async getStorageSyncSummary() {
    const summary = await this.apiClient.getStorageSyncSummary(
      await this.getAuth(),
    );
    this.revision = summary.revision;
    return {
      revision: summary.revision,
      initialized: summary.initialized,
      records: summary.records,
    };
  }

  async loadPlugins(options?: {
    enabledOnly?: boolean;
  }): Promise<any[] | null> {
    if (!(await this.ensureEnabled())) return null;
    const enabledOnly = options?.enabledOnly === true;
    const cacheKey = enabledOnly ? "runtime-cache" : "cache";
    let cached: { hash: string; plugins: any[] } | null = enabledOnly
      ? this.memoryRuntimePluginsCache
      : this.memoryPluginsCache;
    if (!cached) {
      try {
        cached = await this.pluginsCacheForage.getItem(cacheKey);
      } catch {
        cached = null;
      }
    }
    const result = await this.documentClient.loadPlugins(
      enabledOnly,
      cached?.hash,
    );
    if (result.status === "not-modified" && cached) {
      if (enabledOnly) this.memoryRuntimePluginsCache = cached;
      else this.memoryPluginsCache = cached;
      return cached.plugins ?? [];
    }
    if (result.status !== "ok") return null;
    const entry = {
      hash: result.body.hash,
      plugins: (result.body.plugins ?? []) as any[],
    };
    if (enabledOnly) this.memoryRuntimePluginsCache = entry;
    else this.memoryPluginsCache = entry;
    try {
      await this.pluginsCacheForage.setItem(cacheKey, entry);
    } catch {}
    return entry.plugins;
  }

  async setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    let body: { revision?: number };
    try {
      body = await this.documentClient.setPluginEnabled(
        pluginName,
        enabled,
        this.revision,
      );
    } catch (error) {
      if (error && typeof error === "object" && "revision" in error) {
        throw new NodeSqlRevisionConflictError((error as any).revision);
      }
      throw error;
    }
    if (body.revision != null) this.applyRemoteRevision(body.revision);
    this.memoryPluginsCache = null;
    this.memoryRuntimePluginsCache = null;
    try {
      await Promise.all([
        this.pluginsCacheForage.removeItem("cache"),
        this.pluginsCacheForage.removeItem("runtime-cache"),
      ]);
    } catch {}
  }

  async loadPluginCustomStorage(): Promise<Record<string, any> | null> {
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
    const entry = {
      hash: result.body.hash,
      pluginCustomStorage: result.body.pluginCustomStorage ?? {},
    };
    this.memoryPluginStorageCache = entry;
    try {
      await this.pluginStorageCacheForage.setItem("cache", entry);
    } catch {}
    return entry.pluginCustomStorage;
  }

  private pluginKeyCacheForage = localforage.createInstance({
    name: "risuaiPostgresPluginKeyStorage",
  });
  private memoryPluginKeyCache = new BoundedCache<
    string,
    { hash: string; value: any }
  >({ maxEntries: 64 });

  async listPluginCustomStorageKeys(): Promise<string[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.documentClient.listPluginStorageKeys();
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
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
    const entry = { hash: result.body.hash, value: result.body.value };
    this.memoryPluginKeyCache.set(key, entry);
    try {
      await this.pluginKeyCacheForage.setItem(key, entry);
    } catch {}
    return entry.value;
  }

  async loadPersonas(): Promise<RisuPersona[]> {
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
  }

  async listBotPresets(): Promise<BotPresetSummary[]> {
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
    if (result.status === "not-modified" && cached) return cached.presets ?? [];
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
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
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
  }

  async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
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
  }

  async loadModules(): Promise<RisuModule[]> {
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
    if (result.status === "not-modified" && cached) return cached.modules ?? [];
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
  }

  async loadPrompts(): Promise<Record<string, any>> {
    if (!(await this.ensureEnabled())) return {};
    let cached = this.memoryPromptsCache;
    if (!cached) {
      try {
        cached = await this.promptsCacheForage.getItem("cache");
      } catch {
        cached = null;
      }
    }
    const result = await this.documentClient.loadPrompts<Record<string, any>>(
      cached?.hash,
    );
    if (result.status === "not-modified" && cached) return cached.prompts ?? {};
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
  }

  async loadScripts(): Promise<customscript[]> {
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
  }

  async listSettingKeys(): Promise<string[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.readClient.listSettingKeys();
  }

  async loadSettingKey(key: string): Promise<any> {
    if (!(await this.ensureEnabled())) return undefined;
    return await this.readClient.loadSettingKey(key);
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    const body = await this.readClient.loadStartupData<SqlStartupDataResult>();
    if (body === null) {
      this.status = "disabled";
      return null;
    }
    this.status = "enabled";
    this.revision = body.revision;
    return body;
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!(await this.ensureEnabled())) return null;
    const body =
      await this.readClient.exportDatabaseSnapshot<SqlDatabaseSnapshotResult>();
    this.revision = body.revision;
    return body;
  }

  async loadCharacter(
    characterId: string,
  ): Promise<character | groupChat | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.readClient.loadCharacter<character | groupChat>(
      characterId,
    );
  }

  async loadCharacterAssetFields(
    characterId: string,
  ): Promise<Partial<character> | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.readClient.loadCharacterAssetFields<Partial<character>>(
      characterId,
    );
  }

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.readClient.loadChat<Chat>(chatId, options);
  }

  async loadChatMessages(
    chatId: string,
    options: { mode?: "full" | "generation" } = {},
  ): Promise<Message[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.readClient.loadChatMessages<Message>(chatId, options);
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    if (!(await this.ensureEnabled())) {
      return { messages: [], offset: 0, total: 0, hasMore: false };
    }
    return await this.readClient.loadChatMessagePage<{
      messages: Message[];
      offset: number;
      total: number;
      hasMore: boolean;
    }>(chatId, before, limit);
  }

  async listChatBranches(chatId: string): Promise<SqlChatBranchSummary[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.readClient.listChatBranches<SqlChatBranchSummary>(chatId);
  }

  async loadChatBranchGraph(chatId: string): Promise<SqlChatBranchGraphData> {
    if (!(await this.ensureEnabled())) {
      return { branches: [], messages: [], links: [] };
    }
    return (
      (await this.readClient.loadChatBranchGraph<SqlChatBranchGraphData>(
        chatId,
      )) ?? { branches: [], messages: [], links: [] }
    );
  }

  async loadChatBranchGraphPage(
    chatId: string,
    offset: number,
    limit: number,
  ): Promise<SqlChatBranchGraphPage> {
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
  }

  async loadBranchMessages(
    chatId: string,
    branchId: string,
    options: {
      messageLimit?: number;
      mode?: "full" | "generation" | "graph";
    } = {},
  ): Promise<Message[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.readClient.loadBranchMessages<Message>(
      chatId,
      branchId,
      options,
    );
  }

  async createChatBranch(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    return await this.readClient.createChatBranch<SqlChatBranchSummary>(input);
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    await this.readClient.activateChatBranch(chatId, branchId);
  }

  async listRecentChats(
    limit?: number,
    activeChatId?: string,
  ): Promise<SqlRecentChatMetadata[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.readClient.listRecentChats<SqlRecentChatMetadata>(
      limit,
      activeChatId,
    );
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.listRevisions(limit);
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.databaseAdmin.getRevisionDetails(revisionId);
  }

  async getRevisionDiff(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.databaseAdmin.getRevisionDiff(baseId, targetId);
  }

  async previewRestoreRevision(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.databaseAdmin.previewRestoreRevision(revisionId);
  }

  async restoreRevision(
    revisionId: number,
  ): Promise<{ revision: number; revisionId: number }> {
    if (!(await this.ensureEnabled())) {
      throw new Error("PostgreSQL storage is disabled");
    }
    const result = await this.databaseAdmin.restoreRevision(revisionId);
    this.revision = result.revision;
    return result;
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    if (!(await this.ensureEnabled())) return null;
    return await this.coldStorageClient.getItem(key);
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    if (!(await this.ensureEnabled())) return { items: [] };
    return { items: await this.coldStorageClient.listItems() };
  }

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    if (!(await this.ensureEnabled())) return false;
    await this.coldStorageClient.setItem(key, value);
    return true;
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    if (!(await this.ensureEnabled()) || keys.length === 0) return 0;
    return await this.coldStorageClient.removeItems(keys);
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    if (!(await this.ensureEnabled())) return 0;
    return await this.coldStorageClient.prune(retainedKeys);
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    const result = await this.commitClient.commit(commit, this.revision);
    this.revision = result.revision;
    return result;
  }

  async replaceDatabase(
    database: Database,
    onProgress?: (status: string) => void,
  ) {
    onProgress?.("Replacing SQL database...");
    await this.commit(buildSqlReplaceCommit(database, this.revision));
    return true;
  }

  async searchMessages(
    query: string,
    scope: "all" | "active" | "cold" = "all",
    limit = 50,
  ): Promise<NodePostgresMessageSearchResult[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.searchMessages(query, scope, limit);
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.getTokenUsage();
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.getBotChatStats();
  }

  async searchCharactersByTag(
    tag: string,
    limit = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.searchCharacters("tag", tag, limit);
  }

  async searchCharactersByName(
    name: string,
    limit = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    if (!(await this.ensureEnabled())) return [];
    return await this.databaseAdmin.searchCharacters("name", name, limit);
  }

  async listDbTables(): Promise<NodePostgresTableInfo[]> {
    if (!(await this.ensureEnabled())) return [];
    const tables = await this.databaseAdmin.listDbTables();
    if (tables === null) {
      this.status = "disabled";
      return [];
    }
    return tables;
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
    if (!(await this.ensureEnabled())) {
      throw new Error("PostgreSQL storage is disabled");
    }
    const data = await this.databaseAdmin.getDbTableData(table, options);
    if (data === null) {
      this.status = "disabled";
      throw new Error("PostgreSQL storage is disabled");
    }
    return data;
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
