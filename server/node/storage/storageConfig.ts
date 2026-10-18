const __dirname: any = import.meta.dirname;
// Storage Driver 추상화 레이어
// PostgreSQL과 Oracle 저장소 구현체를 동일한 인터페이스로 제공.
// server.cjs는 이 팩토리를 통해 vendor에 따른 구현체를 사용.

("use strict");

import * as fs from "fs";
import * as path from "path";
import { readStorageStartupSettings } from "../http/startupDiagnostics.ts";
import { SQL_DATABASE_VENDORS } from "../../../packages/protocol/storageConfig.ts";

import {
  StorageRevisionConflictError,
  StoragePayloadError,
} from "./storageErrors.ts";

// 지원하는 vendor 목록
const SUPPORTED_VENDORS: any = SQL_DATABASE_VENDORS;

// vendor 결정 우선순위:
// 1. 명시적 options.vendor
// 2. 환경 변수 DB_VENDOR
// 3. 환경 변수 AZURE_HOST / AZURE_DATABASE 존재 시 azure
// 4. 환경 변수 ORACLE_TNS_ALIAS 존재 시 oracle
// 5. 환경 변수 DATABASE_URL 존재 시 postgres
// 6. 기본값 postgres
function resolveVendor(options: any = {}): any {
  if (options.vendor && SUPPORTED_VENDORS.includes(options.vendor)) {
    return options.vendor;
  }
  if (
    process.env.DB_VENDOR &&
    SUPPORTED_VENDORS.includes(process.env.DB_VENDOR)
  ) {
    return process.env.DB_VENDOR;
  }
  if (process.env.AZURE_HOST || process.env.AZURE_DATABASE) {
    return "azure";
  }
  if (process.env.ORACLE_TNS_ALIAS) {
    return "oracle";
  }
  if (process.env.DATABASE_URL) {
    return "postgres";
  }
  return "postgres";
}

function loadVendorEnvFile(filename?: any, customPath: any = null): any {
  const envCandidates: any = customPath
    ? [customPath]
    : [
        path.join(__dirname, filename),
        path.join(process.cwd(), filename),
        path.join(__dirname, "../..", filename),
      ];
  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) continue;
    const content: any = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed: any = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx: any = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key: any = trimmed.slice(0, eqIdx).trim();
      let value: any = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    return envPath;
  }
  return null;
}

// 환경에서 Azure SQL 설정 로딩 (.env.azure 자동 로딩 포함)
function loadAzureEnvFile(customPath: any = null): any {
  return loadVendorEnvFile(".env.azure", customPath);
}

// Azure SQL 설정 객체 생성 (환경 변수에서)
function readAzureConfigFromEnv(): any {
  return {
    server: process.env.AZURE_HOST || "",
    database: process.env.AZURE_DATABASE || "",
    user: process.env.AZURE_USERNAME || "",
    password: process.env.AZURE_PASSWORD || "",
    port: parseInt(process.env.AZURE_PORT || "1433", 10),
    poolMax: parseInt(process.env.AZURE_POOL_MAX || "10", 10),
  };
}

// 환경에서 Oracle 설정 로딩 (.env.oracle 자동 로딩 포함)
function loadOracleEnvFile(customPath: any = null): any {
  return loadVendorEnvFile(".env.oracle", customPath);
}

// Oracle 설정 객체 생성 (환경 변수에서)
function readOracleConfigFromEnv(): any {
  return {
    user: process.env.ORACLE_USER || "",
    password: process.env.ORACLE_USER_PASSWORD || "",
    tnsAlias: process.env.ORACLE_TNS_ALIAS || "",
    walletPath: process.env.ORACLE_WALLET_PATH || "",
    walletPassword: process.env.ORACLE_WALLET_PASSWORD || "",
    poolMax: parseInt(process.env.ORACLE_POOL_MAX || "10", 10),
  };
}

// 저장소 설정 파일 경로 (vendor별)
function getDbConfigPath(savePath?: any): any {
  return path.join(savePath, "__db_config.json");
}

// 저장소 설정 파일 읽기 (vendor + 공통 설정 + vendor별 연결 파라미터 + 선택적 백업 설정)
// 비밀번호 등 민감 정보를 포함하므로 파일 권한은 0600으로 유지.
function readStoredDbConfig(savePath?: any): any {
  const configPath: any = getDbConfigPath(savePath);
  if (!fs.existsSync(configPath)) {
    return {
      vendor: null,
      enabled: false,
      poolMax: 10,
      params: {},
      backup: null,
    };
  }
  try {
    const parsed: any = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      vendor: parsed.vendor || null,
      enabled: parsed.enabled === true,
      poolMax:
        Number.isSafeInteger(parsed.poolMax) && parsed.poolMax > 0
          ? parsed.poolMax
          : 10,
      params: parsed.params || {},
      backup: normalizeBackupConfigSection(parsed.backup),
    };
  } catch (error: any) {
    throw new Error(`Could not read DB server configuration: ${error.message}`);
  }
}

// 저장소 설정 파일 쓰기 (0600 권한 - 비밀번호 포함)
function writeStoredDbConfig(savePath?: any, config?: any): any {
  const configPath: any = getDbConfigPath(savePath);
  const payload: any = JSON.stringify({
    vendor: config.vendor || null,
    enabled: config.enabled === true,
    poolMax: config.poolMax || 10,
    params: config.params || {},
    ...(config.backup !== undefined ? { backup: config.backup ?? null } : {}),
  });
  fs.writeFileSync(configPath, payload, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (e: any) {
    // 권한 변경 실패는 무시 (Windows 등)
  }
}

// ── 백업 데이터베이스 설정 ─────────────────────────────────────────────────

const MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES: any = 5;
const MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES: any = 1440;
const DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES: any = 60;

// 백업 설정 섹션 정규화 (부족한 필드는 기본값으로 채움).
// 지원 vendor가 없으면 null (비활성 섹션).
function normalizeBackupConfigSection(raw?: any): any {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (!SUPPORTED_VENDORS.includes(raw.vendor)) {
    return null;
  }
  const rawInterval: any = Number.parseInt(raw.snapshot?.intervalMinutes, 10);
  const intervalMinutes: any =
    Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.min(
          MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
          Math.max(MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES, rawInterval),
        )
      : DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES;
  return {
    vendor: raw.vendor,
    enabled: raw.enabled === true,
    poolMax:
      Number.isSafeInteger(raw.poolMax) && raw.poolMax > 0 ? raw.poolMax : 10,
    params: raw.params && typeof raw.params === "object" ? raw.params : {},
    mirroring: {
      enabled: raw.mirroring?.enabled === true,
    },
    snapshot: {
      enabled: raw.snapshot?.enabled === true,
      intervalMinutes,
    },
  };
}

// vendor별 연결 파라미터 정규화 (빈 값 제거)
function normalizeVendorParams(vendor?: any, rawParams: any = {}): any {
  const params: any = {};
  if (vendor === "postgres") {
    if (
      typeof rawParams.connectionString === "string" &&
      rawParams.connectionString.trim()
    ) {
      params.connectionString = rawParams.connectionString.trim();
    }
    const poolMax: any = Number.parseInt(rawParams.poolMax || "10", 10);
    if (Number.isSafeInteger(poolMax) && poolMax > 0) {
      params.poolMax = poolMax;
    }
  } else if (vendor === "oracle") {
    for (const key of [
      "user",
      "password",
      "tnsAlias",
      "walletPath",
      "walletPassword",
    ]) {
      if (typeof rawParams[key] === "string" && rawParams[key].trim()) {
        params[key] = rawParams[key].trim();
      }
    }
    const poolMax: any = Number.parseInt(rawParams.poolMax || "10", 10);
    if (Number.isSafeInteger(poolMax) && poolMax > 0) {
      params.poolMax = poolMax;
    }
  } else if (vendor === "azure") {
    for (const key of ["server", "database", "user", "password"]) {
      if (typeof rawParams[key] === "string" && rawParams[key].trim()) {
        params[key] = rawParams[key].trim();
      }
    }
    const port: any = Number.parseInt(rawParams.port || "1433", 10);
    if (Number.isSafeInteger(port) && port > 0) {
      params.port = port;
    }
    const poolMax: any = Number.parseInt(rawParams.poolMax || "10", 10);
    if (Number.isSafeInteger(poolMax) && poolMax > 0) {
      params.poolMax = poolMax;
    }
  }
  return params;
}

// vendor가 활성화 가능한지 (필수 파라미터 모두 존재)
function isVendorConfigComplete(vendor?: any, params: any = {}): any {
  if (vendor === "postgres") {
    return Boolean(params.connectionString);
  }
  if (vendor === "oracle") {
    return Boolean(params.tnsAlias && params.user && params.password);
  }
  if (vendor === "azure") {
    return Boolean(
      params.server && params.database && params.user && params.password,
    );
  }
  return false;
}

// 환경 변수 기반 설정인지 (브라우저에서 변경 불가)
// 세 vendor 모두 환경 변수로 설정된 경우 true.
function isStorageManagedByEnvironment(vendor?: any): any {
  if (vendor === "postgres") {
    return Boolean(process.env.DATABASE_URL);
  }
  if (vendor === "oracle") {
    return Boolean(process.env.ORACLE_TNS_ALIAS);
  }
  if (vendor === "azure") {
    return Boolean(process.env.AZURE_HOST || process.env.AZURE_DATABASE);
  }
  return false;
}

export {
  StorageRevisionConflictError,
  StoragePayloadError,
  SUPPORTED_VENDORS,
  resolveVendor,
  loadAzureEnvFile,
  readAzureConfigFromEnv,
  loadOracleEnvFile,
  readOracleConfigFromEnv,
  readStoredDbConfig,
  writeStoredDbConfig,
  getDbConfigPath,
  normalizeVendorParams,
  isVendorConfigComplete,
  isStorageManagedByEnvironment,
  normalizeBackupConfigSection,
  removeBackupConfig,
  MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
  MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
  DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
};

function removeBackupConfig(savePath?: any): void {
  const stored = readStoredDbConfig(savePath);
  writeStoredDbConfig(savePath, { ...stored, backup: null });
}
