import { describe, expect, it } from "vitest";
import type { ISqlStorage } from "../sql/ISqlStorage";
import type {
  NodeStorageSyncAssetManifestEntry,
  NodeStorageSyncAssetPlan,
  NodeStorageSyncSession,
  NodeStorageSyncSqlPlan,
  NodeStorageSyncSummary,
} from "./nodeApiClient";
import {
  StorageSyncSourceAssetsChangedError,
  stageLocalStorageToRemote,
  type StorageSyncRemoteTarget,
} from "./storageSyncCoordinator";
import type { StorageSyncAssetReader } from "./storageSyncAssetReader";
import { measureStorageSyncSqlSource } from "./storageSyncSource";
import {
  saveStorageSyncResumeState,
  type StorageSyncResumeStorage,
} from "./storageSyncResumeState";

function sourceSql(revision = 7): ISqlStorage {
  return {
    getRevision: () => revision,
    getStorageSyncSummary: async () => ({
      revision,
      initialized: true,
      records: { settings: 0, characters: 0, chats: 0, messages: 0, total: 0 },
    }),
    listSettingKeys: async () => [],
    listPluginCustomStorageKeys: async () => [],
    loadModules: async () => [],
    listBotPresets: async () => [],
    listColdStorageItems: async () => ({ items: [] }),
    loadStartupData: async () => ({ characters: [] }),
  } as unknown as ISqlStorage;
}

function assetReader(
  entries: Record<string, Uint8Array>,
  onRead?: (
    key: string,
    offset: number,
    length: number,
    count: number,
  ) => Uint8Array,
): StorageSyncAssetReader {
  let reads = 0;
  return {
    listKeys: async (prefix) =>
      Object.keys(entries).filter((key) => key.startsWith(prefix)),
    getSize: async (key) => entries[key].byteLength,
    readChunk: async (key, offset, length) => {
      reads++;
      return onRead
        ? onRead(key, offset, length, reads)
        : entries[key].subarray(offset, offset + length);
    },
  };
}

function memoryResumeStorage(): StorageSyncResumeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const TARGET_SUMMARY: NodeStorageSyncSummary = {
  protocolVersion: 1,
  revision: 11,
  initialized: true,
  records: { settings: 1, characters: 1, chats: 1, messages: 1, total: 4 },
  assets: { count: 1, sizeBytes: 10 },
};
class FakeRemoteTarget implements StorageSyncRemoteTarget {
  readonly log: string[] = [];
  readonly skipKeys = new Set<string>();
  readonly resumeAssetOffsets = new Map<string, number>();
  resumeSqlOffset = 0;
  private assetPlan: NodeStorageSyncAssetPlan | null = null;
  private sqlPlan: NodeStorageSyncSqlPlan | null = null;
  private session: NodeStorageSyncSession;

  constructor(sessionId = "session-1") {
    this.session = {
      id: sessionId,
      direction: "local-to-remote",
      role: "target",
      status: "created",
      serverRevision: TARGET_SUMMARY.revision,
      peerRevision: 7,
      summary: structuredClone(TARGET_SUMMARY),
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      chunkSizeBytes: 8,
      maxConcurrency: 2,
    };
  }

  getStorageSyncServerOrigin() {
    return "https://remote.example";
  }

  async getStorageSyncSummary() {
    this.log.push("summary");
    return structuredClone(TARGET_SUMMARY);
  }

  async createStorageSyncSession(options: {
    direction: "local-to-remote";
    expectedRevision: number;
    peerRevision: number;
  }) {
    this.log.push("create-session");
    this.session.peerRevision = options.peerRevision;
    return structuredClone(this.session);
  }
  async getStorageSyncSession(id: string) {
    expect(id).toBe(this.session.id);
    this.log.push("get-session");
    return structuredClone(this.session);
  }

  private refreshAssetPlan() {
    if (!this.assetPlan) throw new Error("asset plan missing");
    const remainingBytes = this.assetPlan.assets.reduce(
      (total, asset) => total + Math.max(0, asset.size - asset.offset),
      0,
    );
    this.assetPlan.remainingBytes = remainingBytes;
    this.assetPlan.missingCount = this.assetPlan.assets.filter(
      (asset) => asset.state !== "skipped",
    ).length;
    this.assetPlan.skippedCount = this.assetPlan.assets.filter(
      (asset) => asset.state === "skipped",
    ).length;
    this.assetPlan.status =
      remainingBytes === 0 ? "assets-ready" : "receiving-assets";
    this.session.status = this.assetPlan.status;
  }

  async planStorageSyncAssets(
    id: string,
    assets: NodeStorageSyncAssetManifestEntry[],
  ) {
    expect(id).toBe(this.session.id);
    this.log.push("plan-assets");
    if (!this.assetPlan) {
      const planned = assets.map((asset, index) => {
        const skipped = this.skipKeys.has(asset.key);
        const offset = skipped
          ? asset.size
          : Math.min(this.resumeAssetOffsets.get(asset.key) ?? 0, asset.size);
        return {
          ...asset,
          id: `asset-${index}`,
          offset,
          state: skipped
            ? ("skipped" as const)
            : offset === asset.size
              ? ("ready" as const)
              : offset > 0
                ? ("receiving" as const)
                : ("pending" as const),
        };
      });
      this.assetPlan = {
        status: "created",
        assets: planned,
        skippedCount: 0,
        missingCount: 0,
        totalBytes: planned.reduce((total, asset) => total + asset.size, 0),
        remainingBytes: 0,
      };
      this.refreshAssetPlan();
    }
    return structuredClone(this.assetPlan);
  }
  async getStorageSyncAssetPlan(id: string) {
    expect(id).toBe(this.session.id);
    this.log.push("get-asset-plan");
    if (!this.assetPlan) throw new Error("asset plan missing");
    return structuredClone(this.assetPlan);
  }

  async uploadStorageSyncAssetChunk(
    id: string,
    assetId: string,
    offset: number,
    data: Uint8Array,
  ) {
    expect(id).toBe(this.session.id);
    if (!this.assetPlan) throw new Error("asset plan missing");
    const asset = this.assetPlan.assets.find((entry) => entry.id === assetId);
    if (!asset) throw new Error("unknown asset");
    expect(offset).toBe(asset.offset);
    this.log.push(`asset:${asset.key}:${offset}:${data.byteLength}`);
    asset.offset += data.byteLength;
    asset.state = asset.offset === asset.size ? "ready" : "receiving";
    this.refreshAssetPlan();
    return {
      id: asset.id,
      offset: asset.offset,
      state: asset.state,
      status: this.session.status,
    };
  }
  async planStorageSyncSql(
    id: string,
    plan: {
      formatVersion: 1;
      size: number;
      recordCount: number;
      sha256: string;
    },
  ) {
    expect(id).toBe(this.session.id);
    if (!this.assetPlan || this.assetPlan.remainingBytes !== 0) {
      throw new Error("SQL planned before assets were ready");
    }
    this.log.push("plan-sql");
    if (!this.sqlPlan) {
      const offset = Math.min(this.resumeSqlOffset, plan.size);
      this.sqlPlan = {
        ...plan,
        offset,
        state:
          offset === plan.size ? "ready" : offset > 0 ? "receiving" : "pending",
        status: offset === plan.size ? "sql-ready" : "receiving-sql",
      };
      this.session.status = this.sqlPlan.status;
    }
    return structuredClone(this.sqlPlan);
  }
  async getStorageSyncSqlPlan(id: string) {
    expect(id).toBe(this.session.id);
    if (!this.sqlPlan) throw new Error("sql plan missing");
    return structuredClone(this.sqlPlan);
  }

  async uploadStorageSyncSqlChunk(
    id: string,
    offset: number,
    data: Uint8Array,
  ) {
    expect(id).toBe(this.session.id);
    if (!this.sqlPlan) throw new Error("sql plan missing");
    expect(offset).toBe(this.sqlPlan.offset);
    this.log.push(`sql:${offset}:${data.byteLength}`);
    this.sqlPlan.offset += data.byteLength;
    this.sqlPlan.state =
      this.sqlPlan.offset === this.sqlPlan.size ? "ready" : "receiving";
    this.sqlPlan.status =
      this.sqlPlan.state === "ready" ? "sql-ready" : "receiving-sql";
    this.session.status = this.sqlPlan.status;
    return structuredClone(this.sqlPlan);
  }

  async validateStorageSyncSql(id: string) {
    expect(id).toBe(this.session.id);
    if (!this.sqlPlan) throw new Error("sql plan missing");
    this.log.push("validate-sql");
    return {
      recordCount: this.sqlPlan.recordCount,
      sourceRevision: this.session.peerRevision ?? 0,
      counts: { meta: 1 },
    };
  }
}

describe("stageLocalStorageToRemote", () => {
  it("stages assets before SQL and respects checksum dedupe", async () => {
    const target = new FakeRemoteTarget();
    target.skipKeys.add("assets/b.bin");
    const resumeStorage = memoryResumeStorage();
    const phases: string[] = [];

    const result = await stageLocalStorageToRemote({
      sourceSql: sourceSql(),
      sourceAssets: assetReader({
        "assets/a.bin": new Uint8Array([1, 2, 3]),
        "assets/b.bin": new Uint8Array([4, 5]),
      }),
      target,
      resumeStorage,
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.session.status).toBe("sql-ready");
    expect(result.assetPlan.remainingBytes).toBe(0);
    expect(
      target.log.some((entry) => entry.startsWith("asset:assets/b.bin")),
    ).toBe(false);
    const lastAsset = Math.max(
      ...target.log.map((entry, index) =>
        entry.startsWith("asset:") ? index : -1,
      ),
    );
    expect(lastAsset).toBeLessThan(target.log.indexOf("plan-sql"));
    expect(phases.at(-1)).toBe("staged");
  });
  it("resumes persisted asset and SQL offsets", async () => {
    const sql = sourceSql();
    const sqlPlan = await measureStorageSyncSqlSource(sql, {
      expectedRevision: 7,
    });
    const target = new FakeRemoteTarget("resume-1");
    target.resumeAssetOffsets.set("assets/a.bin", 1);
    target.resumeSqlOffset = Math.min(5, Math.max(0, sqlPlan.size - 1));
    const resumeStorage = memoryResumeStorage();
    saveStorageSyncResumeState(
      {
        version: 1,
        serverOrigin: target.getStorageSyncServerOrigin(),
        sessionId: "resume-1",
        direction: "local-to-remote",
        sourceRevision: 7,
        createdAt: 1,
      },
      resumeStorage,
    );

    await stageLocalStorageToRemote({
      sourceSql: sql,
      sourceAssets: assetReader({
        "assets/a.bin": new Uint8Array([1, 2, 3, 4]),
      }),
      target,
      resumeStorage,
    });

    expect(target.log).not.toContain("create-session");
    expect(target.log.find((entry) => entry.startsWith("asset:"))).toContain(
      ":1:",
    );
    const firstSqlUpload = target.log.find((entry) => entry.startsWith("sql:"));
    expect(firstSqlUpload).toBe(
      `sql:${target.resumeSqlOffset}:${Math.min(
        8 - (target.resumeSqlOffset % 8),
        sqlPlan.size - target.resumeSqlOffset,
      )}`,
    );
  });
  it("rejects when local assets change after staging", async () => {
    const target = new FakeRemoteTarget();
    const original = new Uint8Array([1, 2, 3]);
    const changed = new Uint8Array([1, 2, 9]);
    const reader = assetReader(
      { "assets/a.bin": original },
      (_key, offset, length, count) => {
        const source = count >= 3 ? changed : original;
        return source.subarray(offset, offset + length);
      },
    );

    await expect(
      stageLocalStorageToRemote({
        sourceSql: sourceSql(),
        sourceAssets: reader,
        target,
        resumeStorage: memoryResumeStorage(),
      }),
    ).rejects.toBeInstanceOf(StorageSyncSourceAssetsChangedError);

    expect(target.log).toContain("plan-sql");
    expect(target.log.some((entry) => entry.startsWith("sql:"))).toBe(true);
  });
});
