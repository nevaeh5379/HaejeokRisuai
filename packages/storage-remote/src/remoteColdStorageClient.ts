import type { NodeApiClient } from "./nodeApiClient";

export class RemoteColdStorageClient {
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

  async getItem(key: string): Promise<unknown | null> {
    const response = await this.apiClient.request(
      `/api/database-v2/cold-storage/${encodeURIComponent(key)}`,
      { method: "GET", cache: "no-cache", headers: await this.authHeaders() },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL cold storage load failed");
    }
    const body: { data: unknown } = await response.json();
    return body.data;
  }

  async listItems(): Promise<string[]> {
    const response = await this.apiClient.request(
      "/api/database-v2/cold-storage",
      {
        method: "GET",
        headers: await this.authHeaders(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL cold storage list failed");
    }
    const body: { items: { key: string }[] } = await response.json();
    return body.items.map((item) => item.key);
  }

  async setItem(key: string, value: unknown): Promise<void> {
    const encoded = await this.jsonBody({ data: value });
    const response = await this.apiClient.request(
      `/api/database-v2/cold-storage/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: encoded.body,
        headers: {
          "content-type": "application/json",
          ...(encoded.contentEncoding
            ? { "content-encoding": encoded.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL cold storage save failed");
    }
  }

  async removeItems(keys: string[]): Promise<number> {
    const encoded = await this.jsonBody({ keys });
    const response = await this.apiClient.request(
      "/api/database-v2/cold-storage",
      {
        method: "DELETE",
        body: encoded.body,
        headers: {
          "content-type": "application/json",
          ...(encoded.contentEncoding
            ? { "content-encoding": encoded.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(response, "PostgreSQL cold storage delete failed");
    }
    const body: { deleted: number } = await response.json();
    return body.deleted;
  }

  async prune(retainedKeys: string[]): Promise<number> {
    const encoded = await this.jsonBody({ retainedKeys });
    const response = await this.apiClient.request(
      "/api/database-v2/cold-storage/prune",
      {
        method: "POST",
        body: encoded.body,
        headers: {
          "content-type": "application/json",
          ...(encoded.contentEncoding
            ? { "content-encoding": encoded.contentEncoding }
            : {}),
          ...(await this.authHeaders()),
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw await this.error(
        response,
        "PostgreSQL cold storage cleanup failed",
      );
    }
    const body: { deleted: number } = await response.json();
    return body.deleted;
  }
}
