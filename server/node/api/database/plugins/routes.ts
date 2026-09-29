import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type {
  PluginMetadata,
  PluginScript,
  PluginStorageRecord,
  PluginStorageValue,
} from "../../../../../src/ts/plugins/pluginTypes.js";
import type { PluginToggleMutation } from "../../../sync/databaseMutations.cjs";

type MaybePromise<T> = T | Promise<T>;

type PluginStorageRequest = {
  body?: PluginToggleRequestBody | null;
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  query: {
    enabledOnly?: string | string[];
  };
};

type PluginToggleRequestBody = {
  baseRevision?: number | string;
  enabled?: boolean;
};

type PluginStorageHttpBody =
  | { error: string; code?: string; revision?: number }
  | { hash: string; plugins: PluginMetadata[] }
  | { plugin: PluginMetadata }
  | { script: PluginScript["script"] }
  | { success: true; revision: number }
  | { keys: string[] }
  | { hash: string; key: string; value: PluginStorageValue }
  | { hash: string; pluginCustomStorage: PluginStorageRecord }
  | {
      hash: string;
      plugins: PluginMetadata[];
      pluginCustomStorage: PluginStorageRecord;
    };

type PluginStorageResponse = {
  end: () => PluginStorageResponse;
  send: (body: PluginStorageHttpBody) => PluginStorageResponse;
  setHeader: (name: string, value: string) => PluginStorageResponse;
  status: (statusCode: number) => PluginStorageResponse;
};

type PluginStorageNext = (error?: unknown) => void;

type PluginStorageRouteHandler = (
  req: PluginStorageRequest,
  res: PluginStorageResponse,
  next: PluginStorageNext,
) => void | Promise<void>;

type PluginStorageRouteApp = {
  get: (path: string, ...handlers: PluginStorageRouteHandler[]) => void;
  patch: (path: string, ...handlers: PluginStorageRouteHandler[]) => void;
};

type PluginStorage = {
  enabled: boolean;
  listPluginCustomStorageKeys: () => Promise<string[]>;
  loadPluginCustomStorage: () => Promise<{
    pluginCustomStorage: PluginStorageRecord;
    hash: string;
  }>;
  loadPluginCustomStorageKey: (key: string) => Promise<{
    exists: boolean;
    hash: string;
    key: string;
    value: PluginStorageValue;
  }>;
  loadPlugins: (options?: { pluginId?: string }) => Promise<{
    hash: string;
    plugins: PluginMetadata[];
  }>;
  loadPluginsData: () => Promise<{
    hash: string;
    pluginCustomStorage: PluginStorageRecord;
    plugins: PluginMetadata[];
  }>;
  loadPluginScript: (
    pluginId: PluginScript["pluginId"],
  ) => Promise<PluginScript["script"] | null>;
};

type PluginStorageMutationApi = {
  togglePlugin: PluginToggleMutation;
};

interface PluginStorageRevisionConflictError extends Error {
  revision: number;
}

/**
 * Runtime dependencies used by the plugin-storage HTTP routes.
 * 플러그인 저장 HTTP 라우트가 사용하는 런타임 의존성입니다.
 */
export type PluginStorageRouteDependencies = {
  app: PluginStorageRouteApp;
  authenticatedRouteLimiter: PluginStorageRouteHandler;
  checkAuth: (
    req: PluginStorageRequest,
    res: PluginStorageResponse,
  ) => MaybePromise<boolean>;
  databaseMutations: PluginStorageMutationApi;
  getStorage: () => PluginStorage;
  isPayloadError: (error: Error) => boolean;
  isRevisionConflictError: (
    error: Error,
  ) => error is PluginStorageRevisionConflictError;
  postgresJsonParser: PluginStorageRouteHandler;
  requireNodeAuth: PluginStorageRouteHandler;
  sendCompressedJson: (
    req: PluginStorageRequest,
    res: PluginStorageResponse,
    payload: PluginStorageHttpBody,
  ) => Promise<void>;
};

function normalizeHeader(value: IncomingHttpHeaders[string]): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function requestHasEtag(req: PluginStorageRequest, etag: string): boolean {
  return normalizeHeader(req.headers["if-none-match"])
    .split(",")
    .map((value) => value.trim())
    .includes(etag);
}

function setPrivateRevalidationHeaders(
  res: PluginStorageResponse,
  etag: string,
): void {
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, no-cache");
}

/**
 * Registers the database-v2 plugin and plugin-custom-storage routes.
 * database-v2의 플러그인 및 플러그인 사용자 저장소 라우트를 등록합니다.
 *
 * @param dependencies - Live server dependencies. 살아 있는 서버 의존성입니다.
 */
export function registerPluginStorageRoutes({
  app,
  authenticatedRouteLimiter,
  checkAuth,
  databaseMutations,
  getStorage,
  isPayloadError,
  isRevisionConflictError,
  postgresJsonParser,
  requireNodeAuth,
  sendCompressedJson,
}: PluginStorageRouteDependencies): void {
  app.get(
    "/api/database-v2/plugins",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "PostgreSQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }

      try {
        const result = await storage.loadPlugins();
        const enabledOnly =
          req.query.enabledOnly === "1" || req.query.enabledOnly === "true";
        const plugins = enabledOnly
          ? result.plugins.filter((plugin) => plugin?.enabled)
          : result.plugins;
        const hash = enabledOnly
          ? createHash("sha256").update(JSON.stringify(plugins)).digest("hex")
          : result.hash;
        const etag = `"risu-plugins-${enabledOnly ? "runtime-" : ""}${hash}"`;
        setPrivateRevalidationHeaders(res, etag);
        if (requestHasEtag(req, etag)) {
          res.status(304).end();
          return;
        }
        await sendCompressedJson(req, res, { plugins, hash });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugins/:pluginId",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) return;
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "SQL storage is not configured",
          code: "sql_disabled",
        });
        return;
      }
      try {
        const result = await storage.loadPlugins({
          pluginId: req.params.pluginId,
        });
        const plugin = result.plugins[0] ?? null;
        if (plugin === null) {
          res
            .status(404)
            .send({ error: "Plugin not found", code: "plugin_not_found" });
          return;
        }
        await sendCompressedJson(req, res, { plugin });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugins/:pluginId/script",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) return;
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "SQL storage is not configured",
          code: "sql_disabled",
        });
        return;
      }
      try {
        const script = await storage.loadPluginScript(req.params.pluginId);
        if (script === null) {
          res.status(404).send({
            error: "Plugin script not found",
            code: "plugin_not_found",
          });
          return;
        }
        await sendCompressedJson(req, res, { script });
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/database-v2/plugins/:pluginName/enabled",
    authenticatedRouteLimiter,
    requireNodeAuth,
    postgresJsonParser,
    async (req, res, next) => {
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "SQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }
      try {
        const enabled = req.body?.enabled;
        const baseRevision = Number(req.body?.baseRevision);
        if (
          typeof enabled !== "boolean" ||
          !Number.isSafeInteger(baseRevision) ||
          baseRevision < 0
        ) {
          res.status(400).send({
            error: "enabled and baseRevision are required",
            code: "invalid_plugin_toggle",
          });
          return;
        }
        const loaded = await storage.loadPlugins();
        const plugins = loaded.plugins.map((plugin) => ({ ...plugin }));
        const plugin = plugins.find(
          (item) => item?.name === req.params.pluginName,
        );
        if (!plugin) {
          res
            .status(404)
            .send({ error: "Plugin not found", code: "plugin_not_found" });
          return;
        }
        const result = await databaseMutations.togglePlugin(
          {
            baseRevision,
            pluginId: plugin.id,
            pluginName: req.params.pluginName,
            enabled,
          },
          req.headers["x-risu-client-id"],
        );
        res.send({ success: true, revision: result.revision });
      } catch (error) {
        if (error instanceof Error && isRevisionConflictError(error)) {
          res.status(409).send({
            error: error.message,
            code: "revision_conflict",
            revision: error.revision,
          });
          return;
        }
        if (error instanceof Error && isPayloadError(error)) {
          res.status(400).send({
            error: error.message,
            code: "invalid_plugin_toggle",
          });
          return;
        }
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugin-custom-storage/keys",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "PostgreSQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }

      try {
        const keys = await storage.listPluginCustomStorageKeys();
        await sendCompressedJson(req, res, { keys });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugin-custom-storage/keys/:key",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "PostgreSQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }

      try {
        const result = await storage.loadPluginCustomStorageKey(req.params.key);
        if (!result.exists) {
          res.status(404).send({
            error: `Plugin custom storage key not found: ${req.params.key}`,
          });
          return;
        }
        const etag = `"risu-plugin-key-${result.hash}"`;
        setPrivateRevalidationHeaders(res, etag);
        if (requestHasEtag(req, etag)) {
          res.status(304).end();
          return;
        }
        await sendCompressedJson(req, res, {
          key: result.key,
          value: result.value,
          hash: result.hash,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugin-custom-storage",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "PostgreSQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }

      try {
        const result = await storage.loadPluginCustomStorage();
        const etag = `"risu-plugin-storage-${result.hash}"`;
        setPrivateRevalidationHeaders(res, etag);
        if (requestHasEtag(req, etag)) {
          res.status(304).end();
          return;
        }
        await sendCompressedJson(req, res, {
          pluginCustomStorage: result.pluginCustomStorage,
          hash: result.hash,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/database-v2/plugins-data",
    authenticatedRouteLimiter,
    async (req, res, next) => {
      if (!(await checkAuth(req, res))) {
        return;
      }
      const storage = getStorage();
      if (!storage.enabled) {
        res.status(404).send({
          error: "PostgreSQL storage is not configured",
          code: "postgres_disabled",
        });
        return;
      }

      try {
        const result = await storage.loadPluginsData();
        const etag = `"risu-plugins-data-${result.hash}"`;
        setPrivateRevalidationHeaders(res, etag);
        if (requestHasEtag(req, etag)) {
          res.status(304).end();
          return;
        }
        await sendCompressedJson(req, res, {
          plugins: result.plugins,
          pluginCustomStorage: result.pluginCustomStorage,
          hash: result.hash,
        });
      } catch (error) {
        next(error);
      }
    },
  );
}
