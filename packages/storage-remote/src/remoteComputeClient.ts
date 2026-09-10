import type {
  NodeChatContinuationDecision,
  NodeChatContinuationRequest,
  NodeChatGenerationPlan,
  NodeChatPlanRequest,
} from "@risuai/protocol/chatExecutor.cjs";
import type {
  NodeProviderCapabilities,
  NodeProviderExecutionRequest,
  NodeProviderExecutionResult,
  NodeProviderTransportRequest,
  NodeProviderTransportResult,
} from "@risuai/protocol/providerExecution.cjs";
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
} from "@risuai/protocol/compute.cjs";
import type { NodeApiClient } from "./nodeApiClient";

export type NodeVectorCacheStats = {
  vector: {
    memory: { indexes: number; vectors: number; bytes: number };
    disk: {
      enabled: boolean;
      indexes: number;
      vectors: number;
      bytes: number;
      pendingWrites: number;
    };
    limits: {
      memoryBytes: number;
      perIndexMemoryBytes: number;
      diskBytes: number;
      memoryIndexes: number;
      vectorsPerIndex: number;
    };
  };
  query: {
    entries: number;
    bytes: number;
    hits: number;
    misses: number;
    coalesced: number;
    limits: { entries: number; bytes: number };
  };
};

export type NodeVectorCacheClearResult = {
  vector: {
    memoryIndexes: number;
    memoryVectors: number;
    diskIndexes: number;
    diskBytes: number;
  };
  query: { entries: number; bytes: number };
};

export class RemoteComputeClient {
  private nodeProviderCapabilities: NodeProviderCapabilities | null = null;

  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
  ) {}

  private async getCachedAuth(): Promise<string> {
    return await this.getAuth();
  }

  async getNodeProviderCapabilities(
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderCapabilities> {
    if (this.nodeProviderCapabilities) return this.nodeProviderCapabilities;
    const auth = await this.getCachedAuth();
    const response = await this.apiClient.request(
      "/api/chat-executor/providers",
      {
        headers: { "risu-auth": auth },
        signal: abortSignal ?? undefined,
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Server provider capabilities failed (${response.status}): ${message}`,
      );
    }
    const data = (await response.json()) as Partial<NodeProviderCapabilities>;
    if (
      !Array.isArray(data.formats) ||
      data.formats.some((format) => !Number.isInteger(format)) ||
      !Array.isArray(data.routes) ||
      data.routes.some((route) => typeof route !== "string") ||
      (data.transportFormats !== undefined &&
        (!Array.isArray(data.transportFormats) ||
          data.transportFormats.some((format) => !Number.isInteger(format))))
    ) {
      throw new Error(
        "Server provider capabilities returned an invalid response",
      );
    }
    this.nodeProviderCapabilities = {
      formats: data.formats,
      routes: data.routes,
      transportFormats: data.transportFormats ?? [],
    };
    return this.nodeProviderCapabilities;
  }

  async executeChatProvider(
    request: NodeProviderExecutionRequest,
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderExecutionResult> {
    const auth = await this.getCachedAuth();
    const response = await this.apiClient.request(
      "/api/chat-executor/provider",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify(request),
        signal: abortSignal ?? undefined,
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Server provider execution failed (${response.status}): ${message}`,
      );
    }
    const data = (await response.json()) as NodeProviderExecutionResult;
    if (!data || typeof data.handled !== "boolean") {
      throw new Error("Server provider execution returned an invalid response");
    }
    if (
      data.handled &&
      (!data.response || !["success", "fail"].includes(data.response.type))
    ) {
      throw new Error(
        "Server provider execution returned an invalid provider response",
      );
    }
    return data;
  }

  async executeChatProviderTransport(
    request: NodeProviderTransportRequest,
    abortSignal?: AbortSignal | null,
  ): Promise<NodeProviderTransportResult> {
    const auth = await this.getCachedAuth();
    const response = await this.apiClient.request(
      "/api/chat-executor/transport",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify(request),
        signal: abortSignal ?? undefined,
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Server provider transport failed (${response.status}): ${message}`,
      );
    }
    const data = (await response.json()) as NodeProviderTransportResult;
    if (!data || typeof data.handled !== "boolean") {
      throw new Error("Server provider transport returned an invalid response");
    }
    if (
      data.handled &&
      (!data.response ||
        typeof data.response.ok !== "boolean" ||
        !Number.isInteger(data.response.status))
    ) {
      throw new Error(
        "Server provider transport returned an invalid transport response",
      );
    }
    return data;
  }

  async planChatContinuation(
    request: NodeChatContinuationRequest,
  ): Promise<NodeChatContinuationDecision> {
    const auth = await this.getCachedAuth();
    const response = await this.apiClient.request(
      "/api/chat-executor/continuation",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Server chat continuation planning failed (${response.status}): ${message}`,
      );
    }
    const data = (await response.json()) as {
      decision?: NodeChatContinuationDecision;
    };
    if (!data.decision || typeof data.decision.shouldContinue !== "boolean") {
      throw new Error(
        "Server chat continuation planning returned an invalid response",
      );
    }
    return data.decision;
  }

  async planChatGeneration(
    request: NodeChatPlanRequest,
  ): Promise<NodeChatGenerationPlan> {
    const auth = await this.getCachedAuth();
    const response = await this.apiClient.request("/api/chat-executor/plan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Server chat planning failed (${response.status}): ${message}`,
      );
    }
    const data = (await response.json()) as { plan?: NodeChatGenerationPlan };
    if (!data.plan || typeof data.plan.ok !== "boolean") {
      throw new Error("Server chat planning returned an invalid response");
    }
    return data.plan;
  }

  async tokenizeCountBatch(
    texts: string[],
    encoding: TokenizerEncoding,
  ): Promise<number[]> {
    if (texts.length === 0) return [];

    const counts: number[] = [];
    const auth = await this.getCachedAuth();
    for (let offset = 0; offset < texts.length; offset += 1024) {
      const response = await this.apiClient.request("/api/tokenize-count", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": auth,
        },
        body: JSON.stringify({
          encoding,
          texts: texts.slice(offset, offset + 1024),
        } satisfies TokenizeCountRequest),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `Server tokenization failed (${response.status}): ${message}`,
        );
      }
      const data = (await response.json()) as Partial<TokenizeCountResponse>;
      if (!Array.isArray(data.counts)) {
        throw new Error("Server tokenization returned an invalid response");
      }
      counts.push(...data.counts);
    }
    return counts;
  }

  async loreMatchBatch(
    payload: LoreMatchBatchRequest,
  ): Promise<LoreMatchBatchResponse["results"]> {
    if (payload.requests.length === 0) return [];
    const response = await this.apiClient.request("/api/lore-match-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `Server lore matching failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as Partial<LoreMatchBatchResponse>;
    if (!Array.isArray(data.results)) {
      throw new Error("Server lore matching returned an invalid response");
    }
    return data.results as LoreMatchBatchResponse["results"];
  }

  async loreResolve(payload: LoreResolveRequest): Promise<LoreResolveResponse> {
    const response = await this.apiClient.request("/api/lore-resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `Server recursive lore resolution failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as Partial<LoreResolveResponse>;
    if (!Array.isArray(data.activatedIndexes) || !Array.isArray(data.logs)) {
      throw new Error(
        "Server recursive lore resolution returned an invalid response",
      );
    }
    return data as LoreResolveResponse;
  }

  async vectorIndexStatus(
    indexId: string,
    descriptors?: VectorIndexDescriptor[],
    revision?: string,
  ): Promise<VectorIndexStatusResponse> {
    const response = await this.apiClient.request("/api/vector-index/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify({
        indexId,
        descriptors,
        revision,
      } satisfies VectorIndexStatusRequest),
    });
    if (!response.ok) {
      throw new Error(
        `Vector index status failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as Partial<VectorIndexStatusResponse>;
    if (
      typeof data.ready !== "boolean" ||
      !Array.isArray(data.missingIds) ||
      typeof data.size !== "number"
    ) {
      throw new Error("Vector index status returned an invalid response");
    }
    return data as VectorIndexStatusResponse;
  }

  async vectorIndexUpsert(
    indexId: string,
    entries: VectorIndexEntry[],
  ): Promise<void> {
    const auth = await this.getCachedAuth();
    for (let offset = 0; offset < entries.length; offset += 64) {
      const response = await this.apiClient.request(
        "/api/vector-index/upsert",
        {
          method: "POST",
          headers: { "content-type": "application/json", "risu-auth": auth },
          body: JSON.stringify({
            indexId,
            entries: entries.slice(offset, offset + 64),
          } satisfies VectorIndexUpsertRequest),
        },
      );
      if (!response.ok)
        throw new Error(
          `Vector index upsert failed (${response.status}): ${await response.text()}`,
        );
    }
  }

  async vectorIndexSearch(
    indexId: string,
    queries: number[][],
    metric: VectorSearchMetric = "cosine",
    topK?: number,
  ): Promise<VectorIndexSearchResult> {
    const response = await this.apiClient.request("/api/vector-index/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify({
        indexId,
        queries,
        metric,
        topK,
      } satisfies VectorIndexSearchRequest),
    });
    if (!response.ok)
      throw new Error(
        `Vector index search failed (${response.status}): ${await response.text()}`,
      );
    const data = (await response.json()) as Partial<VectorIndexSearchResponse>;
    if (!Array.isArray(data.results))
      throw new Error("Vector index search returned an invalid response");
    return data.results as VectorIndexSearchResult;
  }

  async vectorCacheStats(): Promise<NodeVectorCacheStats> {
    const response = await this.apiClient.request("/api/vector-index/cache", {
      headers: { "risu-auth": await this.getCachedAuth() },
    });
    if (!response.ok) {
      throw new Error(
        `Vector cache stats failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as Partial<NodeVectorCacheStats>;
    if (
      typeof data.vector?.memory?.indexes !== "number" ||
      typeof data.vector?.disk?.bytes !== "number" ||
      typeof data.query?.entries !== "number"
    ) {
      throw new Error("Vector cache stats returned an invalid response");
    }
    return data as NodeVectorCacheStats;
  }

  async clearVectorCache(): Promise<NodeVectorCacheClearResult> {
    const response = await this.apiClient.request("/api/vector-index/cache", {
      method: "DELETE",
      headers: { "risu-auth": await this.getCachedAuth() },
    });
    if (!response.ok) {
      throw new Error(
        `Vector cache clear failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as Partial<NodeVectorCacheClearResult>;
    if (
      typeof data.vector?.memoryIndexes !== "number" ||
      typeof data.vector?.diskIndexes !== "number" ||
      typeof data.query?.entries !== "number"
    ) {
      throw new Error("Vector cache clear returned an invalid response");
    }
    return data as NodeVectorCacheClearResult;
  }

  async startHypaMemorySession(request: unknown): Promise<any> {
    const response = await this.apiClient.request("/api/hypa-memory/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      const error = new Error(
        `Server Hypa memory start failed (${response.status}): ${message}`,
      );
      (error as any).status = response.status;
      throw error;
    }
    return await response.json();
  }

  async continueHypaMemorySession(
    sessionId: string,
    actionId: string,
    value: unknown,
  ): Promise<any> {
    const response = await this.apiClient.request(
      `/api/hypa-memory/${encodeURIComponent(sessionId)}/continue`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": await this.getCachedAuth(),
        },
        body: JSON.stringify({ actionId, value }),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      const error = new Error(
        `Server Hypa memory continuation failed (${response.status}): ${message}`,
      );
      (error as any).status = response.status;
      throw error;
    }
    return await response.json();
  }

  async cancelHypaMemorySession(sessionId: string): Promise<void> {
    try {
      await this.apiClient.request(
        `/api/hypa-memory/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { "risu-auth": await this.getCachedAuth() },
        },
      );
    } catch {
      // Best-effort cleanup only. Server sessions also expire automatically.
    }
  }
}
