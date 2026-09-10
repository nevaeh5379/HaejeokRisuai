import type {
  DbVendor,
  NodePostgresServerConfig,
  NodePostgresServerConfigUpdate,
} from "@risuai/protocol/storageConfig.cjs";
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
}
