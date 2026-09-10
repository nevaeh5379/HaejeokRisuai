import type { DbVendor } from "@risuai/protocol/storageConfig.cjs";
import type {
  NodeBackupConfig,
  NodeBackupConfigUpdate,
  NodeBackupProgressEvent,
  NodeBackupFullSyncResult,
} from "@risuai/protocol/databaseApi.cjs";
import type { NodeApiClient } from "./nodeApiClient";

export class RemoteDatabaseBackupClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
    private readonly clientId: string,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      "risu-auth": await this.getAuth(),
      "x-risu-client-id": this.clientId,
    };
  }

  private async jsonBody(payload: unknown): Promise<{
    body: BodyInit;
    contentEncoding?: string;
  }> {
    const json = JSON.stringify(payload);
    if (json.length < 64 * 1024 || typeof CompressionStream === "undefined") {
      return { body: json };
    }
    const compressed = new Blob([json])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return {
      body: await new Response(compressed).arrayBuffer(),
      contentEncoding: "gzip",
    };
  }

  private async error(response: Response, fallback: string): Promise<Error> {
    const body = await response.json().catch(() => null);
    return new Error(body?.error || `${fallback} (${response.status})`);
  }

  async getStatus(): Promise<NodeBackupConfig> {
    const response = await this.apiClient.request("/api/db-backup", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "Backup database status load failed");
    }
    return await response.json();
  }

  async testConnection(
    vendor: DbVendor,
    params: Record<string, any>,
  ): Promise<{ success: boolean; error?: string }> {
    const encoded = await this.jsonBody({ vendor, params });
    const response = await this.apiClient.request("/api/db-backup/test", {
      method: "POST",
      body: encoded.body,
      headers: {
        "content-type": "application/json",
        ...(encoded.contentEncoding
          ? { "content-encoding": encoded.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        "Backup database connection test failed",
      );
    }
    return await response.json();
  }

  async configure(update: NodeBackupConfigUpdate): Promise<NodeBackupConfig> {
    const encoded = await this.jsonBody(update);
    const response = await this.apiClient.request("/api/db-backup", {
      method: "POST",
      body: encoded.body,
      headers: {
        "content-type": "application/json",
        ...(encoded.contentEncoding
          ? { "content-encoding": encoded.contentEncoding }
          : {}),
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "Backup database configuration failed");
    }
    return await response.json();
  }

  private async runStreamingOperation(
    endpoint: string,
    fallback: string,
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    const response = await this.apiClient.request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || fallback);
    }
    const reader = response.body?.getReader();
    if (!reader) return await response.json();

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
            throw new Error(parsed.error || fallback);
          }
        } catch (error: any) {
          if (error?.message && !error.message.includes("JSON")) throw error;
        }
      }
    }
    return finalResult;
  }

  async resync(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    return await this.runStreamingOperation(
      "/api/db-backup/resync",
      "Backup full sync failed",
      onProgress,
    );
  }

  async restore(
    onProgress?: (event: NodeBackupProgressEvent) => void,
  ): Promise<NodeBackupFullSyncResult> {
    return await this.runStreamingOperation(
      "/api/db-backup/restore",
      "Backup restore failed",
      onProgress,
    );
  }

  async remove(): Promise<NodeBackupConfig> {
    const response = await this.apiClient.request("/api/db-backup", {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "Backup database removal failed");
    }
    return await response.json();
  }
}
