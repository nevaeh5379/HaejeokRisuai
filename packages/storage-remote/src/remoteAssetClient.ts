import type { AssetStorageTarget } from "@risuai/protocol/storageConfig.cjs";
import type { NodeApiClient } from "./nodeApiClient";

export interface RemoteAssetReadOptions {
  thumbnail?: boolean;
  size?: "thumb" | "display" | "full";
  width?: number;
  height?: number;
  target?: AssetStorageTarget;
}

export interface RemoteAssetReadResult {
  data: Uint8Array;
  contentType: string;
}

export type RemoteAssetAuthProvider = () => Promise<string>;

function utf8ToHex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readParams(options?: RemoteAssetReadOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (options?.thumbnail) params.set("thumb", "1");
  if (options?.size) params.set("size", options.size);
  if (options?.width) params.set("width", String(options.width));
  if (options?.height) params.set("height", String(options.height));
  if (options?.target && options.target !== "active") {
    params.set("target", options.target);
  }
  return params;
}

export class RemoteAssetClient {
  constructor(
    readonly apiClient: NodeApiClient,
    private readonly getAuth: RemoteAssetAuthProvider,
  ) {}

  async getDirectUrl(
    key: string,
    options?: RemoteAssetReadOptions,
  ): Promise<string> {
    const params = readParams(options);
    params.set("path", utf8ToHex(key));
    params.set("auth", await this.getAuth());
    return this.apiClient.resolve(`/api/read?${params.toString()}`);
  }

  async setItem(key: string, value: Uint8Array): Promise<void> {
    const response = await this.apiClient.request("/api/write", {
      method: "POST",
      body: value as BodyInit,
      headers: {
        "content-type": "application/octet-stream",
        "file-path": utf8ToHex(key),
        "risu-auth": await this.getAuth(),
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `setItem Error: ${response.status}`);
    }
    if (body.error) throw new Error(body.error);
  }

  async getItemWithMetadata(
    key: string,
    options?: RemoteAssetReadOptions,
    cache: RequestCache = "no-cache",
  ): Promise<RemoteAssetReadResult | null> {
    const params = readParams(options);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.apiClient.request(`/api/read${query}`, {
      method: "GET",
      cache,
      headers: {
        "file-path": utf8ToHex(key),
        "risu-auth": await this.getAuth(),
        ...(options?.thumbnail ? { "x-thumbnail": "true" } : {}),
        ...(options?.target && options.target !== "active"
          ? { "x-storage-target": options.target }
          : {}),
      },
    });
    if (!response.ok) throw new Error(`getItem Error: ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) return null;
    return {
      data,
      contentType:
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
        "application/octet-stream",
    };
  }

  async getItem(
    key: string,
    options?: RemoteAssetReadOptions,
  ): Promise<Uint8Array | null> {
    return (await this.getItemWithMetadata(key, options))?.data ?? null;
  }

  async getItemFromBrowserCache(
    key: string,
    options?: Pick<RemoteAssetReadOptions, "thumbnail" | "target">,
  ): Promise<Uint8Array | null> {
    try {
      return (
        (await this.getItemWithMetadata(key, options, "force-cache"))?.data ??
        null
      );
    } catch {
      return null;
    }
  }

  async keys(prefix = ""): Promise<string[]> {
    const search = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    const response = await this.apiClient.request(`/api/list${search}`, {
      method: "GET",
      headers: { "risu-auth": await this.getAuth() },
    });
    if (!response.ok) throw new Error(`listItem Error: ${response.status}`);
    const body = (await response.json()) as {
      error?: string;
      content?: string[];
    };
    if (body.error) throw new Error(body.error);
    return Array.isArray(body.content) ? body.content : [];
  }

  async removeItem(key: string | string[]): Promise<void> {
    const value = Array.isArray(key) ? key.join("$$") : key;
    const response = await this.apiClient.request("/api/remove", {
      method: "GET",
      headers: {
        "file-path": utf8ToHex(value),
        "risu-auth": await this.getAuth(),
      },
    });
    if (!response.ok) throw new Error(`removeItem Error: ${response.status}`);
    const body = (await response.json()) as { error?: string };
    if (body.error) throw new Error(body.error);
  }
}
