import {
  type NodeApiClient,
  type NodeStorageSyncAssetChunkResult,
  type NodeStorageSyncAssetManifestEntry,
  type NodeStorageSyncAssetPlan,
  type NodeStorageSyncFinalizePreflight,
  type NodeStorageSyncFinalizeResult,
  type NodeStorageSyncSession,
  type NodeStorageSyncSqlPlan,
  type NodeStorageSyncSqlPlanInput,
  type NodeStorageSyncSqlValidation,
  type NodeStorageSyncSummary,
  type StorageSyncDirection,
} from "./nodeApiClient";

export class RemoteStorageSyncClient {
  constructor(
    private readonly apiClient: NodeApiClient,
    private readonly getAuth: () => Promise<string>,
  ) {}

  get serverOrigin(): string {
    return this.apiClient.baseUrl;
  }

  async getSummary(signal?: AbortSignal): Promise<NodeStorageSyncSummary> {
    return await this.apiClient.getStorageSyncSummary(
      await this.getAuth(),
      signal,
    );
  }

  async createSession(
    options: {
      direction: StorageSyncDirection;
      expectedRevision: number;
      peerRevision?: number | null;
    },
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    return await this.apiClient.createStorageSyncSession(
      options,
      await this.getAuth(),
      signal,
    );
  }

  async getSession(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession> {
    return await this.apiClient.getStorageSyncSession(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async planAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    return await this.apiClient.planStorageSyncAssets(
      id,
      assets,
      await this.getAuth(),
      signal,
    );
  }

  async getAssetPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan> {
    return await this.apiClient.getStorageSyncAssetPlan(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async uploadAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetChunkResult> {
    return await this.apiClient.uploadStorageSyncAssetChunk(
      id,
      assetId,
      offset,
      data,
      await this.getAuth(),
      signal,
    );
  }

  async planSql(
    id: string,
    plan: NodeStorageSyncSqlPlanInput,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.apiClient.planStorageSyncSql(
      id,
      plan,
      await this.getAuth(),
      signal,
    );
  }

  async getSqlPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.apiClient.getStorageSyncSqlPlan(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async uploadSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan> {
    return await this.apiClient.uploadStorageSyncSqlChunk(
      id,
      offset,
      data,
      await this.getAuth(),
      signal,
    );
  }

  async validateSql(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlValidation> {
    return await this.apiClient.validateStorageSyncSql(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async preflightFinalize(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizePreflight> {
    return await this.apiClient.preflightStorageSyncFinalize(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async finalize(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizeResult> {
    return await this.apiClient.finalizeStorageSync(
      id,
      await this.getAuth(),
      signal,
    );
  }

  async cancelSession(id: string): Promise<void> {
    await this.apiClient.cancelStorageSyncSession(id, await this.getAuth());
  }
}
