import { language } from "src/lang";
import { alertError, alertInput, waitAlert } from "../../alert";
import { NodeSqlStorage } from "../sql/postgres/nodeSqlStorage";
import { NodeS3Storage } from "@risuai/storage-remote/nodeS3Storage";
import { RemoteAssetClient } from "@risuai/storage-remote/remoteAssetClient";
import { RemoteAuthIdentity } from "@risuai/storage-remote/remoteAuthIdentity";
import { RemoteAuthController } from "@risuai/storage-remote/remoteAuthController";
import { RemoteStorageSyncClient } from "@risuai/storage-remote/remoteStorageSyncClient";
import {
  RemoteComputeClient,
  type NodeVectorCacheStats,
  type NodeVectorCacheClearResult,
} from "@risuai/storage-remote/remoteComputeClient";
import {
  RemoteBulkAssetClient,
  type NodeStorageBulkReadHandlers,
  type NodeStorageBulkReadProgress,
  type NodeStorageBulkWriteProgress,
} from "@risuai/storage-remote/remoteBulkAssetClient";
import {
  StorageSyncAssetReadError,
  validateStorageSyncAssetChunkRange,
} from "../runtime/storageSyncAssetReader";
import {
  createSameOriginNodeApiClient,
  type NodeApiClient,
  type NodeStorageSyncAssetChunkResult,
  type NodeStorageSyncAssetManifestEntry,
  type NodeStorageSyncAssetPlan,
  type NodeStorageSyncFinalizePreflight,
  type NodeStorageSyncFinalizeResult,
  type NodeStorageSyncSqlPlan,
  type NodeStorageSyncSqlPlanInput,
  type NodeStorageSyncSqlValidation,
  type NodeStorageSyncSession,
  type NodeStorageSyncSummary,
  type StorageSyncDirection,
} from "@risuai/storage-remote/nodeApiClient";
import type { AssetStorageTarget } from "../../../../packages/protocol/storageConfig.cjs";
import type {
  NodeChatContinuationDecision,
  NodeChatContinuationRequest,
  NodeChatGenerationPlan,
  NodeChatPlanRequest,
} from "../../../../packages/protocol/chatExecutor.cjs";
import type {
  NodeProviderCapabilities,
  NodeProviderExecutionRequest,
  NodeProviderExecutionResult,
  NodeProviderTransportRequest,
  NodeProviderTransportResult,
} from "../../../../packages/protocol/providerExecution.cjs";
import type {
  LoreMatchBatchRequest,
  LoreMatchBatchResponse,
  LoreResolveRequest,
  LoreResolveResponse,
  TokenizeCountRequest,
  TokenizeCountResponse,
  TokenizerEncoding,
  VectorIndexDescriptor,
  VectorIndexEntry,
  VectorIndexSearchRequest,
  VectorIndexSearchResponse,
  VectorIndexSearchResult,
  VectorIndexStatusRequest,
  VectorIndexStatusResponse,
  VectorIndexUpsertRequest,
  VectorSearchMetric,
} from "../../../../packages/protocol/compute.cjs";

export {
  NodeSqlPayloadTooLargeError,
  NodeSqlRevisionConflictError,
} from "../sql/postgres/nodeSqlStorage";
export {
  type AssetStorageTarget,
  type NodeS3ServerConfig,
  type NodeS3ServerConfigUpdate,
  type NodeS3Stats,
  type NodeS3TestResult,
  type NodeS3MigrationResult,
  type NodeS3RollbackResult,
  type NodeS3ThumbnailsResult,
  type NodeS3ProgressEvent,
  type NodeStorageAssetItem,
  type NodeStorageAssetDetails,
  type NodeStorageSummary,
} from "@risuai/storage-remote/nodeS3Storage";

export type {
  NodeStorageBulkReadHandlers,
  NodeStorageBulkReadProgress,
  NodeStorageBulkWriteProgress,
} from "@risuai/storage-remote/remoteBulkAssetClient";

export type {
  NodeVectorCacheStats,
  NodeVectorCacheClearResult,
} from "@risuai/storage-remote/remoteComputeClient";

const NODE_BULK_IMAGE_CACHE_NAME = "risu-node-bulk-images-v1";
const NODE_BULK_IMAGE_CACHE_MAX_ENTRIES = 256;

function canUseNodeBulkImageCache(): boolean {
  return typeof caches !== "undefined" && typeof Response !== "undefined";
}

function getNodeBulkImageCacheUrl(
  key: string,
  options: {
    thumbnail?: boolean;
    size?: "thumb" | "display" | "full";
    width?: number;
    height?: number;
  },
): string {
  const origin =
    typeof location !== "undefined" && location.origin
      ? location.origin
      : "http://localhost";
  const params = new URLSearchParams({
    path: Buffer.from(key, "utf8").toString("hex"),
    size: options.size ?? (options.thumbnail ? "thumb" : "full"),
    width: String(options.width ?? 0),
    height: String(options.height ?? 0),
  });
  return `${origin}/api/read-bulk-cache?${params.toString()}`;
}

function isCacheableBulkImageRequest(options?: {
  thumbnail?: boolean;
  size?: "thumb" | "display" | "full";
  width?: number;
  height?: number;
}): options is NonNullable<typeof options> {
  return Boolean(
    options &&
    (options.thumbnail ||
      options.size === "thumb" ||
      options.size === "display" ||
      (options.width && options.height)),
  );
}

export class NodeStorage {
  private nodeProviderCapabilities: NodeProviderCapabilities | null = null;
  private syncAssetSizeCache: {
    expiresAt: number;
    sizes: Map<string, number>;
  } | null = null;
  private syncAssetSizePromise: Promise<Map<string, number>> | null = null;
  readonly sql: NodeSqlStorage;
  readonly s3: NodeS3Storage;
  private readonly assetClient: RemoteAssetClient;
  private readonly authIdentity: RemoteAuthIdentity;
  private readonly authController: RemoteAuthController;
  private readonly syncClient: RemoteStorageSyncClient;
  private readonly computeClient: RemoteComputeClient;
  private readonly bulkAssetClient: RemoteBulkAssetClient;

  constructor(
    readonly apiClient: NodeApiClient = createSameOriginNodeApiClient(),
  ) {
    const getAuth = async () => {
      await this.ensureAuthFresh();
      return await this.createAuth();
    };
    this.authIdentity = new RemoteAuthIdentity(apiClient);
    this.authController = new RemoteAuthController(
      apiClient,
      this.authIdentity,
      {
        createAuth: () => this.createAuth(),
        requestPassword: (reason) =>
          alertInput(
            reason === "set-password"
              ? language.setNodePassword
              : language.inputNodePassword,
          ),
        reportError: async (message, waitForDismissal) => {
          alertError(message);
          if (waitForDismissal) await waitAlert();
        },
      },
    );
    this.sql = new NodeSqlStorage(getAuth, apiClient);
    this.s3 = new NodeS3Storage(getAuth, apiClient);
    this.assetClient = new RemoteAssetClient(apiClient, () =>
      this.getCachedAuth(),
    );
    this.computeClient = new RemoteComputeClient(apiClient, () =>
      this.getCachedAuth(),
    );
    this.bulkAssetClient = new RemoteBulkAssetClient(apiClient, () =>
      this.getCachedAuth(),
    );
  }

  async createAuth(): Promise<string> {
    return await this.authIdentity.createAuth();
  }

  get authChecked(): boolean {
    return this.authController.authChecked;
  }

  set authChecked(value: boolean) {
    this.authController.authChecked = value;
  }

  private get authValidatedAt(): number {
    return this.authController.authValidatedAt;
  }

  private set authValidatedAt(value: number) {
    this.authController.authValidatedAt = value;
  }

  private async ensureAuthFresh(): Promise<void> {
    await this.authController.ensureFresh();
  }

  async getCachedAuth(): Promise<string> {
    return await this.authController.getCachedAuth();
  }

  async getDirectUrl(
    key: string,
    options?: {
      thumbnail?: boolean;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
      target?: AssetStorageTarget;
    },
  ): Promise<string> {
    return await this.assetClient.getDirectUrl(key, options);
  }

  async getProxyAuth() {
    await this.ensureAuthFresh();
    const auth = await this.createAuth();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("risuauth", auth);
    }
    return auth;
  }

  async getNodeProviderCapabilities(
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderCapabilities> {
    return await this.computeClient.getNodeProviderCapabilities(abortSignal);
  }

  async executeChatProvider(
    request: NodeProviderExecutionRequest,
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderExecutionResult> {
    return await this.computeClient.executeChatProvider(request, abortSignal);
  }

  async executeChatProviderTransport(
    request: NodeProviderTransportRequest,
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderTransportResult> {
    return await this.computeClient.executeChatProviderTransport(
      request,
      abortSignal,
    );
  }

  async planChatContinuation(
    request: NodeChatContinuationRequest,
  ): Promise<NodeChatContinuationDecision> {
    return await this.computeClient.planChatContinuation(request);
  }

  async planChatGeneration(
    request: NodeChatPlanRequest,
  ): Promise<NodeChatGenerationPlan> {
    return await this.computeClient.planChatGeneration(request);
  }

  async tokenizeCountBatch(
    texts: string[],
    encoding: TokenizerEncoding,
  ): Promise<number[]> {
    return await this.computeClient.tokenizeCountBatch(texts, encoding);
  }

  async loreMatchBatch(
    payload: LoreMatchBatchRequest,
  ): Promise<LoreMatchBatchResponse["results"]> {
    return await this.computeClient.loreMatchBatch(payload);
  }

  async loreResolve(payload: LoreResolveRequest): Promise<LoreResolveResponse> {
    return await this.computeClient.loreResolve(payload);
  }

  async vectorIndexStatus(
    indexId: string,
    descriptors?: VectorIndexDescriptor[],
    revision?: string,
  ): Promise<VectorIndexStatusResponse> {
    return await this.computeClient.vectorIndexStatus(
      indexId,
      descriptors,
      revision,
    );
  }

  async vectorIndexUpsert(
    indexId: string,
    entries: VectorIndexEntry[],
  ): Promise<void> {
    await this.computeClient.vectorIndexUpsert(indexId, entries);
  }

  async vectorIndexSearch(
    indexId: string,
    queries: number[][],
    metric: VectorSearchMetric = "cosine",
    topK?: number,
  ): Promise<VectorIndexSearchResult> {
    return await this.computeClient.vectorIndexSearch(
      indexId,
      queries,
      metric,
      topK,
    );
  }

  async vectorCacheStats(): Promise<NodeVectorCacheStats> {
    return await this.computeClient.vectorCacheStats();
  }

  async clearVectorCache(): Promise<NodeVectorCacheClearResult> {
    return await this.computeClient.clearVectorCache();
  }

  async startHypaMemorySession(request: unknown): Promise<any> {
    return await this.computeClient.startHypaMemorySession(request);
  }

  async continueHypaMemorySession(
    sessionId: string,
    actionId: string,
    value: unknown,
  ): Promise<any> {
    return await this.computeClient.continueHypaMemorySession(
      sessionId,
      actionId,
      value,
    );
  }

  async cancelHypaMemorySession(sessionId: string): Promise<void> {
    await this.computeClient.cancelHypaMemorySession(sessionId);
  }

  async getKeyPair(): Promise<CryptoKeyPair> {
    return await this.authIdentity.getKeyPair();
  }

  async setItem(key: string, value: Uint8Array) {
    await this.assetClient.setItem(key, value);
    await this.bulkAssetClient.invalidateCache([key]);
  }

  async setItems(
    items: ReadonlyMap<string, Uint8Array>,
    onProgress?: (progress: NodeStorageBulkWriteProgress) => void,
  ): Promise<void> {
    await this.bulkAssetClient.setItems(items, onProgress);
  }

  async getItemWithMetadata(
    key: string,
    options?: {
      thumbnail?: boolean;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
      target?: AssetStorageTarget;
    },
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const result = await this.assetClient.getItemWithMetadata(key, options);
    return result
      ? { data: Buffer.from(result.data), contentType: result.contentType }
      : null;
  }

  async getItem(
    key: string,
    options?: {
      thumbnail?: boolean;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
      target?: AssetStorageTarget;
    },
  ): Promise<Buffer> {
    const result = await this.getItemWithMetadata(key, options);
    return result?.data ?? null;
  }

  async getItemFromBrowserCache(
    key: string,
    options?: { thumbnail?: boolean; target?: AssetStorageTarget },
  ): Promise<Buffer | null> {
    const data = await this.assetClient.getItemFromBrowserCache(key, options);
    return data ? Buffer.from(data) : null;
  }

  async getItems(
    keys: string[],
    onProgress?: (progress: NodeStorageBulkReadProgress) => void,
    options?: {
      thumbnail?: boolean;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
    },
  ): Promise<Map<string, Buffer>> {
    const items = await this.bulkAssetClient.getItems(keys, onProgress, options);
    return new Map(
      [...items].map(([key, value]) => [key, Buffer.from(value)]),
    );
  }

  async streamItems(
    keys: string[],
    handlers: NodeStorageBulkReadHandlers,
    onProgress?: (progress: NodeStorageBulkReadProgress) => void,
    options?: {
      thumbnail?: boolean;
      prefix?: string;
      size?: "thumb" | "display" | "full";
      width?: number;
      height?: number;
    },
  ): Promise<void> {
    await this.bulkAssetClient.streamItems(keys, handlers, onProgress, options);
  }

  private async loadSyncAssetSizes(
    force = false,
  ): Promise<Map<string, number>> {
    const now = Date.now();
    if (
      !force &&
      this.syncAssetSizeCache &&
      this.syncAssetSizeCache.expiresAt > now
    ) {
      return this.syncAssetSizeCache.sizes;
    }
    if (this.syncAssetSizePromise) return await this.syncAssetSizePromise;
    this.syncAssetSizePromise = (async () => {
      const details = await this.s3.getAssetDetails("active");
      const sizes = new Map<string, number>();
      for (const asset of details.assets ?? []) {
        if (
          typeof asset?.key !== "string" ||
          !Number.isSafeInteger(asset.size) ||
          asset.size < 0
        )
          continue;
        sizes.set(asset.key, asset.size);
      }
      this.syncAssetSizeCache = { expiresAt: Date.now() + 30_000, sizes };
      return sizes;
    })();
    try {
      return await this.syncAssetSizePromise;
    } finally {
      this.syncAssetSizePromise = null;
    }
  }

  async listSyncAssetKeys(prefix = "assets/"): Promise<string[]> {
    const sizes = await this.loadSyncAssetSizes();
    return [...sizes.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async getSyncAssetSize(key: string): Promise<number> {
    let sizes = await this.loadSyncAssetSizes();
    if (!sizes.has(key)) sizes = await this.loadSyncAssetSizes(true);
    const size = sizes.get(key);
    if (size === undefined) {
      throw new StorageSyncAssetReadError(
        `Remote asset '${key}' was not found.`,
        "asset_missing",
      );
    }
    return size;
  }

  async readSyncAssetChunk(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    validateStorageSyncAssetChunkRange(offset, length);
    const size = await this.getSyncAssetSize(key);
    if (offset >= size) {
      throw new StorageSyncAssetReadError(
        `Asset '${key}' offset ${offset} is outside its ${size}-byte range.`,
        "invalid_asset_range",
      );
    }
    const expected = Math.min(length, size - offset);
    const end = offset + expected - 1;
    const hex = Buffer.from(key, "utf8").toString("hex");
    const response = await this.apiClient.request(
      `/api/read?path=${encodeURIComponent(hex)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          range: `bytes=${offset}-${end}`,
          "risu-auth": await this.getCachedAuth(),
        },
      },
    );
    if (
      response.status !== 206 &&
      !(response.ok && offset === 0 && expected === size)
    ) {
      throw new StorageSyncAssetReadError(
        `Remote asset range read failed (${response.status}).`,
        "asset_read_failed",
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== expected) {
      throw new StorageSyncAssetReadError(
        `Remote asset '${key}' changed while it was being read.`,
        "asset_changed",
      );
    }
    return data;
  }

  async keys(prefix = ""): Promise<string[]> {
    return await this.assetClient.keys(prefix);
  }

  async removeItem(key: string | string[]) {
    await this.assetClient.removeItem(key);
    await this.bulkAssetClient.invalidateCache(Array.isArray(key) ? key : [key]);
  }

  private async authorizeKey(password: string): Promise<void> {
    await this.authController.authorizeKey(password);
  }

  getStorageSyncServerOrigin(): string {
    return this.syncClient.serverOrigin;
  }

  async getStorageSyncSummary(
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSummary> {
    return await this.syncClient.getSummary(signal);
  }

  async createStorageSyncSession(
    options: {
      direction: StorageSyncDirection;
      expectedRevision: number;
      peerRevision?: number | null;
    },
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    return await this.syncClient.createSession(options, signal);
  }

  async getStorageSyncSession(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    return await this.syncClient.getSession(id, signal);
  }

  async planStorageSyncAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    return await this.syncClient.planAssets(id, assets, signal);
  }

  async getStorageSyncAssetPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    return await this.syncClient.getAssetPlan(id, signal);
  }

  async uploadStorageSyncAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetChunkResult> {
    return await this.syncClient.uploadAssetChunk(
      id,
      assetId,
      offset,
      data,
      signal,
    );
  }

  async planStorageSyncSql(
    id: string,
    plan: NodeStorageSyncSqlPlanInput,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.syncClient.planSql(id, plan, signal);
  }

  async getStorageSyncSqlPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.syncClient.getSqlPlan(id, signal);
  }

  async uploadStorageSyncSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.syncClient.uploadSqlChunk(id, offset, data, signal);
  }

  async validateStorageSyncSql(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlValidation> {
    return await this.syncClient.validateSql(id, signal);
  }

  async preflightStorageSyncFinalize(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizePreflight> {
    return await this.syncClient.preflightFinalize(id, signal);
  }

  async finalizeStorageSync(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizeResult> {
    return await this.syncClient.finalize(id, signal);
  }

  async cancelStorageSyncSession(id: string): Promise<void> {
    await this.syncClient.cancelSession(id);
  }

  async connectWithPassword(password: string): Promise<void> {
    await this.authController.connectWithPassword(password);
  }

  private async checkAuth(force = false): Promise<void> {
    await this.authController.checkAuth(force);
  }

  listItem = this.keys;
}

const sharedNodeStorage = new NodeStorage();

export async function getNodeServerProxyAuth() {
  try {
    const { getActiveStorageRuntime } =
      await import("../runtime/activeStorageRuntime");
    const storage = getActiveStorageRuntime().assets.realStorage;
    if (storage instanceof NodeStorage) {
      return await storage.getProxyAuth();
    }
  } catch {
    // Some early Node-only callers run before the active runtime is installed.
  }
  return await sharedNodeStorage.getProxyAuth();
}
