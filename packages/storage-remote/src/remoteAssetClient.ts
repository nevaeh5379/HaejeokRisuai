import type { AssetStorageTarget } from "@risuai/protocol/storageConfig.ts";
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

const HEX_TABLE: string[] = [];
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = i.toString(16).padStart(2, "0");
}
const SHARED_TEXT_ENCODER = new TextEncoder();

function utf8ToHex(value: string): string {
  const bytes = SHARED_TEXT_ENCODER.encode(value);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
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

const MAX_STORAGE_ERROR_DETAIL_LENGTH = 2000;

function formatStorageValueSize(byteLength: number) {
  if (byteLength < 1024) {
    return `${byteLength} bytes`;
  }

  const units = ["KiB", "MiB", "GiB"];
  let size = byteLength;
  let unitIndex = -1;
  do {
    size /= 1024;
    unitIndex += 1;
  } while (size >= 1024 && unitIndex < units.length - 1);

  return `${byteLength} bytes (${size.toFixed(2)} ${units[unitIndex]})`;
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? `${error}`;
  } catch {
    return `${error}`;
  }
}

function normalizeStorageErrorDetail(detail: string) {
  const normalized = detail
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();

  if (normalized.length <= MAX_STORAGE_ERROR_DETAIL_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_STORAGE_ERROR_DETAIL_LENGTH) + "...";
}

async function getStorageResponseErrorDetail(response: Response) {
  let responseText = "";
  try {
    responseText = await response.text();
  } catch (error) {
    return `Could not read the server response: ${formatUnknownError(error)}`;
  }

  if (!responseText.trim()) {
    return "";
  }

  try {
    const body = JSON.parse(responseText);
    if (body && typeof body === "object") {
      const candidates = [body.error, body.code, body.message, body.details];
      const seen = new Set<unknown>();
      const details: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const val = candidates[i];
        if (val != null && val !== "" && !seen.has(val)) {
          seen.add(val);
          details.push(formatUnknownError(val));
        }
      }
      if (details.length > 0) {
        return normalizeStorageErrorDetail(details.join(" | "));
      }
    }
  } catch {}

  return normalizeStorageErrorDetail(responseText);
}

function getSetItemContext(key: string, byteLength: number) {
  return `Key: ${key}\nSize: ${formatStorageValueSize(byteLength)}`;
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
    const context = getSetItemContext(key, value.byteLength);
    let response: Response;
    try {
      response = await this.apiClient.request("/api/write", {
        method: "POST",
        body: value as BodyInit,
        headers: {
          "content-type": "application/octet-stream",
          "file-path": utf8ToHex(key),
          "risu-auth": await this.getAuth(),
        },
      });
    } catch (error) {
      throw new Error(
        `Node storage setItem request failed.\n${context}\nCause: ${formatUnknownError(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await getStorageResponseErrorDetail(response);
      throw new Error(
        `Node storage setItem failed.\n${context}\nHTTP: ${response.status} ${response.statusText}` +
          (detail ? `\nServer: ${detail}` : ""),
      );
    }
    let body: { error?: unknown };
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `Node storage setItem received an invalid response.\n${context}\nCause: ${formatUnknownError(error)}`,
      );
    }
    if (body?.error)
      throw new Error(
        `Node storage setItem failed.\n${context}\nServer: ${formatUnknownError(body.error)}`,
      );
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
