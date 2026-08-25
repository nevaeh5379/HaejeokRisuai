import { language } from "src/lang";
import { alertError, alertInput, waitAlert } from "../alert";
import { base64url, getKeypairStore, saveKeypairStore } from "../util";
import { NodePostgresStorage } from "./nodePostgresStorage";
import { NodeS3Storage } from "./nodeS3Storage";
import type { AssetStorageTarget } from "../../../packages/protocol/storageConfig.cjs";
import type {
  NodeChatContinuationDecision,
  NodeChatContinuationRequest,
  NodeChatGenerationPlan,
  NodeChatPlanRequest,
} from "../../../packages/protocol/chatExecutor.cjs";
import type {
  NodeProviderCapabilities,
  NodeProviderExecutionRequest,
  NodeProviderExecutionResult,
} from "../../../packages/protocol/providerExecution.cjs";
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
} from "../../../packages/protocol/compute.cjs";

export {
  NodePostgresPayloadTooLargeError,
  NodePostgresRevisionConflictError,
} from "./nodePostgresStorage";
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
} from "./nodeS3Storage";

export type NodeStorageBulkReadProgress = {
  completedFiles: number;
  totalFiles: number;
  currentFile: string | null;
  receivedBytes: number;
  totalBytes: bigint;
  assetListSource?: string;
};

export type NodeStorageBulkReadHandlers = {
  onFileStart: (name: string, size: bigint) => Promise<void> | void;
  onFileChunk: (name: string, chunk: Uint8Array) => Promise<void> | void;
  onFileEnd?: (name: string) => Promise<void> | void;
};

export type NodeStorageBulkWriteProgress = {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
};

export class NodeStorage {
  authChecked = false;
  private nodeProviderCapabilities: NodeProviderCapabilities | null = null;
  readonly postgres = new NodePostgresStorage(async () => {
    await this.checkAuth();
    return await this.createAuth();
  });
  readonly s3 = new NodeS3Storage(async () => {
    await this.checkAuth();
    return await this.createAuth();
  });
  JSONStringlifyAndbase64Url(obj: any) {
    return base64url(Buffer.from(JSON.stringify(obj), "utf-8"));
  }

  async createAuth() {
    const keyPair = await this.getKeyPair();
    const date = Math.floor(Date.now() / 1000);

    const header = {
      alg: "ES256",
      typ: "JWT",
    };
    const payload = {
      iat: date,
      exp: date + 5 * 60, //5 minutes expiration
      pub: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    };
    const sig = await crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      keyPair.privateKey,
      Buffer.from(
        this.JSONStringlifyAndbase64Url(header) +
          "." +
          this.JSONStringlifyAndbase64Url(payload),
      ),
    );
    const sigString = base64url(new Uint8Array(sig));
    return (
      this.JSONStringlifyAndbase64Url(header) +
      "." +
      this.JSONStringlifyAndbase64Url(payload) +
      "." +
      sigString
    );
  }

  private cachedAuthToken: string = "";
  private cachedAuthTokenExpiresAt: number = 0;

  async getCachedAuth(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (!this.cachedAuthToken || this.cachedAuthTokenExpiresAt - now < 60) {
      await this.checkAuth();
      this.cachedAuthToken = await this.createAuth();
      this.cachedAuthTokenExpiresAt = now + 4 * 60;
    }
    return this.cachedAuthToken;
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
    const auth = await this.getCachedAuth();
    const hex = Buffer.from(key, "utf-8").toString("hex");
    const params: string[] = [];
    if (options?.thumbnail) {
      params.push("thumb=1");
    }
    if (options?.size === "display") {
      params.push("size=display");
    }
    if (options?.width) {
      params.push(`width=${options.width}`);
    }
    if (options?.height) {
      params.push(`height=${options.height}`);
    }
    if (options?.target && options.target !== "active") {
      params.push(`target=${options.target}`);
    }
    params.push(`auth=${encodeURIComponent(auth)}`);
    return `/api/read?path=${hex}&${params.join("&")}`;
  }

  async getProxyAuth() {
    await this.checkAuth();
    const auth = await this.createAuth();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("risuauth", auth);
    }
    return auth;
  }

  async getNodeProviderCapabilities(): Promise<NodeProviderCapabilities> {
    if (this.nodeProviderCapabilities) return this.nodeProviderCapabilities;
    const auth = await this.getCachedAuth();
    const response = await fetch("/api/chat-executor/providers", {
      headers: { "risu-auth": auth },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Server provider capabilities failed (${response.status}): ${message}`);
    }
    const data = (await response.json()) as Partial<NodeProviderCapabilities>;
    if (
      !Array.isArray(data.formats) ||
      data.formats.some((format) => !Number.isInteger(format)) ||
      !Array.isArray(data.routes) ||
      data.routes.some((route) => typeof route !== "string")
    ) {
      throw new Error("Server provider capabilities returned an invalid response");
    }
    this.nodeProviderCapabilities = { formats: data.formats, routes: data.routes };
    return this.nodeProviderCapabilities;
  }

  async executeChatProvider(
    request: NodeProviderExecutionRequest,
  ): Promise<NodeProviderExecutionResult> {
    const auth = await this.getCachedAuth();
    const response = await fetch("/api/chat-executor/provider", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Server provider execution failed (${response.status}): ${message}`);
    }
    const data = (await response.json()) as NodeProviderExecutionResult;
    if (!data || typeof data.handled !== "boolean") {
      throw new Error("Server provider execution returned an invalid response");
    }
    if (data.handled && (!data.response || !["success", "fail"].includes(data.response.type))) {
      throw new Error("Server provider execution returned an invalid provider response");
    }
    return data;
  }

  async planChatContinuation(
    request: NodeChatContinuationRequest,
  ): Promise<NodeChatContinuationDecision> {
    const auth = await this.getCachedAuth();
    const response = await fetch("/api/chat-executor/continuation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Server chat continuation planning failed (${response.status}): ${message}`);
    }
    const data = (await response.json()) as { decision?: NodeChatContinuationDecision };
    if (!data.decision || typeof data.decision.shouldContinue !== "boolean") {
      throw new Error("Server chat continuation planning returned an invalid response");
    }
    return data.decision;
  }

  async planChatGeneration(
    request: NodeChatPlanRequest,
  ): Promise<NodeChatGenerationPlan> {
    const auth = await this.getCachedAuth();
    const response = await fetch("/api/chat-executor/plan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": auth,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Server chat planning failed (${response.status}): ${message}`);
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
      const response = await fetch("/api/tokenize-count", {
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
        throw new Error(`Server tokenization failed (${response.status}): ${message}`);
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
    const response = await fetch("/api/lore-match-batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Server lore matching failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as Partial<LoreMatchBatchResponse>;
    if (!Array.isArray(data.results)) {
      throw new Error("Server lore matching returned an invalid response");
    }
    return data.results as LoreMatchBatchResponse["results"];
  }

  async loreResolve(payload: LoreResolveRequest): Promise<LoreResolveResponse> {
    const response = await fetch("/api/lore-resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.getCachedAuth(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Server recursive lore resolution failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as Partial<LoreResolveResponse>;
    if (!Array.isArray(data.activatedIndexes) || !Array.isArray(data.logs)) {
      throw new Error("Server recursive lore resolution returned an invalid response");
    }
    return data as LoreResolveResponse;
  }

  async vectorIndexStatus(
    indexId: string,
    descriptors?: VectorIndexDescriptor[],
    revision?: string,
  ): Promise<VectorIndexStatusResponse> {
    const response = await fetch("/api/vector-index/status", {
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
      const response = await fetch("/api/vector-index/upsert", {
        method: "POST",
        headers: { "content-type": "application/json", "risu-auth": auth },
        body: JSON.stringify({
          indexId,
          entries: entries.slice(offset, offset + 64),
        } satisfies VectorIndexUpsertRequest),
      });
      if (!response.ok) throw new Error(`Vector index upsert failed (${response.status}): ${await response.text()}`);
    }
  }

  async vectorIndexSearch(
    indexId: string,
    queries: number[][],
    metric: VectorSearchMetric = "cosine",
    topK?: number,
  ): Promise<VectorIndexSearchResult> {
    const response = await fetch("/api/vector-index/search", {
      method: "POST",
      headers: { "content-type": "application/json", "risu-auth": await this.getCachedAuth() },
      body: JSON.stringify({
        indexId,
        queries,
        metric,
        topK,
      } satisfies VectorIndexSearchRequest),
    });
    if (!response.ok) throw new Error(`Vector index search failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as Partial<VectorIndexSearchResponse>;
    if (!Array.isArray(data.results)) throw new Error("Vector index search returned an invalid response");
    return data.results as VectorIndexSearchResult;
  }

  async getKeyPair(): Promise<CryptoKeyPair> {
    const storedKey = await getKeypairStore("node");

    if (storedKey) {
      return storedKey;
    }

    const keyPair = await crypto.subtle.generateKey(
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      false,
      ["sign", "verify"],
    );

    await saveKeypairStore("node", keyPair);

    return keyPair;
  }

  async setItem(key: string, value: Uint8Array) {
    await this.checkAuth();
    const da = await fetch("/api/write", {
      method: "POST",
      body: value as any,
      headers: {
        "content-type": "application/octet-stream",
        "file-path": Buffer.from(key, "utf-8").toString("hex"),
        "risu-auth": await this.createAuth(),
      },
    });
    let data: { error?: string } = {};
    try {
      data = await da.json();
    } catch {}
    if (da.status < 200 || da.status >= 300) {
      throw new Error(data?.error ?? `setItem Error: ${da.status}`);
    }
    if (data.error) {
      throw data.error;
    }
  }

  async setItems(
    items: ReadonlyMap<string, Uint8Array>,
    onProgress?: (progress: NodeStorageBulkWriteProgress) => void,
  ): Promise<void> {
    await this.checkAuth();

    const parts: BlobPart[] = [];
    const chunkSize = 256 * 1024;
    let fileId = 0;

    for (const [name, data] of items) {
      const nameBuffer = Buffer.from(name, "utf8");
      const header = Buffer.alloc(1 + 4 + 4 + nameBuffer.length + 8);
      let offset = 0;

      header.writeUInt8(0x01, offset);
      offset += 1;
      header.writeUInt32BE(fileId, offset);
      offset += 4;
      header.writeUInt32BE(nameBuffer.length, offset);
      offset += 4;
      nameBuffer.copy(header, offset);
      offset += nameBuffer.length;
      header.writeBigUInt64BE(BigInt(data.byteLength), offset);
      parts.push(header as unknown as BlobPart);

      for (
        let dataOffset = 0;
        dataOffset < data.byteLength;
        dataOffset += chunkSize
      ) {
        const chunk = data.subarray(
          dataOffset,
          Math.min(dataOffset + chunkSize, data.byteLength),
        );
        const chunkHeader = Buffer.alloc(1 + 4 + 4);
        chunkHeader.writeUInt8(0x02, 0);
        chunkHeader.writeUInt32BE(fileId, 1);
        chunkHeader.writeUInt32BE(chunk.byteLength, 5);
        parts.push(chunkHeader as unknown as BlobPart);
        parts.push(chunk as unknown as BlobPart);
      }

      const end = Buffer.alloc(1 + 4);
      end.writeUInt8(0x03, 0);
      end.writeUInt32BE(fileId, 1);
      parts.push(end as unknown as BlobPart);
      fileId += 1;
    }

    const body = new Blob(parts, { type: "application/x-risu-bulk" });
    const auth = await this.createAuth();

    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/write-bulk");
      request.responseType = "json";
      request.setRequestHeader("content-type", body.type);
      request.setRequestHeader("risu-auth", auth);

      request.upload.onprogress = (event) => {
        const totalBytes = event.lengthComputable ? event.total : body.size;
        const percent =
          totalBytes === 0
            ? 100
            : Math.min(100, (event.loaded / totalBytes) * 100);
        onProgress?.({
          uploadedBytes: event.loaded,
          totalBytes,
          percent,
        });
      };
      request.onerror = () => reject(new Error("setItems network error"));
      request.onabort = () => reject(new Error("setItems request aborted"));
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          let message = request.response?.error;
          if (
            !message &&
            typeof request.responseText === "string" &&
            request.responseText
          ) {
            try {
              message = JSON.parse(request.responseText)?.error;
            } catch {}
          }
          reject(new Error(message ?? `setItems Error: ${request.status}`));
          return;
        }
        onProgress?.({
          uploadedBytes: body.size,
          totalBytes: body.size,
          percent: 100,
        });
        resolve();
      };

      request.send(body);
    });
  }

  async getItem(
    key: string,
    options?: {
      thumbnail?: boolean;
      target?: AssetStorageTarget;
    },
  ): Promise<Buffer> {
    await this.checkAuth();
    const headers: Record<string, string> = {
      "file-path": Buffer.from(key, "utf-8").toString("hex"),
      "risu-auth": await this.createAuth(),
    };
    if (options?.thumbnail) {
      headers["x-thumbnail"] = "true";
    }
    if (options?.target && options.target !== "active") {
      headers["x-storage-target"] = options.target;
    }
    const targetParam =
      options?.target && options.target !== "active"
        ? `&target=${options.target}`
        : "";
    const thumbParam = options?.thumbnail ? "?thumb=1" : "";
    const query = [thumbParam, targetParam].filter(Boolean).join("&");
    const queryStr = query ? `?${query}` : "";
    const da = await fetch("/api/read" + queryStr, {
      method: "GET",
      cache: "no-cache",
      headers,
    });
    if (da.status < 200 || da.status >= 300) {
      throw "getItem Error";
    }

    const data = Buffer.from(await da.arrayBuffer());
    if (data.length == 0) {
      return null;
    }
    return data;
  }

  async getItemFromBrowserCache(
    key: string,
    options?: {
      thumbnail?: boolean;
      target?: AssetStorageTarget;
    },
  ): Promise<Buffer | null> {
    await this.checkAuth();
    const headers: Record<string, string> = {
      "file-path": Buffer.from(key, "utf-8").toString("hex"),
      "risu-auth": await this.createAuth(),
    };
    if (options?.thumbnail) {
      headers["x-thumbnail"] = "true";
    }
    if (options?.target && options.target !== "active") {
      headers["x-storage-target"] = options.target;
    }
    const targetParam =
      options?.target && options.target !== "active"
        ? `&target=${options.target}`
        : "";
    const thumbParam = options?.thumbnail ? "?thumb=1" : "";
    const query = [thumbParam, targetParam].filter(Boolean).join("&");
    const queryStr = query ? `?${query}` : "";
    let da: Response;
    try {
      da = await fetch("/api/read" + queryStr, {
        method: "GET",
        cache: "force-cache",
        headers,
      });
    } catch {
      return null;
    }
    if (da.status < 200 || da.status >= 300) {
      return null;
    }
    const data = Buffer.from(await da.arrayBuffer());
    if (data.length == 0) {
      return null;
    }
    return data;
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
    const results = new Map<string, Buffer>();
    const receivingChunks = new Map<string, Buffer[]>();

    await this.streamItems(
      keys,
      {
        onFileStart: (name) => {
          receivingChunks.set(name, []);
        },
        onFileChunk: (name, chunk) => {
          const chunks = receivingChunks.get(name);
          if (!chunks) {
            throw new Error(`Received chunk before file start: ${name}`);
          }
          chunks.push(Buffer.from(chunk));
        },
        onFileEnd: (name) => {
          const chunks = receivingChunks.get(name);
          if (!chunks) {
            throw new Error(`Received file end before file start: ${name}`);
          }
          results.set(name, Buffer.concat(chunks));
          receivingChunks.delete(name);
        },
      },
      onProgress,
      options,
    );

    return results;
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
    await this.checkAuth();

    const filePaths = keys.map((key) =>
      Buffer.from(key, "utf8").toString("hex"),
    );

    const isThumb = options?.thumbnail ?? false;
    const isDisplay = options?.size === "display";
    const params: string[] = [];
    if (isThumb) params.push("thumb=1");
    if (isDisplay) params.push("size=display");
    if (options?.width) params.push(`width=${options.width}`);
    if (options?.height) params.push(`height=${options.height}`);
    const queryStr = params.length > 0 ? `?${params.join("&")}` : "";
    const url = `/api/read-bulk${queryStr}`;

    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        ...(options?.prefix ? { prefix: options.prefix } : { filePaths }),
        thumb: isThumb,
        size: options?.size,
        width: options?.width,
        height: options?.height,
      }),
      cache: "no-cache",
      headers: {
        "content-type": "application/json",
        "risu-auth": await this.createAuth(),
      },
    });

    if (!response.ok) {
      throw new Error(`getItems Error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("getItems Error: response body is missing");
    }

    const responseTotal = Number.parseInt(
      response.headers.get("x-risu-total-files") ?? "",
      10,
    );
    const totalFiles = Number.isFinite(responseTotal)
      ? responseTotal
      : keys.length;
    const assetListSource =
      response.headers.get("x-risu-asset-list-source") ?? undefined;

    type ReceivingFile = {
      name: string;
      expectedSize: bigint;
      receivedSize: number;
    };

    const reader = response.body.getReader();
    const receivingFiles = new Map<number, ReceivingFile>();
    let completedFiles = 0;

    let pending = Buffer.alloc(0);

    onProgress?.({
      completedFiles,
      totalFiles,
      currentFile: null,
      receivedBytes: 0,
      totalBytes: 0n,
      assetListSource,
    });

    while (true) {
      const { value, done } = await reader.read();

      if (value) {
        pending = Buffer.concat([pending, Buffer.from(value)]);
      }

      let offset = 0;

      while (offset < pending.length) {
        const available = pending.length - offset;

        if (available < 1) break;

        const type = pending.readUInt8(offset);

        if (type === 0x01) {
          // Type(1) + File ID(4) + NameLength(4)
          if (available < 9) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const nameLength = pending.readUInt32BE(offset + 5);
          const packetLength = 1 + 4 + 4 + nameLength + 8;

          if (available < packetLength) break;

          const nameStart = offset + 9;
          const nameEnd = nameStart + nameLength;

          const name = pending.subarray(nameStart, nameEnd).toString("utf8");

          const expectedSize = pending.readBigUInt64BE(nameEnd);

          receivingFiles.set(fileId, {
            name,
            expectedSize,
            receivedSize: 0,
          });

          await handlers.onFileStart(name, expectedSize);

          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: name,
            receivedBytes: 0,
            totalBytes: expectedSize,
            assetListSource,
          });

          offset += packetLength;
          continue;
        }

        if (type === 0x02) {
          // Type(1) + File ID(4) + ChunkSize(4)
          if (available < 9) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const chunkSize = pending.readUInt32BE(offset + 5);
          const packetLength = 1 + 4 + 4 + chunkSize;

          if (available < packetLength) break;

          const file = receivingFiles.get(fileId);

          if (!file) {
            throw new Error(`Received chunk for unknown file ID: ${fileId}`);
          }

          const chunkStart = offset + 9;
          const chunkEnd = chunkStart + chunkSize;
          const chunk = pending.subarray(chunkStart, chunkEnd);

          file.receivedSize += chunk.length;

          if (BigInt(file.receivedSize) > file.expectedSize) {
            throw new Error(`Received too much data for file: ${file.name}`);
          }

          await handlers.onFileChunk(file.name, chunk);

          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: file.name,
            receivedBytes: file.receivedSize,
            totalBytes: file.expectedSize,
            assetListSource,
          });

          offset += packetLength;
          continue;
        }

        if (type === 0x03) {
          // Type(1) + File ID(4)
          if (available < 5) break;

          const fileId = pending.readUInt32BE(offset + 1);
          const file = receivingFiles.get(fileId);

          if (!file) {
            throw new Error(
              `Received end packet for unknown file ID: ${fileId}`,
            );
          }

          if (BigInt(file.receivedSize) !== file.expectedSize) {
            throw new Error(
              `File size mismatch for ${file.name}: ` +
                `expected ${file.expectedSize}, received ${file.receivedSize}`,
            );
          }

          await handlers.onFileEnd?.(file.name);

          receivingFiles.delete(fileId);
          completedFiles += 1;
          onProgress?.({
            completedFiles,
            totalFiles,
            currentFile: null,
            receivedBytes: 0,
            totalBytes: 0n,
            assetListSource,
          });
          offset += 5;
          continue;
        }

        throw new Error(`Unknown bulk packet type: ${type}`);
      }

      pending = pending.subarray(offset);

      if (done) break;
    }

    if (pending.length !== 0) {
      throw new Error("Bulk response ended with an incomplete packet");
    }

    if (receivingFiles.size !== 0) {
      throw new Error("Bulk response ended before all files were completed");
    }

    if (completedFiles !== totalFiles) {
      throw new Error(
        `Bulk response completed ${completedFiles} of ${totalFiles} files`,
      );
    }
  }

  async keys(prefix = ""): Promise<string[]> {
    await this.checkAuth();
    const search = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    const da = await fetch(`/api/list${search}`, {
      method: "GET",
      headers: {
        "risu-auth": await this.createAuth(),
      },
    });
    if (da.status < 200 || da.status >= 300) {
      throw "listItem Error";
    }
    const data = await da.json();
    if (data.error) {
      throw data.error;
    }
    return data.content;
  }
  async removeItem(key: string | string[]) {
    await this.checkAuth();
    const da = await fetch("/api/remove", {
      method: "GET",
      headers: {
        "file-path": Buffer.from(
          Array.isArray(key) ? key.join("$$") : key,
          "utf-8",
        ).toString("hex"),
        "risu-auth": await this.createAuth(),
      },
    });
    if (da.status < 200 || da.status >= 300) {
      throw "removeItem Error";
    }
    const data = await da.json();
    if (data.error) {
      throw data.error;
    }
  }

  private async authorizeKey(password: string) {
    const keypair = await this.getKeyPair();
    const publicKey = await crypto.subtle.exportKey("jwk", keypair.publicKey);
    const response = await fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({
        password,
        publicKey,
      }),
      headers: {
        "content-type": "application/json",
      },
    });
    if (response.status < 200 || response.status >= 300) {
      let message = `Login failed (${response.status})`;
      try {
        const body = await response.json();
        if (body?.error) {
          message = body.error;
        }
      } catch {}
      alertError(message);
      await waitAlert();
      throw message;
    }
    this.authChecked = true;
  }

  private async checkAuth() {
    if (!this.authChecked) {
      let response: Response;
      try {
        response = await fetch("/api/test_auth", {
          headers: {
            "risu-auth": await this.createAuth(),
          },
        });
      } catch (error) {
        alertError(
          language.errors.networkFetch ||
            "Failed to connect to backend server.",
        );
        throw error;
      }

      if (!response.ok) {
        const message = `Backend server responded with status ${response.status}. Please make sure the backend server (pnpm dev:server) is running.`;
        alertError(message);
        throw new Error(message);
      }

      let data: any;
      try {
        data = await response.json();
      } catch (error) {
        const message = "Invalid JSON response from backend server.";
        alertError(message);
        throw new Error(message);
      }

      if (data?.status === "unset") {
        const input = await digestPassword(
          await alertInput(language.setNodePassword),
        );
        const setRes = await fetch("/api/set_password", {
          method: "POST",
          body: JSON.stringify({
            password: input,
          }),
          headers: {
            "content-type": "application/json",
          },
        });
        if (setRes.status < 200 || setRes.status >= 300) {
          throw new Error(
            `Setting the Node server password failed (${setRes.status})`,
          );
        }
        await this.authorizeKey(input);
      } else if (data?.status === "incorrect") {
        const input = await digestPassword(
          await alertInput(language.inputNodePassword),
        );
        await this.authorizeKey(input);
      } else {
        this.authChecked = true;
      }
    }
  }

  listItem = this.keys;
}

const sharedNodeStorage = new NodeStorage();

export async function getNodeServerProxyAuth() {
  return await sharedNodeStorage.getProxyAuth();
}

async function digestPassword(message: string) {
  const response = await fetch("/api/crypto", {
    body: JSON.stringify({
      data: message,
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (response.status < 200 || response.status >= 300) {
    let message = `Password crypto failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) {
        message = body.error;
      }
    } catch {}
    throw message;
  }
  const crypt = await response.text();

  return crypt;
}
