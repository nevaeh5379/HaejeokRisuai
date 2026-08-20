// Storage Driver 추상화 레이어
// PostgreSQL과 Oracle 저장소 구현체를 동일한 인터페이스로 제공.
// server.cjs는 이 팩토리를 통해 vendor에 따른 구현체를 사용.

'use strict';

const fs = require('fs');
const path = require('path');

const {
    PostgresRevisionConflictError,
    PostgresPayloadError,
} = require('./postgresStorage.cjs');

// 공통 에러 타입 (구현체 무관 및 server.cjs 핸들러 호환)
class StorageRevisionConflictError extends PostgresRevisionConflictError {
    constructor(revision, message = 'Storage revision conflict') {
        super(revision);
        this.message = message;
        this.name = 'StorageRevisionConflictError';
        this.revision = revision;
    }
}

class StoragePayloadError extends PostgresPayloadError {
    constructor(message) {
        super(message);
        this.name = 'StoragePayloadError';
    }
}

// 지원하는 vendor 목록
const SUPPORTED_VENDORS = ['postgres', 'oracle', 'azure'];

// vendor 결정 우선순위:
// 1. 명시적 options.vendor
// 2. 환경 변수 DB_VENDOR
// 3. 환경 변수 AZURE_HOST / AZURE_DATABASE 존재 시 azure
// 4. 환경 변수 ORACLE_TNS_ALIAS 존재 시 oracle
// 5. 환경 변수 DATABASE_URL 존재 시 postgres
// 6. 기본값 postgres
function resolveVendor(options = {}) {
    if (options.vendor && SUPPORTED_VENDORS.includes(options.vendor)) {
        return options.vendor;
    }
    if (process.env.DB_VENDOR && SUPPORTED_VENDORS.includes(process.env.DB_VENDOR)) {
        return process.env.DB_VENDOR;
    }
    if (process.env.AZURE_HOST || process.env.AZURE_DATABASE) {
        return 'azure';
    }
    if (process.env.ORACLE_TNS_ALIAS) {
        return 'oracle';
    }
    if (process.env.DATABASE_URL) {
        return 'postgres';
    }
    return 'postgres';
}

function loadVendorEnvFile(filename, customPath = null) {
    const envCandidates = customPath ? [customPath] : [
        path.join(__dirname, filename),
        path.join(process.cwd(), filename),
        path.join(__dirname, '../..', filename),
    ];
    for (const envPath of envCandidates) {
        if (!fs.existsSync(envPath)) continue;
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx <= 0) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
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
function loadAzureEnvFile(customPath = null) {
    return loadVendorEnvFile('.env.azure', customPath);
}

// Azure SQL 설정 객체 생성 (환경 변수에서)
function readAzureConfigFromEnv() {
    return {
        server: process.env.AZURE_HOST || '',
        database: process.env.AZURE_DATABASE || '',
        user: process.env.AZURE_USERNAME || '',
        password: process.env.AZURE_PASSWORD || '',
        port: parseInt(process.env.AZURE_PORT || '1433', 10),
        poolMax: parseInt(process.env.AZURE_POOL_MAX || '10', 10),
    };
}

// 환경에서 Oracle 설정 로딩 (.env.oracle 자동 로딩 포함)
function loadOracleEnvFile(customPath = null) {
    return loadVendorEnvFile('.env.oracle', customPath);
}

// Oracle 설정 객체 생성 (환경 변수에서)
function readOracleConfigFromEnv() {
    return {
        user: process.env.ORACLE_USER || '',
        password: process.env.ORACLE_USER_PASSWORD || '',
        tnsAlias: process.env.ORACLE_TNS_ALIAS || '',
        walletPath: process.env.ORACLE_WALLET_PATH || '',
        walletPassword: process.env.ORACLE_WALLET_PASSWORD || '',
        poolMax: parseInt(process.env.ORACLE_POOL_MAX || '10', 10),
    };
}

// 저장소 설정 파일 경로 (vendor별)
function getDbConfigPath(savePath) {
    return path.join(savePath, '__db_config.json');
}

// 저장소 설정 파일 읽기 (vendor + 공통 설정 + vendor별 연결 파라미터 + 선택적 백업 설정)
// 비밀번호 등 민감 정보를 포함하므로 파일 권한은 0600으로 유지.
function readStoredDbConfig(savePath) {
    const configPath = getDbConfigPath(savePath);
    if (!fs.existsSync(configPath)) {
        return { vendor: null, enabled: false, poolMax: 10, params: {}, backup: null };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return {
            vendor: parsed.vendor || null,
            enabled: parsed.enabled === true,
            poolMax: Number.isSafeInteger(parsed.poolMax) && parsed.poolMax > 0 ? parsed.poolMax : 10,
            params: parsed.params || {},
            backup: normalizeBackupConfigSection(parsed.backup),
        };
    } catch (error) {
        throw new Error(`Could not read DB server configuration: ${error.message}`);
    }
}

// 저장소 설정 파일 쓰기 (0600 권한 - 비밀번호 포함)
function writeStoredDbConfig(savePath, config) {
    const configPath = getDbConfigPath(savePath);
    const payload = JSON.stringify({
        vendor: config.vendor || null,
        enabled: config.enabled === true,
        poolMax: config.poolMax || 10,
        params: config.params || {},
        ...(config.backup !== undefined ? { backup: config.backup ?? null } : {}),
    });
    fs.writeFileSync(configPath, payload, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch (e) {
        // 권한 변경 실패는 무시 (Windows 등)
    }
}

// ── 백업 데이터베이스 설정 ─────────────────────────────────────────────────

const MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES = 5;
const MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES = 1440;
const DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES = 60;

// 백업 설정 섹션 정규화 (부족한 필드는 기본값으로 채움).
// 지원 vendor가 없으면 null (비활성 섹션).
function normalizeBackupConfigSection(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    if (!SUPPORTED_VENDORS.includes(raw.vendor)) {
        return null;
    }
    const rawInterval = Number.parseInt(raw.snapshot?.intervalMinutes, 10);
    const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
        ? Math.min(MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES, Math.max(MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES, rawInterval))
        : DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES;
    return {
        vendor: raw.vendor,
        enabled: raw.enabled === true,
        poolMax: Number.isSafeInteger(raw.poolMax) && raw.poolMax > 0 ? raw.poolMax : 10,
        params: raw.params && typeof raw.params === 'object' ? raw.params : {},
        mirroring: {
            enabled: raw.mirroring?.enabled === true,
        },
        snapshot: {
            enabled: raw.snapshot?.enabled === true,
            intervalMinutes,
        },
    };
}

// vendor별 저장소 인스턴스를 명시적 파라미터로 직접 생성 (primary/backup 공용)
function instantiateVendorStorage(vendor, params = {}, options = {}) {
    const poolMax = Number.isSafeInteger(options.poolMax) && options.poolMax > 0 ? options.poolMax : 10;
    if (vendor === 'azure') {
        const { AzureStorage } = require('./azureStorage.cjs');
        return new AzureStorage({
            server: params.server || '',
            database: params.database || '',
            user: params.user || '',
            password: params.password || '',
            port: Number.isSafeInteger(params.port) && params.port > 0 ? params.port : 1433,
            poolMax,
            enabled: options.enabled !== false,
        });
    }
    if (vendor === 'oracle') {
        const { OracleStorage } = require('./oracleStorage.cjs');
        return new OracleStorage({
            user: params.user || '',
            password: params.password || '',
            tnsAlias: params.tnsAlias || '',
            walletPath: params.walletPath || undefined,
            walletPassword: params.walletPassword || undefined,
            poolMax,
            enabled: options.enabled !== false,
        });
    }
    const { PostgresStorage } = require('./postgresStorage.cjs');
    return new PostgresStorage({
        connectionString: params.connectionString || '',
        poolMax,
    });
}

// 백업 설정 적용: config 파일에 backup 섹션 기록 후 신규 백업 storage 인스턴스 반환.
// storage.initialize()는 호출자(server.cjs)가 연결 확인과 함께 수행.
function applyBackupConfig(savePath, { vendor, params, mirroring, snapshot }) {
    const normalized = normalizeVendorParams(vendor, params);
    const complete = isVendorConfigComplete(vendor, normalized);
    const backupConfig = complete
        ? normalizeBackupConfigSection({
            vendor,
            enabled: true,
            poolMax: normalized.poolMax,
            params: normalized,
            mirroring: mirroring || {},
            snapshot: snapshot || {},
        })
        : null;
    const stored = readStoredDbConfig(savePath);
    writeStoredDbConfig(savePath, {
        vendor: stored.vendor,
        enabled: stored.enabled,
        poolMax: stored.poolMax,
        params: stored.params,
        backup: backupConfig,
    });
    const storage = backupConfig
        ? instantiateVendorStorage(vendor, normalized, { poolMax: backupConfig.poolMax })
        : null;
    return { backup: backupConfig, storage };
}

// 백업 설정 제거 (config 파일에서 backup 섹션 삭제)
function removeBackupConfig(savePath) {
    const stored = readStoredDbConfig(savePath);
    writeStoredDbConfig(savePath, {
        vendor: stored.vendor,
        enabled: stored.enabled,
        poolMax: stored.poolMax,
        params: stored.params,
        backup: null,
    });
}

// vendor별 연결 파라미터 정규화 (빈 값 제거)
function normalizeVendorParams(vendor, rawParams = {}) {
    const params = {};
    if (vendor === 'postgres') {
        if (typeof rawParams.connectionString === 'string' && rawParams.connectionString.trim()) {
            params.connectionString = rawParams.connectionString.trim();
        }
        const poolMax = Number.parseInt(rawParams.poolMax || '10', 10);
        if (Number.isSafeInteger(poolMax) && poolMax > 0) {
            params.poolMax = poolMax;
        }
    } else if (vendor === 'oracle') {
        for (const key of ['user', 'password', 'tnsAlias', 'walletPath', 'walletPassword']) {
            if (typeof rawParams[key] === 'string' && rawParams[key].trim()) {
                params[key] = rawParams[key].trim();
            }
        }
        const poolMax = Number.parseInt(rawParams.poolMax || '10', 10);
        if (Number.isSafeInteger(poolMax) && poolMax > 0) {
            params.poolMax = poolMax;
        }
    } else if (vendor === 'azure') {
        for (const key of ['server', 'database', 'user', 'password']) {
            if (typeof rawParams[key] === 'string' && rawParams[key].trim()) {
                params[key] = rawParams[key].trim();
            }
        }
        const port = Number.parseInt(rawParams.port || '1433', 10);
        if (Number.isSafeInteger(port) && port > 0) {
            params.port = port;
        }
        const poolMax = Number.parseInt(rawParams.poolMax || '10', 10);
        if (Number.isSafeInteger(poolMax) && poolMax > 0) {
            params.poolMax = poolMax;
        }
    }
    return params;
}

// vendor가 활성화 가능한지 (필수 파라미터 모두 존재)
function isVendorConfigComplete(vendor, params = {}) {
    if (vendor === 'postgres') {
        return Boolean(params.connectionString);
    }
    if (vendor === 'oracle') {
        return Boolean(params.tnsAlias && params.user && params.password);
    }
    if (vendor === 'azure') {
        return Boolean(params.server && params.database && params.user && params.password);
    }
    return false;
}

// vendor별 연결 테스트 - 임시 인스턴스를 만들어 getPool/createInitializedPool 시도.
// throw 또는 error 반환하지 않고 { success, error } 형태로 반환.
async function testConnection(vendor, rawParams = {}) {
    const params = normalizeVendorParams(vendor, rawParams);
    if (!isVendorConfigComplete(vendor, params)) {
        return { success: false, error: 'Required connection parameters are missing' };
    }
    try {
        if (vendor === 'postgres') {
            // initialize() 내부에서 SELECT 1 + 스키마 확인까지 수행.
            // 단, 스키마가 없으면 스키마를 생성하려 시도하므로, 테스트 전용으로는
            // Pool을 직접 만들어 SELECT 1만 수행.
            const { Pool } = require('pg');
            const pool = new Pool({
                connectionString: params.connectionString,
                max: 1,
                application_name: 'risuai-test',
            });
            try {
                await pool.query('SELECT 1');
                return { success: true };
            } finally {
                await pool.end().catch(() => {});
            }
        }
        if (vendor === 'oracle') {
            const oracledb = require('oracledb');
            const conn = await oracledb.getConnection({
                user: params.user,
                password: params.password,
                connectString: params.tnsAlias,
                configDir: params.walletPath,
                walletLocation: params.walletPath,
                walletPassword: params.walletPassword,
            });
            try {
                await conn.execute('SELECT 1 FROM dual');
                return { success: true };
            } finally {
                try { await conn.close(); } catch (e) {}
            }
        }
        if (vendor === 'azure') {
            const sql = require('mssql');
            const pool = new sql.ConnectionPool({
                server: params.server,
                port: params.port || 1433,
                database: params.database,
                user: params.user,
                password: params.password,
                connectionTimeout: 60000,
                requestTimeout: 10000,
                options: { encrypt: true, trustServerCertificate: true, enableArithAbort: true },
                pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
            });
            try {
                await pool.connect();
                await pool.request().query('SELECT 1');
                return { success: true };
            } finally {
                try { await pool.close(); } catch (e) {}
            }
        }
        return { success: false, error: `Unsupported vendor: ${vendor}` };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

// 저장소 설정 적용: config 파일에 저장 후 신규 storage 인스턴스 반환.
// 기존 postgresStorage를 교체해야 하는 경우 server.cjs에서 이 함수로 재생성.
function applyDbConfig(savePath, { vendor, params, enabled }) {
    const normalized = normalizeVendorParams(vendor, params);
    const complete = isVendorConfigComplete(vendor, normalized);
    const finalEnabled = enabled !== false && complete;
    const poolMax = normalized.poolMax || 10;
    writeStoredDbConfig(savePath, {
        vendor,
        enabled: finalEnabled,
        poolMax,
        params: normalized,
    });
    // 환경 변수에도 반영 (createServerStorage가 환경 변수를 읽으므로)
    if (vendor === 'postgres') {
        if (normalized.connectionString) process.env.DATABASE_URL = normalized.connectionString;
    } else if (vendor === 'oracle') {
        if (normalized.user) process.env.ORACLE_USER = normalized.user;
        if (normalized.password) process.env.ORACLE_USER_PASSWORD = normalized.password;
        if (normalized.tnsAlias) process.env.ORACLE_TNS_ALIAS = normalized.tnsAlias;
        if (normalized.walletPath) process.env.ORACLE_WALLET_PATH = normalized.walletPath;
        if (normalized.walletPassword) process.env.ORACLE_WALLET_PASSWORD = normalized.walletPassword;
        if (normalized.poolMax) process.env.ORACLE_POOL_MAX = String(normalized.poolMax);
    } else if (vendor === 'azure') {
        if (normalized.server) process.env.AZURE_HOST = normalized.server;
        if (normalized.database) process.env.AZURE_DATABASE = normalized.database;
        if (normalized.user) process.env.AZURE_USERNAME = normalized.user;
        if (normalized.password) process.env.AZURE_PASSWORD = normalized.password;
        if (normalized.port) process.env.AZURE_PORT = String(normalized.port);
        if (normalized.poolMax) process.env.AZURE_POOL_MAX = String(normalized.poolMax);
    }
    // 신규 인스턴스 반환
    return createServerStorage(savePath, { vendor, postgresConfig: null });
}

// 환경 변수 기반 설정인지 (브라우저에서 변경 불가)
// 세 vendor 모두 환경 변수로 설정된 경우 true.
function isStorageManagedByEnvironment(vendor) {
    if (vendor === 'postgres') {
        return Boolean(process.env.DATABASE_URL);
    }
    if (vendor === 'oracle') {
        return Boolean(process.env.ORACLE_TNS_ALIAS);
    }
    if (vendor === 'azure') {
        return Boolean(process.env.AZURE_HOST || process.env.AZURE_DATABASE);
    }
    return false;
}

// 팩토리: vendor에 따른 저장소 인스턴스 생성
function createStorageDriver(options = {}) {
    const vendor = resolveVendor(options);

    if (vendor === 'azure') {
        const { AzureStorage } = require('./azureStorage.cjs');
        return new AzureStorage(options);
    }

    if (vendor === 'oracle') {
        const { OracleStorage } = require('./oracleStorage.cjs');
        return new OracleStorage(options);
    }

    // 기본: postgres
    const { PostgresStorage } = require('./postgresStorage.cjs');
    return new PostgresStorage(options);
}

// 서버 부팅 시 저장소 인스턴스 생성 (server.cjs에서 호출)
// 환경 변수 + 설정 파일 + 기존 PostgreSQL 설정을 조합하여 적절한 구현체를 반환.
// 우선순위: 명시적 options.vendor > __db_config.json > 환경 변수 감지 > 기본 postgres
function createServerStorage(savePath, options = {}) {
    // 환경 파일 로딩
    loadAzureEnvFile();
    loadOracleEnvFile();

    const storedConfig = readStoredDbConfig(savePath);
    const explicitVendor = options.vendor || process.env.DB_VENDOR || storedConfig.vendor;
    const postgresConfig = options.postgresConfig || null; // 기존 PostgreSQL 설정 (호환성)
    const storedParams = storedConfig.params || {};

    // vendor 결정
    let vendor = 'postgres';
    let enabled = false;
    let poolMax = parseInt(process.env.RISU_POSTGRES_POOL_MAX || '10', 10);
    if (!Number.isSafeInteger(poolMax) || poolMax <= 0) poolMax = 10;

    // __db_config.json에 저장된 params가 있으면 그것을 사용, 없으면 환경 변수에서 읽기
    if (explicitVendor === 'azure' || (!explicitVendor && (process.env.AZURE_HOST || process.env.AZURE_DATABASE) && !process.env.DATABASE_URL && !process.env.ORACLE_TNS_ALIAS)) {
        vendor = 'azure';
        const azureConfig = (storedConfig.vendor === 'azure' && Object.keys(storedParams).length > 0)
            ? {
                server: storedParams.server || process.env.AZURE_HOST || '',
                database: storedParams.database || process.env.AZURE_DATABASE || '',
                user: storedParams.user || process.env.AZURE_USERNAME || '',
                password: storedParams.password || process.env.AZURE_PASSWORD || '',
                port: storedParams.port || parseInt(process.env.AZURE_PORT || '1433', 10),
                poolMax: storedParams.poolMax || parseInt(process.env.AZURE_POOL_MAX || '10', 10),
            }
            : readAzureConfigFromEnv();
        enabled = Boolean(azureConfig.server && azureConfig.database && azureConfig.user && azureConfig.password);
        poolMax = azureConfig.poolMax || poolMax;
    } else if (explicitVendor === 'oracle' || (!explicitVendor && process.env.ORACLE_TNS_ALIAS && !process.env.DATABASE_URL)) {
        vendor = 'oracle';
        const oracleConfig = (storedConfig.vendor === 'oracle' && Object.keys(storedParams).length > 0)
            ? {
                user: storedParams.user || process.env.ORACLE_USER || '',
                password: storedParams.password || process.env.ORACLE_USER_PASSWORD || '',
                tnsAlias: storedParams.tnsAlias || process.env.ORACLE_TNS_ALIAS || '',
                walletPath: storedParams.walletPath || process.env.ORACLE_WALLET_PATH || '',
                walletPassword: storedParams.walletPassword || process.env.ORACLE_WALLET_PASSWORD || '',
                poolMax: storedParams.poolMax || parseInt(process.env.ORACLE_POOL_MAX || '10', 10),
            }
            : readOracleConfigFromEnv();
        enabled = Boolean(oracleConfig.tnsAlias && oracleConfig.user && oracleConfig.password);
        poolMax = oracleConfig.poolMax || poolMax;
    } else if (explicitVendor === 'postgres' || process.env.DATABASE_URL || (postgresConfig && postgresConfig.enabled) || (storedConfig.vendor === 'postgres' && storedParams.connectionString)) {
        vendor = 'postgres';
        // 우선순위: postgresConfig(기존) > storedParams > 환경 변수
        if (postgresConfig && postgresConfig.enabled) {
            enabled = true;
            poolMax = postgresConfig.poolMax || poolMax;
        } else if (storedConfig.vendor === 'postgres' && storedParams.connectionString) {
            enabled = storedConfig.enabled && Boolean(storedParams.connectionString);
            poolMax = storedParams.poolMax || poolMax;
        } else if (process.env.DATABASE_URL) {
            enabled = true;
        } else {
            enabled = false;
        }
    } else if (storedConfig.vendor === 'azure') {
        vendor = 'azure';
        const azureConfig = readAzureConfigFromEnv();
        enabled = storedConfig.enabled && Boolean(azureConfig.server && azureConfig.database && azureConfig.user && azureConfig.password);
        poolMax = storedConfig.poolMax || poolMax;
    } else if (storedConfig.vendor === 'oracle') {
        vendor = 'oracle';
        const oracleConfig = readOracleConfigFromEnv();
        enabled = storedConfig.enabled && Boolean(oracleConfig.tnsAlias && oracleConfig.user && oracleConfig.password);
        poolMax = storedConfig.poolMax || poolMax;
    } else {
        // 기본: PostgreSQL (기존 설정)
        vendor = 'postgres';
        enabled = postgresConfig ? postgresConfig.enabled : false;
        poolMax = postgresConfig ? postgresConfig.poolMax : poolMax;
    }

    if (vendor === 'azure') {
        const { AzureStorage } = require('./azureStorage.cjs');
        let azureConfig;
        if (storedConfig.vendor === 'azure' && Object.keys(storedParams).length > 0) {
            azureConfig = {
                server: storedParams.server || process.env.AZURE_HOST || '',
                database: storedParams.database || process.env.AZURE_DATABASE || '',
                user: storedParams.user || process.env.AZURE_USERNAME || '',
                password: storedParams.password || process.env.AZURE_PASSWORD || '',
                port: storedParams.port || parseInt(process.env.AZURE_PORT || '1433', 10),
                poolMax: storedParams.poolMax || poolMax,
            };
        } else {
            azureConfig = readAzureConfigFromEnv();
        }
        return {
            vendor: 'azure',
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

    if (vendor === 'oracle') {
        const { OracleStorage } = require('./oracleStorage.cjs');
        let oracleConfig;
        if (storedConfig.vendor === 'oracle' && Object.keys(storedParams).length > 0) {
            oracleConfig = {
                user: storedParams.user || process.env.ORACLE_USER || '',
                password: storedParams.password || process.env.ORACLE_USER_PASSWORD || '',
                tnsAlias: storedParams.tnsAlias || process.env.ORACLE_TNS_ALIAS || '',
                walletPath: storedParams.walletPath || process.env.ORACLE_WALLET_PATH || '',
                walletPassword: storedParams.walletPassword || process.env.ORACLE_WALLET_PASSWORD || '',
                poolMax: storedParams.poolMax || poolMax,
            };
        } else {
            oracleConfig = readOracleConfigFromEnv();
        }
        return {
            vendor: 'oracle',
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
    const { PostgresStorage } = require('./postgresStorage.cjs');
    let connectionString = '';
    if (postgresConfig && postgresConfig.enabled) {
        connectionString = postgresConfig.connectionString;
    } else if (storedConfig.vendor === 'postgres' && storedParams.connectionString) {
        connectionString = storedParams.connectionString;
    } else if (process.env.DATABASE_URL) {
        connectionString = process.env.DATABASE_URL;
    }
    return {
        vendor: 'postgres',
        storage: new PostgresStorage({
            connectionString,
            poolMax,
        }),
    };
}

module.exports = {
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
    testConnection,
    applyDbConfig,
    isStorageManagedByEnvironment,
    createStorageDriver,
    createServerStorage,
    normalizeBackupConfigSection,
    instantiateVendorStorage,
    applyBackupConfig,
    removeBackupConfig,
    MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
    MAX_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
    DEFAULT_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
};
