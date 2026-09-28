// @vitest-environment node

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPluginStorageRoutes,
  type PluginStorageRouteDependencies,
} from "./routes.js";

type RouteApp = PluginStorageRouteDependencies["app"];
type RouteHandler = Parameters<RouteApp["get"]>[1];
type RouteRequest = Parameters<RouteHandler>[0];
type RouteResponse = Parameters<RouteHandler>[1];
type RouteNext = Parameters<RouteHandler>[2];
type Storage = ReturnType<PluginStorageRouteDependencies["getStorage"]>;
type Plugin = Awaited<ReturnType<Storage["loadPlugins"]>>["plugins"][number];

type CapturedResponse = RouteResponse & {
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
  statusCode: number;
};

class TestRouteApp {
  readonly routes = new Map<string, RouteHandler[]>();

  get(path: string, ...handlers: RouteHandler[]): void {
    this.routes.set(`GET ${path}`, handlers);
  }

  patch(path: string, ...handlers: RouteHandler[]): void {
    this.routes.set(`PATCH ${path}`, handlers);
  }

  async invoke(
    method: "GET" | "PATCH",
    path: string,
    request: Partial<RouteRequest> = {},
  ): Promise<{ forwardedError: unknown; response: CapturedResponse }> {
    const handlers = this.routes.get(`${method} ${path}`);
    if (!handlers) throw new Error(`Route not registered: ${method} ${path}`);

    const req: RouteRequest = {
      body: undefined,
      headers: {},
      params: {},
      query: {},
      ...request,
    };
    const response: CapturedResponse = {
      body: undefined,
      ended: false,
      headers: {},
      statusCode: 200,
      end() {
        response.ended = true;
        return response;
      },
      send(body: unknown) {
        response.body = body;
        return response;
      },
      setHeader(name: string, value: string) {
        response.headers[name.toLowerCase()] = value;
        return response;
      },
      status(statusCode: number) {
        response.statusCode = statusCode;
        return response;
      },
    };
    let index = 0;
    let forwardedError: unknown;
    const next: RouteNext = async (error?: unknown) => {
      if (error !== undefined) {
        forwardedError = error;
        return;
      }
      const handler = handlers[index++];
      if (handler) await handler(req, response, next);
    };

    await next();
    return { forwardedError, response };
  }
}

class TestRevisionConflictError extends Error {
  constructor(
    message: string,
    readonly revision: number,
  ) {
    super(message);
  }
}

class TestPayloadError extends Error {}

function createPlugin(id: string, name: string, enabled: boolean): Plugin {
  return {
    id,
    position: 0,
    name,
    arguments: {},
    realArg: {},
    customLink: [],
    argMeta: {},
    enabled,
  };
}

const alphaPlugin = createPlugin("plugin-a", "alpha", true);
const betaPlugin = createPlugin("plugin-b", "beta", false);

function createStorage(overrides: Partial<Storage> = {}): Storage {
  return {
    enabled: true,
    listPluginCustomStorageKeys: vi.fn(async () => ["alpha", "beta"]),
    loadPluginCustomStorage: vi.fn(async () => ({
      pluginCustomStorage: { alpha: { count: 1 } },
      hash: "storage-hash",
    })),
    loadPluginCustomStorageKey: vi.fn(async (key: string) => ({
      exists: true,
      hash: "key-hash",
      key,
      value: { count: 1 },
    })),
    loadPlugins: vi.fn(async () => ({
      hash: "plugins-hash",
      plugins: [alphaPlugin, betaPlugin],
    })),
    loadPluginsData: vi.fn(async () => ({
      hash: "plugins-hash:storage-hash",
      pluginCustomStorage: { alpha: { count: 1 } },
      plugins: [alphaPlugin],
    })),
    loadPluginScript: vi.fn(async () => "console.log('plugin')"),
    ...overrides,
  };
}

describe("plugin storage routes", () => {
  let app: TestRouteApp;
  let storage: Storage;
  let checkAuth: PluginStorageRouteDependencies["checkAuth"];
  let databaseMutations: PluginStorageRouteDependencies["databaseMutations"];
  let sendCompressedJson: PluginStorageRouteDependencies["sendCompressedJson"];

  beforeEach(() => {
    app = new TestRouteApp();
    storage = createStorage();
    checkAuth = vi.fn(async () => true);
    databaseMutations = {
      togglePlugin: vi.fn(async () => ({ revision: 8 })),
    };
    sendCompressedJson = vi.fn(async (_req, res, payload) => {
      res.send(payload);
    });

    const passThrough: RouteHandler = (_req, _res, next) => next();
    registerPluginStorageRoutes({
      app,
      authenticatedRouteLimiter: passThrough,
      checkAuth,
      databaseMutations,
      getStorage: () => storage,
      isPayloadError: (error): error is TestPayloadError =>
        error instanceof TestPayloadError,
      isRevisionConflictError: (error): error is TestRevisionConflictError =>
        error instanceof TestRevisionConflictError,
      postgresJsonParser: passThrough,
      requireNodeAuth: passThrough,
      sendCompressedJson,
    });
  });

  it("stops after failed authentication without touching storage", async () => {
    vi.mocked(checkAuth).mockResolvedValue(false);

    const { response } = await app.invoke("GET", "/api/database-v2/plugins");

    expect(checkAuth).toHaveBeenCalledOnce();
    expect(storage.loadPlugins).not.toHaveBeenCalled();
    expect(sendCompressedJson).not.toHaveBeenCalled();
    expect(response.body).toBeUndefined();
  });

  it("preserves each disabled-storage response and legacy error code", async () => {
    storage = createStorage({ enabled: false });
    const cases: Array<{
      code: string;
      error: string;
      method: "GET" | "PATCH";
      path: string;
    }> = [
      {
        method: "GET",
        path: "/api/database-v2/plugins",
        error: "PostgreSQL storage is not configured",
        code: "postgres_disabled",
      },
      {
        method: "GET",
        path: "/api/database-v2/plugins/:pluginId",
        error: "SQL storage is not configured",
        code: "sql_disabled",
      },
      {
        method: "GET",
        path: "/api/database-v2/plugins/:pluginId/script",
        error: "SQL storage is not configured",
        code: "sql_disabled",
      },
      {
        method: "PATCH",
        path: "/api/database-v2/plugins/:pluginName/enabled",
        error: "SQL storage is not configured",
        code: "postgres_disabled",
      },
      ...[
        "/api/database-v2/plugin-custom-storage/keys",
        "/api/database-v2/plugin-custom-storage/keys/:key",
        "/api/database-v2/plugin-custom-storage",
        "/api/database-v2/plugins-data",
      ].map((path) => ({
        method: "GET" as const,
        path,
        error: "PostgreSQL storage is not configured",
        code: "postgres_disabled",
      })),
    ];

    for (const testCase of cases) {
      const { response } = await app.invoke(testCase.method, testCase.path);
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({
        error: testCase.error,
        code: testCase.code,
      });
    }
    expect(storage.loadPlugins).not.toHaveBeenCalled();
  });

  it("returns all or enabled plugins and derives the runtime hash", async () => {
    const all = await app.invoke("GET", "/api/database-v2/plugins");
    expect(all.response.body).toEqual({
      plugins: [alphaPlugin, betaPlugin],
      hash: "plugins-hash",
    });
    expect(all.response.headers).toMatchObject({
      etag: '"risu-plugins-plugins-hash"',
      "cache-control": "private, no-cache",
    });

    const runtimeHash = createHash("sha256")
      .update(JSON.stringify([alphaPlugin]))
      .digest("hex");
    const enabled = await app.invoke("GET", "/api/database-v2/plugins", {
      query: { enabledOnly: "true" },
    });
    expect(enabled.response.body).toEqual({
      plugins: [alphaPlugin],
      hash: runtimeHash,
    });
    expect(enabled.response.headers.etag).toBe(
      `"risu-plugins-runtime-${runtimeHash}"`,
    );
  });

  it("returns 304 for a matching plugins ETag", async () => {
    const { response } = await app.invoke("GET", "/api/database-v2/plugins", {
      headers: {
        "if-none-match": '"other", "risu-plugins-plugins-hash"',
      },
    });

    expect(response.statusCode).toBe(304);
    expect(response.ended).toBe(true);
    expect(sendCompressedJson).not.toHaveBeenCalled();
  });

  it("loads individual plugins and scripts and preserves their 404 responses", async () => {
    const plugin = await app.invoke(
      "GET",
      "/api/database-v2/plugins/:pluginId",
      { params: { pluginId: "plugin-a" } },
    );
    expect(storage.loadPlugins).toHaveBeenCalledWith({
      pluginId: "plugin-a",
    });
    expect(plugin.response.body).toEqual({
      plugin: alphaPlugin,
    });

    vi.mocked(storage.loadPlugins).mockResolvedValueOnce({
      hash: "empty-hash",
      plugins: [],
    });
    const missingPlugin = await app.invoke(
      "GET",
      "/api/database-v2/plugins/:pluginId",
      { params: { pluginId: "missing" } },
    );
    expect(missingPlugin.response.statusCode).toBe(404);
    expect(missingPlugin.response.body).toEqual({
      error: "Plugin not found",
      code: "plugin_not_found",
    });

    const script = await app.invoke(
      "GET",
      "/api/database-v2/plugins/:pluginId/script",
      { params: { pluginId: "plugin-a" } },
    );
    expect(storage.loadPluginScript).toHaveBeenCalledWith("plugin-a");
    expect(script.response.body).toEqual({ script: "console.log('plugin')" });

    vi.mocked(storage.loadPluginScript).mockResolvedValueOnce(null);
    const missingScript = await app.invoke(
      "GET",
      "/api/database-v2/plugins/:pluginId/script",
      { params: { pluginId: "missing" } },
    );
    expect(missingScript.response.statusCode).toBe(404);
    expect(missingScript.response.body).toEqual({
      error: "Plugin script not found",
      code: "plugin_not_found",
    });
  });

  it("validates enabled mutation requests and missing plugin names", async () => {
    const invalid = await app.invoke(
      "PATCH",
      "/api/database-v2/plugins/:pluginName/enabled",
      {
        body: { enabled: "true", baseRevision: 7 },
        params: { pluginName: "alpha" },
      },
    );
    expect(invalid.response.statusCode).toBe(400);
    expect(invalid.response.body).toEqual({
      error: "enabled and baseRevision are required",
      code: "invalid_plugin_toggle",
    });

    const missing = await app.invoke(
      "PATCH",
      "/api/database-v2/plugins/:pluginName/enabled",
      {
        body: { enabled: true, baseRevision: 7 },
        params: { pluginName: "missing" },
      },
    );
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.body).toEqual({
      error: "Plugin not found",
      code: "plugin_not_found",
    });
    expect(databaseMutations.togglePlugin).not.toHaveBeenCalled();
  });

  it("passes mutation arguments and the source client ID", async () => {
    const { response } = await app.invoke(
      "PATCH",
      "/api/database-v2/plugins/:pluginName/enabled",
      {
        body: { enabled: false, baseRevision: 7 },
        headers: { "x-risu-client-id": "client-a" },
        params: { pluginName: "alpha" },
      },
    );

    expect(databaseMutations.togglePlugin).toHaveBeenCalledWith(
      {
        baseRevision: 7,
        pluginId: "plugin-a",
        pluginName: "alpha",
        enabled: false,
      },
      "client-a",
    );
    expect(response.body).toEqual({ success: true, revision: 8 });
  });

  it("maps revision and payload conflicts without forwarding them", async () => {
    vi.mocked(databaseMutations.togglePlugin)
      .mockRejectedValueOnce(new TestRevisionConflictError("stale", 12))
      .mockRejectedValueOnce(new TestPayloadError("bad payload"));
    const request = {
      body: { enabled: true, baseRevision: 7 },
      params: { pluginName: "alpha" },
    };

    const revision = await app.invoke(
      "PATCH",
      "/api/database-v2/plugins/:pluginName/enabled",
      request,
    );
    expect(revision.forwardedError).toBeUndefined();
    expect(revision.response.statusCode).toBe(409);
    expect(revision.response.body).toEqual({
      error: "stale",
      code: "revision_conflict",
      revision: 12,
    });

    const payload = await app.invoke(
      "PATCH",
      "/api/database-v2/plugins/:pluginName/enabled",
      request,
    );
    expect(payload.forwardedError).toBeUndefined();
    expect(payload.response.statusCode).toBe(400);
    expect(payload.response.body).toEqual({
      error: "bad payload",
      code: "invalid_plugin_toggle",
    });
  });

  it("serves custom-storage keys, values, and the combined plugins payload", async () => {
    const keys = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage/keys",
    );
    expect(keys.response.body).toEqual({ keys: ["alpha", "beta"] });

    const key = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage/keys/:key",
      { params: { key: "alpha" } },
    );
    expect(key.response.body).toEqual({
      key: "alpha",
      value: { count: 1 },
      hash: "key-hash",
    });
    expect(key.response.headers.etag).toBe('"risu-plugin-key-key-hash"');

    vi.mocked(storage.loadPluginCustomStorageKey).mockResolvedValueOnce({
      exists: false,
      hash: "null",
      key: "missing",
      value: null,
    });
    const missingKey = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage/keys/:key",
      { params: { key: "missing" } },
    );
    expect(missingKey.response.statusCode).toBe(404);
    expect(missingKey.response.body).toEqual({
      error: "Plugin custom storage key not found: missing",
    });

    const allStorage = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage",
    );
    expect(allStorage.response.body).toEqual({
      pluginCustomStorage: { alpha: { count: 1 } },
      hash: "storage-hash",
    });
    expect(allStorage.response.headers.etag).toBe(
      '"risu-plugin-storage-storage-hash"',
    );

    const pluginsData = await app.invoke(
      "GET",
      "/api/database-v2/plugins-data",
    );
    expect(pluginsData.response.body).toEqual({
      plugins: [alphaPlugin],
      pluginCustomStorage: { alpha: { count: 1 } },
      hash: "plugins-hash:storage-hash",
    });
    expect(pluginsData.response.headers.etag).toBe(
      '"risu-plugins-data-plugins-hash:storage-hash"',
    );
  });

  it("returns 304 for matching custom-storage and plugins-data ETags", async () => {
    const key = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage/keys/:key",
      {
        headers: { "if-none-match": '"risu-plugin-key-key-hash"' },
        params: { key: "alpha" },
      },
    );
    const allStorage = await app.invoke(
      "GET",
      "/api/database-v2/plugin-custom-storage",
      {
        headers: {
          "if-none-match": '"risu-plugin-storage-storage-hash"',
        },
      },
    );
    const pluginsData = await app.invoke(
      "GET",
      "/api/database-v2/plugins-data",
      {
        headers: {
          "if-none-match": '"risu-plugins-data-plugins-hash:storage-hash"',
        },
      },
    );

    for (const result of [key, allStorage, pluginsData]) {
      expect(result.response.statusCode).toBe(304);
      expect(result.response.ended).toBe(true);
    }
    expect(sendCompressedJson).not.toHaveBeenCalled();
  });

  it("gets the current storage instance for every request", async () => {
    const firstStorage = storage;
    const replacementPlugin = createPlugin("plugin-new", "replacement", true);
    const secondStorage = createStorage({
      loadPlugins: vi.fn(async () => ({
        hash: "replacement-hash",
        plugins: [replacementPlugin],
      })),
    });

    await app.invoke("GET", "/api/database-v2/plugins");
    storage = secondStorage;
    const replacement = await app.invoke("GET", "/api/database-v2/plugins");

    expect(firstStorage.loadPlugins).toHaveBeenCalledOnce();
    expect(secondStorage.loadPlugins).toHaveBeenCalledOnce();
    expect(replacement.response.body).toEqual({
      plugins: [replacementPlugin],
      hash: "replacement-hash",
    });
  });
});
