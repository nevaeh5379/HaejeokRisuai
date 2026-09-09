"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./storageSyncPersistence.cjs");
const {
  STORAGE_SYNC_CHUNK_SIZE_BYTES,
  STORAGE_SYNC_MAX_CONCURRENCY,
} = require("./storageSync.cjs");

const MAX_SYNC_ASSETS = 100000;
const MAX_SYNC_ASSET_KEY_BYTES = 16 * 1024;

class StorageSyncAssetError extends Error {
  constructor(message, code = "invalid_asset_manifest") {
    super(message);
    this.name = "StorageSyncAssetError";
    this.code = code;
  }
}

function keyToHex(key) {
  return Buffer.from(key, "utf8").toString("hex");
}

function assetIdForKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}
function normalizeManifest(assets) {
  if (!Array.isArray(assets) || assets.length > MAX_SYNC_ASSETS) {
    throw new StorageSyncAssetError(
      "Storage sync asset manifest is invalid or too large",
    );
  }
  const seenKeys = new Set();
  const normalized = assets.map((asset) => {
    const key = typeof asset?.key === "string" ? asset.key : "";
    const size = Number(asset?.size);
    const sha256 = String(asset?.sha256 || "").toLowerCase();
    if (
      !key ||
      Buffer.byteLength(key, "utf8") > MAX_SYNC_ASSET_KEY_BYTES ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new StorageSyncAssetError(
        "Storage sync asset manifest contains an invalid entry",
      );
    }
    if (seenKeys.has(key)) {
      throw new StorageSyncAssetError(
        `Duplicate storage sync asset key: ${key}`,
      );
    }
    seenKeys.add(key);
    return { id: assetIdForKey(key), key, size, sha256 };
  });
  const totalSize = normalized.reduce((sum, asset) => sum + asset.size, 0);
  if (!Number.isSafeInteger(totalSize)) {
    throw new StorageSyncAssetError(
      "Storage sync asset manifest total size is too large",
    );
  }
  return normalized;
}

async function hashReadable(source) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    hash.update(source);
  } else {
    for await (const chunk of source) hash.update(chunk);
  }
  return hash.digest("hex");
}
async function hashActiveAsset(storage, asset) {
  const opened =
    typeof storage.openReadStream === "function"
      ? await storage.openReadStream(keyToHex(asset.key))
      : await storage.read(keyToHex(asset.key));
  if (!opened?.exists) return null;
  const contentLength = Number(opened.contentLength ?? opened.buffer?.length);
  if (Number.isSafeInteger(contentLength) && contentLength !== asset.size) {
    return null;
  }
  const source = opened.stream ?? opened.buffer;
  if (!source) return null;
  return await hashReadable(source);
}

function serializeAssetPlan(session) {
  const assets = Object.values(session.assets || {});
  const status = assets.every(
    (asset) => asset.state === "skipped" || asset.state === "ready",
  )
    ? "assets-ready"
    : "receiving-assets";
  return {
    status,
    assets,
    skippedCount: assets.filter((asset) => asset.state === "skipped").length,
    missingCount: assets.filter((asset) => asset.state !== "skipped").length,
    totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
    remainingBytes: assets.reduce(
      (sum, asset) => sum + Math.max(0, asset.size - asset.offset),
      0,
    ),
  };
}

class StorageSyncStagingStore {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
  }
  sessionDirectory(sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new StorageSyncAssetError("Invalid storage sync session id");
    }
    return path.join(this.rootPath, sessionId);
  }

  assetPath(sessionId, assetId) {
    if (!/^[0-9a-f]{64}$/.test(assetId)) {
      throw new StorageSyncAssetError("Invalid storage sync asset id");
    }
    return path.join(
      this.sessionDirectory(sessionId),
      "assets",
      `${assetId}.part`,
    );
  }

  planPath(sessionId) {
    return path.join(this.sessionDirectory(sessionId), "assets-plan.json");
  }

  persistPlan(session) {
    const assets = Object.values(session.assets || {}).map(
      ({ uploading: _uploading, ...asset }) => asset,
    );
    writeJsonAtomic(this.planPath(session.id), { version: 1, assets });
  }

  async planAssets(session, assets, activeStorage) {
    if (session.role !== "target") {
      throw new StorageSyncAssetError(
        "Only target sync sessions accept asset manifests",
      );
    }
    if (session.assets) return serializeAssetPlan(session);
    const manifest = normalizeManifest(assets);
    const plannedAssets = {};
    session.status = "planning-assets";
    try {
      await fs.promises.mkdir(
        path.join(this.sessionDirectory(session.id), "assets"),
        { recursive: true },
      );
      let cursor = 0;
      const workers = Array.from(
        {
          length: Math.min(
            STORAGE_SYNC_MAX_CONCURRENCY,
            Math.max(1, manifest.length),
          ),
        },
        async () => {
          while (cursor < manifest.length) {
            const asset = manifest[cursor++];
            const existingHash = await hashActiveAsset(activeStorage, asset);
            const skipped = existingHash === asset.sha256;
            plannedAssets[asset.id] = {
              ...asset,
              offset: skipped ? asset.size : 0,
              state: skipped ? "skipped" : "pending",
            };
          }
        },
      );
      await Promise.all(workers);
      for (const asset of Object.values(plannedAssets)) {
        if (asset.state === "pending" && asset.size === 0) {
          const emptyHash = crypto.createHash("sha256").digest("hex");
          if (asset.sha256 !== emptyHash) {
            throw new StorageSyncAssetError(
              `Empty asset checksum mismatch: ${asset.key}`,
              "asset_checksum_mismatch",
            );
          }
          await fs.promises.writeFile(
            this.assetPath(session.id, asset.id),
            Buffer.alloc(0),
          );
          asset.state = "ready";
        }
      }
      session.assets = plannedAssets;
      session.activeUploads = 0;
      session.status = Object.values(plannedAssets).every(
        (asset) => asset.state === "skipped" || asset.state === "ready",
      )
        ? "assets-ready"
        : "receiving-assets";
      this.persistPlan(session);
      return serializeAssetPlan(session);
    } catch (error) {
      session.status = "created";
      delete session.assets;
      delete session.activeUploads;
      await this.cleanupAssets(session.id);
      throw error;
    }
  }

  async writeAssetChunk(session, assetId, offset, data) {
    if (session.role !== "target" || !session.assets?.[assetId]) {
      throw new StorageSyncAssetError(
        "Storage sync asset is not part of this session",
      );
    }
    if (
      !(data instanceof Uint8Array) ||
      data.byteLength > STORAGE_SYNC_CHUNK_SIZE_BYTES
    ) {
      throw new StorageSyncAssetError(
        `Storage sync chunks must not exceed ${STORAGE_SYNC_CHUNK_SIZE_BYTES} bytes`,
        "chunk_too_large",
      );
    }
    const asset = session.assets[assetId];
    if (asset.state === "skipped" || asset.state === "ready") return asset;
    if (asset.uploading) {
      throw new StorageSyncAssetError(
        "Storage sync asset already has an upload in progress",
        "asset_upload_in_progress",
      );
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset !== asset.offset
    ) {
      throw new StorageSyncAssetError(
        `Storage sync asset offset mismatch; expected ${asset.offset}`,
        "offset_mismatch",
      );
    }
    if (offset + data.byteLength > asset.size) {
      throw new StorageSyncAssetError(
        "Storage sync asset chunk exceeds declared size",
      );
    }
    if ((session.activeUploads || 0) >= STORAGE_SYNC_MAX_CONCURRENCY) {
      throw new StorageSyncAssetError(
        "Storage sync upload concurrency limit exceeded",
        "too_many_uploads",
      );
    }
    session.activeUploads = (session.activeUploads || 0) + 1;
    asset.uploading = true;
    try {
      const filePath = this.assetPath(session.id, asset.id);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const handle = await fs.promises.open(
        filePath,
        offset === 0 ? "w" : "r+",
      );
      try {
        const buffer = Buffer.from(data);
        let written = 0;
        while (written < buffer.length) {
          const result = await handle.write(
            buffer,
            written,
            buffer.length - written,
            offset + written,
          );
          if (!result.bytesWritten) {
            throw new StorageSyncAssetError(
              "Storage sync asset chunk write made no progress",
              "asset_write_failed",
            );
          }
          written += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      asset.offset += data.byteLength;
      asset.state = "receiving";
      if (asset.offset === asset.size) {
        const digest = await hashReadable(fs.createReadStream(filePath));
        if (digest !== asset.sha256) {
          await fs.promises.rm(filePath, { force: true });
          asset.offset = 0;
          asset.state = "pending";
          throw new StorageSyncAssetError(
            `Storage sync asset checksum mismatch: ${asset.key}`,
            "asset_checksum_mismatch",
          );
        }
        asset.state = "ready";
      }
      session.status = Object.values(session.assets).every(
        (item) => item.state === "skipped" || item.state === "ready",
      )
        ? "assets-ready"
        : "receiving-assets";
      return asset;
    } finally {
      asset.uploading = false;
      session.activeUploads = Math.max(0, (session.activeUploads || 1) - 1);
    }
  }

  async hydrateSession(session) {
    if (session.assets) return true;
    let raw;
    try {
      raw = JSON.parse(
        await fs.promises.readFile(this.planPath(session.id), "utf8"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      await this.cleanupAssets(session.id);
      return false;
    }
    if (raw?.version !== 1 || !Array.isArray(raw.assets)) {
      await this.cleanupAssets(session.id);
      return false;
    }

    let manifest;
    try {
      manifest = normalizeManifest(raw.assets);
    } catch {
      await this.cleanupAssets(session.id);
      return false;
    }
    const persisted = new Map(raw.assets.map((asset) => [asset.id, asset]));
    const hydrated = {};
    for (const asset of manifest) {
      const saved = persisted.get(asset.id);
      if (saved?.state === "skipped" && Number(saved.offset) === asset.size) {
        hydrated[asset.id] = { ...asset, offset: asset.size, state: "skipped" };
        continue;
      }
      const filePath = this.assetPath(session.id, asset.id);
      let actualSize = 0;
      let exists = true;
      try {
        actualSize = (await fs.promises.stat(filePath)).size;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        exists = false;
      }
      if (actualSize > asset.size) {
        await fs.promises.rm(filePath, { force: true });
        actualSize = 0;
        exists = false;
      }
      let state = actualSize > 0 ? "receiving" : "pending";
      if (asset.size === 0) {
        const emptyHash = crypto.createHash("sha256").digest("hex");
        if (asset.sha256 === emptyHash) {
          if (!exists) {
            await fs.promises.mkdir(path.dirname(filePath), {
              recursive: true,
            });
            await fs.promises.writeFile(filePath, Buffer.alloc(0));
          }
          state = "ready";
        }
      } else if (exists && actualSize === asset.size) {
        const digest = await hashReadable(fs.createReadStream(filePath));
        if (digest === asset.sha256) state = "ready";
        else {
          await fs.promises.rm(filePath, { force: true });
          actualSize = 0;
          state = "pending";
        }
      }
      hydrated[asset.id] = { ...asset, offset: actualSize, state };
    }
    session.assets = hydrated;
    session.activeUploads = 0;
    session.status = Object.values(hydrated).every(
      (asset) => asset.state === "skipped" || asset.state === "ready",
    )
      ? "assets-ready"
      : "receiving-assets";
    return true;
  }

  getPlan(session) {
    if (!session.assets) {
      throw new StorageSyncAssetError(
        "Storage sync asset manifest has not been planned",
      );
    }
    return serializeAssetPlan(session);
  }

  async cleanupAssets(sessionId) {
    await Promise.all([
      fs.promises.rm(path.join(this.sessionDirectory(sessionId), "assets"), {
        recursive: true,
        force: true,
      }),
      fs.promises.rm(this.planPath(sessionId), { force: true }),
    ]);
  }

  async cleanup(sessionId) {
    await fs.promises.rm(this.sessionDirectory(sessionId), {
      recursive: true,
      force: true,
    });
  }
}

module.exports = {
  MAX_SYNC_ASSETS,
  StorageSyncAssetError,
  StorageSyncStagingStore,
  hashReadable,
  normalizeManifest,
  serializeAssetPlan,
};
