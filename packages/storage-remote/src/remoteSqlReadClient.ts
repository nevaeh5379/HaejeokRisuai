import type { NodeApiClient } from "./nodeApiClient";

export interface RemoteCreateChatBranchInput {
  chatId: string;
  id: string;
  parentBranchId?: string;
  forkMessageId?: string;
  reason: "root" | "manual" | "reroll";
  createdAt: number;
}

export class RemoteSqlReadClient {
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

  private async error(response: Response, fallback: string): Promise<Error> {
    const body = await response.json().catch(() => null);
    return new Error(body?.error || `${fallback} (${response.status})`);
  }

  async listSettingKeys(): Promise<string[]> {
    const response = await this.apiClient.request("/api/database-v2/settings", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL setting key list failed");
    }
    const body: { keys?: string[] } = await response.json();
    return Array.isArray(body.keys) ? body.keys : [];
  }

  async loadSettingKey<T = unknown>(key: string): Promise<T | undefined> {
    const response = await this.apiClient.request(
      `/api/database-v2/settings/${encodeURIComponent(key)}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        `PostgreSQL load setting key '${key}' failed`,
      );
    }
    const body: { value: T } = await response.json();
    return body.value;
  }

  async loadStartupData<T>(): Promise<T | null> {
    const response = await this.apiClient.request("/api/database-v2/startup", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL startup data load failed");
    }
    return (await response.json()) as T;
  }

  async exportDatabaseSnapshot<T>(): Promise<T> {
    const response = await this.apiClient.request("/api/database-v2/export", {
      method: "GET",
      cache: "no-cache",
      headers: await this.authHeaders(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL database snapshot export failed");
    }
    return (await response.json()) as T;
  }

  async loadCharacter<T>(characterId: string): Promise<T | null> {
    const response = await this.apiClient.request(
      `/api/database-v2/characters/${encodeURIComponent(characterId)}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL character load failed");
    }
    const body: { character?: T } = await response.json();
    return body.character ?? null;
  }

  async loadCharacterAssetFields<T>(characterId: string): Promise<T | null> {
    const response = await this.apiClient.request(
      `/api/database-v2/characters/${encodeURIComponent(characterId)}/asset-fields`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        "PostgreSQL character asset fields load failed",
      );
    }
    const body: { assets?: T } = await response.json();
    return body.assets ?? null;
  }

  async loadChat<T>(
    chatId: string,
    options?: { messageLimit?: number },
  ): Promise<T | null> {
    const search =
      options?.messageLimit !== undefined
        ? `?messageLimit=${encodeURIComponent(options.messageLimit)}`
        : "";
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}${search}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL chat load failed");
    }
    const body: { chat?: T } = await response.json();
    return body.chat ?? null;
  }

  async loadChatMessages<T>(
    chatId: string,
    options: { mode?: "full" | "generation" } = {},
  ): Promise<T[]> {
    const mode = options.mode === "generation" ? "?mode=generation" : "";
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/messages${mode}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL chat messages load failed");
    }
    const body: { messages?: T[] } = await response.json();
    return body.messages ?? [];
  }

  async loadChatMessagePage<T>(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<T> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) params.set("before", String(before));
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/messages?${params}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        "PostgreSQL chat message page load failed",
      );
    }
    return (await response.json()) as T;
  }

  async listChatBranches<T>(chatId: string): Promise<T[]> {
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL chat branch list failed");
    }
    const body: { branches?: T[] } = await response.json();
    return body.branches ?? [];
  }

  async loadChatBranchGraph<T>(chatId: string): Promise<T | null> {
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/graph`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL chat branch graph load failed");
    }
    const body: { graph?: T } = await response.json();
    return body.graph ?? null;
  }

  async loadChatBranchGraphPage<T>(
    chatId: string,
    offset: number,
    limit: number,
  ): Promise<T | null> {
    const params = new URLSearchParams({
      offset: String(Math.max(0, Math.floor(offset))),
      limit: String(Math.max(1, Math.floor(limit))),
    });
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/graph/page?${params}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        "SQL chat branch graph page load failed",
      );
    }
    const body: { page?: T } = await response.json();
    return body.page ?? null;
  }

  async loadBranchMessages<T>(
    chatId: string,
    branchId: string,
    options: {
      messageLimit?: number;
      mode?: "full" | "generation" | "graph";
    } = {},
  ): Promise<T[]> {
    const params = new URLSearchParams();
    if (options.messageLimit !== undefined) {
      params.set("limit", String(options.messageLimit));
    }
    if (options.mode === "generation" || options.mode === "graph") {
      params.set("mode", options.mode);
    }
    const search = params.size > 0 ? `?${params}` : "";
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/${encodeURIComponent(branchId)}/messages${search}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL chat branch messages load failed");
    }
    const body: { messages?: T[] } = await response.json();
    return body.messages ?? [];
  }

  async createChatBranch<T>(input: RemoteCreateChatBranchInput): Promise<T> {
    const response = await this.apiClient.request(
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
      throw await this.error(response, "SQL chat branch creation failed");
    }
    const body: { branch: T } = await response.json();
    return body.branch;
  }

  async activateChatBranch(chatId: string, branchId: string): Promise<void> {
    const response = await this.apiClient.request(
      `/api/database-v2/chats/${encodeURIComponent(chatId)}/branches/${encodeURIComponent(branchId)}/activate`,
      { method: "POST", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "SQL chat branch activation failed");
    }
  }

  async listRecentChats<T>(
    limit?: number,
    activeChatId?: string,
  ): Promise<T[]> {
    const params = new URLSearchParams();
    if (limit !== undefined && limit !== null && limit > 0) {
      params.set("limit", String(limit));
    }
    if (activeChatId) params.set("activeChatId", activeChatId);
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.apiClient.request(
      `/api/database-v2/recent-chats${search}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL recent chats load failed");
    }
    const body: { chats?: T[] } = await response.json();
    return body.chats ?? [];
  }
}
