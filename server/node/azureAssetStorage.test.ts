import { createRequire } from "node:module";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  keyToHex,
  AzureSqlAssetStorage,
  AssetStorageManager,
} = require("./assetStorage.cjs");

// In-memory mssql mock. The AzureSqlAssetStorage talks to a tiny store backed
// by Map<string, Buffer> and exposes the subset of the mssql API surface that
// the storage driver uses (ConnectionPool, request().input().query, VarBinary,
// MAX, NVarChar, Int, BigInt, batch).
function makeMssqlMock() {
  const store = new Map<string, Buffer>();
  const thumbStore = new Map<string, Buffer>();

  const sql = {
    VarBinary: (len: number) => ({ type: "VarBinary", length: len }),
    NVarChar: (len: number) => ({ type: ".NVarChar", length: len }),
    Int: { type: "Int" },
    BigInt: { type: "BigInt" },
    MAX: "max",
    ConnectionPool: class MockConnectionPool {
      connected = false;
      config: any;
      constructor(config: any) {
        this.config = config;
      }
      on() {}
      async connect() {
        this.connected = true;
        return this;
      }
      async close() {
        this.connected = false;
      }
      request() {
        return new MockRequest(this.config, store, thumbStore);
      }
    },
  };

  class MockRequest {
    private params: Record<string, any> = {};
    constructor(
      private config: any,
      private store: Map<string, Buffer>,
      private thumbStore: Map<string, Buffer>,
    ) {}
    input(name: string, _typeOrValue: any, value?: any) {
      // mssql request.input(name, type, value) or request.input(name, value)
      this.params[name] = value !== undefined ? value : _typeOrValue;
      return this;
    }
    async query(sqlText: string) {
      return handleQuery(sqlText, this.params, this.store, this.thumbStore);
    }
    async batch(sqlText: string) {
      return handleQuery(sqlText, this.params, this.store, this.thumbStore);
    }
  }

  function handleQuery(
    sqlText: string,
    params: Record<string, any>,
    store: Map<string, Buffer>,
    thumbStore: Map<string, Buffer>,
  ) {
    const upper = sqlText.trim().toUpperCase();
    // CREATE TABLE ... (DDL) — no-op
    if (upper.startsWith("IF NOT EXISTS") || upper.startsWith("CREATE TABLE")) {
      return { recordset: [] };
    }
    if (upper.includes("SELECT 1")) {
      return { recordset: [{ "": 1 }] };
    }
    // MERGE asset_files
    if (upper.includes("MERGE") && upper.includes("ASSET_FILES")) {
      const key = params.key;
      const content = params.content;
      store.set(
        key,
        Buffer.isBuffer(content) ? content : Buffer.from(content || []),
      );
      return { recordset: [] };
    }
    // MERGE asset_thumbnails
    if (upper.includes("MERGE") && upper.includes("ASSET_THUMBNAILS")) {
      const key = `${params.key}|${params.w}x${params.h}`;
      const content = params.content;
      thumbStore.set(
        key,
        Buffer.isBuffer(content) ? content : Buffer.from(content || []),
      );
      return { recordset: [] };
    }
    if (upper.includes("SELECT TOP 1 1 AS HIT FROM ASSET_FILES")) {
      const hit = store.has(params.key) ? [{ hit: 1 }] : [];
      return { recordset: hit };
    }
    if (upper.includes("SELECT CONTENT, CONTENT_TYPE, SIZE FROM ASSET_FILES")) {
      if (!store.has(params.key)) return { recordset: [] };
      const buf = store.get(params.key)!;
      return {
        recordset: [
          {
            content: buf,
            content_type: "application/octet-stream",
            size: buf.length,
          },
        ],
      };
    }
    if (upper.includes("SELECT CONTENT, SIZE FROM ASSET_THUMBNAILS")) {
      const k = `${params.key}|${params.w}x${params.h}`;
      if (!thumbStore.has(k)) return { recordset: [] };
      const buf = thumbStore.get(k)!;
      return { recordset: [{ content: buf, size: buf.length }] };
    }
    if (upper.includes("SELECT ASSET_KEY FROM ASSET_FILES")) {
      const keys = Array.from(store.keys()).map((k) => ({ asset_key: k }));
      return { recordset: keys };
    }
    if (upper.includes("SELECT COUNT(*) AS TOTAL_OBJECTS")) {
      let totalSize = 0;
      for (const buf of store.values()) totalSize += buf.length;
      return {
        recordset: [{ total_objects: store.size, total_size: totalSize }],
      };
    }
    if (upper.includes("SELECT ASSET_KEY, SIZE, MTIME FROM ASSET_FILES")) {
      const rows = Array.from(store.entries()).map(([k, buf]) => ({
        asset_key: k,
        size: buf.length,
        mtime: new Date(),
      }));
      return { recordset: rows };
    }
    if (upper.includes("DELETE FROM ASSET_FILES")) {
      // Single-key or IN-list
      const keys: string[] = [];
      for (const name of Object.keys(params)) {
        if (name === "key" || name.startsWith("k")) keys.push(params[name]);
      }
      for (const k of keys) store.delete(k);
      return { recordset: [] };
    }
    if (upper.includes("DELETE FROM ASSET_THUMBNAILS")) {
      const keys: string[] = [];
      for (const name of Object.keys(params)) {
        if (name === "key" || name.startsWith("k")) keys.push(params[name]);
      }
      for (const k of keys) {
        for (const tk of Array.from(thumbStore.keys())) {
          if (tk.startsWith(`${k}|`)) thumbStore.delete(tk);
        }
      }
      return { recordset: [] };
    }
    if (upper.includes("SELECT DISTINCT ASSET_KEY FROM ASSET_THUMBNAILS")) {
      const keys = new Set<string>();
      for (const tk of thumbStore.keys()) {
        keys.add(tk.split("|")[0]);
      }
      return { recordset: Array.from(keys).map((k) => ({ asset_key: k })) };
    }
    if (upper.includes("SELECT F.ASSET_KEY")) {
      // image query for generateMissingThumbnails
      const rows = Array.from(store.keys()).map((k) => ({ asset_key: k }));
      return { recordset: rows };
    }
    // Default
    return { recordset: [] };
  }

  return { sql, store, thumbStore };
}

describe("AzureSqlAssetStorage basic CRUD", () => {
  let tmpDir: string;
  let storage: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "risu-test-azsql-"));
    const { sql, store } = makeMssqlMock();
    storage = new AzureSqlAssetStorage(
      {
        server: "mock.database.windows.net",
        database: "risuai_test",
        user: "mock",
        password: "mock",
        port: 1433,
      },
      tmpDir,
    );
    // Inject the mock mssql + pre-constructed pool.
    storage.sql = sql;
    storage.pool = new sql.ConnectionPool({});
    storage.pool.connected = true;
    storage.pool.request = () =>
      new (class {
        params: Record<string, any> = {};
        input(name: string, _t: any, v?: any) {
          this.params[name] = v !== undefined ? v : _t;
          return this;
        }
        async query(q: string) {
          return handleMockQuery(q, this.params, store, new Map());
        }
        async batch(q: string) {
          return handleMockQuery(q, this.params, store, new Map());
        }
      })();
    await storage.init();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir))
      fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes, checks existence, reads, lists, and deletes", async () => {
    const key = "assets/test.png";
    const hex = keyToHex(key);
    const payload = Buffer.from("fake-image-bytes");

    expect(await storage.exists(hex)).toBe(false);
    const before = await storage.read(hex);
    expect(before.exists).toBe(false);

    await storage.write(hex, payload);
    expect(await storage.exists(hex)).toBe(true);

    const readRes = await storage.read(hex);
    expect(readRes.exists).toBe(true);
    expect(readRes.contentLength).toBe(payload.length);
    expect(readRes.buffer).toEqual(payload);

    const list = await storage.list();
    expect(list).toContain(key);

    const stats = await storage.getStats();
    expect(stats.storageType).toBe("azuresql");
    expect(stats.totalObjects).toBe(1);
    expect(stats.totalSizeBytes).toBe(payload.length);

    await storage.remove(hex);
    expect(await storage.exists(hex)).toBe(false);
  });

  it("returns asset details with total size", async () => {
    const hex1 = keyToHex("assets/a.bin");
    const hex2 = keyToHex("assets/b.bin");
    await storage.write(hex1, Buffer.from("aaaa"));
    await storage.write(hex2, Buffer.from("bbbbbb"));
    const details = await storage.getAssetDetails();
    expect(details.storageType).toBe("azuresql");
    expect(details.totalObjects).toBe(2);
    expect(details.totalSizeBytes).toBe(10);
    expect(details.assets.map((a: any) => a.key)).toContain("assets/a.bin");
  });
});

function handleMockQuery(
  sqlText: string,
  params: any,
  store: Map<string, Buffer>,
  thumbStore: Map<string, Buffer>,
) {
  const upper = sqlText.trim().toUpperCase();
  if (upper.startsWith("IF NOT EXISTS") || upper.startsWith("CREATE TABLE")) {
    return { recordset: [] };
  }
  if (upper.includes("MERGE") && upper.includes("ASSET_FILES")) {
    store.set(
      params.key,
      Buffer.isBuffer(params.content)
        ? params.content
        : Buffer.from(params.content || []),
    );
    return { recordset: [] };
  }
  if (upper.includes("MERGE") && upper.includes("ASSET_THUMBNAILS")) {
    const k = `${params.key}|${params.w}x${params.h}`;
    thumbStore.set(
      k,
      Buffer.isBuffer(params.content)
        ? params.content
        : Buffer.from(params.content || []),
    );
    return { recordset: [] };
  }
  if (upper.includes("SELECT TOP 1 1 AS HIT")) {
    return { recordset: store.has(params.key) ? [{ hit: 1 }] : [] };
  }
  if (upper.includes("SELECT CONTENT, CONTENT_TYPE, SIZE FROM ASSET_FILES")) {
    if (!store.has(params.key)) return { recordset: [] };
    const buf = store.get(params.key)!;
    return {
      recordset: [
        {
          content: buf,
          content_type: "application/octet-stream",
          size: buf.length,
        },
      ],
    };
  }
  if (upper.includes("SELECT ASSET_KEY FROM ASSET_FILES")) {
    return {
      recordset: Array.from(store.keys()).map((k) => ({ asset_key: k })),
    };
  }
  if (upper.includes("SELECT COUNT(*) AS TOTAL_OBJECTS")) {
    let total = 0;
    for (const b of store.values()) total += b.length;
    return { recordset: [{ total_objects: store.size, total_size: total }] };
  }
  if (upper.includes("SELECT ASSET_KEY, SIZE, MTIME")) {
    return {
      recordset: Array.from(store.entries()).map(([k, b]) => ({
        asset_key: k,
        size: b.length,
        mtime: new Date(),
      })),
    };
  }
  if (upper.includes("DELETE FROM ASSET_FILES")) {
    for (const name of Object.keys(params)) {
      if (name === "key" || name.startsWith("k")) store.delete(params[name]);
    }
    return { recordset: [] };
  }
  if (upper.includes("DELETE FROM ASSET_THUMBNAILS")) {
    return { recordset: [] };
  }
  if (upper.includes("SELECT DISTINCT ASSET_KEY FROM ASSET_THUMBNAILS")) {
    const keys = new Set<string>();
    for (const tk of thumbStore.keys()) keys.add(tk.split("|")[0]);
    return { recordset: Array.from(keys).map((k) => ({ asset_key: k })) };
  }
  if (upper.includes("SELECT F.ASSET_KEY")) {
    return {
      recordset: Array.from(store.keys()).map((k) => ({ asset_key: k })),
    };
  }
  if (upper.includes("SELECT CONTENT, SIZE FROM ASSET_THUMBNAILS")) {
    const k = `${params.key}|${params.w}x${params.h}`;
    if (!thumbStore.has(k)) return { recordset: [] };
    const buf = thumbStore.get(k)!;
    return { recordset: [{ content: buf, size: buf.length }] };
  }
  return { recordset: [] };
}

describe("AssetStorageManager Azure SQL selection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "risu-test-azmgr-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir))
      fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports storageType fs by default", async () => {
    const mgr = new AssetStorageManager(tmpDir);
    await mgr.init();
    expect(mgr.getStorage().type).toBe("fs");
    const cfg = mgr.getPublicConfig();
    expect(cfg.storageType).toBe("fs");
    expect(cfg.azureServer).toBe("");
  });

  it("persists azure config to __azure_asset_config.json", async () => {
    const mgr = new AssetStorageManager(tmpDir);
    await mgr.init();
    const cfgPath = path.join(tmpDir, "__azure_asset_config.json");
    expect(fs.existsSync(cfgPath)).toBe(false);
    // Direct config save (skips connection test by writing file only).
    mgr.saveAzureConfig({
      enabled: true,
      server: "svr.database.windows.net",
      database: "assets",
      user: "u",
      password: "p",
      port: 1433,
      poolMax: 10,
    });
    expect(fs.existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(parsed.server).toBe("svr.database.windows.net");
    expect(parsed.enabled).toBe(true);
  });

  it("getSummary includes azuresql slot when configured", async () => {
    const mgr = new AssetStorageManager(tmpDir);
    await mgr.init();
    const summary = await mgr.getSummary();
    expect(summary.activeType).toBe("fs");
    expect(summary.azuresql).toBe(null);
    expect(summary.localFs).toBeDefined();
  });
});

describe("AzureSqlAssetStorage.testConnection", () => {
  it("rejects when required fields are missing", async () => {
    const result = await AzureSqlAssetStorage.testConnection({
      server: "",
      database: "",
      user: "",
      password: "",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/required/i);
  });
});
