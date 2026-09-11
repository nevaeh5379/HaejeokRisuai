"use strict";

const { createStorageSyncSummary } = require("./storageSync.cjs");

class StorageSyncFinalizeError extends Error {
  constructor(message, code = "finalize_preflight_failed") {
    super(message);
    this.name = "StorageSyncFinalizeError";
    this.code = code;
  }
}

function summaryFingerprint(summary) {
  return JSON.stringify({
    protocolVersion: summary?.protocolVersion,
    revision: summary?.revision,
    initialized: summary?.initialized,
    records: summary?.records,
    assets: summary?.assets,
  });
}

function assertReadySession(session) {
  if (
    !session ||
    session.role !== "target" ||
    session.direction !== "local-to-remote"
  ) {
    throw new StorageSyncFinalizeError(
      "Storage sync session is not a local-to-remote target session",
      "invalid_finalize_session",
    );
  }
  if (session.status !== "sql-ready") {
    throw new StorageSyncFinalizeError(
      "Storage sync session has not finished SQL staging",
      "sql_not_ready",
    );
  }
}
async function preflightStorageSyncFinalize(options) {
  const { session, sqlStaging, assetStaging, sqlStorage, assetStorage } =
    options;
  assertReadySession(session);

  const assetPlan = assetStaging.getPlan(session);
  if (
    assetPlan.remainingBytes !== 0 ||
    assetPlan.assets.some(
      (asset) => asset.state !== "ready" && asset.state !== "skipped",
    )
  ) {
    throw new StorageSyncFinalizeError(
      "Storage sync assets are not ready for finalize",
      "assets_not_ready",
    );
  }

  const currentSummary = await createStorageSyncSummary(
    sqlStorage,
    assetStorage,
  );
  if (
    summaryFingerprint(currentSummary) !== summaryFingerprint(session.summary)
  ) {
    throw new StorageSyncFinalizeError(
      "Storage sync target changed while staging",
      "target_changed",
    );
  }
  const skippedAssets = await assetStaging.verifySkippedAssets(
    session,
    assetStorage,
  );
  const validation = await sqlStaging.validate(session);
  if (validation.sourceRevision !== session.peerRevision) {
    throw new StorageSyncFinalizeError(
      "Validated SQL source revision does not match the sync session",
      "source_revision_mismatch",
    );
  }

  return {
    status: "ready",
    targetRevision: currentSummary.revision,
    sourceRevision: validation.sourceRevision,
    recordCount: validation.recordCount,
    skippedAssetsVerified: skippedAssets.verifiedCount,
  };
}


class StorageSyncFinalizeGate {
  constructor() {
    this.active = null;
    this.activeRequests = 0;
  }

  enterRequest() {
    if (this.active) return null;
    this.activeRequests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0 && this.active?.resolveDrain) {
        const resolve = this.active.resolveDrain;
        delete this.active.resolveDrain;
        resolve();
      }
    };
  }

  async acquire(sessionId) {
    if (this.active) {
      throw new StorageSyncFinalizeError(
        `Storage sync finalize is already running for session ${this.active.sessionId}`,
        "finalize_in_progress",
      );
    }
    const token = Symbol("storage-sync-finalize");
    let resolveDrain = null;
    const drained =
      this.activeRequests === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            resolveDrain = resolve;
          });
    this.active = {
      sessionId: String(sessionId),
      startedAt: Date.now(),
      phase: this.activeRequests === 0 ? "finalizing" : "draining",
      token,
      ...(resolveDrain ? { resolveDrain } : {}),
    };
    await drained;
    if (this.active?.token === token) this.active.phase = "finalizing";
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active?.token === token) this.active = null;
    };
  }

  isLocked() {
    return this.active !== null;
  }

  status() {
    if (!this.active) return null;
    return {
      sessionId: this.active.sessionId,
      startedAt: this.active.startedAt,
      phase: this.active.phase,
      activeRequests: this.activeRequests,
    };
  }
}

function asTargetChanged(error) {
  if (!Number.isSafeInteger(error?.revision)) return error;
  const wrapped = new StorageSyncFinalizeError(
    `Storage sync target changed to revision ${error.revision} before commit`,
    "target_changed",
  );
  wrapped.currentRevision = error.revision;
  return wrapped;
}

async function finalizeStorageSyncReplacement(options) {
  const {
    session,
    sqlStaging,
    assetStaging,
    sqlStorage,
    assetStorage,
    recoveryStore,
    applySqlRecords,
    gate,
  } = options;
  const release = gate ? await gate.acquire(session?.id) : () => {};
  try {
    const preflight = await preflightStorageSyncFinalize({
      session,
      sqlStaging,
      assetStaging,
      sqlStorage,
      assetStorage,
    });
    const assetPlan = assetStaging.getPlan(session);
    const recovery = await recoveryStore.prepare(session, assetPlan, assetStorage);
    const hasReadyAssets = assetPlan.assets.some((asset) => asset.state === "ready");
    let assetResult = { applied: 0 };
    let dbResult;
    try {
      assetResult = await assetStaging.applyReadyAssets(session, assetStorage);
      dbResult = await sqlStorage.runStorageSyncFinalizeTransaction(
        session.serverRevision,
        async (client, transactionContext) => {
          recoveryStore.attachDatabaseRecoveryPoint(session.id, {
            storageRevision: transactionContext.currentRevision,
            revisionId: transactionContext.previousRevisionId,
            initialized: transactionContext.databaseInitialized,
          });
          const sqlResult = await applySqlRecords({
            session,
            sqlStaging,
            sqlStorage,
            client,
            transactionContext,
          });
          return { sqlResult };
        },
      );
    } catch (error) {
      if (hasReadyAssets) {
        try {
          await recoveryStore.restoreAssets(recoveryStore.read(session.id), assetStorage);
        } catch (restoreError) {
          const rollbackError = new StorageSyncFinalizeError(
            `Storage sync failed and asset rollback also failed: ${restoreError?.message || restoreError}`,
            "asset_rollback_failed",
          );
          rollbackError.cause = error;
          throw rollbackError;
        }
      }
      throw asTargetChanged(error);
    }

    let recoveryPromoted = true;
    let recoveryWarning = null;
    try {
      await recoveryStore.promote(session.id);
    } catch (error) {
      recoveryPromoted = false;
      recoveryWarning = error?.message || String(error);
    }
    return {
      status: "completed",
      revision: dbResult.revision,
      revisionId: dbResult.revisionId,
      targetRevisionBefore: preflight.targetRevision,
      sourceRevision: preflight.sourceRevision,
      recordCount: preflight.recordCount,
      assetsApplied: assetResult.applied,
      recoveryId: session.id,
      recoveryPromoted,
      recoveryWarning,
      sqlResult: dbResult.sqlResult,
    };
  } finally {
    release();
  }
}

module.exports = {
  StorageSyncFinalizeError,
  StorageSyncFinalizeGate,
  finalizeStorageSyncReplacement,
  preflightStorageSyncFinalize,
  summaryFingerprint,
};
