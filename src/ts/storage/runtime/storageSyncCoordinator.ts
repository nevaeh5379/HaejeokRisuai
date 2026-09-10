import { flushDurableStores } from "../../stores/domain/flushDurableStores";
import type { ISqlStorage } from "../sql/ISqlStorage";
import type {
  NodeStorageSyncAssetChunkResult,
  NodeStorageSyncAssetManifestEntry,
  NodeStorageSyncAssetPlan,
  NodeStorageSyncAssetPlanEntry,
  NodeStorageSyncFinalizePreflight,
  NodeStorageSyncFinalizeResult,
  NodeStorageSyncSession,
  NodeStorageSyncSqlPlan,
  NodeStorageSyncSqlPlanInput,
  NodeStorageSyncSqlValidation,
  NodeStorageSyncSummary,
} from "./nodeApiClient";
import {
  STORAGE_SYNC_ASSET_CHUNK_BYTES,
  STORAGE_SYNC_ASSET_MAX_CONCURRENCY,
  buildStorageSyncAssetManifest,
  type StorageSyncAssetReader,
} from "./storageSyncAssetReader";
import {
  iterateStorageSyncSqlChunks,
  measureStorageSyncSqlSource,
  type StorageSyncSqlSourcePlan,
} from "./storageSyncSource";
import {
  clearStorageSyncResumeState,
  loadStorageSyncResumeState,
  saveStorageSyncResumeState,
  type StorageSyncResumeStorage,
} from "./storageSyncResumeState";

export interface StorageSyncRemoteTarget {
  getStorageSyncServerOrigin(): string;
  getStorageSyncSummary(signal?: AbortSignal): Promise<NodeStorageSyncSummary>;
  createStorageSyncSession(
    options: {
      direction: "local-to-remote";
      expectedRevision: number;
      peerRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession>;
  getStorageSyncSession(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSession>;
  planStorageSyncAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan>;
  getStorageSyncAssetPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetPlan>;
  uploadStorageSyncAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncAssetChunkResult>;
  planStorageSyncSql(
    id: string,
    plan: NodeStorageSyncSqlPlanInput,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan>;
  getStorageSyncSqlPlan(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan>;
  uploadStorageSyncSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlPlan>;
  validateStorageSyncSql(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncSqlValidation>;
  preflightStorageSyncFinalize(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizePreflight>;
  finalizeStorageSync(
    id: string,
    signal?: AbortSignal,
  ): Promise<NodeStorageSyncFinalizeResult>;
}

export type StorageSyncStagePhase =
  | "preview"
  | "assets"
  | "sql"
  | "verifying"
  | "staged"
  | "finalizing"
  | "completed";

export interface StorageSyncStageProgress {
  phase: StorageSyncStagePhase;
  transferredBytes?: number;
  totalBytes?: number;
  currentKey?: string;
}

export interface LocalToRemoteStageResult {
  session: NodeStorageSyncSession;
  assetPlan: NodeStorageSyncAssetPlan;
  sqlPlan: NodeStorageSyncSqlPlan;
  sqlSourcePlan: StorageSyncSqlSourcePlan;
  sourceRevision: number;
  targetRevision: number;
}
export class StorageSyncAlreadyFinalizedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly result: NodeStorageSyncFinalizeResult,
  ) {
    super("The saved storage sync session has already finalized successfully.");
    this.name = "StorageSyncAlreadyFinalizedError";
  }
}

export class StorageSyncPlanMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageSyncPlanMismatchError";
  }
}

export class StorageSyncResumeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageSyncResumeConflictError";
  }
}

export class StorageSyncTargetChangedError extends Error {
  constructor() {
    super(
      "The remote target changed while the sync was staging. Refresh the preview and retry.",
    );
    this.name = "StorageSyncTargetChangedError";
  }
}

export class StorageSyncSourceAssetsChangedError extends Error {
  constructor() {
    super(
      "Local assets changed while the sync was staging. Refresh the preview and retry.",
    );
    this.name = "StorageSyncSourceAssetsChangedError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  signal.throwIfAborted();
}
function manifestFingerprint(
  entries: NodeStorageSyncAssetManifestEntry[],
): string {
  return JSON.stringify(
    [...entries]
      .map(({ key, size, sha256 }) => ({ key, size, sha256 }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function assertAssetPlanMatchesSource(
  manifest: NodeStorageSyncAssetManifestEntry[],
  plan: NodeStorageSyncAssetPlan,
): void {
  if (manifestFingerprint(manifest) !== manifestFingerprint(plan.assets)) {
    throw new StorageSyncPlanMismatchError(
      "The staged asset plan does not match the current local asset manifest.",
    );
  }
}

function assertSqlPlanMatchesSource(
  source: StorageSyncSqlSourcePlan,
  remote: NodeStorageSyncSqlPlan,
): void {
  if (
    source.formatVersion !== remote.formatVersion ||
    source.size !== remote.size ||
    source.recordCount !== remote.recordCount ||
    source.sha256 !== remote.sha256
  ) {
    throw new StorageSyncPlanMismatchError(
      "The staged SQL plan does not match the current local database stream.",
    );
  }
  if (remote.offset < 0 || remote.offset > source.size) {
    throw new StorageSyncPlanMismatchError(
      "The staged SQL offset is outside the source stream.",
    );
  }
}
function activeSummaryFingerprint(summary: NodeStorageSyncSummary): string {
  return JSON.stringify({
    revision: summary.revision,
    initialized: summary.initialized,
    records: summary.records,
    assets: summary.assets,
  });
}

function assertTargetUnchanged(
  expected: NodeStorageSyncSummary,
  current: NodeStorageSyncSummary,
): void {
  if (
    activeSummaryFingerprint(expected) !== activeSummaryFingerprint(current)
  ) {
    throw new StorageSyncTargetChangedError();
  }
}

function sourcePlanInput(
  plan: StorageSyncSqlSourcePlan,
): NodeStorageSyncSqlPlanInput {
  return {
    formatVersion: plan.formatVersion,
    size: plan.size,
    recordCount: plan.recordCount,
    sha256: plan.sha256,
  };
}

async function requireSourceSummary(sourceSql: ISqlStorage) {
  const summary = await sourceSql.getStorageSyncSummary();
  if (!summary) throw new Error("Local SQL storage is unavailable for sync.");
  return summary;
}

function initialTransferredBytes(plan: NodeStorageSyncAssetPlan): number {
  return plan.assets.reduce((total, asset) => total + asset.offset, 0);
}
async function uploadAsset(
  target: StorageSyncRemoteTarget,
  reader: StorageSyncAssetReader,
  session: NodeStorageSyncSession,
  asset: NodeStorageSyncAssetPlanEntry,
  signal: AbortSignal | undefined,
  onProgress: ((progress: StorageSyncStageProgress) => void) | undefined,
  progress: { transferred: number; total: number },
): Promise<void> {
  if (asset.state === "skipped" || asset.state === "ready") return;
  if (asset.offset < 0 || asset.offset > asset.size) {
    throw new StorageSyncPlanMismatchError(
      `Invalid staged offset for asset '${asset.key}'.`,
    );
  }
  const chunkSize = Math.max(
    1,
    Math.min(session.chunkSizeBytes, STORAGE_SYNC_ASSET_CHUNK_BYTES),
  );
  let offset = asset.offset;
  while (offset < asset.size) {
    throwIfAborted(signal);
    const length = Math.min(chunkSize, asset.size - offset);
    const data = await reader.readChunk(asset.key, offset, length);
    if (data.byteLength !== length) {
      throw new StorageSyncSourceAssetsChangedError();
    }
    const result = await target.uploadStorageSyncAssetChunk(
      session.id,
      asset.id,
      offset,
      data,
      signal,
    );
    const expectedOffset = offset + data.byteLength;
    if (result.id !== asset.id || result.offset !== expectedOffset) {
      throw new StorageSyncPlanMismatchError(
        `Remote asset offset did not advance for '${asset.key}'.`,
      );
    }
    progress.transferred += data.byteLength;
    offset = result.offset;
    onProgress?.({
      phase: "assets",
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      currentKey: asset.key,
    });
  }
}
async function uploadPlannedAssets(
  target: StorageSyncRemoteTarget,
  reader: StorageSyncAssetReader,
  session: NodeStorageSyncSession,
  plan: NodeStorageSyncAssetPlan,
  signal?: AbortSignal,
  onProgress?: (progress: StorageSyncStageProgress) => void,
): Promise<NodeStorageSyncAssetPlan> {
  const pending = plan.assets.filter(
    (asset) => asset.state === "pending" || asset.state === "receiving",
  );
  const progress = {
    transferred: initialTransferredBytes(plan),
    total: plan.totalBytes,
  };
  let next = 0;
  const concurrency = Math.max(
    1,
    Math.min(
      session.maxConcurrency,
      STORAGE_SYNC_ASSET_MAX_CONCURRENCY,
      pending.length || 1,
    ),
  );
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= pending.length) return;
      await uploadAsset(
        target,
        reader,
        session,
        pending[index],
        signal,
        onProgress,
        progress,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const finalPlan = await target.getStorageSyncAssetPlan(session.id, signal);
  if (
    finalPlan.remainingBytes !== 0 ||
    finalPlan.assets.some(
      (asset) => asset.state !== "ready" && asset.state !== "skipped",
    )
  ) {
    throw new StorageSyncPlanMismatchError(
      "Remote assets did not reach the ready state.",
    );
  }
  return finalPlan;
}
async function uploadSqlStream(
  target: StorageSyncRemoteTarget,
  sourceSql: ISqlStorage,
  session: NodeStorageSyncSession,
  sourcePlan: StorageSyncSqlSourcePlan,
  remotePlan: NodeStorageSyncSqlPlan,
  signal?: AbortSignal,
  onProgress?: (progress: StorageSyncStageProgress) => void,
): Promise<NodeStorageSyncSqlPlan> {
  if (remotePlan.state === "ready") return remotePlan;
  let remoteOffset = remotePlan.offset;
  let sourceOffset = 0;
  const chunkSize = Math.max(
    1,
    Math.min(session.chunkSizeBytes, 4 * 1024 * 1024),
  );

  for await (const chunk of iterateStorageSyncSqlChunks(sourceSql, {
    expectedRevision: sourcePlan.sourceRevision,
    chunkSize,
  })) {
    throwIfAborted(signal);
    const chunkStart = sourceOffset;
    const chunkEnd = chunkStart + chunk.byteLength;
    sourceOffset = chunkEnd;
    if (chunkEnd <= remoteOffset) continue;
    const start = Math.max(0, remoteOffset - chunkStart);
    const data = chunk.subarray(start);
    if (data.byteLength === 0) continue;
    const next = await target.uploadStorageSyncSqlChunk(
      session.id,
      remoteOffset,
      data,
      signal,
    );
    const expectedOffset = remoteOffset + data.byteLength;
    if (next.offset !== expectedOffset) {
      throw new StorageSyncPlanMismatchError(
        "Remote SQL offset did not advance as expected.",
      );
    }
    remoteOffset = next.offset;
    remotePlan = next;
    onProgress?.({
      phase: "sql",
      transferredBytes: remoteOffset,
      totalBytes: sourcePlan.size,
    });
  }
  if (
    sourceOffset !== sourcePlan.size ||
    remoteOffset !== sourcePlan.size ||
    remotePlan.state !== "ready"
  ) {
    throw new StorageSyncPlanMismatchError(
      "Remote SQL stream did not reach the ready state.",
    );
  }
  return remotePlan;
}

function assertResumeSession(
  session: NodeStorageSyncSession,
  sourceRevision: number,
): void {
  if (
    session.direction !== "local-to-remote" ||
    session.role !== "target" ||
    session.peerRevision !== sourceRevision
  ) {
    throw new StorageSyncResumeConflictError(
      "The saved sync session no longer matches the current local source revision.",
    );
  }
}

async function resolveSession(
  target: StorageSyncRemoteTarget,
  sourceRevision: number,
  targetSummary: NodeStorageSyncSummary,
  resumeStorage: StorageSyncResumeStorage | null | undefined,
  signal?: AbortSignal,
): Promise<NodeStorageSyncSession> {
  const serverOrigin = target.getStorageSyncServerOrigin();
  const resume = loadStorageSyncResumeState(resumeStorage);
  if (
    resume &&
    resume.serverOrigin === serverOrigin &&
    resume.direction === "local-to-remote"
  ) {
    if (resume.sourceRevision !== sourceRevision) {
      throw new StorageSyncResumeConflictError(
        "Local data changed since the saved sync session was created. Refresh the preview before continuing.",
      );
    }
    const session = await target.getStorageSyncSession(
      resume.sessionId,
      signal,
    );
    assertResumeSession(session, sourceRevision);
    return session;
  }
  const session = await target.createStorageSyncSession(
    {
      direction: "local-to-remote",
      expectedRevision: targetSummary.revision,
      peerRevision: sourceRevision,
    },
    signal,
  );
  saveStorageSyncResumeState(
    {
      version: 1,
      serverOrigin,
      sessionId: session.id,
      direction: "local-to-remote",
      sourceRevision,
      createdAt: Date.now(),
    },
    resumeStorage,
  );
  return session;
}

export interface StageLocalToRemoteOptions {
  sourceSql: ISqlStorage;
  sourceAssets: StorageSyncAssetReader;
  target: StorageSyncRemoteTarget;
  resumeStorage?: StorageSyncResumeStorage | null;
  signal?: AbortSignal;
  onProgress?: (progress: StorageSyncStageProgress) => void;
  flushPendingWrites?: () => Promise<void>;
}

export async function stageLocalStorageToRemote(
  options: StageLocalToRemoteOptions,
): Promise<LocalToRemoteStageResult> {
  const {
    sourceSql,
    sourceAssets,
    target,
    resumeStorage,
    signal,
    onProgress,
    flushPendingWrites = flushDurableStores,
  } = options;
  throwIfAborted(signal);
  onProgress?.({ phase: "preview" });
  await flushPendingWrites();
  throwIfAborted(signal);
  const sourceSummary = await requireSourceSummary(sourceSql);
  const sourceRevision = sourceSummary.revision;
  const targetSummary = await target.getStorageSyncSummary(signal);
  const assetManifest = await buildStorageSyncAssetManifest(sourceAssets);
  const sqlSourcePlan = await measureStorageSyncSqlSource(sourceSql, {
    expectedRevision: sourceRevision,
  });
  const session = await resolveSession(
    target,
    sourceRevision,
    targetSummary,
    resumeStorage,
    signal,
  );
  assertResumeSession(session, sourceRevision);
  if (session.status === "finalized" && session.finalizedResult) {
    if (session.finalizedResult.sourceRevision !== sourceRevision) {
      throw new StorageSyncResumeConflictError(
        "The finalized sync result belongs to a different local source revision.",
      );
    }
    throw new StorageSyncAlreadyFinalizedError(
      session.id,
      session.finalizedResult,
    );
  }
  assertTargetUnchanged(session.summary, targetSummary);

  const plannedAssets = await target.planStorageSyncAssets(
    session.id,
    assetManifest,
    signal,
  );
  assertAssetPlanMatchesSource(assetManifest, plannedAssets);
  onProgress?.({
    phase: "assets",
    transferredBytes: initialTransferredBytes(plannedAssets),
    totalBytes: plannedAssets.totalBytes,
  });
  const assetPlan = await uploadPlannedAssets(
    target,
    sourceAssets,
    session,
    plannedAssets,
    signal,
    onProgress,
  );
  assertAssetPlanMatchesSource(assetManifest, assetPlan);
  const plannedSql = await target.planStorageSyncSql(
    session.id,
    sourcePlanInput(sqlSourcePlan),
    signal,
  );
  assertSqlPlanMatchesSource(sqlSourcePlan, plannedSql);
  onProgress?.({
    phase: "sql",
    transferredBytes: plannedSql.offset,
    totalBytes: sqlSourcePlan.size,
  });

  const sqlPlan = await uploadSqlStream(
    target,
    sourceSql,
    session,
    sqlSourcePlan,
    plannedSql,
    signal,
    onProgress,
  );
  assertSqlPlanMatchesSource(sqlSourcePlan, sqlPlan);
  const validation = await target.validateStorageSyncSql(session.id, signal);
  if (
    validation.recordCount !== sqlSourcePlan.recordCount ||
    validation.sourceRevision !== sourceRevision
  ) {
    throw new StorageSyncPlanMismatchError(
      "Remote SQL validation does not match the staged local source.",
    );
  }

  onProgress?.({ phase: "verifying" });
  const finalAssetManifest = await buildStorageSyncAssetManifest(sourceAssets);
  if (
    manifestFingerprint(finalAssetManifest) !==
    manifestFingerprint(assetManifest)
  ) {
    throw new StorageSyncSourceAssetsChangedError();
  }
  await flushPendingWrites();
  throwIfAborted(signal);
  const finalSourceSummary = await requireSourceSummary(sourceSql);
  if (finalSourceSummary.revision !== sourceRevision) {
    throw new StorageSyncResumeConflictError(
      "Local SQL data changed while the sync was staging. Refresh the preview and retry.",
    );
  }
  const finalTargetSummary = await target.getStorageSyncSummary(signal);
  assertTargetUnchanged(session.summary, finalTargetSummary);

  const finalSession = await target.getStorageSyncSession(session.id, signal);
  assertResumeSession(finalSession, sourceRevision);
  if (finalSession.status !== "sql-ready") {
    throw new StorageSyncPlanMismatchError(
      "Remote sync session did not reach the SQL-ready state.",
    );
  }

  const preflight = await target.preflightStorageSyncFinalize(
    session.id,
    signal,
  );
  if (
    preflight.status !== "ready" ||
    preflight.targetRevision !== session.summary.revision ||
    preflight.sourceRevision !== sourceRevision ||
    preflight.recordCount !== sqlSourcePlan.recordCount
  ) {
    throw new StorageSyncPlanMismatchError(
      "Remote finalize preflight does not match the staged source and target.",
    );
  }

  onProgress?.({
    phase: "staged",
    transferredBytes: sqlSourcePlan.size,
    totalBytes: sqlSourcePlan.size,
  });
  return {
    session: finalSession,
    assetPlan,
    sqlPlan,
    sqlSourcePlan,
    sourceRevision,
    targetRevision: targetSummary.revision,
  };
}

export interface LocalToRemoteSyncResult {
  finalized: NodeStorageSyncFinalizeResult;
  staged?: LocalToRemoteStageResult;
  resumedFinalized: boolean;
}

export async function syncLocalStorageToRemote(
  options: StageLocalToRemoteOptions,
): Promise<LocalToRemoteSyncResult> {
  const { target, resumeStorage, signal, onProgress } = options;
  try {
    const staged = await stageLocalStorageToRemote(options);
    throwIfAborted(signal);
    onProgress?.({ phase: "finalizing" });
    const finalized = await target.finalizeStorageSync(
      staged.session.id,
      signal,
    );
    if (
      finalized.sourceRevision !== staged.sourceRevision ||
      finalized.targetRevisionBefore !== staged.targetRevision ||
      finalized.recordCount !== staged.sqlSourcePlan.recordCount
    ) {
      throw new StorageSyncPlanMismatchError(
        "Remote finalize result does not match the staged source and target.",
      );
    }
    clearStorageSyncResumeState(staged.session.id, resumeStorage);
    onProgress?.({ phase: "completed" });
    return { finalized, staged, resumedFinalized: false };
  } catch (error) {
    if (!(error instanceof StorageSyncAlreadyFinalizedError)) throw error;
    clearStorageSyncResumeState(error.sessionId, resumeStorage);
    onProgress?.({ phase: "completed" });
    return {
      finalized: error.result,
      resumedFinalized: true,
    };
  }
}
