// Storage Driver 추상화 레이어
// PostgreSQL과 Oracle 저장소 구현체를 동일한 인터페이스로 제공.
// server.cjs는 이 팩토리를 통해 vendor에 따른 구현체를 사용.

'use strict';

const fs = require('fs');
const path = require('path');

// 공통 에러 타입 (구현체 무관)
class StorageRevisionConflictError extends Error {
    constructor(revision, message = 'Storage revision conflict') {
        super(message);
        this.name = 'StorageRevisionConflictError';
        this.revision = revision;
    }
}

class StoragePayloadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StoragePayloadError';
    }
}

// 지원하는 vendor 목록
const SUPPORTED_VENDORS = ['postgres', 'oracle'];

// vendor 결정 우선순위:
// 1. 명시적 options.vendor
// 2. 환경 변수 DB_VENDOR
// 3. 환경 변수 DATABASE_URL 존재 시 postgres
// 4. 환경 변수 ORACLE_TNS_ALIAS 존재 시 oracle
// 5. 기본값 postgres
function resolveVendor(options = {}) {
    if (options.vendor && SUPPORTED_VENDORS.includes(options.vendor)) {
        return options.vendor;
    }
    if (process.env.DB_VENDOR && SUPPORTED_VENDORS.includes(process.env.DB_VENDOR)) {
        return process.env.DB_VENDOR;
    }
    if (process.env.DATABASE_URL) {
        return 'postgres';
    }
    if (process.env.ORACLE_TNS_ALIAS) {
        return 'oracle';
    }
    return 'postgres';
}

// 환경에서 Oracle 설정 로딩 (.env.oracle 자동 로딩 포함)
function loadOracleEnvFile() {
    const envCandidates = [
        path.join(__dirname, '.env.oracle'),
        path.join(process.cwd(), '.env.oracle'),
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

// 저장소 설정 파일 읽기 (vendor + 공통 설정)
function readStoredDbConfig(savePath) {
    const configPath = getDbConfigPath(savePath);
    if (!fs.existsSync(configPath)) {
        return { vendor: null, enabled: false, poolMax: 10 };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return {
            vendor: parsed.vendor || null,
            enabled: parsed.enabled === true,
            poolMax: Number.isSafeInteger(parsed.poolMax) && parsed.poolMax > 0 ? parsed.poolMax : 10,
        };
    } catch (error) {
        throw new Error(`Could not read DB server configuration: ${error.message}`);
    }
}

// 저장소 설정 파일 쓰기
function writeStoredDbConfig(savePath, config) {
    const configPath = getDbConfigPath(savePath);
    fs.writeFileSync(configPath, JSON.stringify({
        vendor: config.vendor || null,
        enabled: config.enabled === true,
        poolMax: config.poolMax || 10,
    }), 'utf8');
}

// 팩토리: vendor에 따른 저장소 인스턴스 생성
function createStorageDriver(options = {}) {
    const vendor = resolveVendor(options);

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
function createServerStorage(savePath, options = {}) {
    // Oracle 환경 파일 로딩
    loadOracleEnvFile();

    const storedConfig = readStoredDbConfig(savePath);
    const explicitVendor = options.vendor || process.env.DB_VENDOR || storedConfig.vendor;
    const postgresConfig = options.postgresConfig || null; // 기존 PostgreSQL 설정 (호환성)

    // 환경 변수 기반 vendor 감지
    let vendor = 'postgres';
    let enabled = false;
    let poolMax = parseInt(process.env.RISU_POSTGRES_POOL_MAX || '10', 10);
    if (!Number.isSafeInteger(poolMax) || poolMax <= 0) poolMax = 10;

    if (explicitVendor === 'oracle' || (!explicitVendor && process.env.ORACLE_TNS_ALIAS && !process.env.DATABASE_URL)) {
        vendor = 'oracle';
        const oracleConfig = readOracleConfigFromEnv();
        enabled = Boolean(oracleConfig.tnsAlias && oracleConfig.user && oracleConfig.password);
        poolMax = oracleConfig.poolMax || poolMax;
    } else if (explicitVendor === 'postgres' || process.env.DATABASE_URL || (postgresConfig && postgresConfig.enabled)) {
        vendor = 'postgres';
        enabled = postgresConfig ? postgresConfig.enabled : (process.env.DATABASE_URL ? true : false);
        poolMax = postgresConfig ? postgresConfig.poolMax : poolMax;
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

    if (vendor === 'oracle') {
        const { OracleStorage } = require('./oracleStorage.cjs');
        const oracleConfig = readOracleConfigFromEnv();
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
    const connectionString = postgresConfig && postgresConfig.enabled ? postgresConfig.connectionString : '';
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
    loadOracleEnvFile,
    readOracleConfigFromEnv,
    readStoredDbConfig,
    writeStoredDbConfig,
    getDbConfigPath,
    createStorageDriver,
    createServerStorage,
};