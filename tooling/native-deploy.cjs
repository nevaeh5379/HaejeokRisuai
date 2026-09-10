#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { parseAllowedOrigins } = require("../server/node/remoteCors.cjs");

const root = path.resolve(__dirname, "..");
const stateDir = path.join(root, ".risuai");
const configPath = path.join(stateDir, "native.json");
const pidPath = path.join(stateDir, "native.pid");
const logPath = path.join(stateDir, "native.log");
const defaultSavePath = path.join(stateDir, "native-save");
const CONFIG_VERSION = 1;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseEnvFile(filename) {
  const values = {};
  if (!filename) return values;
  const resolved = path.resolve(filename);
  const content = fs.readFileSync(resolved, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function takeOption(args, index) {
  if (index + 1 >= args.length) fail(`${args[index]} requires a value`);
  return args[index + 1];
}

function defaultAllowedOrigins(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host).toLowerCase())
    ? "http://localhost:5174,http://127.0.0.1:5174"
    : "";
}

function normalizeAllowedOrigins(value) {
  return Array.from(parseAllowedOrigins(value || "")).join(",");
}

function parseInstallArgs(args, env = process.env) {
  const options = {
    envFile: null,
    build: true,
    start: true,
    skipDbCheck: false,
  };
  const explicit = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-build") options.build = false;
    else if (arg === "--no-start") options.start = false;
    else if (arg === "--skip-db-check") options.skipDbCheck = true;
    else if (arg === "--env-file") options.envFile = takeOption(args, i++);
    else if (arg.startsWith("--"))
      explicit[arg.slice(2)] = takeOption(args, i++);
    else fail(`Unknown native install argument: ${arg}`);
  }
  const requestedVendor = (
    explicit["db-vendor"] ??
    env.DB_VENDOR ??
    "postgres"
  ).toLowerCase();
  if (!["postgres", "oracle", "azure"].includes(requestedVendor))
    fail(`Unsupported database vendor: ${requestedVendor}`);
  if (!options.envFile) {
    const candidate =
      requestedVendor === "postgres"
        ? path.join(root, ".env")
        : path.join(root, `.env.${requestedVendor}`);
    if (fs.existsSync(candidate)) options.envFile = candidate;
  }
  const fileEnv = parseEnvFile(options.envFile);
  const value = (key, flag, fallback = "") =>
    explicit[flag] ?? fileEnv[key] ?? env[key] ?? fallback;
  const vendor = (
    explicit["db-vendor"] ??
    fileEnv.DB_VENDOR ??
    env.DB_VENDOR ??
    requestedVendor
  ).toLowerCase();
  if (!["postgres", "oracle", "azure"].includes(vendor))
    fail(`Unsupported database vendor: ${vendor}`);
  const port = Number.parseInt(
    explicit.port ?? fileEnv.PORT ?? env.PORT ?? "6001",
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`Invalid native port: ${port}`);
  const host =
    explicit.host ?? fileEnv.RISU_HOST ?? env.RISU_HOST ?? "127.0.0.1";
  const savePath = path.resolve(
    explicit["save-path"] ??
      fileEnv.RISU_SAVE_PATH ??
      env.RISU_SAVE_PATH ??
      defaultSavePath,
  );
  const allowedOrigins = normalizeAllowedOrigins(
    value(
      "RISUAI_ALLOWED_ORIGINS",
      "allowed-origins",
      defaultAllowedOrigins(host),
    ),
  );
  const poolMax = Number.parseInt(explicit["pool-max"] ?? "10", 10);
  if (!Number.isInteger(poolMax) || poolMax < 1)
    fail(`Invalid pool size: ${poolMax}`);

  let params;
  if (vendor === "postgres") {
    params = {
      connectionString: value("DATABASE_URL", "database-url"),
      poolMax,
    };
    if (!params.connectionString)
      fail("PostgreSQL native mode requires --database-url or DATABASE_URL");
  } else if (vendor === "oracle") {
    params = {
      user: value("ORACLE_USER", "oracle-user"),
      password: value("ORACLE_USER_PASSWORD", "oracle-password"),
      tnsAlias: value("ORACLE_TNS_ALIAS", "oracle-tns-alias"),
      walletPath: value("ORACLE_WALLET_PATH", "oracle-wallet-path"),
      walletPassword: value("ORACLE_WALLET_PASSWORD", "oracle-wallet-password"),
      poolMax,
    };
    if (!params.user || !params.password || !params.tnsAlias)
      fail("Oracle native mode requires user, password, and TNS alias");
  } else {
    params = {
      server: value("AZURE_HOST", "azure-host"),
      database: value("AZURE_DATABASE", "azure-database"),
      user: value("AZURE_USERNAME", "azure-user"),
      password: value("AZURE_PASSWORD", "azure-password"),
      port: Number.parseInt(value("AZURE_PORT", "azure-port", "1433"), 10),
      poolMax,
    };
    if (!params.server || !params.database || !params.user || !params.password)
      fail("Azure SQL native mode requires host, database, user, and password");
    if (
      !Number.isInteger(params.port) ||
      params.port < 1 ||
      params.port > 65535
    )
      fail(`Invalid Azure SQL port: ${params.port}`);
  }
  return {
    options,
    config: {
      version: CONFIG_VERSION,
      host,
      port,
      savePath,
      allowedOrigins,
      db: { vendor, params },
      assetStorage: { type: "fs" },
    },
  };
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(stateDir, 0o700);
  } catch {}
}

function writeConfig(config) {
  ensureStateDir();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {}
}

function readConfig() {
  if (!fs.existsSync(configPath))
    fail(
      `No native installation found. Run './risuai.sh native install ...' first.`,
    );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.version !== CONFIG_VERSION)
    fail(`Unsupported native config version: ${config.version}`);
  return config;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  if (!processAlive(pid)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {}
    return null;
  }
  return pid;
}

function databaseEnv(config) {
  const { vendor, params } = config.db;
  const result = { DB_VENDOR: vendor };
  if (vendor === "postgres") {
    result.DATABASE_URL = params.connectionString;
    result.RISU_POSTGRES_POOL_MAX = String(params.poolMax || 10);
  } else if (vendor === "oracle") {
    result.ORACLE_USER = params.user;
    result.ORACLE_USER_PASSWORD = params.password;
    result.ORACLE_TNS_ALIAS = params.tnsAlias;
    if (params.walletPath) result.ORACLE_WALLET_PATH = params.walletPath;
    if (params.walletPassword)
      result.ORACLE_WALLET_PASSWORD = params.walletPassword;
    result.ORACLE_POOL_MAX = String(params.poolMax || 10);
  } else {
    result.AZURE_HOST = params.server;
    result.AZURE_DATABASE = params.database;
    result.AZURE_USERNAME = params.user;
    result.AZURE_PASSWORD = params.password;
    result.AZURE_PORT = String(params.port || 1433);
    result.AZURE_POOL_MAX = String(params.poolMax || 10);
  }
  return result;
}

function runtimeEnv(config) {
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(config.port),
    RISU_HOST: config.host,
    RISU_SAVE_PATH: config.savePath,
    RISU_STORAGE_TYPE: config.assetStorage?.type || "fs",
    TRUST_PROXY: "1",
    RISUAI_ALLOWED_ORIGINS:
      config.allowedOrigins ?? defaultAllowedOrigins(config.host),
    ...databaseEnv(config),
  };
}

function summarizeBuildOutput(outputDir = path.join(root, "dist")) {
  const indexPath = path.join(outputDir, "index.html");
  const assetsDir = path.join(outputDir, "assets");
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
    fail(`Native build did not produce ${indexPath}`);
  }
  if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
    fail(`Native build did not produce ${assetsDir}`);
  }
  let files = 0;
  let bytes = 0;
  const stack = [assetsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(fullPath).size;
      }
    }
  }
  if (files === 0)
    fail(`Native build produced an empty asset directory: ${assetsDir}`);
  return { files, bytes, outputDir, assetsDir, indexPath };
}

function runBuild() {
  console.log("==> Building native RisuAI");
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_RISU_LEGAL_CONFIGURED: "TRUE" },
  });
  if (result.status !== 0)
    fail(`Native build failed with exit code ${result.status ?? "unknown"}`);
  const output = summarizeBuildOutput();
  console.log(
    `OK: Native frontend assets ready (${output.files} files, ${(output.bytes / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

async function testDatabase(config) {
  const { testConnection } = require(
    path.join(root, "server/node/storageDriver.cjs"),
  );
  console.log(`==> Testing ${config.db.vendor} connection`);
  const result = await testConnection(config.db.vendor, config.db.params);
  if (!result.success)
    fail(`Database connection failed: ${result.error || "unknown error"}`);
  console.log(`OK: ${config.db.vendor} connection succeeded`);
}

async function waitForHealth(config, childPid) {
  const host =
    !config.host || config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${config.port}/api/health`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!processAlive(childPid))
      fail(`Native server exited before becoming ready. See ${logPath}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) {
        console.warn(
          `Warning: native server is reachable but health returned HTTP ${response.status}; recovery mode may be active.`,
        );
      }
      return;
    } catch {}
    await sleep(1000);
  }
  fail(`Native server did not become ready at ${url}. See ${logPath}`);
}

async function startNative(config = readConfig()) {
  const existing = readPid();
  if (existing) fail(`Native RisuAI is already running with PID ${existing}`);
  ensureStateDir();
  fs.mkdirSync(config.savePath, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [path.join(root, "server/node/server.cjs")],
    {
      cwd: root,
      env: runtimeEnv(config),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  await waitForHealth(config, child.pid);
  console.log(
    `OK: Native RisuAI started on ${config.host}:${config.port} (PID ${child.pid})`,
  );
}

async function stopNative() {
  const pid = readPid();
  if (!pid) {
    console.log("Native RisuAI is not running");
    return;
  }
  console.log(`==> Stopping native RisuAI (PID ${pid})`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 50 && processAlive(pid); i += 1) await sleep(100);
  if (processAlive(pid)) {
    console.warn(
      "Warning: native server did not stop after 5s; sending SIGKILL",
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    fs.unlinkSync(pidPath);
  } catch {}
  console.log("OK: Native RisuAI stopped");
}

function maskedConfig(config) {
  const clone = structuredClone(config);
  if (clone.db.vendor === "postgres") {
    try {
      const parsed = new URL(clone.db.params.connectionString);
      if (parsed.password) parsed.password = "***";
      clone.db.params.connectionString = parsed.toString();
    } catch {
      clone.db.params.connectionString = "<configured>";
    }
  }
  if (clone.db.vendor === "oracle") {
    clone.db.params.password = "***";
    if (clone.db.params.walletPassword) clone.db.params.walletPassword = "***";
  }
  if (clone.db.vendor === "azure") clone.db.params.password = "***";
  return clone;
}

function showStatus() {
  const config = readConfig();
  const pid = readPid();
  console.log(
    JSON.stringify(
      { running: Boolean(pid), pid, ...maskedConfig(config) },
      null,
      2,
    ),
  );
}

function showLogs(args) {
  const tailArg = args[0] && /^\d+$/.test(args[0]) ? Number(args[0]) : 200;
  if (!fs.existsSync(logPath)) {
    console.log("No native log file yet.");
    return;
  }
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
  console.log(lines.slice(Math.max(0, lines.length - tailArg - 1)).join("\n"));
}

function usage() {
  console.log(
    `RisuAI native deployment\n\nUsage:\n  ./risuai.sh native install --db-vendor postgres --database-url URL\n  ./risuai.sh native install --db-vendor oracle --env-file .env.oracle\n  ./risuai.sh native install --db-vendor azure --env-file .env.azure\n  ./risuai.sh native build|start|stop|restart|rebuild|status|config|logs\n\nCommon install options:\n  --port PORT             Node server port (default: 6001)\n  --host HOST             Listen host (default: 127.0.0.1)\n  --save-path PATH        Persistent local asset/settings path\n  --allowed-origins LIST  Exact comma-separated browser origins allowed for remote API CORS\n  --pool-max N            SQL connection pool size (default: 10)\n  --env-file FILE         Read DB variables from an env file\n  --skip-db-check         Save configuration without testing the DB\n  --no-build              Do not run pnpm build during install\n  --no-start              Do not start after install\n\nPostgreSQL:\n  --database-url URL      DATABASE_URL\n\nOracle:\n  --oracle-user USER\n  --oracle-password PASS\n  --oracle-tns-alias ALIAS\n  --oracle-wallet-path PATH\n  --oracle-wallet-password PASS\n\nAzure SQL:\n  --azure-host HOST\n  --azure-database DB\n  --azure-user USER\n  --azure-password PASS\n  --azure-port PORT       Default: 1433\n\nNative mode stores assets on the local filesystem. Database credentials are\nstored in .risuai/native.json with mode 0600.`,
  );
}

async function main(argv) {
  const command = argv[0] || "help";
  const args = argv.slice(1);
  if (command === "help" || command === "-h" || command === "--help")
    return usage();
  if (command === "install") {
    const { options, config } = parseInstallArgs(args);
    if (!options.skipDbCheck) await testDatabase(config);
    if (options.build) runBuild();
    writeConfig(config);
    console.log(`OK: Saved native configuration to ${configPath}`);
    if (options.start) await startNative(config);
    return;
  }
  if (args.length && !["logs"].includes(command))
    fail(`${command} does not accept arguments`);
  if (command === "build") return runBuild();
  if (command === "start") return startNative();
  if (command === "stop") return stopNative();
  if (command === "restart") {
    await stopNative();
    return startNative();
  }
  if (command === "rebuild") {
    await stopNative();
    runBuild();
    return startNative();
  }
  if (command === "status") return showStatus();
  if (command === "config")
    return console.log(JSON.stringify(maskedConfig(readConfig()), null, 2));
  if (command === "logs") return showLogs(args);
  fail(`Unknown native command: ${command}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    if (!process.exitCode) console.error(error.stack || error.message || error);
    process.exitCode ||= 1;
  });
}

module.exports = {
  parseEnvFile,
  parseInstallArgs,
  summarizeBuildOutput,
  databaseEnv,
  runtimeEnv,
  maskedConfig,
};
