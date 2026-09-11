import type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
} from "@risuai/protocol/storageConfig.cjs";
import type {
  NodePostgresRevision,
  NodePostgresRevisionDetails,
  NodePostgresRevisionDiff,
  NodePostgresRestorePreview,
  NodePostgresMessageSearchResult,
  NodePostgresTokenUsage,
  NodePostgresBotChatStats,
  NodePostgresCharacterSearchResult,
  NodePostgresTableInfo,
  NodePostgresTableData,
} from "@risuai/protocol/databaseApi.cjs";
import type { NodeApiClient } from "./nodeApiClient";

export type RemoteDatabaseConfig = NodePostgresServerConfig & {
  params: Record<string, any>;
  storedVendor: DbVendor | null;
};

export type RemoteDatabaseAuthProvider = () => Promise<string>;

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

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || `${fallback} (${response.status})`);
}

export class RemoteDatabaseAdminClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: RemoteDatabaseAuthProvider,
    private readonly clientId: string,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      "risu-auth": await this.getAuth(),
      "x-risu-client-id": this.clientId,
    };
  }

  async getPostgresConfig(): Promise<NodePostgresServerConfig> {
    const response = await this.apiClient.request("/api/postgres-config", {
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
    return await response.json();
  }

  async configurePostgres(
    update: NodePostgresServerConfigUpdate,
  ): Promise<NodePostgresServerConfig> {
    const encodedBody = await encodeJsonBody(update);
    const response = await this.apiClient.request("/api/postgres-config", {
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
    return await response.json();
  }

  async getDatabaseConfig(): Promise<RemoteDatabaseConfig> {
    const response = await this.apiClient.request("/api/db-config", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB configuration load failed");
    }
    return await response.json();
  }

  async applyDatabaseConfig(
    vendor: DbVendor,
    params: Record<string, any>,
    migrate = false,
  ): Promise<RemoteDatabaseConfig> {
    const encodedBody = await encodeJsonBody({ vendor, params, migrate });
    const response = await this.apiClient.request("/api/db-config", {
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
    return await response.json();
  }

  async retryDatabaseConnection(): Promise<RemoteDatabaseConfig> {
    const response = await this.apiClient.request("/api/db-config/retry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "DB reconnection failed");
    }
    return await response.json();
  }

  async testConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    const encodedBody = await encodeJsonBody({ vendor, params });
    const response = await this.apiClient.request("/api/db-config/test", {
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

  async migrateLegacyData(): Promise<{
    success: boolean;
    migrated: number;
    skipped: number;
  }> {
    const response = await this.apiClient.request(
      "/api/database-v2/migrate-legacy",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Legacy migration failed");
    }
    return await response.json();
  }

  async listRevisions(limit?: number): Promise<NodePostgresRevision[]> {
    const url =
      limit !== undefined && limit !== null && limit > 0
        ? `/api/database-v2/revisions?limit=${encodeURIComponent(limit)}`
        : "/api/database-v2/revisions";
    const response = await this.apiClient.request(url, {
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
    const response = await this.apiClient.request(
      `/api/database-v2/revisions/${encodeURIComponent(revisionId)}/details`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
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
  ): Promise<NodePostgresRevisionDiff> {
    const response = await this.apiClient.request(
      `/api/database-v2/revisions/diff?base=${encodeURIComponent(baseId)}&target=${encodeURIComponent(targetId)}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
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
  ): Promise<NodePostgresRestorePreview> {
    const encodedBody = await encodeJsonBody({ revisionId });
    const response = await this.apiClient.request(
      "/api/database-v2/revisions/preview-restore",
      {
        method: "POST",
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
        "PostgreSQL revision preview restore failed",
      );
    }
    const body: { preview: NodePostgresRestorePreview } = await response.json();
    return body.preview;
  }

  async restoreRevision(
    revisionId: number,
  ): Promise<{ revision: number; revisionId: number }> {
    const encodedBody = await encodeJsonBody({ revisionId });
    const response = await this.apiClient.request(
      "/api/database-v2/revisions/restore",
      {
        method: "POST",
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
      throw await responseError(response, "PostgreSQL revision restore failed");
    }
    return await response.json();
  }

  async searchMessages(
    query: string,
    scope: "all" | "active" | "cold" = "all",
    limit = 50,
  ): Promise<NodePostgresMessageSearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      scope,
      limit: String(limit),
    });
    const response = await this.apiClient.request(
      `/api/database-v2/search?${params.toString()}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL message search failed");
    }
    const body: { results: NodePostgresMessageSearchResult[] } =
      await response.json();
    return body.results;
  }

  async getTokenUsage(): Promise<NodePostgresTokenUsage[]> {
    const response = await this.apiClient.request(
      "/api/database-v2/token-usage",
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL token usage load failed");
    }
    const body: { usage: NodePostgresTokenUsage[] } = await response.json();
    return body.usage;
  }

  async getBotChatStats(): Promise<NodePostgresBotChatStats[]> {
    const response = await this.apiClient.request(
      "/api/database-v2/bot-stats",
      {
        method: "GET",
        cache: "no-cache",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL bot stats load failed");
    }
    const body: { stats: NodePostgresBotChatStats[] } = await response.json();
    return body.stats;
  }

  async searchCharacters(
    field: "tag" | "name",
    value: string,
    limit = 100,
  ): Promise<NodePostgresCharacterSearchResult[]> {
    const params = new URLSearchParams({
      [field]: value,
      limit: String(limit),
    });
    const response = await this.apiClient.request(
      `/api/database-v2/characters/search?${params.toString()}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        `PostgreSQL character ${field} search failed`,
      );
    }
    const body: { results: NodePostgresCharacterSearchResult[] } =
      await response.json();
    return body.results;
  }

  async listDbTables(): Promise<NodePostgresTableInfo[] | null> {
    const response = await this.apiClient.request("/api/database-v2/tables", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status === 404) return null;
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
  ): Promise<NodePostgresTableData | null> {
    const params = new URLSearchParams({
      offset: String(options.offset ?? 0),
      limit: String(options.limit ?? 50),
    });
    if (options.sortColumn) params.set("sort", options.sortColumn);
    if (options.sortOrder) params.set("dir", options.sortOrder);
    if (options.search) params.set("search", options.search);
    if (options.columns?.length)
      params.set("columns", options.columns.join(","));
    const response = await this.apiClient.request(
      `/api/database-v2/tables/${encodeURIComponent(table)}/rows?${params.toString()}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "PostgreSQL table data load failed");
    }
    const body: { data: NodePostgresTableData } = await response.json();
    return body.data;
  }
}
