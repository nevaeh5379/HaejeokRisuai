import type { RemoteStorageProfile } from "./types";

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
export type NodeStorageSyncSessionStatus =
  | "created"
  | "planning-assets"
  | "receiving-assets"
  | "assets-ready"
  | "receiving-sql"
  | "sql-ready"
  | "finalized";
export type NodeStorageSyncAssetState =
  "skipped" | "pending" | "receiving" | "ready";

export interface NodeStorageSyncSession {
  id: string;
  direction: StorageSyncDirection;
  role: "source" | "target";
  status: NodeStorageSyncSessionStatus;
  serverRevision: number;
  peerRevision: number | null;
  summary: NodeStorageSyncSummary;
  createdAt: number;
  expiresAt: number;
  chunkSizeBytes: number;
  maxConcurrency: number;
  finalizedResult?: NodeStorageSyncFinalizeResult;
}

export interface NodeStorageSyncAssetManifestEntry {
  key: string;
  size: number;
  sha256: string;
}

export interface NodeStorageSyncAssetPlanEntry extends NodeStorageSyncAssetManifestEntry {
  id: string;
  offset: number;
  state: NodeStorageSyncAssetState;
}

export interface NodeStorageSyncAssetPlan {
  status: NodeStorageSyncSessionStatus;
  assets: NodeStorageSyncAssetPlanEntry[];
  skippedCount: number;
  missingCount: number;
  totalBytes: number;
  remainingBytes: number;
}

export interface NodeStorageSyncAssetChunkResult {
  id: string;
  offset: number;
  state: NodeStorageSyncAssetState;
  status: NodeStorageSyncSessionStatus;
}

export type NodeStorageSyncSqlState = "pending" | "receiving" | "ready";

export interface NodeStorageSyncSqlPlanInput {
  formatVersion: 1;
  size: number;
  recordCount: number;
  sha256: string;
}

export interface NodeStorageSyncSqlPlan extends NodeStorageSyncSqlPlanInput {
  offset: number;
  state: NodeStorageSyncSqlState;
  status: NodeStorageSyncSessionStatus;
}

export interface NodeStorageSyncSqlValidation {
  recordCount: number;
  sourceRevision: number;
  counts: Record<string, number>;
}

export interface NodeStorageSyncFinalizePreflight {
  status: "ready";
  targetRevision: number;
  sourceRevision: number;
  recordCount: number;
  skippedAssetsVerified: number;
}

export interface NodeStorageSyncFinalizeResult {
  status: "completed";
  revision: number;
  revisionId: number | string;
  targetRevisionBefore: number;
  sourceRevision: number;
  recordCount: number;
  assetsApplied: number;
  recoveryId: string;
  recoveryPromoted: boolean;
  recoveryWarning: string | null;
  cleanupWarning?: string | null;
}

export class NodeStorageSyncRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(
      `Storage revision changed to ${currentRevision}. Refresh the sync preview before continuing.`,
    );
    this.name = "NodeStorageSyncRevisionConflictError";
  }
}

export class NodeStorageSyncAssetError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncAssetError";
  }
}

export class NodeStorageSyncSqlError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncSqlError";
  }
}

export class NodeStorageSyncFinalizeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeStorageSyncFinalizeError";
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

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateStorageSyncSession(value: unknown): NodeStorageSyncSession {
  const session = value as Partial<NodeStorageSyncSession> | null;
  const statuses: NodeStorageSyncSessionStatus[] = [
    "created",
    "planning-assets",
    "receiving-assets",
    "assets-ready",
    "receiving-sql",
    "sql-ready",
    "finalized",
  ];
  if (
    !session ||
    typeof session.id !== "string" ||
    !session.id ||
    !["local-to-remote", "remote-to-local"].includes(
      String(session.direction),
    ) ||
    !["source", "target"].includes(String(session.role)) ||
    !statuses.includes(session.status as NodeStorageSyncSessionStatus) ||
    !isNonNegativeSafeInteger(session.serverRevision) ||
    (session.peerRevision !== null &&
      !isNonNegativeSafeInteger(session.peerRevision)) ||
    !isNonNegativeSafeInteger(session.createdAt) ||
    !isNonNegativeSafeInteger(session.expiresAt) ||
    !isNonNegativeSafeInteger(session.chunkSizeBytes) ||
    !isNonNegativeSafeInteger(session.maxConcurrency)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync session.",
    );
  }
  validateStorageSyncSummary(session.summary);
  if (session.status === "finalized") {
    validateStorageSyncFinalizeResult(session.finalizedResult);
  }
  return session as NodeStorageSyncSession;
}

function validateStorageSyncAssetPlan(
  value: unknown,
): NodeStorageSyncAssetPlan {
  const plan = value as Partial<NodeStorageSyncAssetPlan> | null;
  const states: NodeStorageSyncAssetState[] = [
    "skipped",
    "pending",
    "receiving",
    "ready",
  ];
  if (
    !plan ||
    !["receiving-assets", "assets-ready"].includes(String(plan.status)) ||
    !Array.isArray(plan.assets) ||
    !isNonNegativeSafeInteger(plan.skippedCount) ||
    !isNonNegativeSafeInteger(plan.missingCount) ||
    !isNonNegativeSafeInteger(plan.totalBytes) ||
    !isNonNegativeSafeInteger(plan.remainingBytes)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync asset plan.",
    );
  }
  for (const asset of plan.assets) {
    if (
      typeof asset?.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.id) ||
      typeof asset.key !== "string" ||
      !asset.key ||
      !isNonNegativeSafeInteger(asset.size) ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !isNonNegativeSafeInteger(asset.offset) ||
      asset.offset > asset.size ||
      !states.includes(asset.state)
    ) {
      throw new NodeApiCompatibilityError(
        "The storage server returned an invalid storage sync asset entry.",
      );
    }
  }
  return plan as NodeStorageSyncAssetPlan;
}

function validateStorageSyncAssetChunkResult(
  value: unknown,
): NodeStorageSyncAssetChunkResult {
  const result = value as Partial<NodeStorageSyncAssetChunkResult> | null;
  if (
    !result ||
    typeof result.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.id) ||
    !isNonNegativeSafeInteger(result.offset) ||
    !["skipped", "pending", "receiving", "ready"].includes(
      String(result.state),
    ) ||
    !["receiving-assets", "assets-ready"].includes(String(result.status))
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync chunk result.",
    );
  }
  return result as NodeStorageSyncAssetChunkResult;
}

function validateStorageSyncSqlPlan(value: unknown): NodeStorageSyncSqlPlan {
  const plan = value as Partial<NodeStorageSyncSqlPlan> | null;
  if (
    !plan ||
    plan.formatVersion !== 1 ||
    !isNonNegativeSafeInteger(plan.size) ||
    !isNonNegativeSafeInteger(plan.recordCount) ||
    typeof plan.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.sha256) ||
    !isNonNegativeSafeInteger(plan.offset) ||
    Number(plan.offset) > Number(plan.size) ||
    !["pending", "receiving", "ready"].includes(String(plan.state)) ||
    !["receiving-sql", "sql-ready"].includes(String(plan.status))
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync SQL plan.",
    );
  }
  return plan as NodeStorageSyncSqlPlan;
}

function validateStorageSyncSqlValidation(
  value: unknown,
): NodeStorageSyncSqlValidation {
  const result = value as Partial<NodeStorageSyncSqlValidation> | null;
  if (
    !result ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !result.counts ||
    typeof result.counts !== "object" ||
    Array.isArray(result.counts) ||
    Object.values(result.counts).some(
      (count) => !isNonNegativeSafeInteger(count),
    )
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid storage sync SQL validation result.",
    );
  }
  return result as NodeStorageSyncSqlValidation;
}

function validateStorageSyncFinalizePreflight(
  value: unknown,
): NodeStorageSyncFinalizePreflight {
  const result = value as Partial<NodeStorageSyncFinalizePreflight> | null;
  if (
    !result ||
    result.status !== "ready" ||
    !isNonNegativeSafeInteger(result.targetRevision) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.skippedAssetsVerified)
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid finalize preflight result.",
    );
  }
  return result as NodeStorageSyncFinalizePreflight;
}

function validateStorageSyncFinalizeResult(
  value: unknown,
): NodeStorageSyncFinalizeResult {
  const result = value as Partial<NodeStorageSyncFinalizeResult> | null;
  if (
    !result ||
    result.status !== "completed" ||
    !isNonNegativeSafeInteger(result.revision) ||
    !(
      typeof result.revisionId === "string" ||
      isNonNegativeSafeInteger(result.revisionId)
    ) ||
    !isNonNegativeSafeInteger(result.targetRevisionBefore) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !isNonNegativeSafeInteger(result.recordCount) ||
    !isNonNegativeSafeInteger(result.assetsApplied) ||
    typeof result.recoveryId !== "string" ||
    !result.recoveryId ||
    typeof result.recoveryPromoted !== "boolean" ||
    !(
      result.recoveryWarning === null ||
      typeof result.recoveryWarning === "string"
    ) ||
    !(
      result.cleanupWarning === undefined ||
      result.cleanupWarning === null ||
      typeof result.cleanupWarning === "string"
    )
  ) {
    throw new NodeApiCompatibilityError(
      "The storage server returned an invalid finalize result.",
    );
  }
  return result as NodeStorageSyncFinalizeResult;
}

async function storageSyncAssetError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncAssetError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync asset request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_asset_error",
    response.status,
  );
}

async function storageSyncSqlError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncSqlError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync SQL request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_sql_error",
    response.status,
  );
}

async function storageSyncFinalizeError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new NodeStorageSyncFinalizeError(
    typeof body?.error === "string"
      ? body.error
      : `Storage sync finalize request failed (HTTP ${response.status}).`,
    typeof body?.code === "string" ? body.code : "storage_sync_finalize_error",
    response.status,
  );
}

export class NodeApiClient {
  readonly baseUrl: string;
  private readonly fetcher: NodeApiFetch;

  constructor(
    profile: RemoteStorageProfile,
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

  async planStorageSyncAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/plan`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify({ assets }),
        signal,
      },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetPlan(await response.json());
  }

  async getStorageSyncAssetPlan(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/plan`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetPlan(await response.json());
  }

  async uploadStorageSyncAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetChunkResult> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}?offset=${encodeURIComponent(String(offset))}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "risu-auth": auth,
        },
        body: data as BodyInit,
        signal,
      },
    );
    if (!response.ok) return await storageSyncAssetError(response);
    return validateStorageSyncAssetChunkResult(await response.json());
  }

  async planStorageSyncSql(
    id: string,
    plan: NodeStorageSyncSqlPlanInput,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/plan`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify(plan),
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  async getStorageSyncSqlPlan(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/plan`,
      { cache: "no-store", headers: { "risu-auth": auth }, signal },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  async uploadStorageSyncSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql?offset=${encodeURIComponent(String(offset))}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "risu-auth": auth,
        },
        body: data as BodyInit,
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlPlan(await response.json());
  }

  async validateStorageSyncSql(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlValidation> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/sql/validate`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncSqlError(response);
    return validateStorageSyncSqlValidation(await response.json());
  }

  async preflightStorageSyncFinalize(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizePreflight> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/finalize/preflight`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncFinalizeError(response);
    return validateStorageSyncFinalizePreflight(await response.json());
  }

  async finalizeStorageSync(
    id: string,
    auth: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizeResult> {
    const response = await this.request(
      `/api/storage-sync/sessions/${encodeURIComponent(id)}/finalize`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "risu-auth": auth },
        signal,
      },
    );
    if (!response.ok) return await storageSyncFinalizeError(response);
    return validateStorageSyncFinalizeResult(await response.json());
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
