import {
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
} from "./storageConfig.ts";
import { readStorageStartupSettings } from "../http/startupDiagnostics.ts";
import { loadPostgres, loadOracle, loadMssql } from "../util/runtimeModules.ts";
export * from "./storageConfig.ts";
// vendor별 저장소 인스턴스를 명시적 파라미터로 직접 생성 (primary/backup 공용)
async function instantiateVendorStorage(
  vendor?: any,
  params: any = {},
  options: any = {},
): Promise<any> {
  const poolMax: any =
    Number.isSafeInteger(options.poolMax) && options.poolMax > 0
      ? options.poolMax
      : 10;
  if (vendor === "azure") {
    const { AzureStorage } = await import("./azure/azureStorage.ts");
    return new AzureStorage({
      server: params.server || "",
      database: params.database || "",
      user: params.user || "",
      password: params.password || "",
      port:
        Number.isSafeInteger(params.port) && params.port > 0
          ? params.port
          : 1433,
      poolMax,
      enabled: options.enabled !== false,
    });
  }
  if (vendor === "oracle") {
    const { OracleStorage } = await import("./oracle/oracleStorage.ts");
    return new OracleStorage({
      user: params.user || "",
      password: params.password || "",
      tnsAlias: params.tnsAlias || "",
      walletPath: params.walletPath || undefined,
      walletPassword: params.walletPassword || undefined,
      poolMax,
      enabled: options.enabled !== false,
    });
  }
  const { PostgresStorage } = await import("./postgres/postgresStorage.ts");
  return new PostgresStorage({
    connectionString: params.connectionString || "",
    poolMax,
  });
}

// 백업 설정 적용: config 파일에 backup 섹션 기록 후 신규 백업 storage 인스턴스 반환.
// storage.initialize()는 호출자(server.cjs)가 연결 확인과 함께 수행.
async function applyBackupConfig(
  savePath: any,
  { vendor, params, mirroring, snapshot }: any,
): Promise<any> {
  const normalized: any = normalizeVendorParams(vendor, params);
  const complete: any = isVendorConfigComplete(vendor, normalized);
  const backupConfig: any = complete
    ? normalizeBackupConfigSection({
        vendor,
        enabled: true,
        poolMax: normalized.poolMax,
        params: normalized,
        mirroring: mirroring || {},
        snapshot: snapshot || {},
      })
    : null;
  const stored: any = readStoredDbConfig(savePath);
  writeStoredDbConfig(savePath, {
    vendor: stored.vendor,
    enabled: stored.enabled,
    poolMax: stored.poolMax,
    params: stored.params,
    backup: backupConfig,
  });
  const storage: any = backupConfig
    ? await instantiateVendorStorage(vendor, normalized, {
        poolMax: backupConfig.poolMax,
      })
    : null;
  return { backup: backupConfig, storage };
}

// 백업 설정 제거 (config 파일에서 backup 섹션 삭제)
// vendor별 연결 테스트 - 임시 인스턴스를 만들어 getPool/createInitializedPool 시도.
// throw 또는 error 반환하지 않고 { success, error } 형태로 반환.
async function testConnection(vendor?: any, rawParams: any = {}): Promise<any> {
  const params: any = normalizeVendorParams(vendor, rawParams);
  const startupSettings: any = readStorageStartupSettings();
  if (!isVendorConfigComplete(vendor, params)) {
    return {
      success: false,
      error: "Required connection parameters are missing",
    };
  }
  try {
    if (vendor === "postgres") {
      // initialize() 내부에서 SELECT 1 + 스키마 확인까지 수행.
      // 단, 스키마가 없으면 스키마를 생성하려 시도하므로, 테스트 전용으로는
      // Pool을 직접 만들어 SELECT 1만 수행.
      const { Pool } = await loadPostgres();
      const pool: any = new Pool({
        connectionString: params.connectionString,
        max: 1,
        application_name: "risuai-test",
        connectionTimeoutMillis: startupSettings.connectTimeoutMs,
      });
      try {
        await pool.query("SELECT 1");
        return { success: true };
      } finally {
        await pool.end().catch(() => {});
      }
    }
    if (vendor === "oracle") {
      const oracledb: any = await loadOracle();
      const conn: any = await oracledb.getConnection({
        user: params.user,
        password: params.password,
        connectString: params.tnsAlias,
        configDir: params.walletPath,
        walletLocation: params.walletPath,
        walletPassword: params.walletPassword,
      });
      try {
        await conn.execute("SELECT 1 FROM dual");
        return { success: true };
      } finally {
        try {
          await conn.close();
        } catch (e: any) {}
      }
    }
    if (vendor === "azure") {
      const sql: any = await loadMssql();
      const pool: any = new sql.ConnectionPool({
        server: params.server,
        port: params.port || 1433,
        database: params.database,
        user: params.user,
        password: params.password,
        connectionTimeout: startupSettings.connectTimeoutMs,
        requestTimeout: 10000,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          enableArithAbort: true,
        },
        pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
      });
      try {
        await pool.connect();
        await pool.request().query("SELECT 1");
        return { success: true };
      } finally {
        try {
          await pool.close();
        } catch (e: any) {}
      }
    }
    return { success: false, error: `Unsupported vendor: ${vendor}` };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

// 저장소 설정 적용: config 파일에 저장 후 신규 storage 인스턴스 반환.
// 기존 postgresStorage를 교체해야 하는 경우 server.cjs에서 이 함수로 재생성.
async function applyDbConfig(
  savePath: any,
  { vendor, params, enabled }: any,
): Promise<any> {
  const normalized: any = normalizeVendorParams(vendor, params);
  const complete: any = isVendorConfigComplete(vendor, normalized);
  const finalEnabled: any = enabled !== false && complete;
  const poolMax: any = normalized.poolMax || 10;
  writeStoredDbConfig(savePath, {
    vendor,
    enabled: finalEnabled,
    poolMax,
    params: normalized,
  });
  // 환경 변수에도 반영 (createServerStorage가 환경 변수를 읽으므로)
  if (vendor === "postgres") {
    if (normalized.connectionString)
      process.env.DATABASE_URL = normalized.connectionString;
  } else if (vendor === "oracle") {
    if (normalized.user) process.env.ORACLE_USER = normalized.user;
    if (normalized.password)
      process.env.ORACLE_USER_PASSWORD = normalized.password;
    if (normalized.tnsAlias) process.env.ORACLE_TNS_ALIAS = normalized.tnsAlias;
    if (normalized.walletPath)
      process.env.ORACLE_WALLET_PATH = normalized.walletPath;
    if (normalized.walletPassword)
      process.env.ORACLE_WALLET_PASSWORD = normalized.walletPassword;
    if (normalized.poolMax)
      process.env.ORACLE_POOL_MAX = String(normalized.poolMax);
  } else if (vendor === "azure") {
    if (normalized.server) process.env.AZURE_HOST = normalized.server;
    if (normalized.database) process.env.AZURE_DATABASE = normalized.database;
    if (normalized.user) process.env.AZURE_USERNAME = normalized.user;
    if (normalized.password) process.env.AZURE_PASSWORD = normalized.password;
    if (normalized.port) process.env.AZURE_PORT = String(normalized.port);
    if (normalized.poolMax)
      process.env.AZURE_POOL_MAX = String(normalized.poolMax);
  }
  // 신규 인스턴스 반환
  return createServerStorage(savePath, { vendor, postgresConfig: null });
}

// 팩토리: vendor에 따른 저장소 인스턴스 생성
async function createStorageDriver(options: any = {}): Promise<any> {
  const vendor: any = resolveVendor(options);

  if (vendor === "azure") {
    const { AzureStorage } = await import("./azure/azureStorage.ts");
    return new AzureStorage(options);
  }

  if (vendor === "oracle") {
    const { OracleStorage } = await import("./oracle/oracleStorage.ts");
    return new OracleStorage(options);
  }

  // 기본: postgres
  const { PostgresStorage } = await import("./postgres/postgresStorage.ts");
  return new PostgresStorage(options);
}

// 서버 부팅 시 저장소 인스턴스 생성 (server.cjs에서 호출)
// 환경 변수 + 설정 파일 + 기존 PostgreSQL 설정을 조합하여 적절한 구현체를 반환.
// 우선순위: 명시적 options.vendor > __db_config.json > 환경 변수 감지 > 기본 postgres
async function createServerStorage(
  savePath?: any,
  options: any = {},
): Promise<any> {
  // 환경 파일 로딩
  loadAzureEnvFile();
  loadOracleEnvFile();

  const storedConfig: any = readStoredDbConfig(savePath);
  const explicitVendor: any =
    options.vendor || process.env.DB_VENDOR || storedConfig.vendor;
  const postgresConfig: any = options.postgresConfig || null; // 기존 PostgreSQL 설정 (호환성)
  const storedParams: any = storedConfig.params || {};

  // vendor 결정
  let vendor: any = "postgres";
  let enabled: any = false;
  let poolMax: any = parseInt(process.env.RISU_POSTGRES_POOL_MAX || "10", 10);
  if (!Number.isSafeInteger(poolMax) || poolMax <= 0) poolMax = 10;

  // __db_config.json에 저장된 params가 있으면 그것을 사용, 없으면 환경 변수에서 읽기
  if (
    explicitVendor === "azure" ||
    (!explicitVendor &&
      (process.env.AZURE_HOST || process.env.AZURE_DATABASE) &&
      !process.env.DATABASE_URL &&
      !process.env.ORACLE_TNS_ALIAS)
  ) {
    vendor = "azure";
    const azureConfig: any =
      storedConfig.vendor === "azure" && Object.keys(storedParams).length > 0
        ? {
            server: storedParams.server || process.env.AZURE_HOST || "",
            database: storedParams.database || process.env.AZURE_DATABASE || "",
            user: storedParams.user || process.env.AZURE_USERNAME || "",
            password: storedParams.password || process.env.AZURE_PASSWORD || "",
            port:
              storedParams.port ||
              parseInt(process.env.AZURE_PORT || "1433", 10),
            poolMax:
              storedParams.poolMax ||
              parseInt(process.env.AZURE_POOL_MAX || "10", 10),
          }
        : readAzureConfigFromEnv();
    enabled = Boolean(
      azureConfig.server &&
      azureConfig.database &&
      azureConfig.user &&
      azureConfig.password,
    );
    poolMax = azureConfig.poolMax || poolMax;
  } else if (
    explicitVendor === "oracle" ||
    (!explicitVendor &&
      process.env.ORACLE_TNS_ALIAS &&
      !process.env.DATABASE_URL)
  ) {
    vendor = "oracle";
    const oracleConfig: any =
      storedConfig.vendor === "oracle" && Object.keys(storedParams).length > 0
        ? {
            user: storedParams.user || process.env.ORACLE_USER || "",
            password:
              storedParams.password || process.env.ORACLE_USER_PASSWORD || "",
            tnsAlias:
              storedParams.tnsAlias || process.env.ORACLE_TNS_ALIAS || "",
            walletPath:
              storedParams.walletPath || process.env.ORACLE_WALLET_PATH || "",
            walletPassword:
              storedParams.walletPassword ||
              process.env.ORACLE_WALLET_PASSWORD ||
              "",
            poolMax:
              storedParams.poolMax ||
              parseInt(process.env.ORACLE_POOL_MAX || "10", 10),
          }
        : readOracleConfigFromEnv();
    enabled = Boolean(
      oracleConfig.tnsAlias && oracleConfig.user && oracleConfig.password,
    );
    poolMax = oracleConfig.poolMax || poolMax;
  } else if (
    explicitVendor === "postgres" ||
    process.env.DATABASE_URL ||
    (postgresConfig && postgresConfig.enabled) ||
    (storedConfig.vendor === "postgres" && storedParams.connectionString)
  ) {
    vendor = "postgres";
    // 우선순위: postgresConfig(기존) > storedParams > 환경 변수
    if (postgresConfig && postgresConfig.enabled) {
      enabled = true;
      poolMax = postgresConfig.poolMax || poolMax;
    } else if (
      storedConfig.vendor === "postgres" &&
      storedParams.connectionString
    ) {
      enabled = storedConfig.enabled && Boolean(storedParams.connectionString);
      poolMax = storedParams.poolMax || poolMax;
    } else if (process.env.DATABASE_URL) {
      enabled = true;
    } else {
      enabled = false;
    }
  } else if (storedConfig.vendor === "azure") {
    vendor = "azure";
    const azureConfig: any = readAzureConfigFromEnv();
    enabled =
      storedConfig.enabled &&
      Boolean(
        azureConfig.server &&
        azureConfig.database &&
        azureConfig.user &&
        azureConfig.password,
      );
    poolMax = storedConfig.poolMax || poolMax;
  } else if (storedConfig.vendor === "oracle") {
    vendor = "oracle";
    const oracleConfig: any = readOracleConfigFromEnv();
    enabled =
      storedConfig.enabled &&
      Boolean(
        oracleConfig.tnsAlias && oracleConfig.user && oracleConfig.password,
      );
    poolMax = storedConfig.poolMax || poolMax;
  } else {
    // 기본: PostgreSQL (기존 설정)
    vendor = "postgres";
    enabled = postgresConfig ? postgresConfig.enabled : false;
    poolMax = postgresConfig ? postgresConfig.poolMax : poolMax;
  }

  if (vendor === "azure") {
    const { AzureStorage } = await import("./azure/azureStorage.ts");
    let azureConfig: any;
    if (
      storedConfig.vendor === "azure" &&
      Object.keys(storedParams).length > 0
    ) {
      azureConfig = {
        server: storedParams.server || process.env.AZURE_HOST || "",
        database: storedParams.database || process.env.AZURE_DATABASE || "",
        user: storedParams.user || process.env.AZURE_USERNAME || "",
        password: storedParams.password || process.env.AZURE_PASSWORD || "",
        port:
          storedParams.port || parseInt(process.env.AZURE_PORT || "1433", 10),
        poolMax: storedParams.poolMax || poolMax,
      };
    } else {
      azureConfig = readAzureConfigFromEnv();
    }
    return {
      vendor: "azure",
      storage: new AzureStorage({
        server: azureConfig.server,
        database: azureConfig.database,
        user: azureConfig.user,
        password: azureConfig.password,
        port: azureConfig.port,
        poolMax,
        enabled,
      }),
    };
  }

  if (vendor === "oracle") {
    const { OracleStorage } = await import("./oracle/oracleStorage.ts");
    let oracleConfig: any;
    if (
      storedConfig.vendor === "oracle" &&
      Object.keys(storedParams).length > 0
    ) {
      oracleConfig = {
        user: storedParams.user || process.env.ORACLE_USER || "",
        password:
          storedParams.password || process.env.ORACLE_USER_PASSWORD || "",
        tnsAlias: storedParams.tnsAlias || process.env.ORACLE_TNS_ALIAS || "",
        walletPath:
          storedParams.walletPath || process.env.ORACLE_WALLET_PATH || "",
        walletPassword:
          storedParams.walletPassword ||
          process.env.ORACLE_WALLET_PASSWORD ||
          "",
        poolMax: storedParams.poolMax || poolMax,
      };
    } else {
      oracleConfig = readOracleConfigFromEnv();
    }
    return {
      vendor: "oracle",
      storage: new OracleStorage({
        user: oracleConfig.user,
        password: oracleConfig.password,
        tnsAlias: oracleConfig.tnsAlias,
        walletPath: oracleConfig.walletPath,
        walletPassword: oracleConfig.walletPassword,
        poolMax,
        enabled,
      }),
    };
  }

  // postgres
  const { PostgresStorage } = await import("./postgres/postgresStorage.ts");
  let connectionString: any = "";
  if (postgresConfig && postgresConfig.enabled) {
    connectionString = postgresConfig.connectionString;
  } else if (
    storedConfig.vendor === "postgres" &&
    storedParams.connectionString
  ) {
    connectionString = storedParams.connectionString;
  } else if (process.env.DATABASE_URL) {
    connectionString = process.env.DATABASE_URL;
  }
  return {
    vendor: "postgres",
    storage: new PostgresStorage({
      connectionString,
      poolMax,
    }),
  };
}

export {
  testConnection,
  applyDbConfig,
  createStorageDriver,
  createServerStorage,
  instantiateVendorStorage,
  applyBackupConfig,
};
