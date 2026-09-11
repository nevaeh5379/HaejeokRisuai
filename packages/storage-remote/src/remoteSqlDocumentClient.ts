import type { NodeApiClient } from "./nodeApiClient";

export type RemoteCachedDocument<T> =
  | { status: "not-modified" }
  | { status: "missing" }
  | { status: "ok"; body: T };

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(body?.error || `${fallback} (${response.status})`);
}

export class RemoteSqlDocumentClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
    private readonly clientId: string,
  ) {}

  private async headers(etag?: string): Promise<Record<string, string>> {
    return {
      "risu-auth": await this.getAuth(),
      "x-risu-client-id": this.clientId,
      ...(etag ? { "If-None-Match": etag } : {}),
    };
  }

  private async getCached<T>(
    path: string,
    etag: string | undefined,
    fallback: string,
  ): Promise<RemoteCachedDocument<T>> {
    const response = await this.apiClient.request(path, {
      method: "GET",
      cache: "no-cache",
      headers: await this.headers(etag),
    });
    if (response.status === 304) return { status: "not-modified" };
    if (response.status === 404) return { status: "missing" };
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, fallback);
    }
    return { status: "ok", body: (await response.json()) as T };
  }

  loadPlugins(enabledOnly: boolean, hash?: string) {
    return this.getCached<{ plugins: unknown[]; hash: string }>(
      `/api/database-v2/plugins${enabledOnly ? "?enabledOnly=1" : ""}`,
      hash
        ? `"risu-plugins-${enabledOnly ? "runtime-" : ""}${hash}"`
        : undefined,
      "PostgreSQL plugins load failed",
    );
  }

  async setPluginEnabled(
    pluginName: string,
    enabled: boolean,
    baseRevision: number,
  ): Promise<{ revision?: number }> {
    const response = await this.apiClient.request(
      `/api/database-v2/plugins/${encodeURIComponent(pluginName)}/enabled`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled, baseRevision }),
        headers: {
          ...(await this.headers()),
          "content-type": "application/json",
        },
      },
    );
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      const error = new Error("SQL revision conflict") as Error & {
        revision?: unknown;
      };
      error.revision = body?.revision;
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      throw await responseError(response, "Plugin toggle failed");
    }
    return await response.json();
  }

  loadPluginStorage(hash?: string) {
    return this.getCached<{
      pluginCustomStorage: Record<string, unknown>;
      hash: string;
    }>(
      "/api/database-v2/plugin-custom-storage",
      hash ? `"risu-plugin-storage-${hash}"` : undefined,
      "PostgreSQL plugin custom storage load failed",
    );
  }

  async listPluginStorageKeys(): Promise<string[]> {
    const result = await this.getCached<{ keys?: string[] }>(
      "/api/database-v2/plugin-custom-storage/keys",
      undefined,
      "PostgreSQL list plugin custom storage keys failed",
    );
    return result.status === "ok" && Array.isArray(result.body.keys)
      ? result.body.keys
      : [];
  }

  loadPluginStorageKey(key: string, hash?: string) {
    return this.getCached<{ key: string; value: unknown; hash: string }>(
      `/api/database-v2/plugin-custom-storage/keys/${encodeURIComponent(key)}`,
      hash ? `"risu-plugin-key-${hash}"` : undefined,
      `PostgreSQL plugin custom storage key '${key}' load failed`,
    );
  }

  loadPersonas<T>(hash?: string) {
    return this.getCached<{ personas: T[]; hash: string }>(
      "/api/database-v2/personas",
      hash ? `"risu-personas-${hash}"` : undefined,
      "PostgreSQL personas load failed",
    );
  }

  listBotPresets<T>(hash?: string) {
    return this.getCached<{ presets: T[]; hash: string }>(
      "/api/database-v2/presets",
      hash ? `"risu-presets-${hash}"` : undefined,
      "PostgreSQL bot presets load failed",
    );
  }

  loadBotPreset<T>(id: string, hash?: string) {
    return this.getCached<{ preset: T; hash: string }>(
      `/api/database-v2/presets/${encodeURIComponent(id)}`,
      hash ? `"risu-preset-${id}-${hash}"` : undefined,
      "Bot preset load failed",
    );
  }

  loadLorebooks<T>(hash?: string) {
    return this.getCached<{ loreBook: T[]; hash: string }>(
      "/api/database-v2/lorebooks",
      hash ? `"risu-lorebooks-${hash}"` : undefined,
      "PostgreSQL global lorebooks load failed",
    );
  }

  loadModules<T>(hash?: string) {
    return this.getCached<{ modules: T[]; hash: string }>(
      "/api/database-v2/modules",
      hash ? `"risu-modules-${hash}"` : undefined,
      "PostgreSQL modules load failed",
    );
  }

  loadPrompts<T>(hash?: string) {
    return this.getCached<{ prompts: T; hash: string }>(
      "/api/database-v2/prompts",
      hash ? `"risu-prompts-${hash}"` : undefined,
      "PostgreSQL prompts load failed",
    );
  }

  loadScripts<T>(hash?: string) {
    return this.getCached<{ globalscript: T[]; hash: string }>(
      "/api/database-v2/scripts",
      hash ? `"risu-scripts-${hash}"` : undefined,
      "PostgreSQL scripts load failed",
    );
  }
}
