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

module.exports = {
  StorageSyncFinalizeError,
  preflightStorageSyncFinalize,
  summaryFingerprint,
};
