"use strict";

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";
import { writeJsonAtomic } from "./storageSyncPersistence.ts";

const RECOVERY_VERSION: any = 1;
const RECOVERY_ASSET_CONCURRENCY: any = 2;

class StorageSyncRecoveryError extends Error {
  [key: string]: any;

  constructor(message?: any, code: any = "storage_sync_recovery_error") {
    super(message);
    this.name = "StorageSyncRecoveryError";
    this.code = code;
  }
}

function keyToHex(key?: any): any {
  return Buffer.from(key, "utf8").toString("hex");
}
function snapshotId(value?: any): any {
  const id: any = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new StorageSyncRecoveryError("Invalid recovery snapshot id");
  }
  return id;
}

async function copyOpenedAsset(opened?: any, destination?: any): Promise<any> {
  const hash: any = crypto.createHash("sha256");
  let size: any = 0;
  const meter: any = new Transform({
    transform(chunk?: any, _encoding?: any, callback?: any): any {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source: any =
    opened.stream ??
    (opened.buffer ? Readable.from([Buffer.from(opened.buffer)]) : null);
  if (!source) {
    throw new StorageSyncRecoveryError(
      "Asset storage returned no readable body",
    );
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary: any = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await pipeline(
      source,
      meter,
      fs.createWriteStream(temporary, { mode: 0o600 }),
    );
    const declared: any = Number(opened.contentLength);
    if (Number.isSafeInteger(declared) && declared >= 0 && declared !== size) {
      throw new StorageSyncRecoveryError(
        `Recovery asset size changed while reading; expected ${declared}, got ${size}`,
        "recovery_asset_changed",
      );
    }
    await fs.promises.rename(temporary, destination);
    return { size, sha256: hash.digest("hex") };
  } catch (error: any) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAssetFromFile(
  storage?: any,
  hexPath?: any,
  sourcePath?: any,
): Promise<any> {
  if (typeof storage.createWriteStream === "function") {
    const writer: any = storage.createWriteStream(hexPath, {
      generateThumbnail: false,
    });
    try {
      await pipeline(fs.createReadStream(sourcePath), writer.stream);
      await writer.done();
      return;
    } catch (error: any) {
      await writer.abort?.().catch(() => {});
      throw error;
    }
  }
  if (typeof storage.writeFromPath === "function") {
    const temporary: any = `${sourcePath}.restore-${crypto.randomUUID()}`;
    await fs.promises.copyFile(sourcePath, temporary);
    await storage.writeFromPath(hexPath, temporary);
    return;
  }
  throw new StorageSyncRecoveryError(
    "Asset storage cannot restore a recovery file",
    "recovery_asset_write_unsupported",
  );
}

class StorageSyncRecoveryStore {
  [key: string]: any;

  constructor(rootPath?: any) {
    this.rootPath = path.resolve(rootPath);
  }

  snapshotDirectory(id?: any): any {
    return path.join(this.rootPath, snapshotId(id));
  }

  metadataPath(id?: any): any {
    return path.join(this.snapshotDirectory(id), "metadata.json");
  }
  currentPath(): any {
    return path.join(this.rootPath, "current.json");
  }

  assetPath(id?: any, assetId?: any): any {
    if (!/^[0-9a-f]{64}$/.test(assetId)) {
      throw new StorageSyncRecoveryError("Invalid recovery asset id");
    }
    return path.join(this.snapshotDirectory(id), "assets", `${assetId}.bin`);
  }

  read(id?: any): any {
    const raw: any = JSON.parse(fs.readFileSync(this.metadataPath(id), "utf8"));
    if (raw?.version !== RECOVERY_VERSION || raw?.id !== id) {
      throw new StorageSyncRecoveryError(
        "Recovery snapshot metadata is invalid",
      );
    }
    return raw;
  }

  getCurrent(): any {
    try {
      const pointer: any = JSON.parse(
        fs.readFileSync(this.currentPath(), "utf8"),
      );
      if (pointer?.version !== RECOVERY_VERSION) return null;
      return this.read(snapshotId(pointer.id));
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  planFingerprint(assetPlan?: any): any {
    const entries: any = (assetPlan?.assets || [])
      .filter((asset?: any) => asset.state === "ready")
      .map((asset?: any) => ({
        id: asset.id,
        key: asset.key,
        size: asset.size,
        sha256: asset.sha256,
      }))
      .sort((left?: any, right?: any) => left.id.localeCompare(right.id));
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex");
  }

  async prepare(
    session?: any,
    assetPlan?: any,
    activeStorage?: any,
  ): Promise<any> {
    const id: any = snapshotId(session?.id);
    const fingerprint: any = this.planFingerprint(assetPlan);
    try {
      const existing: any = this.read(id);
      if (
        existing.state === "prepared" &&
        existing.serverRevision === session.serverRevision &&
        existing.assetPlanSha256 === fingerprint
      ) {
        return existing;
      }
    } catch {}

    await fs.promises.rm(this.snapshotDirectory(id), {
      recursive: true,
      force: true,
    });
    await fs.promises.mkdir(this.snapshotDirectory(id), { recursive: true });
    const metadata: any = {
      version: RECOVERY_VERSION,
      id,
      state: "preparing",
      sessionId: id,
      serverRevision: session.serverRevision,
      assetPlanSha256: fingerprint,
      createdAt: Date.now(),
      database: {
        storageRevision: session.serverRevision,
        revisionId: null,
        initialized: Boolean(session.summary?.initialized),
      },
      assets: [],
    };
    writeJsonAtomic(this.metadataPath(id), metadata);

    const assets: any = (assetPlan?.assets || []).filter(
      (asset?: any) => asset.state === "ready",
    );
    if (
      assets.length > 0 &&
      typeof activeStorage?.openReadStream !== "function"
    ) {
      throw new StorageSyncRecoveryError(
        "Active asset storage cannot stream recovery snapshots",
        "recovery_asset_read_unsupported",
      );
    }
    let cursor: any = 0;
    const recovered: any = new Array(assets.length);
    const workers: any = Array.from(
      {
        length: Math.min(
          RECOVERY_ASSET_CONCURRENCY,
          Math.max(1, assets.length),
        ),
      },
      async () => {
        while (cursor < assets.length) {
          const index: any = cursor++;
          const asset: any = assets[index];
          const opened: any = await activeStorage.openReadStream(
            keyToHex(asset.key),
          );
          if (!opened?.exists) {
            recovered[index] = {
              id: asset.id,
              key: asset.key,
              existed: false,
            };
            continue;
          }
          const result: any = await copyOpenedAsset(
            opened,
            this.assetPath(id, asset.id),
          );
          recovered[index] = {
            id: asset.id,
            key: asset.key,
            existed: true,
            size: result.size,
            sha256: result.sha256,
          };
        }
      },
    );
    try {
      await Promise.all(workers);
      metadata.assets = recovered;
      metadata.state = "prepared";
      writeJsonAtomic(this.metadataPath(id), metadata);
      return metadata;
    } catch (error: any) {
      await fs.promises.rm(this.snapshotDirectory(id), {
        recursive: true,
        force: true,
      });
      throw error;
    }
  }

  attachDatabaseRecoveryPoint(id?: any, recoveryPoint?: any): any {
    const metadata: any = this.read(snapshotId(id));
    if (metadata.state !== "prepared") {
      throw new StorageSyncRecoveryError("Recovery snapshot is not prepared");
    }
    metadata.database = {
      storageRevision: Number(recoveryPoint.storageRevision),
      revisionId:
        recoveryPoint.revisionId == null
          ? null
          : Number(recoveryPoint.revisionId),
      initialized: Boolean(recoveryPoint.initialized),
    };
    writeJsonAtomic(this.metadataPath(metadata.id), metadata);
    return metadata;
  }
  async promote(id?: any): Promise<any> {
    const metadata: any = this.read(snapshotId(id));
    if (metadata.state !== "prepared") {
      throw new StorageSyncRecoveryError("Recovery snapshot is not prepared");
    }
    let previousId: any = null;
    try {
      previousId = this.getCurrent()?.id || null;
    } catch {}
    metadata.state = "current";
    metadata.promotedAt = Date.now();
    writeJsonAtomic(this.metadataPath(metadata.id), metadata);
    await fs.promises.mkdir(this.rootPath, { recursive: true });
    writeJsonAtomic(this.currentPath(), {
      version: RECOVERY_VERSION,
      id: metadata.id,
    });
    if (previousId && previousId !== metadata.id) {
      await fs.promises.rm(this.snapshotDirectory(previousId), {
        recursive: true,
        force: true,
      });
    }
    return metadata;
  }

  async discard(id?: any): Promise<any> {
    const normalized: any = snapshotId(id);
    const current: any = this.getCurrent();
    if (current?.id === normalized) return false;
    await fs.promises.rm(this.snapshotDirectory(normalized), {
      recursive: true,
      force: true,
    });
    return true;
  }

  async restoreAssets(metadata?: any, activeStorage?: any): Promise<any> {
    if (!metadata || metadata.version !== RECOVERY_VERSION) {
      throw new StorageSyncRecoveryError(
        "Recovery snapshot metadata is invalid",
      );
    }
    let cursor: any = 0;
    const assets: any = metadata.assets || [];
    const workers: any = Array.from(
      {
        length: Math.min(
          RECOVERY_ASSET_CONCURRENCY,
          Math.max(1, assets.length),
        ),
      },
      async () => {
        while (cursor < assets.length) {
          const asset: any = assets[cursor++];
          const hexPath: any = keyToHex(asset.key);
          if (!asset.existed) {
            await activeStorage.remove(hexPath);
            continue;
          }
          await writeAssetFromFile(
            activeStorage,
            hexPath,
            this.assetPath(metadata.id, asset.id),
          );
        }
      },
    );
    await Promise.all(workers);
    return { restored: assets.length };
  }
}

export {
  RECOVERY_ASSET_CONCURRENCY,
  RECOVERY_VERSION,
  StorageSyncRecoveryError,
  StorageSyncRecoveryStore,
  copyOpenedAsset,
  writeAssetFromFile,
};
