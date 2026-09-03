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

async function encodeJsonBody(payload: unknown): Promise<{
  body: BodyInit;
  contentEncoding?: string;
}> {
  const json = JSON.stringify(payload);
  if (json.length < 64 * 1024 || typeof CompressionStream === "undefined") {
    return { body: json };
  }
  const input = new Blob([json]).stream();
  const compressed = input.pipeThrough(new CompressionStream("gzip"));
  return {
    body: await new Response(compressed).arrayBuffer(),
    contentEncoding: "gzip",
  };
}

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || `${fallback} (${response.status})`);
}

export class NodePostgresRevisionConflictError extends Error {
  readonly currentRevision: number | null;
  constructor(revision: unknown) {
    super(
      `PostgreSQL data changed in another session (server revision ${revision ?? "unknown"}). Reload before saving again.`,
    );
    this.name = "NodePostgresRevisionConflictError";
    this.currentRevision = Number.isSafeInteger(Number(revision))
      ? Number(revision)
      : null;
  }
}

export class NodePostgresPayloadTooLargeError extends Error {
  constructor(message?: string) {
    super(
      message ||
        "PostgreSQL save payload is larger than the Node server allows.",
    );
    this.name = "NodePostgresPayloadTooLargeError";
  }
}

export class NodePostgresStorage implements INodeSqlStorageAdmin {
  readonly backendKind = "node" as const;
  private status: "unknown" | "enabled" | "disabled" | "degraded" = "unknown";
  private revision = 0;
  private readonly clientId = getNodeClientSessionId();
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

  constructor(private readonly getAuth: () => Promise<string>) {}

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

  private async authHeaders() {
    return {
      "risu-auth": await this.getAuth(),
      "x-risu-client-id": this.clientId,
    };
  }

  private async ensureEnabled() {
    if (this.status === "unknown") await this.init();
    return this.status === "enabled";
  }

  async getServerConfig(): Promise<NodePostgresServerConfig> {
    const response = await fetch("/api/postgres-config", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL configuration load failed",
      );
    }
    const config: NodePostgresServerConfig = await response.json();
    this.status = config.enabled ? "enabled" : "disabled";
    this.revision = config.revision ?? 0;
    return config;
  }

  async configureServer(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig> {
    const encodedBody = await encodeJsonBody(update);
    const response = await fetch("/api/postgres-config", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL configuration update failed",
      );
    }
    const config: NodePostgresServerConfig = await response.json();
    this.status = config.enabled ? "enabled" : "disabled";
    this.revision = config.revision ?? 0;
    return config;
  }

  // ── 범용 DB 설정 API (postgres / oracle / azure 공통) ──

  /**
   * 현재 DB 설정 조회 (vendor, enabled, 마스킹된 연결 정보).
   * /api/db-config GET 대응.
   */
  async getDatabaseConfig(): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: DbVendor | null;
    }
  > {
    const response = await fetch("/api/db-config", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB configuration load failed");
    }
    const config = await response.json();
    this.status =
      config.runtime?.status === "ready"
        ? "enabled"
        : config.runtime?.status === "degraded"
          ? "degraded"
          : config.enabled
            ? "enabled"
            : "disabled";
    if (config.revision != null) {
      this.revision = config.revision;
    }
    return config;
  }

  /**
   * DB 설정 적용 (vendor + params + migrate). 서버가 storage를 재생성.
   * /api/db-config POST 대응.
   */
  async applyDatabaseConfig(
    vendor: DbVendor,
    params: Record<string, any>,
    migrate = false,
  ): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: DbVendor | null;
    }
  > {
    const encodedBody = await encodeJsonBody({ vendor, params, migrate });
    const response = await fetch("/api/db-config", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB configuration update failed");
    }
    const body = await response.json();
    this.status =
      body.runtime?.status === "ready" || body.enabled
        ? "enabled"
        : body.runtime?.status === "degraded"
          ? "degraded"
          : "disabled";
    if (body.revision != null) {
      this.revision = body.revision;
    }
    return body;
  }

  async retryDatabaseConnection(): Promise<
    NodePostgresServerConfig & {
      params: Record<string, any>;
      storedVendor: DbVendor | null;
    }
  > {
    const response = await fetch("/api/db-config/retry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB reconnection failed");
    }
    const body = await response.json();
    this.status = body.runtime?.status === "ready" ? "enabled" : "degraded";
    if (body.revision != null) this.revision = body.revision;
    return body;
  }

  /**
   * 연결 테스트 (실제 storage 재생성 없이 연결만 확인).
   * /api/db-config/test POST 대응.
   */
  async testConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    const encodedBody = await encodeJsonBody({ vendor, params });
    const response = await fetch("/api/db-config/test", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB connection test failed");
    }
    return await response.json();
  }

  /**
   * 명시적 로컬 → SQL 마이그레이션 트리거.
   * /api/database-v2/migrate-legacy POST 대응.
   */
  async migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    const response = await fetch("/api/database-v2/migrate-legacy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Legacy migration failed");
    }
    return await response.json();
  }

  getRevision(): number {
    return this.revision;
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

    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] =
        `"risu-plugins-${enabledOnly ? "runtime-" : ""}${cached.hash}"`;
    }

    const response = await fetch(
      `/api/database-v2/plugins${enabledOnly ? "?enabledOnly=1" : ""}`,
      { method: "GET", cache: "no-cache", headers },
    );

    if (response.status === 304 && cached) {
      if (enabledOnly) this.memoryRuntimePluginsCache = cached;
      else this.memoryPluginsCache = cached;
      return cached.plugins ?? [];
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw await responseError(response, "PostgreSQL plugins load failed");
    }

    const body: { plugins: any[]; hash: string } = await response.json();
    const entry = { hash: body.hash, plugins: body.plugins ?? [] };
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
    const response = await fetch(
      `/api/database-v2/plugins/${encodeURIComponent(pluginName)}/enabled`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled, baseRevision: this.revision }),
        headers: {
          "content-type": "application/json",
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      throw new NodePostgresRevisionConflictError(body?.revision);
    }
    if (!response.ok) {
      throw await responseError(response, "Plugin toggle failed");
    }
    const body: { revision?: number } = await response.json();
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
    if (!(await this.ensureEnabled())) {
      return null;
    }
    let cached: {
      hash: string;
      pluginCustomStorage: Record<string, any>;
    } | null = this.memoryPluginStorageCache;
    if (!cached) {
      try {
        cached = await this.pluginStorageCacheForage.getItem("cache");
      } catch {
        cached = null;
      }
    }

    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-plugin-storage-${cached.hash}"`;
    }

    const response = await fetch("/api/database-v2/plugin-custom-storage", {
      method: "GET",
      cache: "no-cache",
      headers,
    });

    if (response.status === 304 && cached) {
      this.memoryPluginStorageCache = cached;
      return cached.pluginCustomStorage ?? {};
    }

    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL plugin custom storage load failed",
      );
    }

    const body: { pluginCustomStorage: Record<string, any>; hash: string } =
      await response.json();
    const entry = {
      hash: body.hash,
      pluginCustomStorage: body.pluginCustomStorage ?? {},
    };
    this.memoryPluginStorageCache = entry;
    try {
      await this.pluginStorageCacheForage.setItem("cache", entry);
    } catch {}
    return body.pluginCustomStorage ?? {};
  }

  private pluginKeyCacheForage = localforage.createInstance({
    name: "risuaiPostgresPluginKeyStorage",
  });
  private memoryPluginKeyCache = new BoundedCache<
    string,
    { hash: string; value: any }
  >({ maxEntries: 64 });

  async listPluginCustomStorageKeys(): Promise<string[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const response = await fetch(
      "/api/database-v2/plugin-custom-storage/keys",
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return [];
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL list plugin custom storage keys failed",
      );
    }
    const body: { keys: string[] } = await response.json();
    return body.keys ?? [];
  }

  async loadPluginCustomStorageKey(key: string): Promise<any> {
    if (!(await this.ensureEnabled())) {
      return undefined;
    }
    let cached = this.memoryPluginKeyCache.get(key);
    if (!cached) {
      try {
        cached = (await this.pluginKeyCacheForage.getItem(key)) ?? undefined;
      } catch {
        cached = undefined;
      }
    }

    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-plugin-key-${cached.hash}"`;
    }

    const response = await fetch(
      `/api/database-v2/plugin-custom-storage/keys/${encodeURIComponent(key)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers,
      },
    );

    if (response.status === 304 && cached) {
      return cached.value;
    }
    if (response.status === 404) {
      return undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        `PostgreSQL plugin custom storage key '${key}' load failed`,
      );
    }

    const body: { key: string; value: any; hash: string } =
      await response.json();
    const entry = {
      hash: body.hash,
      value: body.value,
    };
    this.memoryPluginKeyCache.set(key, entry);
    try {
      await this.pluginKeyCacheForage.setItem(key, entry);
    } catch {}
    return body.value;
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-personas-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/personas", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.personas ?? [];
    }
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL personas load failed");
    }
    const body: { personas: RisuPersona[]; hash: string } =
      await response.json();
    const entry = { hash: body.hash, personas: body.personas ?? [] };
    this.memoryPersonasCache = entry;
    try {
      await this.personasCacheForage.setItem("cache", entry);
    } catch {}
    return body.personas ?? [];
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-presets-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/presets", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.presets ?? [];
    }
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL bot presets load failed");
    }
    const body: { presets: BotPresetSummary[]; hash: string } =
      await response.json();
    const entry = { hash: body.hash, presets: body.presets ?? [] };
    this.memoryBotPresetsCache = entry;
    try {
      await this.botPresetsCacheForage.setItem("cache", entry);
    } catch {}
    return body.presets ?? [];
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash)
      headers["If-None-Match"] = `"risu-preset-${id}-${cached.hash}"`;
    const response = await fetch(
      `/api/database-v2/presets/${encodeURIComponent(id)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers,
      },
    );
    if (response.status === 304 && cached) return cached.preset;
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300)
      throw await responseError(response, "Bot preset load failed");
    const body: { preset: StoredBotPreset; hash: string } =
      await response.json();
    const entry = { hash: body.hash, preset: body.preset };
    this.memoryBotPresetCache.set(id, entry);
    void this.botPresetsCacheForage
      .setItem(`preset:${id}`, entry)
      .catch(() => {});
    return body.preset;
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-lorebooks-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/lorebooks", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.loreBook ?? [];
    }
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL global lorebooks load failed",
      );
    }
    const body: {
      loreBook: { name: string; data: loreBook[] }[];
      hash: string;
    } = await response.json();
    const entry = { hash: body.hash, loreBook: body.loreBook ?? [] };
    this.memoryLoreBookCache = entry;
    try {
      await this.loreBookCacheForage.setItem("cache", entry);
    } catch {}
    return body.loreBook ?? [];
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-modules-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/modules", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.modules ?? [];
    }
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL modules load failed");
    }
    const body: { modules: RisuModule[]; hash: string } = await response.json();
    const entry = { hash: body.hash, modules: body.modules ?? [] };
    this.memoryModulesCache = entry;
    try {
      await this.modulesCacheForage.setItem("cache", entry);
    } catch {}
    return body.modules ?? [];
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-prompts-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/prompts", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.prompts ?? {};
    }
    if (response.status === 404) return {};
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL prompts load failed");
    }
    const body: { prompts: Record<string, any>; hash: string } =
      await response.json();
    const entry = { hash: body.hash, prompts: body.prompts ?? {} };
    this.memoryPromptsCache = entry;
    try {
      await this.promptsCacheForage.setItem("cache", entry);
    } catch {}
    return body.prompts ?? {};
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
    const headers: Record<string, string> = await this.authHeaders();
    if (cached?.hash) {
      headers["If-None-Match"] = `"risu-scripts-${cached.hash}"`;
    }
    const response = await fetch("/api/database-v2/scripts", {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (response.status === 304 && cached) {
      return cached.globalscript ?? [];
    }
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL scripts load failed");
    }
    const body: { globalscript: customscript[]; hash: string } =
      await response.json();
    const entry = { hash: body.hash, globalscript: body.globalscript ?? [] };
    this.memoryScriptsCache = entry;
    try {
      await this.scriptsCacheForage.setItem("cache", entry);
    } catch {}
    return body.globalscript ?? [];
  }

  async loadSettingKey(key: string): Promise<any> {
    if (!(await this.ensureEnabled())) return undefined;
    const headers: Record<string, string> = await this.authHeaders();
    const response = await fetch(
      `/api/database-v2/settings/${encodeURIComponent(key)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers,
      },
    );
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        `PostgreSQL load setting key '${key}' failed`,
      );
    }
    const body: { key: string; value: any; hash: string } =
      await response.json();
    return body.value;
  }

  async loadStartupData(): Promise<SqlStartupDataResult | null> {
    const response = await fetch("/api/database-v2/startup", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status === 404) {
      this.status = "disabled";
      return null;
    }
    if (!response.ok) {
      throw await responseError(response, "SQL startup data load failed");
    }
    const body = (await response.json()) as SqlStartupDataResult;
    this.status = "enabled";
    this.revision = body.revision;
    return body;
  }

  async exportDatabaseSnapshot(): Promise<SqlDatabaseSnapshotResult | null> {
    if (!(await this.ensureEnabled())) return null;
    const response = await fetch("/api/database-v2/export", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        "SQL database snapshot export failed",
      );
    }
    const body = (await response.json()) as SqlDatabaseSnapshotResult;
    this.revision = body.revision;
    return body;
  }

  async loadCharacter(
    characterId: string,
  ): Promise<character | groupChat | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const response = await fetch(
      `/api/database-v2/characters/${encodeURIComponent(characterId)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL character load failed");
    }
    const body: { character: character | groupChat } = await response.json();
    return body.character ?? null;
  }

  /**
   * Reads only the asset-bearing fields of a character (image, emotionImages,
   * additionalAssets, ccAssets, customBackground, vits…). Used by the storage
   * explorer's orphan-asset analysis so unhydrated characters still count as
   * referencing their assets.
   */
  async loadCharacterAssetFields(
    characterId: string,
  ): Promise<Partial<character> | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const response = await fetch(
      `/api/database-v2/characters/${encodeURIComponent(characterId)}/asset-fields`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL character asset fields load failed",
      );
    }
    const body: { assets: Partial<character> } = await response.json();
    return body.assets ?? null;
  }

  async loadChat(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<Chat | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const search =
      options?.messageLimit !== undefined
        ? `?messageLimit=${encodeURIComponent(options.messageLimit)}`
        : "";
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}${search}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL chat load failed");
    }
    const body: { chat: Chat } = await response.json();
    return body.chat ?? null;
  }

  async loadChatMessages(
    chatId: string,
    options: { mode?: "full" | "generation" } = {},
  ): Promise<Message[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const mode = options.mode === "generation" ? "?mode=generation" : "";
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/messages${mode}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return [];
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL chat messages load failed",
      );
    }
    const body: { messages?: Message[] } = await response.json();
    return body.messages ?? [];
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ) {
    if (!(await this.ensureEnabled()))
      return { messages: [], offset: 0, total: 0, hasMore: false };
    const params = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) params.set("before", String(before));
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/messages?${params}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL chat message page load failed",
      );
    }
    return await response.json();
  }

  async listChatBranches(chatId: string): Promise<SqlChatBranchSummary[]> {
    if (!(await this.ensureEnabled())) return [];
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "SQL chat branch list failed");
    }
    const body: { branches?: SqlChatBranchSummary[] } = await response.json();
    return body.branches ?? [];
  }

  async loadChatBranchGraph(chatId: string): Promise<SqlChatBranchGraphData> {
    if (!(await this.ensureEnabled())) {
      return { branches: [], messages: [], links: [] };
    }
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/graph`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "SQL chat branch graph load failed");
    }
    const body: { graph?: SqlChatBranchGraphData } = await response.json();
    return body.graph ?? { branches: [], messages: [], links: [] };
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
    const params = new URLSearchParams();
    if (options.messageLimit !== undefined) {
      params.set("limit", String(options.messageLimit));
    }
    if (options.mode === "generation" || options.mode === "graph") {
      params.set("mode", options.mode);
    }
    const search = params.size > 0 ? `?${params}` : "";
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/${encodeURIComponent(branchId)}/messages${search}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "SQL chat branch messages load failed",
      );
    }
    const body: { messages?: Message[] } = await response.json();
    return body.messages ?? [];
  }

  async createChatBranch(
    input: SqlCreateChatBranchInput,
  ): Promise<SqlChatBranchSummary> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(input.chatId)}/branches`,
      {
        method: "POST",
        cache: "no-cache",
        headers: {
          ...(await this.authHeaders()),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: input.id,
          parentBranchId: input.parentBranchId,
          forkMessageId: input.forkMessageId,
          reason: input.reason,
          createdAt: input.createdAt,
        }),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "SQL chat branch creation failed");
    }
    const body: { branch: SqlChatBranchSummary } = await response.json();
    return body.branch;
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }
    const response = await fetch(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/${encodeURIComponent(branchId)}/activate`,
      {
        method: "POST",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "SQL chat branch activation failed");
    }
  }

  async listRecentChats(limit?: number): Promise<SqlRecentChatMetadata[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const url =
      limit !== undefined && limit !== null && limit > 0
        ? `/api/database-v2/recent-chats?limit=${encodeURIComponent(limit)}`
        : "/api/database-v2/recent-chats";
    const response = await fetch(url, {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status === 404) {
      return [];
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL recent chats load failed",
      );
    }
    const body: { chats: SqlRecentChatMetadata[] } = await response.json();
    return body.chats ?? [];
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const url =
      limit !== undefined && limit !== null && limit > 0
        ? `/api/database-v2/revisions?limit=${encodeURIComponent(limit)}`
        : "/api/database-v2/revisions";
    const response = await fetch(url, {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL revision history load failed",
      );
    }
    const body: { revisions: NodePostgresRevision[] } = await response.json();
    return body.revisions;
  }

  async getRevisionDetails(
    revisionId: number,
  ): Promise<NodePostgresRevisionDetails | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const response = await fetch(
      `/api/database-v2/revisions/${encodeURIComponent(revisionId)}/details`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL revision details load failed",
      );
    }
    const body: { details: NodePostgresRevisionDetails } =
      await response.json();
    return body.details;
  }

  async getRevisionDiff(
    baseId: number,
    targetId: number,
  ): Promise<NodePostgresRevisionDiff | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const response = await fetch(
      `/api/database-v2/revisions/diff?base=${encodeURIComponent(baseId)}&target=${encodeURIComponent(targetId)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL revision diff load failed",
      );
    }
    const body: { diff: NodePostgresRevisionDiff } = await response.json();
    return body.diff;
  }

  async previewRestoreRevision(
    revisionId: number,
  ): Promise<NodePostgresRestorePreview | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const encodedBody = await encodeJsonBody({ revisionId });
    const response = await fetch("/api/database-v2/revisions/preview-restore", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL revision preview restore failed",
      );
    }
    const body: { preview: NodePostgresRestorePreview } = await response.json();
    return body.preview;
  }

  async restoreRevision(
    revisionId: number,
  ): Promise<{ revision: number; revisionId: number }> {
    if (!(await this.ensureEnabled())) {
      throw new Error("PostgreSQL storage is disabled");
    }
    const encodedBody = await encodeJsonBody({ revisionId });
    const response = await fetch("/api/database-v2/revisions/restore", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL revision restore failed");
    }
    const result: { revision: number; revisionId: number } =
      await response.json();
    this.revision = result.revision;
    return result;
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    if (!(await this.ensureEnabled())) {
      return null;
    }
    const response = await fetch(
      `/api/database-v2/cold-storage/${encodeURIComponent(key)}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL cold storage load failed",
      );
    }
    const body: { data: unknown } = await response.json();
    return body.data;
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    if (!(await this.ensureEnabled())) {
      return { items: [] };
    }
    const response = await fetch("/api/database-v2/cold-storage", {
      method: "GET",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL cold storage list failed",
      );
    }
    const body: { items: { key: string }[] } = await response.json();
    return {
      items: body.items.map((item) => item.key),
    };
  }

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    if (!(await this.ensureEnabled())) {
      return false;
    }
    const encodedBody = await encodeJsonBody({ data: value });
    const response = await fetch(
      `/api/database-v2/cold-storage/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: encodedBody.body,
        headers: {
          "content-type": "application/json",
          ...(encodedBody.contentEncoding
            ? { "content-encoding": encodedBody.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL cold storage save failed",
      );
    }
    return true;
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    if (!(await this.ensureEnabled()) || keys.length === 0) {
      return 0;
    }
    const encodedBody = await encodeJsonBody({ keys });
    const response = await fetch("/api/database-v2/cold-storage", {
      method: "DELETE",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL cold storage delete failed",
      );
    }
    const body: { deleted: number } = await response.json();
    return body.deleted;
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    if (!(await this.ensureEnabled())) {
      return 0;
    }
    const encodedBody = await encodeJsonBody({ retainedKeys });
    const response = await fetch("/api/database-v2/cold-storage/prune", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL cold storage cleanup failed",
      );
    }
    const body: { deleted: number } = await response.json();
    return body.deleted;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    if (!(await this.ensureEnabled())) {
      throw new Error("SQL storage is not enabled");
    }

    let pending: SqlCommit = {
      ...commit,
      baseRevision: Math.max(commit.baseRevision, this.revision),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const encodedBody = await encodeJsonBody(pending);
      const response = await fetch("/api/database-v2/commit", {
        method: "POST",
        body: encodedBody.body,
        headers: {
          "content-type": "application/json",
          ...(encodedBody.contentEncoding
            ? { "content-encoding": encodedBody.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null);
        const currentRevision = Number(conflict?.revision);
        if (Number.isSafeInteger(currentRevision) && attempt < 2) {
          this.applyRemoteRevision(currentRevision);
          pending = { ...pending, baseRevision: currentRevision };
          continue;
        }
        throw new NodePostgresRevisionConflictError(conflict?.revision);
      }
      if (response.status === 413) {
        const body = await response.json().catch(() => null);
        throw new NodePostgresPayloadTooLargeError(body?.error);
      }
      if (response.status < 200 || response.status >= 300) {
        throw await responseError(response, "SQL commit failed");
      }
      const result = (await response.json()) as SqlCommitResult;
      this.revision = result.revision;
      return result;
    }
    throw new NodePostgresRevisionConflictError(this.revision);
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
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const params = new URLSearchParams({
      q: query,
      scope,
      limit: String(limit),
    });
    const response = await fetch(
      `/api/database-v2/search?${params.toString()}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL message search failed");
    }
    const body: { results: NodePostgresMessageSearchResult[] } =
      await response.json();
    return body.results;
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const response = await fetch("/api/database-v2/token-usage", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL token usage load failed");
    }
    const body: { usage: NodePostgresTokenUsage[] } = await response.json();
    return body.usage;
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const response = await fetch("/api/database-v2/bot-stats", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL bot stats load failed");
    }
    const body: { stats: NodePostgresBotChatStats[] } = await response.json();
    return body.stats;
  }

  async searchCharactersByTag(
    tag: string,
    limit = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const params = new URLSearchParams({ tag, limit: String(limit) });
    const response = await fetch(
      `/api/database-v2/characters/search?${params.toString()}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL character tag search failed",
      );
    }
    const body: { results: NodePostgresCharacterSearchResult[] } =
      await response.json();
    return body.results;
  }

  async searchCharactersByName(
    name: string,
    limit = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const params = new URLSearchParams({ name, limit: String(limit) });
    const response = await fetch(
      `/api/database-v2/characters/search?${params.toString()}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "PostgreSQL character name search failed",
      );
    }
    const body: { results: NodePostgresCharacterSearchResult[] } =
      await response.json();
    return body.results;
  }

  async listDbTables(): Promise<NodePostgresTableInfo[]> {
    if (!(await this.ensureEnabled())) {
      return [];
    }
    const response = await fetch("/api/database-v2/tables", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status === 404) {
      this.status = "disabled";
      return [];
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL table list load failed");
    }
    const body: { tables: NodePostgresTableInfo[] } = await response.json();
    return body.tables;
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
    const params = new URLSearchParams({
      offset: String(options.offset ?? 0),
      limit: String(options.limit ?? 50),
    });
    if (options.sortColumn) {
      params.set("sort", options.sortColumn);
    }
    if (options.sortOrder) {
      params.set("dir", options.sortOrder);
    }
    if (options.search && options.search.length > 0) {
      params.set("search", options.search);
    }
    if (options.columns && options.columns.length > 0) {
      params.set("columns", options.columns.join(","));
    }
    const response = await fetch(
      `/api/database-v2/tables/${encodeURIComponent(table)}/rows?${params.toString()}`,
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status === 404) {
      this.status = "disabled";
      throw new Error("PostgreSQL storage is disabled");
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL table data load failed");
    }
    const body: { data: NodePostgresTableData } = await response.json();
    return body.data;
  }

  // ── 백업 데이터베이스 API ──

  /**
   * 백업 DB 설정 + 실시간 상태 조회 (revision lag, 마지막 미러/스냅샷 시점).
   * /api/db-backup GET 대응.
   */
  async getBackupStatus(): Promise<NodeBackupConfig> {
    const response = await fetch("/api/db-backup", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Backup database status load failed");
    }
    return await response.json();
  }

  /**
   * 백업 DB 연결 테스트 (실제 저장소 생성 없이 연결만 확인).
   * /api/db-backup/test POST 대응.
   */
  async testBackupConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    const encodedBody = await encodeJsonBody({ vendor, params });
    const response = await fetch("/api/db-backup/test", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "Backup database connection test failed",
      );
    }
    return await response.json();
  }

  /**
   * 백업 DB 설정 적용 + 초기화 + 최초 전체 백업 트리거.
   * /api/db-backup POST 대응.
   */
  async configureBackup(
    update: NodeBackupConfigUpdate,
  ): Promise<NodeBackupConfig> {
    const encodedBody = await encodeJsonBody(update);
    const response = await fetch("/api/db-backup", {
      method: "POST",
      body: encodedBody.body,
      headers: {
        "content-type": "application/json",
        ...(encodedBody.contentEncoding
          ? { "content-encoding": encodedBody.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "Backup database configuration failed",
      );
    }
    return await response.json();
  }

  /**
   * 수동 전체 백업: 메인 DB 전체를 백업 DB에 replaceAll 적요 (실시간 진행상황 콜백 지원).
   * /api/db-backup/resync POST 대응.
   */
  async resyncBackup(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    const response = await fetch("/api/db-backup/resync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || "Backup full sync failed");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return await response.json();
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: NodeBackupFullSyncResult = { success: true };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "progress") {
            onProgress?.(parsed);
          } else if (parsed.type === "done") {
            finalResult = {
              success: parsed.success !== false,
              lastFullSyncAt: parsed.lastFullSyncAt,
              settingsCount: parsed.settingsCount,
              charactersCount: parsed.charactersCount,
              chatsCount: parsed.chatsCount,
              messagesCount: parsed.messagesCount,
              revision: parsed.revision,
              changed: parsed.changed,
            };
          } else if (parsed.type === "error") {
            throw new Error(parsed.error || "Backup full sync failed");
          }
        } catch (err: any) {
          if (err?.message && !err.message.includes("JSON")) {
            throw err;
          }
        }
      }
    }

    return finalResult;
  }

  /**
   * 백업 DB에서 데이터를 읽어와 메인 DB로 복원 (덮어쓰기).
   * /api/db-backup/restore POST 대응.
   */
  async restoreFromBackup(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    const response = await fetch("/api/db-backup/restore", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || "Backup restore failed");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return await response.json();
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: NodeBackupFullSyncResult = { success: true };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "progress") {
            onProgress?.(parsed);
          } else if (parsed.type === "done") {
            finalResult = {
              success: parsed.success !== false,
              lastFullSyncAt: parsed.lastFullSyncAt,
              settingsCount: parsed.settingsCount,
              charactersCount: parsed.charactersCount,
              chatsCount: parsed.chatsCount,
              messagesCount: parsed.messagesCount,
              revision: parsed.revision,
              changed: parsed.changed,
            };
          } else if (parsed.type === "error") {
            throw new Error(parsed.error || "Backup restore failed");
          }
        } catch (err: any) {
          if (err?.message && !err.message.includes("JSON")) {
            throw err;
          }
        }
      }
    }

    return finalResult;
  }

  /**
   * 백업 DB 설정 해제 (풀 close + 설정 제거).
   * /api/db-backup DELETE 대응.
   */
  async removeBackup(): Promise<NodeBackupConfig> {
    const response = await fetch("/api/db-backup", {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Backup database removal failed");
    }
    return await response.json();
  }
}
