import type {
  AssetStorageTarget,
  AssetStorageType,
  NodeS3MigrationResult,
  NodeS3ProgressEvent,
  NodeS3RollbackResult,
  NodeS3ServerConfig,
  NodeS3ServerConfigUpdate,
  NodeS3Stats,
  NodeS3TestResult,
  NodeS3ThumbnailsResult,
  NodeStorageAssetDetails,
  NodeStorageAssetItem,
  NodeStorageSummary,
} from "../../../../packages/protocol/storageConfig.cjs";
export type {
  AssetStorageTarget,
  AssetStorageType,
  NodeS3MigrationResult,
  NodeS3ProgressEvent,
  NodeS3RollbackResult,
  NodeS3ServerConfig,
  NodeS3ServerConfigUpdate,
  NodeS3Stats,
  NodeS3TestResult,
  NodeS3ThumbnailsResult,
  NodeStorageAssetDetails,
  NodeStorageAssetItem,
  NodeStorageSummary,
} from "../../../../packages/protocol/storageConfig.cjs";

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || `${fallback} (${response.status})`);
}

export class NodeS3Storage {
  constructor(private readonly getAuth: () => Promise<string>) {}

  private async authHeaders() {
    return {
      "risu-auth": await this.getAuth(),
    };
  }

  async getServerConfig(): Promise<NodeS3ServerConfig> {
    const response = await fetch("/api/s3-config", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "S3 storage configuration load failed",
      );
    }
    return await response.json();
  }

  async configureServer(
    update: NodeS3ServerConfigUpdate,
  ): Promise<NodeS3ServerConfig> {
    const response = await fetch("/api/s3-config", {
      method: "POST",
      body: JSON.stringify(update),
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(
        response,
        "S3 storage configuration update failed",
      );
    }
    const data = await response.json();
    return data.config;
  }

  async testConnection(
    config: NodeS3ServerConfigUpdate,
  ): Promise<NodeS3TestResult> {
    const response = await fetch("/api/s3-test", {
      method: "POST",
      body: JSON.stringify(config),
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const body = await response.json().catch(() => null);
      return {
        success: false,
        bucketExists: false,
        message:
          body?.message ||
          body?.error ||
          `Connection test failed (${response.status})`,
      };
    }
    return await response.json();
  }

  async getStats(): Promise<NodeS3Stats> {
    const response = await fetch("/api/s3-stats", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to fetch storage stats");
    }
    return await response.json();
  }

  async migrateLocalToS3(
    onProgress?: (event: NodeS3ProgressEvent) => void,
  ): Promise<NodeS3MigrationResult> {
    const response = await fetch("/api/s3-migrate", {
      method: "POST",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Local to S3 migration failed");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return await response.json();
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: NodeS3MigrationResult = {
      total: 0,
      migrated: 0,
      skipped: 0,
      errors: [],
    };

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
              total: parsed.total,
              migrated: parsed.migrated,
              skipped: parsed.skipped,
              errors: parsed.errors || [],
            };
          } else if (parsed.type === "error") {
            throw new Error(parsed.error);
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

  async rollbackS3ToLocal(
    onProgress?: (event: NodeS3ProgressEvent) => void,
  ): Promise<NodeS3RollbackResult> {
    const response = await fetch("/api/s3-rollback", {
      method: "POST",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "S3 to local rollback failed");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return await response.json();
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: NodeS3RollbackResult = {
      total: 0,
      downloaded: 0,
      errors: [],
    };

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
              total: parsed.total,
              downloaded: parsed.downloaded,
              errors: parsed.errors || [],
            };
          } else if (parsed.type === "error") {
            throw new Error(parsed.error);
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

  async generateMissingThumbnails(
    onProgress?: (event: NodeS3ProgressEvent) => void,
  ): Promise<NodeS3ThumbnailsResult> {
    const response = await fetch("/api/s3-generate-thumbnails", {
      method: "POST",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "S3 thumbnail generation failed");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return await response.json();
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: NodeS3ThumbnailsResult = {
      total: 0,
      created: 0,
      skipped: 0,
      errors: [],
    };

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
              total: parsed.total,
              created: parsed.created,
              skipped: parsed.skipped,
              errors: parsed.errors || [],
            };
          } else if (parsed.type === "error") {
            throw new Error(parsed.error);
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

  async getStorageSummary(): Promise<NodeStorageSummary> {
    const response = await fetch("/api/storage-summary", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to fetch storage summary");
    }
    return await response.json();
  }

  async getAssetDetails(
    target: AssetStorageTarget = "active",
  ): Promise<NodeStorageAssetDetails> {
    const url =
      target === "active"
        ? "/api/s3-asset-details"
        : `/api/s3-asset-details?target=${target}`;
    const response = await fetch(url, {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to fetch asset details");
    }
    return await response.json();
  }

  async deleteAssetKeys(
    keys: string[],
    target: AssetStorageTarget = "active",
  ): Promise<{ deleted: number }> {
    const response = await fetch("/api/storage-assets-delete", {
      method: "POST",
      body: JSON.stringify({ keys, target }),
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to delete assets");
    }
    return await response.json();
  }

  async cleanLocalFs(): Promise<{ deleted: number; freedBytes: number }> {
    const response = await fetch("/api/storage-local-clean", {
      method: "POST",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to clean local storage");
    }
    return await response.json();
  }

  async resyncAssetCatalog(): Promise<{
    success: boolean;
    count: number;
    source: string;
  }> {
    const response = await fetch("/api/asset-catalog/resync", {
      method: "POST",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Failed to resync asset catalog");
    }
    return await response.json();
  }
}
