import type { StorageProfile } from "./storageProfile";

export const CLIENT_STORAGE_API_VERSION = 1;

export interface NodeClientCapabilities {
  apiVersion: number;
  features: {
    sqlStorage: boolean;
    assetStorage: boolean;
    dataChangeEvents: boolean;
    storageSync?: boolean;
    modelExecution?: boolean;
    vectorSearch?: boolean;
  };
}

export interface NodeStorageSyncSummary {
  protocolVersion: number;
  revision: number;
  initialized: boolean;
  records: {
    settings: number;
    characters: number;
    chats: number;
    messages: number;
    total: number;
  };
  assets: { count: number; sizeBytes: number };
}

export type StorageSyncDirection = "local-to-remote" | "remote-to-local";

export interface NodeStorageSyncSession {
  id: string;
  direction: StorageSyncDirection;
  role: "source" | "target";
  status: "created" | "cancelled";
  serverRevision: number;
  peerRevision: number | null;
  summary: NodeStorageSyncSummary;
  createdAt: number;
  expiresAt: number;
  chunkSizeBytes: number;
  maxConcurrency: number;
}

export class NodeStorageSyncRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(
      `Storage revision changed to ${currentRevision}. Refresh the sync preview before continuing.`,
    );
    this.name = "NodeStorageSyncRevisionConflictError";
  }
}

export type NodeApiFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class NodeApiCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeApiCompatibilityError";
  }
}

function validateCapabilities(value: unknown): NodeClientCapabilities {
  if (!value || typeof value !== "object") {
    throw new NodeApiCompatibilityError(
      "The storage server returned invalid capabilities.",
    );
  }
  const capabilities = value as Partial<NodeClientCapabilities>;
  if (capabilities.apiVersion !== CLIENT_STORAGE_API_VERSION) {
    throw new NodeApiCompatibilityError(
      `The storage server API is incompatible (server ${String(capabilities.apiVersion ?? "unknown")}, client ${CLIENT_STORAGE_API_VERSION}). Upgrade the server before connecting.`,
    );
  }
  if (
    !capabilities.features ||
    capabilities.features.sqlStorage !== true ||
    capabilities.features.assetStorage !== true ||
    capabilities.features.dataChangeEvents !== true
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server does not provide the required SQL, asset, and data-change features.",
    );
  }
  return capabilities as NodeClientCapabilities;
}

function validateStorageSyncSummary(value: unknown): NodeStorageSyncSummary {
  const summary = value as Partial<NodeStorageSyncSummary> | null;
  const counters = summary?.records;
  const assets = summary?.assets;
  const validCounter = (entry: unknown) =>
    Number.isSafeInteger(entry) && Number(entry) >= 0;
  if (
    !summary ||
    summary.protocolVersion !== 1 ||
    !validCounter(summary.revision) ||
    typeof summary.initialized !== "boolean" ||
    !counters ||
    !validCounter(counters.settings) ||
    !validCounter(counters.characters) ||
    !validCounter(counters.chats) ||
    !validCounter(counters.messages) ||
    !validCounter(counters.total) ||
    !assets ||
    !validCounter(assets.count) ||
    !validCounter(assets.sizeBytes)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync summary.",
    );
  }
  return summary as NodeStorageSyncSummary;
}

function validateStorageSyncSession(value: unknown): NodeStorageSyncSession {
  const session = value as Partial<NodeStorageSyncSession> | null;
  if (
    !session ||
    typeof session.id !== "string" ||
    !session.id ||
    !["local-to-remote", "remote-to-local"].includes(
      String(session.direction),
    ) ||
    !["source", "target"].includes(String(session.role)) ||
    session.status !== "created" ||
    !Number.isSafeInteger(session.serverRevision) ||
    (session.peerRevision !== null &&
      !Number.isSafeInteger(session.peerRevision)) ||
    !Number.isSafeInteger(session.createdAt) ||
    !Number.isSafeInteger(session.expiresAt) ||
    !Number.isSafeInteger(session.chunkSizeBytes) ||
    !Number.isSafeInteger(session.maxConcurrency)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync session.",
    );
  }
  validateStorageSyncSummary(session.summary);
  return session as NodeStorageSyncSession;
}

export class NodeApiClient {
  readonly baseUrl: string;
  private readonly fetcher: NodeApiFetch;

  constructor(
    profile: Extract<StorageProfile, { mode: "remote" }>,
    fetcher: NodeApiFetch = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = profile.baseUrl;
    this.fetcher = fetcher;
  }

  resolve(path: string): string {
    if (!path.startsWith("/")) {
      throw new TypeError("Node API paths must start with '/'.");
    }
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl) {
      throw new TypeError("Node API paths must stay on the configured server.");
    }
    return url.toString();
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetcher(this.resolve(path), init);
  }

  async getCapabilities(signal?: AbortSignal): Promise<NodeClientCapabilities> {
    const response = await this.request("/api/client-capabilities", {
      method: "GET",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new NodeApiCompatibilityError(
          "This server is too old for remote storage. Upgrade the server before connecting.",
        );
      }
      throw new Error(
        `Could not read storage server capabilities (HTTP ${response.status}).`,
      );
    }
    return validateCapabilities(await response.json());
  }

  async getStorageSyncSummary(
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSummary> {
    await this.requireStorageSyncCapability(signal);
    const response = await this.request("/api/storage-sync/summary", {
      method: "GET",
      cache: "no-store",
      headers: { "risu-auth": auth },
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Could not read storage sync summary (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSummary(await response.json());
  }

  async createStorageSyncSession(
    options: {
      direction: StorageSyncDirection;
      expectedRevision: number;
      peerRevision?: number | null;
    },
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    await this.requireStorageSyncCapability(signal);
    const response = await this.request("/api/storage-sync/sessions", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(options),
      signal,
    });
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      throw new NodeStorageSyncRevisionConflictError(
        Number.isSafeInteger(body?.currentRevision) ? body.currentRevision : 0,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Could not create storage sync session (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSession(await response.json());
  }

  async getStorageSyncSession(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) {
      throw new Error(
        `Could not read storage sync session (HTTP ${response.status}).`,
      );
    }
    return validateStorageSyncSession(await response.json());
  }

  async cancelStorageSyncSession(id: string, auth: string): Promise<void> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { "risu-auth": auth } },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Could not cancel storage sync session (HTTP ${response.status}).`,
      );
    }
  }

  private async requireStorageSyncCapability(
    signal?: AbortSignal,
  ): Promise<void> {
    const capabilities = await this.getCapabilities(signal);
    if (capabilities.features.storageSync !== true) {
      throw new NodeApiCompatibilityError(
        "This server does not support local/self-hosted storage sync. Upgrade the server before syncing.",
      );
    }
  }
}

/**
 * The Node-hosted web app deliberately keeps browser-relative requests. This
 * avoids changing cookie/cache semantics while still routing every endpoint
 * through the same client abstraction used by remote profiles.
 */
export function createSameOriginNodeApiClient(
  fetcher: NodeApiFetch = (input, init) => fetch(input, init),
  origin = globalThis.location?.origin || "http://localhost",
): NodeApiClient {
  return new NodeApiClient(
    {
      version: 1,
      mode: "remote",
      baseUrl: origin,
      allowInsecureHttp: origin.startsWith("http:"),
    },
    (input, init) => {
      const url = new URL(input);
      return fetcher(`${url.pathname}${url.search}${url.hash}`, init);
    },
  );
}

export async function createRemoteNodeApiClient(
  profile: Extract<StorageProfile, { mode: "remote" }>,
  platform: "web" | "tauri" | "capacitor" | "node",
): Promise<NodeApiClient> {
  if (platform === "tauri") {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return new NodeApiClient(
      profile,
      (input, init) => tauriFetch(input, init) as Promise<Response>,
    );
  }
  if (platform === "node" && profile.baseUrl === globalThis.location?.origin) {
    return createSameOriginNodeApiClient();
  }
  // CapacitorHttp patches window.fetch/XMLHttpRequest when enabled in
  // capacitor.config.ts. Web clients intentionally use the browser transport
  // so mixed-content and certificate failures remain visible to the user.
  return new NodeApiClient(profile);
}
