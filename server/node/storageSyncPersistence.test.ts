import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  StorageSyncSessionPersistence,
} = require("./storageSyncPersistence.cjs");
const { StorageSyncSessionManager } = require("./storageSync.cjs");
const { StorageSyncStagingStore } = require("./storageSyncStaging.cjs");
const { StorageSyncSqlStagingStore } = require("./storageSyncSqlStaging.cjs");
import crypto from "node:crypto";

const roots: string[] = [];
function makePersistence(now = () => 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "risu-sync-session-"));
  roots.push(root);
  return new StorageSyncSessionPersistence(root, now);
}

function session(id = "session-1") {
  return {
    id,
    direction: "local-to-remote",
    role: "target",
    status: "created",
    serverRevision: 7,
    peerRevision: 3,
    summary: { revision: 7, initialized: true, records: {}, assets: {} },
    createdAt: 1000,
    expiresAt: 5000,
    chunkSizeBytes: 4 * 1024 * 1024,
    maxConcurrency: 2,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("StorageSyncSessionPersistence", () => {
  it("round-trips only the small session base metadata", () => {
    const persistence = makePersistence();
    const source = {
      ...session(),
      assets: { huge: true },
      sql: { offset: 10 },
    };
    persistence.saveBase(source);

    const raw = JSON.parse(
      fs.readFileSync(persistence.metadataPath(source.id), "utf8"),
    );
    expect(raw.assets).toBeUndefined();
    expect(raw.sql).toBeUndefined();

    expect(persistence.loadActiveSessions()).toEqual([
      expect.objectContaining({
        id: source.id,
        serverRevision: 7,
        status: "created",
        needsHydration: true,
      }),
    ]);
  });

  it("removes expired and corrupted persisted sessions", () => {
    const persistence = makePersistence(() => 6000);
    persistence.saveBase(session("expired"));

    const corruptDir = persistence.sessionDirectory("corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "session.json"), "{nope", "utf8");

    expect(persistence.loadActiveSessions()).toEqual([]);
    expect(fs.existsSync(persistence.sessionDirectory("expired"))).toBe(false);
    expect(fs.existsSync(corruptDir)).toBe(false);
  });

  it("cleans the whole session directory on request", () => {
    const persistence = makePersistence();
    const current = session("cleanup");
    persistence.saveBase(current);
    fs.writeFileSync(
      path.join(persistence.sessionDirectory(current.id), "sql.ndjson.part"),
      "data",
    );
    persistence.cleanup(current.id);
    expect(fs.existsSync(persistence.sessionDirectory(current.id))).toBe(false);
  });

  it("restores staged asset and SQL progress after a simulated restart", async () => {
    const persistence = makePersistence(() => 1000);
    const manager = new StorageSyncSessionManager({
      randomId: () => "restart-flow",
      now: () => 1000,
      onCreate: (value) => persistence.saveBase(value),
    });
    const current = manager.create({
      direction: "local-to-remote",
      expectedRevision: 4,
      peerRevision: 2,
      summary: { revision: 4 },
    });
    const assets = new StorageSyncStagingStore(persistence.rootPath);
    const assetBody = Buffer.from("asset-data");
    const digest = (data: Uint8Array) =>
      crypto.createHash("sha256").update(data).digest("hex");
    const assetPlan = await assets.planAssets(
      current,
      [{ key: "assets/a.bin", size: assetBody.length, sha256: digest(assetBody) }],
      { openReadStream: async () => ({ exists: false }) },
    );
    await assets.writeAssetChunk(current, assetPlan.assets[0].id, 0, assetBody);

    const sql = new StorageSyncSqlStagingStore(persistence.rootPath);
    const sqlBody = Buffer.from('{"type":"root"}\n{"type":"message"}\n');
    await sql.plan(current, {
      formatVersion: 1, size: sqlBody.length, recordCount: 2, sha256: digest(sqlBody),
    });
    const sqlPrefix = sqlBody.subarray(0, 10);
    await sql.writeChunk(current, 0, sqlPrefix);

    const restoredManager = new StorageSyncSessionManager({
      initialSessions: persistence.loadActiveSessions(),
      now: () => 1000,
    });
    const restored = restoredManager.get(current.id);
    expect(restored).toMatchObject({ id: current.id, needsHydration: true });
    await assets.hydrateSession(restored);
    await sql.hydrateSession(restored);
    expect(assets.getPlan(restored).assets[0]).toMatchObject({ state: "ready", offset: assetBody.length });
    expect(sql.getPlan(restored)).toMatchObject({ state: "receiving", offset: sqlPrefix.length });
  });

  it("restores finalized results without hydrating removed staging payloads", () => {
    const persistence = makePersistence();
    const current = {
      ...session("finalized"),
      status: "finalized",
      finalizedResult: {
        status: "completed",
        revision: 8,
        revisionId: 41,
        sourceRevision: 3,
        recordCount: 12,
        recoveryId: "finalized",
        recoveryPromoted: true,
      },
    };
    persistence.saveBase(current);
    const restored = persistence.loadActiveSessions();
    expect(restored).toEqual([
      expect.objectContaining({
        id: "finalized",
        status: "finalized",
        finalizedResult: current.finalizedResult,
      }),
    ]);
    expect(restored[0].needsHydration).toBeUndefined();
  });

});
