"use strict";

const DEFAULT_STORAGE_STARTUP_TIMEOUT_MS = 180000;
const DEFAULT_STORAGE_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_STORAGE_HEARTBEAT_MS = 10000;

class StartupTimeoutError extends Error {
  constructor(scope, operation, timeoutMs) {
    super(`${operation} did not finish within ${formatDuration(timeoutMs)}`);
    this.name = "StartupTimeoutError";
    this.code = "RISUAI_STARTUP_TIMEOUT";
    this.scope = scope;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function readBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function readStorageStartupSettings(env = process.env) {
  const startupTimeoutMs = readBoundedInteger(
    env.RISU_STORAGE_STARTUP_TIMEOUT_MS,
    DEFAULT_STORAGE_STARTUP_TIMEOUT_MS,
    1000,
    3600000,
  );
  const defaultConnectTimeoutMs = Math.min(
    DEFAULT_STORAGE_CONNECT_TIMEOUT_MS,
    startupTimeoutMs,
  );
  return {
    startupTimeoutMs,
    connectTimeoutMs: readBoundedInteger(
      env.RISU_STORAGE_CONNECT_TIMEOUT_MS,
      defaultConnectTimeoutMs,
      1000,
      startupTimeoutMs,
    ),
    heartbeatMs: readBoundedInteger(
      env.RISU_STORAGE_STARTUP_HEARTBEAT_MS,
      DEFAULT_STORAGE_HEARTBEAT_MS,
      1000,
      60000,
    ),
  };
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function sanitizeSensitiveText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1<redacted>@")
    .replace(
      /\b(password|passwd|pwd|secret|token|access[_-]?key|api[_-]?key)=([^\s&,;]+)/gi,
      "$1=<redacted>",
    );
}

function describePostgresTarget(connectionString) {
  if (!connectionString) return "legacy file storage (PostgreSQL disabled)";
  try {
    const target = new URL(connectionString);
    const host = target.hostname.includes(":")
      ? `[${target.hostname}]`
      : target.hostname;
    const port = target.port || "5432";
    const database =
      decodeURIComponent(target.pathname.replace(/^\//, "")) ||
      "(default database)";
    const sslMode = target.searchParams.get("sslmode");
    return `${host || "(local socket)"}:${port}/${database}${sslMode ? ` (sslmode=${sslMode})` : ""}`;
  } catch {
    return "configured PostgreSQL target (connection URL is not parseable)";
  }
}

function describeOracleTarget(tnsAlias, walletPath = "") {
  const alias =
    typeof tnsAlias === "string" && /^[A-Za-z0-9_.-]+$/.test(tnsAlias)
      ? tnsAlias
      : "configured TNS descriptor";
  return `${alias}${walletPath ? " (wallet configured)" : ""}`;
}

function describeStorageTarget(vendor, storage) {
  if (!storage?.enabled) return `legacy file storage (${vendor} disabled)`;
  if (vendor === "postgres")
    return describePostgresTarget(storage.connectionString);
  if (vendor === "oracle") {
    return describeOracleTarget(storage.tnsAlias, storage.walletPath);
  }
  if (vendor === "azure") {
    return `${storage.server || "(missing server)"}:${storage.port || 1433}/${storage.database || "(missing database)"}`;
  }
  return `${vendor || "unknown"} storage`;
}

function errorDiagnostic(error) {
  const fields = [];
  for (const key of ["code", "errno", "syscall", "address", "port"]) {
    if (
      error?.[key] !== undefined &&
      error?.[key] !== null &&
      error[key] !== ""
    ) {
      fields.push(`${key}=${sanitizeSensitiveText(error[key])}`);
    }
  }
  return fields.join(", ");
}

function startupErrorHint(error) {
  const code = error?.code;
  const message = String(error?.message || "").toLowerCase();
  if (code === "RISUAI_STARTUP_TIMEOUT") {
    return "The active operation is shown in the last progress line. Check database reachability, locks, and server load, or raise RISU_STORAGE_STARTUP_TIMEOUT_MS.";
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return "Database hostname lookup failed. Check the hostname and Docker network/service name.";
  }
  if (["ECONNREFUSED", "ECONNRESET"].includes(code)) {
    return "The database endpoint rejected or reset the connection. Check that it is running, healthy, and listening on the configured port.";
  }
  if (
    ["ETIMEDOUT", "ESOCKET"].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("connection timed out")
  ) {
    return "The database connection timed out. Check routing, firewall rules, TLS settings, and database load.";
  }
  if (["28P01", "28000", "ORA-01017", "ELOGIN"].includes(code)) {
    return "Database authentication failed. Check the configured user and password.";
  }
  if (code === "3D000") {
    return "The configured PostgreSQL database does not exist.";
  }
  return "";
}

async function runStartupStage(options, task) {
  const {
    scope = "Startup",
    operation,
    detail = "",
    timeoutMs = 0,
    heartbeatMs = DEFAULT_STORAGE_HEARTBEAT_MS,
    logger = console,
  } = options || {};
  if (!operation || typeof task !== "function") {
    throw new TypeError("runStartupStage requires an operation and task");
  }

  const startedAt = Date.now();
  const safeDetail = sanitizeSensitiveText(detail);
  logger.log(
    `[${scope}] ${operation} started${safeDetail ? ` (${safeDetail})` : ""}.`,
  );

  let heartbeat = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      logger.warn(
        `[${scope}] ${operation} is still running (${formatDuration(Date.now() - startedAt)} elapsed).`,
      );
    }, heartbeatMs);
  }

  let timeout = null;
  const operationPromise = Promise.resolve().then(task);
  const guardedPromise =
    timeoutMs > 0
      ? Promise.race([
          operationPromise,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new StartupTimeoutError(scope, operation, timeoutMs)),
              timeoutMs,
            );
          }),
        ])
      : operationPromise;

  try {
    const result = await guardedPromise;
    logger.log(
      `[${scope}] ${operation} completed in ${formatDuration(Date.now() - startedAt)}.`,
    );
    return result;
  } catch (error) {
    if (error && typeof error === "object") {
      error.startupOperation ||= operation;
      error.startupScope ||= scope;
    }
    const message = sanitizeSensitiveText(
      error?.message || error || "Unknown error",
    );
    logger.error(
      `[${scope}] ${operation} failed after ${formatDuration(Date.now() - startedAt)}: ${message}`,
    );
    const diagnostic = errorDiagnostic(error);
    if (diagnostic) logger.error(`[${scope}] Diagnostic: ${diagnostic}`);
    const hint = startupErrorHint(error);
    if (hint) logger.error(`[${scope}] Hint: ${hint}`);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_STORAGE_STARTUP_TIMEOUT_MS,
  DEFAULT_STORAGE_CONNECT_TIMEOUT_MS,
  DEFAULT_STORAGE_HEARTBEAT_MS,
  StartupTimeoutError,
  describeOracleTarget,
  describePostgresTarget,
  describeStorageTarget,
  errorDiagnostic,
  formatDuration,
  readStorageStartupSettings,
  runStartupStage,
  sanitizeSensitiveText,
  startupErrorHint,
};
