const express = require('express');
const app = express();
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// EPIPE / ECONNRESET during large S3 migrations (peer closes the socket
// mid-write) surface as unhandled 'error' events on the underlying socket and
// can crash the whole server. Log and swallow them so the migration worker
// can record the failure and the process stays alive.
process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED')) {
        console.warn('[Server] Swallowed socket error:', err.code, err.message);
        return;
    }
    console.error('[Server] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED')) {
        console.warn('[Server] Swallowed socket rejection:', err.code, err && err.message);
        return;
    }
    console.error('[Server] Unhandled rejection:', err);
});
const http = require('http');
const path = require('path');
const net = require('net');
const htmlparser = require('node-html-parser');
const fsSync = require('fs');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { promisify } = require('util');
const zlib = require('zlib');
const { gzip } = require('zlib');
const { createJsonStream } = require('./streamJson.cjs');
const {
    PostgresPayloadError,
    PostgresRevisionConflictError,
    PostgresStorage,
} = require('./postgresStorage.cjs');
const {
    StoragePayloadError,
    StorageRevisionConflictError,
    createServerStorage,
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
    SUPPORTED_VENDORS,
    normalizeBackupConfigSection,
    instantiateVendorStorage,
    applyBackupConfig,
    removeBackupConfig,
    MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES,
} = require('./storageDriver.cjs');
const {
    AssetStorageManager,
    S3AssetStorage,
    AzureSqlAssetStorage,
    keyToHex,
} = require('./assetStorage.cjs');
const defaultJsonParser = express.json({ limit: '100mb' });
const postgresJsonBodyLimit = process.env.RISU_POSTGRES_JSON_BODY_LIMIT || '1gb';
const postgresJsonParser = express.json({ limit: postgresJsonBodyLimit });
const rawBodyParser = express.raw({ type: 'application/octet-stream', limit: '100mb' });

function isStreamingAssetWriteRequest(req) {
    return req.method === 'POST' && req.path === '/api/write' && req.is('application/octet-stream');
}

const distDir = path.join(process.cwd(), 'dist');
const HASHED_ASSET_REGEX = /-[a-zA-Z0-9_-]{8,}\.(js|css|png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|eot|wasm|ico|json|map)$/;
const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.wasm', '.map']);

const STATIC_MIME_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    if (req.path.startsWith('/api/') || req.path.startsWith('/proxy') || req.path.startsWith('/v1/')) {
        return next();
    }
    if (req.path === '/' || req.path === '') {
        return next();
    }

    try {
        let safePath;
        try {
            safePath = decodeURIComponent(req.path);
        } catch {
            return next();
        }
        const resolvedPath = path.normalize(path.join(distDir, safePath));
        if (!resolvedPath.startsWith(distDir)) {
            return next();
        }

        let stats;
        try {
            stats = await fs.stat(resolvedPath);
        } catch {
            return next();
        }

        if (!stats.isFile()) {
            return next();
        }

        const fileName = path.basename(resolvedPath);
        const ext = path.extname(fileName).toLowerCase();

        if (resolvedPath.includes('/assets/') || resolvedPath.includes('\\assets\\') || HASHED_ASSET_REGEX.test(fileName)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (fileName.endsWith('.html') || fileName === 'sw.js' || fileName === 'manifest.json') {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }

        const etag = `"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
        res.setHeader('ETag', etag);
        const ifNoneMatch = String(req.headers['if-none-match'] || '');
        if (ifNoneMatch && ifNoneMatch.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }

        if (STATIC_MIME_TYPES[ext]) {
            res.setHeader('Content-Type', STATIC_MIME_TYPES[ext]);
        }

        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        const canGzip = COMPRESSIBLE_EXTENSIONS.has(ext) && stats.size >= 1024 && /(^|,|\s)gzip(\s|,|;|$)/i.test(acceptEncoding);

        if (req.method === 'HEAD') {
            res.status(200).end();
            return;
        }

        if (canGzip) {
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            const gzipStream = zlib.createGzip({ level: 6 });
            const fileStream = fsSync.createReadStream(resolvedPath);
            fileStream.on('error', (err) => next(err));
            gzipStream.on('error', (err) => next(err));
            fileStream.pipe(gzipStream).pipe(res);
        } else {
            res.setHeader('Content-Length', stats.size);
            const fileStream = fsSync.createReadStream(resolvedPath);
            fileStream.on('error', (err) => next(err));
            fileStream.pipe(res);
        }
    } catch (error) {
        next(error);
    }
});
app.use((req, res, next) => {
    if (isLargePostgresJsonRequest(req)) {
        next();
        return;
    }
    defaultJsonParser(req, res, next);
});
app.use((req, res, next) => {
    if (isStreamingAssetWriteRequest(req)) return next();
    rawBodyParser(req, res, next);
});
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const {once} = require('events')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
let openidClient = null;
function getOpenidClient() {
    openidClient ||= require('openid-client');
    return openidClient;
}
const gzipAsync = promisify(gzip);

let password = ''
let knownPublicKeysHashes = []

const savePath = process.env.RISU_SAVE_PATH
    ? path.resolve(process.env.RISU_SAVE_PATH)
    : path.join(process.cwd(), 'save')
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const postgresConfigPath = path.join(savePath, '__postgres_config.json');
const postgresManagedByEnvironment = Boolean(process.env.DATABASE_URL);
// 저장소가 환경 변수로 관리되는지 (세 vendor 공통)
// dbVendor는 아래 createServerStorage 후에 확정되므로, 초기값은 postgresManagedByEnvironment로.
let storageManagedByEnvironment = postgresManagedByEnvironment;
const postgresConfigExists = existsSync(postgresConfigPath);
const postgresBootstrapUrl = process.env.RISU_POSTGRES_BOOTSTRAP_URL || '';

function readStoredPostgresConfig() {
    if (!existsSync(postgresConfigPath)) {
        return { enabled: false, connectionString: '', poolMax: 10 };
    }
    try {
        const parsed = JSON.parse(readFileSync(postgresConfigPath, 'utf8'));
        return {
            enabled: parsed.enabled === true,
            connectionString: typeof parsed.connectionString === 'string' ? parsed.connectionString : '',
            poolMax: Number.isSafeInteger(parsed.poolMax) && parsed.poolMax > 0 ? parsed.poolMax : 10,
        };
    } catch (error) {
        throw new Error(`Could not read PostgreSQL server configuration: ${error.message}`);
    }
}

const storedPostgresConfig = readStoredPostgresConfig();
const environmentPoolMax = Number.parseInt(process.env.RISU_POSTGRES_POOL_MAX || '10', 10);
const initialPoolMax = Number.isSafeInteger(environmentPoolMax) && environmentPoolMax > 0
    ? environmentPoolMax
    : 10;
let postgresServerConfig = postgresManagedByEnvironment
    ? {
        enabled: process.env.RISU_POSTGRES_ENABLED !== 'false',
        connectionString: process.env.DATABASE_URL,
        poolMax: initialPoolMax,
    }
    : (!postgresConfigExists && postgresBootstrapUrl
        ? {
            enabled: true,
            connectionString: postgresBootstrapUrl,
            poolMax: initialPoolMax,
        }
        : storedPostgresConfig);

// 저장소 드라이버: vendor(postgres/oracle)에 따른 구현체 생성.
// 기존 postgresStorage 호환성: postgresStorage 변수는 팩토리 결과의 .storage를 가리킴.
// applyDbConfig API로 재할당되므로 let 선언.
let { storage: postgresStorage, vendor: dbVendor } = createServerStorage(savePath, {
    // 기존 PostgreSQL 설정 호환성
    postgresConfig: postgresServerConfig,
});
// vendor 확정 후 환경 변수 관리 여부 갱신
storageManagedByEnvironment = isStorageManagedByEnvironment(dbVendor);

// ─────────────────────────────────────────────────────────────────────────────
// 백업 데이터베이스 (메인 SQL DB → 백업 SQL DB 미러링/스냅샷)
// - 실시간 미러링: 메인 sync 성공 시 동일한 payload를 백업 DB에 적요 (직렬 큐)
// - 주기적 스냅샷: 간격마다 메인 전체를 백업 DB에 replaceAll 적요
// - 수동 전체 백업: /api/db-backup/resync
// 백업은 패시브 레플라이카이며, 단일 writer(이 서버)만 쓰기 때문에
// baseRevision은 실행 시점의 백업 revision으로 교체한다.
// ─────────────────────────────────────────────────────────────────────────────

let backupStorage = null;
let backupConfig = {
    vendor: null,
    enabled: false,
    poolMax: 10,
    params: {},
    mirroring: { enabled: false },
    snapshot: { enabled: false, intervalMinutes: 60 },
};
const backupRuntime = {
    initialized: false,
    lastMirrorAt: null,
    lastMirrorError: null,
    lastSnapshotAt: null,
    lastSnapshotError: null,
    lastFullSyncAt: null,
    lastFullSyncError: null,
    inFlight: false,
};
let backupSnapshotTimer = null;
let backupMirrorChain = Promise.resolve();

function delayMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 전체 payload 구성은 backupFullPayload.cjs 모듈에서 (테스트 가능성)
const { buildFullBackupPayload } = require('./backupFullPayload.cjs');

// 직렬 큐: 백업 DB로의 모든 쓰기는 순서를 보장하며 하나씩 수행.
// 실패는 재시도(백오프) 후 상태 기록만 남기고 큐는 계속 진행 (메인 저장에는 영향 없음).
// 반환되는 promise는 task별 결과를 전달: 성공 시 resolve, 최종 실패 시 reject.
function enqueueBackupWrite(task, label = 'write') {
    const execute = async () => {
        if (!backupStorage?.enabled) return null;
        backupRuntime.inFlight = true;
        const backoffs = [1000, 5000, 15000];
        let lastError = null;
        for (let attempt = 0; attempt <= backoffs.length; attempt++) {
            try {
                const result = await task();
                return result;
            } catch (error) {
                lastError = error;
                console.error(`[db-backup] ${label} failed (attempt ${attempt + 1}):`, error?.message || error);
                if (attempt < backoffs.length) {
                    await delayMs(backoffs[attempt]);
                }
            }
        }
        throw lastError;
    };
    return new Promise((resolve, reject) => {
        backupMirrorChain = backupMirrorChain.then(async () => {
            try {
                const result = await execute();
                resolve(result);
            } catch (error) {
                if (label === 'mirror') {
                    backupRuntime.lastMirrorError = error?.message || String(error);
                } else if (label === 'snapshot') {
                    backupRuntime.lastSnapshotError = error?.message || String(error);
                } else {
                    backupRuntime.lastFullSyncError = error?.message || String(error);
                }
                reject(error);
            } finally {
                backupRuntime.inFlight = false;
            }
            // 재투하 안 함: 큐의 다음 작업은 계속 진행
        });
    });
}

async function awaitBackgroundMirror(task) {
    try {
        await enqueueBackupWrite(task, 'mirror');
    } catch {
        // The primary write already succeeded. Waiting is for bounded memory and
        // ordering; backup failure remains observable through backupRuntime.
    }
}

// 메인 sync payload를 백업에 미러 (baseRevision은 백업 현재 revision으로 교체)
async function mirrorSyncPayloadToBackup(payload) {
    const state = await backupStorage.getState();
    await backupStorage.sync({
        ...payload,
        baseRevision: state.revision ?? 0,
    });
}

async function mirrorFullBackupToBackup(onProgress) {
    onProgress?.({ stage: 'reading', message: 'Reading data from main database...', percentage: 10 });
    const loaded = await postgresStorage.loadDatabase({ shallow: false });
    if (!loaded?.database) {
        return { skipped: 'primary_not_initialized' };
    }
    const payload = buildFullBackupPayload(loaded.database);
    const settingsCount = payload.root?.upserts?.length ?? payload.rootUpserts?.length ?? 0;
    const charactersCount = payload.characters?.length || 0;
    const chatsCount = payload.chats?.length || 0;
    const messagesCount = payload.messages?.length || 0;
    const totalItems = settingsCount + charactersCount + chatsCount + messagesCount;

    onProgress?.({
        stage: 'preparing',
        message: 'Preparing backup data...',
        percentage: 30,
        settingsCount,
        charactersCount,
        chatsCount,
        messagesCount,
        total: totalItems,
    });

    const state = await backupStorage.getState();

    const handleStorageProgress = (subProgress) => {
        if (!subProgress) return;
        let mappedPercentage = 40;
        const subStage = subProgress.stage;
        let subMessage = subProgress.message;
        if (subStage === 'settings') {
            mappedPercentage = 45;
            subMessage = subMessage || `Syncing settings (${settingsCount})`;
        } else if (subStage === 'characters') {
            mappedPercentage = 60;
            subMessage = subMessage || `Syncing characters (${charactersCount})`;
        } else if (subStage === 'chats') {
            mappedPercentage = 75;
            subMessage = subMessage || `Syncing chats (${chatsCount})`;
        } else if (subStage === 'messages') {
            mappedPercentage = 90;
            subMessage = subMessage || `Syncing messages (${messagesCount})`;
        } else if (subStage === 'finalizing') {
            mappedPercentage = 98;
            subMessage = subMessage || 'Finalizing backup database...';
        }
        onProgress?.({
            stage: subStage || 'syncing',
            message: subMessage,
            percentage: mappedPercentage,
            settingsCount,
            charactersCount,
            chatsCount,
            messagesCount,
            total: totalItems,
        });
    };

    const syncResult = await backupStorage.sync(
        { ...payload, baseRevision: state.revision ?? 0 },
        { onProgress: handleStorageProgress }
    );

    const finalResult = {
        success: true,
        ...(syncResult || {}),
        settingsCount,
        charactersCount,
        chatsCount,
        messagesCount,
    };

    onProgress?.({
        stage: 'done',
        message: 'Backup complete',
        percentage: 100,
        ...finalResult,
    });

    return finalResult;
}

async function runBackupSnapshot() {
    return await mirrorFullBackupToBackup();
}

// 백업 DB 스키마 초기화(없으면 생성) 후 인스턴스 활성화
async function activateBackupStorage(storage) {
    await storage.initialize();
    backupStorage = storage;
    backupRuntime.initialized = true;
    backupRuntime.lastFullSyncError = null;
}

// 부팅 시 설정 파일의 backup 섹션으로 백업 storage 생성 (실패해도 서버 기동은 유지)
function loadBackupStorageFromConfig() {
    try {
        const stored = readStoredDbConfig(savePath);
        if (!stored.backup || !stored.backup.vendor || !stored.backup.enabled) {
            return;
        }
        if (!isVendorConfigComplete(stored.backup.vendor, stored.backup.params)) {
            console.warn('[db-backup] Stored backup configuration is incomplete; skipping backup storage.');
            return;
        }
        backupConfig = stored.backup;
        const storage = instantiateVendorStorage(stored.backup.vendor, stored.backup.params, {
            poolMax: stored.backup.poolMax,
        });
        activateBackupStorage(storage).then(() => {
            console.log(`[db-backup] Backup storage ready (vendor: ${backupConfig.vendor}).`);
            syncBackupSnapshotTimer();
        }).catch((error) => {
            console.error('[db-backup] Failed to initialize backup storage at startup:', error?.message || error);
            backupStorage = null;
            backupRuntime.initialized = false;
            backupRuntime.lastFullSyncError = `startup: ${error?.message || error}`;
        });
    } catch (error) {
        console.error('[db-backup] Failed to read backup configuration:', error?.message || error);
    }
}

// 스냅샷 타이머를 현재 설정에 맞게 (재)설정
function syncBackupSnapshotTimer() {
    if (backupSnapshotTimer) {
        clearInterval(backupSnapshotTimer);
        backupSnapshotTimer = null;
    }
    if (!backupStorage?.enabled || !backupConfig.snapshot?.enabled) {
        return;
    }
    const intervalMinutes = Math.max(MIN_BACKUP_SNAPSHOT_INTERVAL_MINUTES, backupConfig.snapshot.intervalMinutes || 60);
    backupSnapshotTimer = setInterval(() => {
        enqueueBackupWrite(() => runBackupSnapshot().then((result) => {
            backupRuntime.lastSnapshotAt = new Date().toISOString();
            backupRuntime.lastSnapshotError = null;
            return result;
        }), 'snapshot');
    }, intervalMinutes * 60 * 1000);
    backupSnapshotTimer.unref?.();
}

// 백업 설정 해제: 타이머 정지, 풀 close, 설정 섹션 제거
async function deactivateBackupStorage() {
    if (backupSnapshotTimer) {
        clearInterval(backupSnapshotTimer);
        backupSnapshotTimer = null;
    }
    const previous = backupStorage;
    backupStorage = null;
    backupConfig = { vendor: null, enabled: false, poolMax: 10, params: {}, mirroring: { enabled: false }, snapshot: { enabled: false, intervalMinutes: 60 } };
    backupRuntime.initialized = false;
    if (previous && typeof previous.close === 'function') {
        try { await previous.close(); } catch (e) {}
    }
}

loadBackupStorageFromConfig();

const assetStorageManager = new AssetStorageManager(savePath);

const passwordPath = path.join(savePath, '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

const knownPublicKeysPath = path.join(savePath, '__known_public_key_hashes.json')
if(existsSync(knownPublicKeysPath)){
    const knownPublicKeysRaw = readFileSync(knownPublicKeysPath, 'utf-8');
    knownPublicKeysHashes = JSON.parse(knownPublicKeysRaw);
}

const authCodePath = path.join(savePath, '__authcode')
const hexRegex = /^[0-9a-fA-F]+$/;
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 10000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = Math.max(
    1,
    Number.parseInt(process.env.RISUAI_PROXY_MAX_JOBS || '16', 10) || 16
);
const PROXY_STREAM_MAX_PENDING_EVENTS = Math.max(
    1,
    Number.parseInt(process.env.RISUAI_PROXY_PENDING_EVENTS || '128', 10) || 128
);
const PROXY_STREAM_MAX_PENDING_BYTES = Math.max(
    64 * 1024,
    Number.parseInt(process.env.RISUAI_PROXY_PENDING_BYTES || String(512 * 1024), 10) || 512 * 1024
);
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const proxyStreamJobs = new Map();

function isLargePostgresJsonRequest(req) {
    return (req.method === 'POST' && req.path === '/api/database-v2/commit') ||
        (req.method === 'PUT' && req.path.startsWith('/api/database-v2/cold-storage/')) ||
        (req.method === 'DELETE' && req.path === '/api/database-v2/cold-storage') ||
        (req.method === 'POST' && req.path === '/api/database-v2/cold-storage/prune');
}

let largeJsonRequestTail = Promise.resolve();
function serializeLargeJsonRequests(req, res, next) {
    let release;
    const previous = largeJsonRequestTail;
    largeJsonRequestTail = new Promise((resolve) => { release = resolve; });
    previous.then(() => {
        let released = false;
        const releaseOnce = () => {
            if (released) return;
            released = true;
            release();
        };
        res.once('finish', releaseOnce);
        res.once('close', releaseOnce);
        next();
    }, next);
}

const authenticatedRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please retry shortly.' }
});
const authRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please retry shortly.' }
});
const loginRouteLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait and try again later.' }
});
function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

async function sendCompressedJson(req, res, payload) {
    const acceptEncoding = normalizeAuthHeader(req.headers['accept-encoding']);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    if (/(^|,|\s)gzip(\s|,|;|$)/i.test(acceptEncoding)) {
        res.setHeader('Content-Encoding', 'gzip');
        await pipeline(createJsonStream(payload), zlib.createGzip({ level: 6 }), res);
        return;
    }
    await pipeline(createJsonStream(payload), res);
}

function validatePostgresConnectionString(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
        throw new PostgresPayloadError('PostgreSQL connection string must contain 1 to 4096 characters');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new PostgresPayloadError('PostgreSQL connection string is not a valid URL');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new PostgresPayloadError('PostgreSQL connection string must use postgres:// or postgresql://');
    }
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
        throw new PostgresPayloadError('PostgreSQL connection string must include a host and database name');
    }
    return value;
}

function maskPostgresConnectionString(value) {
    if (!value) {
        return '';
    }
    try {
        const parsed = new URL(value);
        if (parsed.password) {
            parsed.password = '********';
        }
        for (const key of new Set(parsed.searchParams.keys())) {
            if (/^(?:password|passfile|sslpassword|sslkey|token|secret|api[_-]?key)$/i.test(key)) {
                parsed.searchParams.set(key, '********');
            }
        }
        return parsed.toString();
    } catch {
        return 'Configured connection string';
    }
}

function normalizePostgresPoolMax(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new PostgresPayloadError('PostgreSQL pool size must be an integer from 1 to 100');
    }
    return parsed;
}

function isSecurePostgresConfigRequest(req) {
    if (req.secure) {
        return true;
    }
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (typeof forwardedProto === 'string') {
        const proto = forwardedProto.split(',')[0].trim().toLowerCase();
        if (proto === 'https') return true;
    }
    const forwardedSsl = req.headers['x-forwarded-ssl'];
    if (typeof forwardedSsl === 'string' && forwardedSsl.toLowerCase() === 'on') {
        return true;
    }
    const frontEndHttps = req.headers['front-end-https'];
    if (typeof frontEndHttps === 'string' && frontEndHttps.toLowerCase() === 'on') {
        return true;
    }
    const urlScheme = req.headers['x-url-scheme'];
    if (typeof urlScheme === 'string' && urlScheme.toLowerCase() === 'https') {
        return true;
    }
    const cfVisitor = req.headers['cf-visitor'];
    if (typeof cfVisitor === 'string' && cfVisitor.includes('"scheme":"https"')) {
        return true;
    }
    const forwarded = req.headers['forwarded'];
    if (typeof forwarded === 'string' && /proto=https/i.test(forwarded)) {
        return true;
    }
    const remoteAddress = req.socket?.remoteAddress || '';
    return remoteAddress === '127.0.0.1' || remoteAddress === '::1' ||
        remoteAddress === '::ffff:127.0.0.1' || remoteAddress === 'localhost';
}

async function persistPostgresServerConfig(config) {
    const temporaryPath = `${postgresConfigPath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, postgresConfigPath);
}

async function getPostgresConfigResponse() {
    let revision = null;
    let initialized = false;
    if (postgresStorage.enabled) {
        const state = await postgresStorage.getState();
        revision = state.revision;
        initialized = state.initialized;
    }
    return {
        enabled: postgresStorage.enabled,
        configured: Boolean(postgresServerConfig.connectionString),
        managedByEnvironment: storageManagedByEnvironment,
        vendor: dbVendor,
        connectionDisplay: maskPostgresConnectionString(postgresServerConfig.connectionString),
        poolMax: postgresServerConfig.poolMax,
        revision,
        initialized,
    };
}

async function hashJSON(json){
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

function isAuthorizedRequest(req) {
    const authHeader = normalizeAuthHeader(req.headers['risu-auth']);
    return !!authHeader && authHeader.trim() === password.trim();
}

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function isAuthorizedJwtHeader(authHeader) {
    try {
        const normalized = normalizeAuthHeader(authHeader);
        if (!normalized) {
            return false;
        }

        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = normalized.split('.');

        if (!jsonHeaderB64 || !jsonPayloadB64 || !signatureB64) {
            return false;
        }

        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));
        const signature = Buffer.from(signatureB64, 'base64url');

        const now = Math.floor(Date.now() / 1000);
        if (jsonPayload.exp < now) {
            return false;
        }

        const pubKeyHash = await hashJSON(jsonPayload.pub);
        if (!knownPublicKeysHashes.includes(pubKeyHash)) {
            return false;
        }

        if (jsonHeader.alg !== 'ES256') {
            return false;
        }

        return await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: { name: 'SHA-256' },
            },
            await crypto.subtle.importKey(
                'jwk',
                jsonPayload.pub,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256',
                },
                false,
                ['verify']
            ),
            signature,
            Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`)
        );
    } catch {
        return false;
    }
}

async function isAuthorizedProxyRequest(req) {
    if (isAuthorizedRequest(req)) {
        return true;
    }
    return await isAuthorizedJwtHeader(req.headers['risu-auth']);
}

async function checkProxyAuth(req, res) {
    if (isAuthorizedRequest(req)) {
        return true;
    }
    return await checkAuth(req, res);
}

function getRequestTimeoutMs(timeoutHeader) {
    const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs) {
    if (!timeoutMs) {
        return {
            signal: undefined,
            cleanup: () => {}
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer)
    };
}

function normalizeProxyStreamTimeoutMs(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

function isPrivateIPv4Host(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [a, b] = octets;
    if (a === 10) {
        return true;
    }
    if (a === 127) {
        return true;
    }
    if (a === 0) {
        return true;
    }
    if (a === 192 && b === 168) {
        return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    if (a === 169 && b === 254) {
        return true;
    }
    return false;
}

function isLocalNetworkHost(hostname) {
    if (typeof hostname !== 'string' || hostname.trim() === '') {
        return false;
    }

    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '').split('%')[0];
    if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost.endsWith('.local')) {
        return true;
    }

    if (net.isIP(normalizedHost) === 4) {
        return isPrivateIPv4Host(normalizedHost);
    }

    if (net.isIP(normalizedHost) === 6) {
        if (normalizedHost.startsWith('::ffff:')) {
            const mapped = normalizedHost.substring(7);
            return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
        }
        if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) {
            return true;
        }
        if (/^fe[89ab]/.test(normalizedHost)) {
            return true;
        }
        return normalizedHost === '::1';
    }

    return false;
}

function sanitizeTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!isLocalNetworkHost(parsed.hostname)) {
            return null;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    } // lgtm[js/request-forgery]
}

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') {
            continue;
        }
        if (typeof value === 'string') {
            normalized[key] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    return normalized;
}

function normalizeProxyResponseHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) {
            continue;
        }
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function requestLocalTargetStream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers['content-length']) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let cleanupAbort = () => {};
        const finishReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupAbort();
            reject(error);
        };

        const req = client.request(parsedUrl, {
            method: arg.method,
            headers
        }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            cleanupAbort();
            resolve({
                status: res.statusCode || 502,
                headers: normalizeProxyResponseHeaders(res.headers),
                body: res
            });
        });

        req.on('error', (error) => {
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            const onAbort = () => {
                const abortError = new Error('Proxy stream job aborted');
                abortError.name = 'AbortError';
                req.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => arg.signal.removeEventListener('abort', onAbort);
        }

        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

function createProxyStreamJob(arg) {
    const jobId = crypto.randomUUID();
    const timeoutMs = normalizeProxyStreamTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
    const controller = new AbortController();
    const createdAt = Date.now();
    const job = {
        id: jobId,
        createdAt,
        updatedAt: createdAt,
        done: false,
        cleanupAt: 0,
        clients: new Set(),
        pendingEvents: [],
        pendingBytes: 0,
        abortController: controller,
        deadlineAt: createdAt + timeoutMs,
        heartbeatSec,
        timeoutMs // lgtm[js/request-forgery]
    };
    proxyStreamJobs.set(jobId, job);
    return job;
}

function pushJobEvent(job, event) {
    job.updatedAt = Date.now();
    const text = JSON.stringify(event);
    if (job.clients.size === 0) {
        job.pendingEvents.push(text);
        job.pendingBytes += Buffer.byteLength(text);
        while (
            job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS
            || job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
        ) {
            const removed = job.pendingEvents.shift();
            if (!removed) {
                break;
            }
            job.pendingBytes -= Buffer.byteLength(removed);
        }
        return;
    }
    for (const client of job.clients) {
        if (client.readyState === client.OPEN) {
            client.send(text);
        }
    }
}

function markJobDone(job) {
    if (job.done) {
        return;
    }
    job.done = true;
    job.cleanupAt = Date.now() + PROXY_STREAM_DONE_GRACE_MS;
}

function cleanupJob(jobId) {
    const job = proxyStreamJobs.get(jobId);
    if (!job) {
        return;
    }
    for (const client of job.clients) {
        try {
            client.close();
        } catch {
            // ignore
        }
    }
    proxyStreamJobs.delete(jobId);
}

async function runProxyStreamJob(job, arg) {
    const targetUrl = sanitizeTargetUrl(arg.targetUrl);
    if (!targetUrl) {
        pushJobEvent(job, {
            type: 'error',
            status: 400,
            message: 'Blocked non-local target URL'
        });
        markJobDone(job);
        return;
    }

    const headers = normalizeForwardHeaders(arg.headers);
    if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = arg.clientIp;
    }
    const bodyBuffer = arg.bodyBase64 ? Buffer.from(arg.bodyBase64, 'base64') : undefined;

    try {
        const upstreamResponse = await requestLocalTargetStream(targetUrl, {
            method: arg.method,
            headers,
            bodyBuffer,
            timeoutMs: job.timeoutMs,
            signal: job.abortController.signal
        });

        const filteredHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key === 'content-security-policy' || key === 'content-security-policy-report-only' || key === 'clear-site-data') {
                continue;
            }
            filteredHeaders[key] = value;
        }

        pushJobEvent(job, {
            type: 'upstream_headers',
            status: upstreamResponse.status,
            headers: filteredHeaders
        });

        if (upstreamResponse.body) {
            for await (const value of upstreamResponse.body) {
                if (job.abortController.signal.aborted) {
                    break;
                }
                if (value && value.length > 0) {
                    pushJobEvent(job, {
                        type: 'chunk',
                        dataBase64: Buffer.from(value).toString('base64')
                    });
                }
            }
        }
        pushJobEvent(job, { type: 'done' });
        markJobDone(job);
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'Proxy stream job aborted' : `${error}`;
        pushJobEvent(job, {
            type: 'error',
            status: 504,
            message
        });
        markJobDone(job);
    }
}

async function forwardUpstreamResponse(originalResponse, res) {
    const head = new Headers(originalResponse.headers);
    head.delete('content-security-policy');
    head.delete('content-security-policy-report-only');
    head.delete('clear-site-data');
    head.delete('Cache-Control');
    head.delete('Content-Encoding');

    const contentType = (head.get('content-type') || '').toLowerCase();
    const isSSE = contentType.includes('text/event-stream');
    if (isSSE) {
        head.set('Cache-Control', 'no-cache, no-transform');
        head.set('Connection', 'keep-alive');
        head.set('X-Accel-Buffering', 'no');
        head.delete('content-length');
    }

    const headObj = {};
    for (const [k, v] of head) {
        headObj[k] = v;
    }

    res.header(headObj);
    res.status(originalResponse.status);

    if (!originalResponse.body) {
        res.end();
        return;
    }

    if (!isSSE) {
        await pipeline(originalResponse.body, res);
        return;
    }

    const reader = originalResponse.body.getReader();

    const onClose = () => {
        reader.cancel().catch(() => {});
    };
    res.on('close', onClose);

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    try {
        while (!res.writableEnded) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value && value.length > 0) {
                res.write(Buffer.from(value));
            }
        }
    } catch (error) {
        if (!res.writableEnded) {
            throw error;
        }
    } finally {
        res.off('close', onClose);
        if (!res.writableEnded) {
            res.end();
        }
    }
}

app.get('/', async (req, res, next) => {

    const clientIP = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        const legalConfigured = process.env.VITE_RISU_LEGAL_CONFIGURED?.trim().toUpperCase() === 'TRUE';
        head.innerHTML = `<script>globalThis.__NODE__ = true;globalThis.__RISU_LEGAL_CONFIGURED__ = ${legalConfigured}</script>` + head.innerHTML
        
        const html = root.toString();
        const bodyBuffer = Buffer.from(html, 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.setHeader('Vary', 'Accept-Encoding');

        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        if (bodyBuffer.length >= 1024 && /(^|,|\s)gzip(\s|,|;|$)/i.test(acceptEncoding)) {
            const compressed = await gzipAsync(bodyBuffer, { level: 6 });
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Content-Length', compressed.length);
            res.send(compressed);
            return;
        }

        res.setHeader('Content-Length', bodyBuffer.length);
        res.send(bodyBuffer);
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false){
    try {
        const authHeader = normalizeAuthHeader(req.headers['risu-auth'] || req.query.auth || req.query['risu-auth']);

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp, pub
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        //signature
        const signature = Buffer.from(signatureB64, 'base64url');

        
        //check expiration
        const now = Math.floor(Date.now() / 1000);
        if(jsonPayload.exp < now){
            console.log('Token expired')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Token Expired'
            });
            return false
        }

        //check if public key is known
        const pubKeyHash = await hashJSON(jsonPayload.pub)
        if(!knownPublicKeysHashes.includes(pubKeyHash)){
            console.log('Unknown public key')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unknown Public Key'
            });
            return false
        }

        //check signature
        if(jsonHeader.alg !== "ES256"){
            //only support ECDSA for now
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const isValid = await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: {name: 'SHA-256'},
            },
            await crypto.subtle.importKey(
                'jwk',
                jsonPayload.pub,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256',
                },
                false,
                ['verify']
            ),
            signature,
            Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`)
        );

        if(!isValid){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        
        return true   
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

async function requireNodeAuth(req, res, next) {
    if (await checkAuth(req, res)) {
        next();
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkProxyAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body),
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);

    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkProxyAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(savePath, '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            if(!await checkAuth(req, res)){
                return;
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        console.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', authenticatedRouteLimiter, reverseProxyFunc_get);
app.get('/proxy2', authenticatedRouteLimiter, reverseProxyFunc_get);
app.get('/hub-proxy/*', authenticatedRouteLimiter, hubProxyFunc);

app.post('/proxy', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/proxy2', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/hub-proxy/*', authenticatedRouteLimiter, hubProxyFunc);
app.post('/proxy-stream-jobs', authenticatedRouteLimiter, async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }

    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const encodedUrl = encodeURIComponent(rawUrl);
    const url = sanitizeTargetUrl(decodeURIComponent(encodedUrl));
    if (!url) {
        res.status(400).send({ error: 'Invalid target URL. Only local/private network http(s) endpoints are allowed.' });
        return;
    }

    const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'POST';
    if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        res.status(400).send({ error: 'Invalid method' });
        return;
    }

    const bodyBase64 = typeof req.body?.bodyBase64 === 'string' ? req.body.bodyBase64 : '';
    if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
        res.status(413).send({ error: 'Request body too large' });
        return;
    }
    if (proxyStreamJobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
        res.status(429).send({ error: 'Too many active stream jobs. Retry shortly.' });
        return;
    }
    const headers = normalizeForwardHeaders(req.body?.headers);
    const heartbeatSec = normalizeHeartbeatSec(Number(req.body?.heartbeatSec));
    const job = createProxyStreamJob({
        heartbeatSec,
        timeoutMs: req.body?.timeoutMs
    });

    void runProxyStreamJob(job, {
        targetUrl: url,
        headers,
        method,
        bodyBase64,
        clientIp: req.ip
    });

    res.send({
        jobId: job.id,
        heartbeatSec: job.heartbeatSec
    });
});

app.delete('/proxy-stream-jobs/:jobId', authenticatedRouteLimiter, async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    const job = proxyStreamJobs.get(req.params.jobId);
    if (!job) {
        res.send({ success: true });
        return;
    }
    job.abortController.abort();
    markJobDone(job);
    cleanupJob(job.id);
    res.send({ success: true });
});

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', authRouteLimiter, async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        res.send({status: 'incorrect'})
    }
    else{
        res.send({status: 'success'})
    }
})

app.post('/api/login', loginRouteLimiter, async (req, res) => {
    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        knownPublicKeysHashes.push(await hashJSON(req.body.publicKey))
        writeFileSync(knownPublicKeysPath, JSON.stringify(knownPublicKeysHashes), 'utf-8')
        res.send({status:'success'})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = crypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        writeFileSync(passwordPath, password, 'utf-8')
        res.send({status: 'success'})
    }
    else{
        res.status(400).send("already set")
    }
})


function createHeaderPacket(fileId, name, fileSize) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const packet = Buffer.alloc(1 + 4 + 4 + nameBuffer.length + 8);

    let offset = 0;

    packet.writeUInt8(0x01, offset);
    offset += 1;
    packet.writeUInt32BE(fileId, offset);
    offset += 4;
    packet.writeUInt32BE(nameBuffer.length, offset);
    offset += 4;

    nameBuffer.copy(packet, offset);
    offset += nameBuffer.length;

    packet.writeBigUint64BE(BigInt(fileSize), offset);

    return packet;
}

function createChunkPacket(fileId, data) {
    const header = Buffer.alloc(1+4+4);
    header.writeUInt8(0x02, 0);
    header.writeUInt32BE(fileId, 1);
    header.writeUint32BE(data.length, 5);

    return Buffer.concat([header, data])
}


async function writePacket(res, packet) {
      if (!res.write(packet)) {
          await once(res, 'drain')
      }
  }


  function createEndPacket(fileId) {
    const packet = Buffer.alloc(1 + 4);
    packet.writeInt8(0x03, 0);
    packet.writeInt32BE(fileId, 1);

    return packet;
  }

const BULK_WRITE_CONTENT_TYPE = 'application/x-risu-bulk';
const BULK_WRITE_MAX_NAME_BYTES = 64 * 1024;
const BULK_WRITE_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const BULK_WRITE_MAX_FILES = 10000;
const BULK_WRITE_MAX_OPEN_FILES = Math.max(
    1,
    parseInt(process.env.RISUAI_RESTORE_MAX_OPEN_FILES || '64', 10) || 64
);
function createBulkProtocolError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

async function writeFileChunk(fileHandle, data) {
    let offset = 0;
    while (offset < data.length) {
        const { bytesWritten } = await fileHandle.write(
            data,
            offset,
            data.length - offset,
            null
        );
        if (bytesWritten === 0) {
            throw new Error('Failed to write bulk file chunk');
        }
        offset += bytesWritten;
    }
}
//   Type list:
// Header Type (Type: 0x01):
// Type - 1 byte
// File ID - 4bytes
// NameLength - 4bytes
// Name - N bytes
// TotalFileSize: 8 bytes (BigInt)
// 
// Chunk Data Type (Type: 0x02):
// Type - 1byte
// File ID - 4bytes
// ChunkSize: 4bytes
// ChunkData: N bytes

// File End Type (Type: 0x03):
// Type - 1byte
// File ID: 4bytes

app.post('/api/read-bulk', authenticatedRouteLimiter, async(req, res, next) => {
    if (!await checkAuth(req, res)) return;

    const filePaths = req.body?.filePaths;
    const isThumb = req.query.thumb === '1' || req.query.thumb === 'true' || req.body?.thumb === true || req.headers['x-thumbnail'] === 'true';

    if (!Array.isArray(filePaths)) {
        res.status(400).send({
            error: "filePaths isn't an array."
        });
        return;
    }
    const storage = assetStorageManager.getStorage();
    let fileId = 0;
    for (const filePath of filePaths) {
        if (!isHex(filePath)) continue;
        try {
            const result = isThumb && typeof storage.readThumbnail === 'function'
                ? await storage.readThumbnail(filePath)
                : await storage.read(filePath);
            if (!result.exists) continue;

            const name = Buffer.from(filePath, 'hex').toString('utf8');
            const totalSize = result.contentLength || (result.buffer ? result.buffer.length : 0);
            await writePacket(res, createHeaderPacket(fileId, name, totalSize));

            if (result.filePath) {
                const fileHandle = await fs.open(result.filePath, 'r');
                try {
                    const stream = fileHandle.createReadStream({ autoClose: false });
                    for await (const chunk of stream) {
                        await writePacket(res, createChunkPacket(fileId, chunk));
                    }
                } finally {
                    await fileHandle.close();
                }
            } else if (result.stream) {
                for await (const chunk of result.stream) {
                    await writePacket(res, createChunkPacket(fileId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                }
            } else if (result.buffer) {
                const chunkSize = 256 * 1024;
                for (let offset = 0; offset < result.buffer.length; offset += chunkSize) {
                    const chunk = result.buffer.subarray(offset, Math.min(offset + chunkSize, result.buffer.length));
                    await writePacket(res, createChunkPacket(fileId, chunk));
                }
            }
            await writePacket(res, createEndPacket(fileId));
            fileId += 1;
        } catch (err) {
            console.error(`Error reading ${filePath} in read-bulk:`, err);
        }
    }

    res.end();
});

app.post('/api/write-bulk', authenticatedRouteLimiter, async(req, res, next) => {
    if (!await checkAuth(req, res)) return;

    if (!req.is(BULK_WRITE_CONTENT_TYPE)) {
        res.status(415).send({ error: `Content-Type must be ${BULK_WRITE_CONTENT_TYPE}` });
        return;
    }

    const storage = assetStorageManager.getStorage();
    const receivingFiles = new Map();
    const targetPaths = new Set();
    let pending = Buffer.alloc(0);
    let activeChunk = null;
    let fileCount = 0;

    const cleanup = async() => {
        for (const file of receivingFiles.values()) {
            if (file.writer) {
                try { await file.writer.abort(); } catch {}
            }
        }
    };

    try {
        for await (const incomingChunk of req) {
            pending = pending.length === 0
                ? incomingChunk
                : Buffer.concat([pending, incomingChunk], pending.length + incomingChunk.length);
            let offset = 0;

            while (offset < pending.length) {
                const available = pending.length - offset;

                if (activeChunk) {
                    const writeLength = Math.min(available, activeChunk.remaining);
                    if (!activeChunk.file.writer.stream.write(pending.subarray(offset, offset + writeLength))) {
                        await once(activeChunk.file.writer.stream, 'drain');
                    }
                    activeChunk.file.receivedSize += BigInt(writeLength);
                    activeChunk.remaining -= writeLength;
                    offset += writeLength;
                    if (activeChunk.remaining === 0) activeChunk = null;
                    continue;
                }

                if (available < 1) break;

                const type = pending.readUInt8(offset);

                if (type === 0x01) {
                    if (available < 9) break;

                    const fileId = pending.readUInt32BE(offset + 1);
                    const nameLength = pending.readUInt32BE(offset + 5);
                    if (nameLength === 0 || nameLength > BULK_WRITE_MAX_NAME_BYTES) {
                        throw createBulkProtocolError('Invalid bulk file name length');
                    }

                    const packetLength = 1 + 4 + 4 + nameLength + 8;
                    if (available < packetLength) break;
                    if (receivingFiles.has(fileId)) {
                        throw createBulkProtocolError(`Duplicate bulk file ID: ${fileId}`);
                    }
                    if (fileCount >= BULK_WRITE_MAX_FILES) {
                        throw createBulkProtocolError('Too many files in bulk write request');
                    }
                    if (receivingFiles.size >= BULK_WRITE_MAX_OPEN_FILES) {
                        throw createBulkProtocolError(`Too many simultaneously open bulk files (maximum ${BULK_WRITE_MAX_OPEN_FILES})`);
                    }

                    const nameStart = offset + 9;
                    const nameEnd = nameStart + nameLength;
                    const name = pending.subarray(nameStart, nameEnd).toString('utf8');
                    const expectedSize = pending.readBigUInt64BE(nameEnd);
                    const encodedName = Buffer.from(name, 'utf8').toString('hex');
                    if (targetPaths.has(encodedName)) {
                        throw createBulkProtocolError(`Duplicate bulk file name: ${name}`);
                    }

                    const writer = storage.createWriteStream(encodedName);
                    receivingFiles.set(fileId, {
                        name,
                        expectedSize,
                        receivedSize: 0n,
                        writer
                    });
                    targetPaths.add(encodedName);
                    fileCount += 1;
                    offset += packetLength;
                    continue;
                }

                if (type === 0x02) {
                    if (available < 9) break;

                    const fileId = pending.readUInt32BE(offset + 1);
                    const chunkSize = pending.readUInt32BE(offset + 5);
                    if (chunkSize > BULK_WRITE_MAX_CHUNK_BYTES) {
                        throw createBulkProtocolError('Bulk file chunk is too large');
                    }

                    const file = receivingFiles.get(fileId);
                    if (!file) {
                        throw createBulkProtocolError(`Chunk for unknown bulk file ID: ${fileId}`);
                    }

                    const nextSize = file.receivedSize + BigInt(chunkSize);
                    if (nextSize > file.expectedSize) {
                        throw createBulkProtocolError(`Too much data for bulk file: ${file.name}`);
                    }

                    offset += 9;
                    activeChunk = { file, remaining: chunkSize };
                    if (chunkSize === 0) activeChunk = null;
                    continue;
                }

                if (type === 0x03) {
                    if (available < 5) break;

                    const fileId = pending.readUInt32BE(offset + 1);
                    const file = receivingFiles.get(fileId);
                    if (!file) {
                        throw createBulkProtocolError(`End packet for unknown bulk file ID: ${fileId}`);
                    }
                    if (file.receivedSize !== file.expectedSize) {
                        throw createBulkProtocolError(`Incomplete bulk file: ${file.name}`);
                    }

                    file.writer.stream.end();
                    receivingFiles.delete(fileId);
                    offset += 5;
                    // Apply request backpressure so completed multipart uploads are not
                    // retained until the entire restore body has arrived.
                    await file.writer.done();
                    continue;
                }

                throw createBulkProtocolError(`Unknown bulk packet type: ${type}`);
            }

            pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
        }

        if (pending.length !== 0 || activeChunk || receivingFiles.size !== 0) {
            throw createBulkProtocolError('Bulk write request ended with an incomplete packet');
        }

        res.send({ success: true, written: fileCount });
    } catch (error) {
        await cleanup();
        if (error?.statusCode) {
            res.status(error.statusCode).send({ error: error.message });
            return;
        }
        next(error);
    }
});

app.get('/api/postgres-config', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        res.send(await getPostgresConfigResponse());
    } catch (error) {
        next(error);
    }
});

app.post('/api/postgres-config', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (postgresManagedByEnvironment) {
        res.status(403).send({
            error: 'PostgreSQL is managed by server environment variables',
            code: 'postgres_environment_managed',
        });
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'PostgreSQL configuration changes require HTTPS or a localhost connection',
            code: 'postgres_secure_transport_required',
        });
        return;
    }

    const previousConfig = { ...postgresServerConfig };
    try {
        if (typeof req.body?.enabled !== 'boolean') {
            throw new PostgresPayloadError('enabled must be a boolean');
        }
        const connectionString = typeof req.body.connectionString === 'string' && req.body.connectionString.trim()
            ? req.body.connectionString.trim()
            : previousConfig.connectionString;
        const poolMax = normalizePostgresPoolMax(req.body.poolMax ?? previousConfig.poolMax);
        if (req.body.enabled) {
            validatePostgresConnectionString(connectionString);
        }

        const connectionChanged = connectionString !== previousConfig.connectionString;
        const mustExportLegacy = postgresStorage.enabled && (!req.body.enabled || connectionChanged);
        if (mustExportLegacy && req.body.legacySnapshotReady !== true) {
            throw new PostgresPayloadError(
                'A current database.bin snapshot is required before changing active PostgreSQL storage'
            );
        }
        if (mustExportLegacy) {
            await postgresStorage.exportColdStorageToLegacy(savePath);
        }

        const needsReconfigure = postgresStorage.enabled !== req.body.enabled ||
            (req.body.enabled && (connectionChanged || poolMax !== previousConfig.poolMax));
        if (needsReconfigure) {
            await postgresStorage.reconfigure({
                connectionString: req.body.enabled ? connectionString : '',
                poolMax,
            });
        }

        postgresServerConfig = {
            enabled: req.body.enabled,
            connectionString,
            poolMax,
        };
        try {
            await persistPostgresServerConfig(postgresServerConfig);
        } catch (persistError) {
            postgresServerConfig = previousConfig;
            await postgresStorage.reconfigure({
                connectionString: previousConfig.enabled ? previousConfig.connectionString : '',
                poolMax: previousConfig.poolMax,
            });
            throw persistError;
        }

        if (postgresStorage.enabled) {
            await postgresStorage.migrateLegacyColdStorage(savePath);
        }
        res.send({ success: true, ...await getPostgresConfigResponse() });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_postgres_configuration' });
            return;
        }
        next(error);
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// 범용 DB 설정 API (postgres / oracle / azure 공통)
// /api/db-config: 현재 vendor, enabled, 마스킹된 연결 정보 반환
// /api/db-config POST: vendor + params + migrate 설정 적용 후 storage 재생성
// /api/db-config/test: 전달된 파라미터로 연결 테스트
// /api/database-v2/migrate-legacy: 명시적 로컬→SQL 마이그레이션 트리거
// ─────────────────────────────────────────────────────────────────────────────

function maskSecret(value) {
    if (!value || typeof value !== 'string') return '';
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

function getDbConfigResponse() {
    const stored = readStoredDbConfig(savePath);
    const params = stored.params || {};
    // vendor별 마스킹된 params 구성
    const maskedParams = {};
    if (stored.vendor === 'postgres') {
        maskedParams.connectionString = maskPostgresConnectionString(params.connectionString || '');
        maskedParams.poolMax = params.poolMax || 10;
    } else if (stored.vendor === 'oracle') {
        maskedParams.user = params.user || '';
        maskedParams.tnsAlias = params.tnsAlias || '';
        maskedParams.walletPath = params.walletPath || '';
        maskedParams.poolMax = params.poolMax || 10;
        // password/walletPassword는 마스킹
        maskedParams.hasPassword = Boolean(params.password);
        maskedParams.hasWalletPassword = Boolean(params.walletPassword);
    } else if (stored.vendor === 'azure') {
        maskedParams.server = params.server || '';
        maskedParams.database = params.database || '';
        maskedParams.user = params.user || '';
        maskedParams.port = params.port || 1433;
        maskedParams.poolMax = params.poolMax || 10;
        maskedParams.hasPassword = Boolean(params.password);
    }
    return {
        vendor: dbVendor,
        enabled: postgresStorage.enabled,
        configured: isVendorConfigComplete(dbVendor, params) || postgresStorage.enabled,
        managedByEnvironment: storageManagedByEnvironment,
        revision: null,
        initialized: false,
        params: maskedParams,
        storedVendor: stored.vendor,
    };
}

app.get('/api/db-config', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        let revision = null;
        let initialized = false;
        if (postgresStorage.enabled) {
            try {
                const state = await postgresStorage.getState();
                revision = state.revision;
                initialized = state.initialized;
            } catch (e) {
                // storage가 초기화되지 않았을 수 있음
            }
        }
        const resp = getDbConfigResponse();
        resp.revision = revision;
        resp.initialized = initialized;
        res.send(resp);
    } catch (error) {
        next(error);
    }
});

app.post('/api/db-config/test', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'DB configuration test requires HTTPS or a localhost connection',
            code: 'secure_transport_required',
        });
        return;
    }
    try {
        const vendor = req.body?.vendor;
        const params = req.body?.params || {};
        if (!SUPPORTED_VENDORS.includes(vendor)) {
            res.status(400).send({ success: false, error: `Unsupported vendor: ${vendor}` });
            return;
        }
        const result = await testConnection(vendor, params);
        res.send(result);
    } catch (error) {
        res.send({ success: false, error: error.message || String(error) });
    }
});

app.post('/api/db-config', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (storageManagedByEnvironment) {
        res.status(403).send({
            error: 'Database storage is managed by server environment variables',
            code: 'storage_environment_managed',
        });
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'DB configuration changes require HTTPS or a localhost connection',
            code: 'secure_transport_required',
        });
        return;
    }
    try {
        const vendor = req.body?.vendor;
        const params = req.body?.params || {};
        const migrate = req.body?.migrate === true;
        if (!SUPPORTED_VENDORS.includes(vendor)) {
            throw new StoragePayloadError(`Unsupported vendor: ${vendor}`);
        }
        const normalized = normalizeVendorParams(vendor, params);
        if (!isVendorConfigComplete(vendor, normalized)) {
            throw new StoragePayloadError('Required connection parameters are missing');
        }

        // 기존 storage가 활성 상태면 cold storage를 legacy로 export (롤백 가능하도록)
        if (postgresStorage.enabled && typeof postgresStorage.exportColdStorageToLegacy === 'function') {
            try {
                await postgresStorage.exportColdStorageToLegacy(savePath);
            } catch (e) {
                console.warn('[db-config] Cold storage export skipped:', e.message);
            }
        }

        // 신규 config 저장 + 신규 storage 인스턴스 생성
        const result = applyDbConfig(savePath, { vendor, params: normalized, enabled: true });
        // 기존 storage 풀 정리
        if (typeof postgresStorage.close === 'function') {
            try { await postgresStorage.close(); } catch (e) {}
        }
        postgresStorage = result.storage;
        dbVendor = result.vendor;
        storageManagedByEnvironment = isStorageManagedByEnvironment(dbVendor);

        // 신규 storage 초기화
        await postgresStorage.initialize();

        // 마이그레이션 명시적 수행
        if (migrate && postgresStorage.enabled) {
            try {
                await postgresStorage.migrateLegacyColdStorage(savePath);
            } catch (e) {
                console.warn('[db-config] Legacy cold storage migration skipped:', e.message);
            }
        }

        // PostgreSQL 호환 config 파일도 갱신 (기존 /api/postgres-config와 호환성)
        if (vendor === 'postgres') {
            await persistPostgresServerConfig({
                enabled: true,
                connectionString: normalized.connectionString,
                poolMax: normalized.poolMax || 10,
            });
        }

        const resp = getDbConfigResponse();
        try {
            if (postgresStorage.enabled) {
                const state = await postgresStorage.getState();
                resp.revision = state.revision;
                resp.initialized = state.initialized;
            }
        } catch (e) {}
        res.send({ success: true, ...resp });
    } catch (error) {
        if (error instanceof StoragePayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_db_configuration' });
            return;
        }
        next(error);
    }
});

app.post('/api/database-v2/migrate-legacy', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'SQL storage is not configured',
            code: 'storage_disabled',
        });
        return;
    }
    try {
        const coldResult = await postgresStorage.migrateLegacyColdStorage(savePath);
        res.send({
            success: true,
            migrated: coldResult.migrated,
            skipped: coldResult.skipped,
        });
    } catch (error) {
        next(error);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 백업 데이터베이스 API
// /api/db-backup:         백업 설정 + 실시간 상태(revision lag, 마지막 미러/스냅샷)
// /api/db-backup/test:    전달된 백업 연결 파라미터로 연결 테스트
// /api/db-backup POST:    백업 설정 적용 + 초기화 + 최초 전체 백업
// /api/db-backup/resync:  수동 전체 백업 (메인 전체 → 백업 replaceAll)
// /api/db-backup DELETE:  백업 설정 해제
// ─────────────────────────────────────────────────────────────────────────────

function maskBackupParams(vendor, params = {}) {
    const masked = {};
    if (vendor === 'postgres') {
        masked.connectionString = maskPostgresConnectionString(params.connectionString || '');
        masked.poolMax = params.poolMax || 10;
    } else if (vendor === 'oracle') {
        masked.user = params.user || '';
        masked.tnsAlias = params.tnsAlias || '';
        masked.walletPath = params.walletPath || '';
        masked.poolMax = params.poolMax || 10;
        masked.hasPassword = Boolean(params.password);
        masked.hasWalletPassword = Boolean(params.walletPassword);
    } else if (vendor === 'azure') {
        masked.server = params.server || '';
        masked.database = params.database || '';
        masked.user = params.user || '';
        masked.port = params.port || 1433;
        masked.poolMax = params.poolMax || 10;
        masked.hasPassword = Boolean(params.password);
    }
    return masked;
}

async function getBackupConfigResponse() {
    const configured = Boolean(backupConfig.vendor && backupConfig.enabled);
    const active = Boolean(backupStorage?.enabled);
    let primaryRevision = null;
    let backupRevision = null;
    let backupInitialized = false;
    try {
        if (postgresStorage.enabled) {
            const primaryState = await postgresStorage.getState();
            primaryRevision = primaryState.revision;
        }
    } catch (e) {}
    if (active) {
        try {
            const backupState = await backupStorage.getState();
            backupRevision = backupState.revision;
            backupInitialized = Boolean(backupState.initialized);
        } catch (e) {}
    }
    return {
        configured,
        enabled: active,
        vendor: configured ? backupConfig.vendor : null,
        managedByEnvironment: false,
        mirroring: { enabled: Boolean(backupConfig.mirroring?.enabled) },
        snapshot: {
            enabled: Boolean(backupConfig.snapshot?.enabled),
            intervalMinutes: backupConfig.snapshot?.intervalMinutes || 60,
        },
        params: configured ? maskBackupParams(backupConfig.vendor, backupConfig.params) : {},
        primaryRevision,
        backupRevision,
        lag: (primaryRevision !== null && backupRevision !== null) ? Math.max(0, primaryRevision - backupRevision) : null,
        backupInitialized,
        inFlight: backupRuntime.inFlight,
        lastMirrorAt: backupRuntime.lastMirrorAt,
        lastMirrorError: backupRuntime.lastMirrorError,
        lastSnapshotAt: backupRuntime.lastSnapshotAt,
        lastSnapshotError: backupRuntime.lastSnapshotError,
        lastFullSyncAt: backupRuntime.lastFullSyncAt,
        lastFullSyncError: backupRuntime.lastFullSyncError,
    };
}

app.get('/api/db-backup', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        res.send(await getBackupConfigResponse());
    } catch (error) {
        next(error);
    }
});

app.post('/api/db-backup/test', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'Backup database connection test requires HTTPS or a localhost connection',
            code: 'secure_transport_required',
        });
        return;
    }
    try {
        const vendor = req.body?.vendor;
        const params = req.body?.params || {};
        if (!SUPPORTED_VENDORS.includes(vendor)) {
            res.status(400).send({ success: false, error: `Unsupported vendor: ${vendor}` });
            return;
        }
        const result = await testConnection(vendor, params);
        res.send(result);
    } catch (error) {
        res.send({ success: false, error: error.message || String(error) });
    }
});

app.post('/api/db-backup', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'Backup database configuration changes require HTTPS or a localhost connection',
            code: 'secure_transport_required',
        });
        return;
    }
    try {
        const vendor = req.body?.vendor;
        const params = req.body?.params || {};
        if (!SUPPORTED_VENDORS.includes(vendor)) {
            throw new StoragePayloadError(`Unsupported vendor: ${vendor}`);
        }
        const normalized = normalizeVendorParams(vendor, params);
        if (!isVendorConfigComplete(vendor, normalized)) {
            throw new StoragePayloadError('Required backup connection parameters are missing');
        }
        const mirroring = { enabled: req.body?.mirroring?.enabled === true };
        const snapshot = {
            enabled: req.body?.snapshot?.enabled === true,
            intervalMinutes: req.body?.snapshot?.intervalMinutes,
        };

        // 기존 백업 풀 정리
        if (backupStorage && typeof backupStorage.close === 'function') {
            try { await backupStorage.close(); } catch (e) {}
        }
        backupStorage = null;
        backupRuntime.initialized = false;

        // 설정 저장 + 신규 인스턴스
        const { backup, storage } = applyBackupConfig(savePath, { vendor, params: normalized, mirroring, snapshot });
        backupConfig = backup;

        // 초기화 (스키마 생성/확인)
        await activateBackupStorage(storage);
        console.log(`[db-backup] Backup storage configured (vendor: ${vendor}).`);

        // 스냅샷 타이머 재설정
        syncBackupSnapshotTimer();

        // 최초 전체 백업: 메인 DB에서 백업 DB로 전체 적요 (직렬 큐)
        void enqueueBackupWrite(() => mirrorFullBackupToBackup().then((result) => {
            backupRuntime.lastFullSyncAt = new Date().toISOString();
            backupRuntime.lastFullSyncError = null;
            return result;
        }), 'full').catch(() => {});

        const resp = await getBackupConfigResponse();
        res.send({ success: true, ...resp });
    } catch (error) {
        if (error instanceof StoragePayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_backup_configuration' });
            return;
        }
        next(error);
    }
});

app.post('/api/db-backup/resync', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!backupStorage?.enabled) {
        res.status(404).send({ error: 'Backup database is not configured', code: 'backup_disabled' });
        return;
    }
    try {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        const sendProgress = (event) => {
            if (res.writableEnded || res.closed) return;
            res.write(JSON.stringify({ type: 'progress', ...event }) + '\n');
        };

        const result = await enqueueBackupWrite(() => mirrorFullBackupToBackup(sendProgress).then((r) => {
            backupRuntime.lastFullSyncAt = new Date().toISOString();
            backupRuntime.lastFullSyncError = null;
            return r;
        }), 'full');

        res.write(JSON.stringify({
            type: 'done',
            success: true,
            ...(result || {}),
            lastFullSyncAt: backupRuntime.lastFullSyncAt,
        }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).send({
                success: false,
                error: error?.message || 'Backup full sync failed',
                code: 'backup_sync_failed',
            });
        } else {
            res.write(JSON.stringify({
                type: 'error',
                error: error?.message || 'Backup full sync failed',
                code: 'backup_sync_failed',
            }) + '\n');
            res.end();
        }
    }
});

app.delete('/api/db-backup', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!isSecurePostgresConfigRequest(req)) {
        res.status(403).send({
            error: 'Backup database removal requires HTTPS or a localhost connection',
            code: 'secure_transport_required',
        });
        return;
    }
    try {
        await deactivateBackupStorage();
        removeBackupConfig(savePath);
        res.send({ success: true, ...(await getBackupConfigResponse()) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const shallow = req.query.shallow !== 'false';
        const state = await postgresStorage.getState();
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        const stateEtag = `"risu-postgres-${state.revision}"`;
        if (state.initialized && requestEtag.split(',').map((value) => value.trim()).includes(stateEtag)) {
            res.setHeader('ETag', stateEtag);
            res.setHeader('Cache-Control', 'private, no-cache');
            res.status(304).end();
            return;
        }
        const stored = await postgresStorage.loadDatabase({ shallow });
        const etag = `"risu-postgres-${stored.revision}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        if (stored.initialized && requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, {
            status: stored.initialized ? 'ready' : 'empty',
            revision: stored.revision,
            database: stored.database,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/plugins', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const result = await postgresStorage.loadPlugins();
        const etag = `"risu-plugins-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, {
            plugins: result.plugins,
            hash: result.hash,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/plugin-custom-storage/keys', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const keys = await postgresStorage.listPluginCustomStorageKeys();
        await sendCompressedJson(req, res, { keys });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/plugin-custom-storage/keys/:key', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const result = await postgresStorage.loadPluginCustomStorageKey(req.params.key);
        if (!result.exists) {
            res.status(404).send({ error: `Plugin custom storage key not found: ${req.params.key}` });
            return;
        }
        const etag = `"risu-plugin-key-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
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
});

app.get('/api/database-v2/plugin-custom-storage', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const result = await postgresStorage.loadPluginCustomStorage();
        const etag = `"risu-plugin-storage-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
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
});

app.get('/api/database-v2/plugins-data', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const result = await postgresStorage.loadPluginsData();
        const etag = `"risu-plugins-data-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
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
});

app.get('/api/database-v2/personas', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadPersonas();
        const etag = `"risu-personas-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { personas: result.personas, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/bot-presets', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadBotPresets();
        const etag = `"risu-bot-presets-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { botPresets: result.botPresets, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/lorebooks', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadLorebooks();
        const etag = `"risu-lorebooks-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { loreBook: result.loreBook, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/modules', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadModules();
        const etag = `"risu-modules-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { modules: result.modules, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/prompts', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadPrompts();
        const etag = `"risu-prompts-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { prompts: result.prompts, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/scripts', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadScripts();
        const etag = `"risu-scripts-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { globalscript: result.globalscript, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/settings/:key', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.loadSettingKey(req.params.key);
        if (!result.exists) {
            res.status(404).send({ error: `Setting key not found: ${req.params.key}` });
            return;
        }
        const etag = `"risu-setting-${encodeURIComponent(result.key)}-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { key: result.key, value: result.value, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/characters/:characterId', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const character = await postgresStorage.loadCharacter(req.params.characterId);
        if (!character) {
            res.status(404).send({ error: 'Character not found', code: 'character_not_found' });
            return;
        }
        await sendCompressedJson(req, res, { character });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_character_id' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/chats/:chatId', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const chat = await postgresStorage.loadChat(req.params.chatId);
        if (!chat) {
            res.status(404).send({ error: 'Chat not found', code: 'chat_not_found' });
            return;
        }
        await sendCompressedJson(req, res, { chat });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_chat_id' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/chats/:chatId/messages', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({
            error: 'PostgreSQL storage is not configured',
            code: 'postgres_disabled',
        });
        return;
    }

    try {
        const messages = await postgresStorage.loadChatMessages(req.params.chatId);
        await sendCompressedJson(req, res, { messages });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_chat_id' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/revisions', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        res.send({ revisions: await postgresStorage.listRevisions(req.query.limit) });
    } catch (error) {
        next(error);
    }
});

app.post(
    '/api/database-v2/revisions/restore',
    authenticatedRouteLimiter,
    requireNodeAuth,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.restoreRevision(req.body?.revisionId);
            // 메인 DB 상태가 통째로 바뀌므로 백업에는 전체 재동기를 트리거.
            if (backupStorage?.enabled && backupConfig.mirroring?.enabled) {
                await awaitBackgroundMirror(() => mirrorFullBackupToBackup().then((r) => {
                    backupRuntime.lastMirrorAt = new Date().toISOString();
                    backupRuntime.lastMirrorError = null;
                    return r;
                }));
            }
            res.send({ success: true, ...result });
        } catch (error) {
            if (error instanceof PostgresPayloadError) {
                res.status(400).send({ error: error.message, code: 'invalid_revision_restore' });
                return;
            }
            next(error);
        }
    }
);

app.post(
    '/api/database-v2/commit',
    authenticatedRouteLimiter,
    requireNodeAuth,
    serializeLargeJsonRequests,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({
                error: 'PostgreSQL storage is not configured',
                code: 'postgres_disabled',
            });
            return;
        }

        try {
            const result = await postgresStorage.sync(req.body);
            // Keep at most one large parsed mutation alive: wait for the serial
            // mirror, while preserving primary-write success if the backup fails.
            if (backupStorage?.enabled && backupConfig.mirroring?.enabled) {
                await awaitBackgroundMirror(() => mirrorSyncPayloadToBackup(req.body).then((r) => {
                    backupRuntime.lastMirrorAt = new Date().toISOString();
                    backupRuntime.lastMirrorError = null;
                    return r;
                }));
            }
            res.send({ success: true, ...result });
        } catch (error) {
            if (error instanceof PostgresRevisionConflictError || error instanceof StorageRevisionConflictError) {
                res.status(409).send({
                    error: error.message,
                    code: 'revision_conflict',
                    revision: error.revision,
                });
                return;
            }
            if (error instanceof PostgresPayloadError || error instanceof StoragePayloadError) {
                res.status(400).send({
                    error: error.message,
                    code: 'invalid_sync_payload',
                });
                return;
            }
            next(error);
        }
    }
);

app.get('/api/database-v2/cold-storage', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }

    try {
        const items = await postgresStorage.listColdStorage();
        await sendCompressedJson(req, res, { items });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/cold-storage/:key', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }

    try {
        const item = await postgresStorage.loadColdStorage(req.params.key);
        if (!item) {
            res.status(404).send({ error: 'Cold storage item not found', code: 'cold_storage_not_found' });
            return;
        }
        const etag = `"risu-cold-${item.key}-${item.revision}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((value) => value.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, {
            key: item.key,
            kind: item.kind,
            updatedAt: item.updated_at,
            data: item.data,
        });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_cold_storage_key' });
            return;
        }
        next(error);
    }
});

app.put(
    '/api/database-v2/cold-storage/:key',
    authenticatedRouteLimiter,
    requireNodeAuth,
    serializeLargeJsonRequests,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({
                error: 'PostgreSQL storage is not configured',
                code: 'postgres_disabled',
            });
            return;
        }

        try {
            const item = await postgresStorage.upsertColdStorage(req.params.key, req.body?.data);
            if (backupStorage?.enabled && backupConfig.mirroring?.enabled) {
                await awaitBackgroundMirror(() => backupStorage.upsertColdStorage(req.params.key, req.body?.data).then((r) => {
                    backupRuntime.lastMirrorAt = new Date().toISOString();
                    backupRuntime.lastMirrorError = null;
                    return r;
                }));
            }
            res.send({
                success: true,
                key: item.key,
                kind: item.kind,
                updatedAt: item.updated_at,
            });
        } catch (error) {
            if (error instanceof PostgresPayloadError) {
                res.status(400).send({
                    error: error.message,
                    code: 'invalid_cold_storage_payload',
                });
                return;
            }
            next(error);
        }
    }
);

app.delete('/api/database-v2/cold-storage', authenticatedRouteLimiter, serializeLargeJsonRequests, postgresJsonParser, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }

    try {
        const result = await postgresStorage.deleteColdStorage(req.body?.keys);
        if (backupStorage?.enabled && backupConfig.mirroring?.enabled) {
            await awaitBackgroundMirror(() => backupStorage.deleteColdStorage(req.body?.keys).then((r) => {
                backupRuntime.lastMirrorAt = new Date().toISOString();
                backupRuntime.lastMirrorError = null;
                return r;
            }));
        }
        res.send({ success: true, ...result });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_cold_storage_keys' });
            return;
        }
        next(error);
    }
});

app.post('/api/database-v2/cold-storage/prune', authenticatedRouteLimiter, serializeLargeJsonRequests, postgresJsonParser, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }

    try {
        const result = await postgresStorage.pruneColdStorage(req.body?.retainedKeys);
        if (backupStorage?.enabled && backupConfig.mirroring?.enabled) {
            await awaitBackgroundMirror(() => backupStorage.pruneColdStorage(req.body?.retainedKeys).then((r) => {
                backupRuntime.lastMirrorAt = new Date().toISOString();
                backupRuntime.lastMirrorError = null;
                return r;
            }));
        }
        res.send({ success: true, ...result });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_cold_storage_keys' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/search', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (typeof postgresStorage.searchMessages !== 'function') {
        res.send({ results: [] });
        return;
    }

    try {
        const results = await postgresStorage.searchMessages(
            req.query.q,
            req.query.scope,
            req.query.limit
        );
        await sendCompressedJson(req, res, { results });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_search_query' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/token-usage', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (typeof postgresStorage.getTokenUsage !== 'function') {
        res.send({ usage: [] });
        return;
    }

    try {
        await sendCompressedJson(req, res, { usage: await postgresStorage.getTokenUsage() });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/characters/search', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    const tag = req.query.tag;
    const name = req.query.name;
    if (tag && typeof postgresStorage.searchCharactersByTag !== 'function') {
        res.send({ results: [] });
        return;
    }
    if (!tag && typeof postgresStorage.searchCharactersByName !== 'function') {
        res.send({ results: [] });
        return;
    }

    try {
        const results = tag
            ? await postgresStorage.searchCharactersByTag(tag, req.query.limit)
            : await postgresStorage.searchCharactersByName(name, req.query.limit);
        await sendCompressedJson(req, res, { results });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_character_search' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/tables', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (typeof postgresStorage.listDbExplorerTables !== 'function') {
        res.send({ tables: [] });
        return;
    }

    try {
        await sendCompressedJson(req, res, { tables: await postgresStorage.listDbExplorerTables() });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/tables/:table/rows', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (typeof postgresStorage.getDbExplorerTableRows !== 'function') {
        res.send({ data: { columns: [], rows: [], total: 0, offset: 0, limit: 50 } });
        return;
    }

    try {
        const data = await postgresStorage.getDbExplorerTableRows(
            req.params.table,
            req.query.offset,
            req.query.limit,
            req.query.sort,
            req.query.dir,
            req.query.search,
            typeof req.query.columns === 'string' && req.query.columns.length > 0
                ? req.query.columns.split(',')
                : null
        );
        await sendCompressedJson(req, res, { data });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_table' });
            return;
        }
        next(error);
    }
});

app.get('/api/s3-config', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        res.send(assetStorageManager.getPublicConfig());
    } catch (error) {
        next(error);
    }
});

app.post('/api/s3-config', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const body = req.body || {};
        const updated = await assetStorageManager.setConfig(body);
        res.send({ success: true, config: updated });
    } catch (error) {
        res.status(400).send({ error: error.message });
    }
});

app.post('/api/s3-test', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const body = req.body || {};
        // Azure SQL asset storage test path: when storageType === 'azuresql',
        // delegate to AzureSqlAssetStorage.testConnection using the merged
        // Azure config (server/database/user/password). S3 credentials are
        // not relevant here, so we keep the two code paths separate.
        if (body.storageType === 'azuresql') {
            // The client sends Azure fields with the `azure*` prefix
            // (azureServer/azureDatabase/azureUser/azurePassword); map them to
            // the plain server/database/user/password keys that
            // AzureSqlAssetStorage.testConnection expects.
            const azureMerged = {
                ...assetStorageManager.azureConfig,
                server: (body.azureServer !== undefined && body.azureServer !== '')
                    ? body.azureServer.trim()
                    : assetStorageManager.azureConfig.server,
                database: (body.azureDatabase !== undefined && body.azureDatabase !== '')
                    ? body.azureDatabase.trim()
                    : assetStorageManager.azureConfig.database,
                user: (body.azureUser !== undefined && body.azureUser !== '')
                    ? body.azureUser.trim()
                    : assetStorageManager.azureConfig.user,
                password: (body.azurePassword !== undefined && body.azurePassword !== '')
                    ? body.azurePassword
                    : assetStorageManager.azureConfig.password,
                port: (body.azurePort !== undefined && body.azurePort !== '')
                    ? parseInt(body.azurePort, 10)
                    : assetStorageManager.azureConfig.port,
            };
            const result = await AzureSqlAssetStorage.testConnection(azureMerged);
            res.send(result);
            return;
        }
        const merged = {
            ...assetStorageManager.config,
            ...body,
            accessKeyId: (body.accessKeyId !== undefined && body.accessKeyId !== '')
                ? body.accessKeyId.trim()
                : assetStorageManager.config.accessKeyId,
            secretAccessKey: (body.secretAccessKey !== undefined && body.secretAccessKey !== '')
                ? body.secretAccessKey.trim()
                : assetStorageManager.config.secretAccessKey,
        };
        const result = await S3AssetStorage.testConnection(merged);
        res.send(result);
    } catch (error) {
        res.status(400).send({ success: false, message: error.message });
    }
});

app.get('/api/s3-stats', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const stats = await assetStorageManager.getStorage().getStats();
        res.send(stats);
    } catch (error) {
        next(error);
    }
});

app.get('/api/db-hash', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const hashes = await assetStorageManager.getDatabaseBinHashes();
        res.send(hashes);
    } catch (error) {
        next(error);
    }
});

app.post('/api/db-resolve', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const keep = req.query.keep || req.body?.keep;
        if (keep !== 'local' && keep !== 's3' && keep !== 'azuresql') {
            res.status(400).send({ error: "keep must be 'local', 's3', or 'azuresql'" });
            return;
        }
        const result = await assetStorageManager.resolveDatabaseBinConflict(keep);
        if (result.error) {
            res.status(500).send({ error: result.error });
            return;
        }
        res.send({ ok: true, size: result.bytes ? result.bytes.length : 0 });
    } catch (error) {
        next(error);
    }
});

app.get('/api/storage-summary', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const summary = await assetStorageManager.getSummary();
        res.send(summary);
    } catch (error) {
        next(error);
    }
});

app.get('/api/s3-asset-details', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const target = req.query.target || 'active';
        const details = await assetStorageManager.getAssetDetails(target);
        res.send(details);
    } catch (error) {
        next(error);
    }
});

app.post('/api/storage-assets-delete', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const { keys, target = 'active' } = req.body || {};
        if (!Array.isArray(keys)) {
            res.status(400).send({ error: 'keys must be an array of asset keys' });
            return;
        }
        const result = await assetStorageManager.deleteAssetKeys(keys, target);
        res.send(result);
    } catch (error) {
        next(error);
    }
});

app.post('/api/storage-local-clean', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const result = await assetStorageManager.cleanLocalAssets();
        res.send(result);
    } catch (error) {
        next(error);
    }
});

app.post('/api/s3-migrate', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        if (assetStorageManager.getStorage().type !== 's3' && assetStorageManager.getStorage().type !== 'azuresql') {
            res.status(400).send({ error: 'Remote storage (S3 or Azure SQL) is not currently active.' });
            return;
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        const result = await assetStorageManager.getStorage().migrateFromLocal(savePath, (progress) => {
            res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
        });

        res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).send({ error: error.message });
        } else {
            res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n');
            res.end();
        }
    }
});

app.post('/api/s3-rollback', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        if (assetStorageManager.getStorage().type !== 's3' && assetStorageManager.getStorage().type !== 'azuresql') {
            res.status(400).send({ error: 'Remote storage (S3 or Azure SQL) is not currently active.' });
            return;
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        const result = await assetStorageManager.getStorage().rollbackToLocal(savePath, (progress) => {
            res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
        });

        res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).send({ error: error.message });
        } else {
            res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n');
            res.end();
        }
    }
});

app.post('/api/s3-generate-thumbnails', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;

    if (assetStorageManager.getStorage().type !== 's3' && assetStorageManager.getStorage().type !== 'azuresql') {
        res.status(400).send({ error: 'Remote storage (S3 or Azure SQL) is not currently active' });
        return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const result = await assetStorageManager.getStorage().generateMissingThumbnails((progress) => {
            res.write(JSON.stringify(progress) + '\n');
        });

        res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).send({ error: error.message });
        } else {
            res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n');
            res.end();
        }
    }
});

app.get('/api/read', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    let filePath = req.headers['file-path'] || req.query.path || req.query['file-path'] || req.query.filePath;
    const isThumb = req.query.thumb === '1' || req.query.thumb === 'true' || req.headers['x-thumbnail'] === 'true';
    if (!filePath) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }

    if(!isHex(filePath)){
        filePath = keyToHex(filePath);
    }
    try {
        const storage = assetStorageManager.getStorage();
        const result = isThumb && typeof storage.readThumbnail === 'function'
            ? await storage.readThumbnail(filePath)
            : await storage.read(filePath);
        if(!result.exists){
            res.send();
        }
        else{
            const contentType = result.contentType || 'application/octet-stream';
            const totalLength = result.contentLength || (result.buffer ? result.buffer.length : 0);
            const rangeHeader = req.headers.range;

            res.setHeader('Content-Type', contentType);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', isThumb ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');

            if (rangeHeader && totalLength > 0 && !isThumb) {
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

                if (!isNaN(start) && start < totalLength) {
                    const chunkEnd = Math.min(end, totalLength - 1);
                    const chunkSize = (chunkEnd - start) + 1;

                    res.status(206);
                    res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${totalLength}`);
                    res.setHeader('Content-Length', chunkSize);

                    if (result.filePath) {
                        fs.createReadStream(result.filePath, { start, end: chunkEnd }).pipe(res);
                        return;
                    } else if (result.buffer) {
                        res.send(result.buffer.subarray(start, chunkEnd + 1));
                        return;
                    }
                }
            }

            if (result.contentLength) {
                res.setHeader('Content-Length', result.contentLength);
            }
            if (result.filePath) {
                res.sendFile(result.filePath);
            } else if (result.buffer) {
                res.send(result.buffer);
            } else if (result.stream) {
                result.stream.pipe(res);
            } else {
                res.send();
            }
        }
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePaths = req.headers['file-path']?.split('$$') || []

    for(const filePath of filePaths){
        if (!filePath) {
            res.status(400).send({
                error:'File path required'
            });
            return;
        }
        if(!isHex(filePath)){
            res.status(400).send({
                error:'Invaild Path'
            });
            return;
        }
    }

    try {
        await assetStorageManager.getStorage().remove(filePaths);
        res.send({
            success: true,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const storage = assetStorageManager.getStorage();
        const content = await storage.list();
        res.send({
            success: true,
            content
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    if (!req.is('application/octet-stream')) {
        res.status(415).send({ error: 'Content-Type must be application/octet-stream' });
        return;
    }

    const maxBytes = 100 * 1024 * 1024;
    const declaredLength = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        res.status(413).send({ error: 'Asset exceeds the 100 MB upload limit' });
        return;
    }

    const writer = assetStorageManager.getStorage().createWriteStream(filePath);
    try {
        let received = 0;
        for await (const chunk of req) {
            received += chunk.length;
            if (received > maxBytes) {
                const error = new Error('Asset exceeds the 100 MB upload limit');
                error.statusCode = 413;
                throw error;
            }
            if (!writer.stream.write(chunk)) await once(writer.stream, 'drain');
        }
        writer.stream.end();
        await writer.done();
        res.send({
            success: true
        });
    } catch (error) {
        await writer.abort().catch(() => {});
        if (error?.statusCode === 413) {
            res.status(413).send({ error: error.message });
            return;
        }
        next(error);
    }
});

const oauthData = {
    client_id: '',
    client_secret: '',
    config: {},
    code_verifier: ''

}
app.get('/api/oauth_login', async (req, res) => {
    const redirect_uri = (new URL (req.url)).host + '/api/oauth_callback'

    if(!redirect_uri){
        res.status(400).send({ error: 'redirect_uri is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret){
        const discovery = await getOpenidClient().discovery('https://account.sionyw.com/','','');
        oauthData.config = discovery;

        //oauth dynamic client registration
        //https://datatracker.ietf.org/doc/html/rfc7591

        const serverMeta = discovery.serverMetadata()
        //since we can't find a good library to do this, we will do it manually
        const registrationResponse = await fetch(serverMeta.registration_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (serverMeta.registration_access_token || '')
            },
            body: JSON.stringify({
                client_id: oauthData.client_id,
                client_secret: oauthData.client_secret,
                redirect_uris: [redirect_uri],
                response_types: ['code'],
                grant_types: ['authorization_code'],
                scope: 'risuai',
                token_endpoint_auth_method: 'client_secret_basic',
                client_name: 'Risuai Node Server',
            })
        });

        if(registrationResponse.status === 201 || registrationResponse.status === 200){
            const registrationData = await registrationResponse.json();
            oauthData.client_id = registrationData.client_id;
            oauthData.client_secret = registrationData.client_secret;
            discovery.clientMetadata().client_id = oauthData.client_id;
            discovery.clientMetadata().client_secret = oauthData.client_secret;
        }
        else{
            console.error('[Server] OAuth2 dynamic client registration failed:', registrationResponse.statusText);
            res.status(500).send({ error: 'OAuth2 client registration failed' });
            return
        }


        //now lets request

        const openid = getOpenidClient();
        let code_verifier = openid.randomPKCECodeVerifier();
        let code_challenge = await openid.calculatePKCECodeChallenge(code_verifier);

        oauthData.code_verifier = code_verifier;
        let redirectTo = openid.buildAuthorizationUrl(oauthData.config, {
            redirect_uri,
            code_challenge,
            code_challenge_method: 'S256',
            scope: 'risuai',
        })

        res.redirect(redirectTo.toString());

        return;

    }
    
    res.status(500).send({ error: 'OAuth2 login failed' });
});

app.get('/api/oauth_callback', async (req, res) => {

    //since this is a callback we don't need to check password

    const params = (new URL(req.url, `http://${req.headers.host}`)).searchParams;
    const code = params.get('code');

    if(!code){
        res.status(400).send({ error: 'code is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret || !oauthData.code_verifier){
        res.status(400).send({ error: 'OAuth2 not initialized' });
        return
    }

    let tokens = await getOpenidClient().authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    writeFileSync(authCodePath, tokens.access_token, 'utf-8')

    res.send(tokens)
            
})

app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) {
        const isPostgresPayload = isLargePostgresJsonRequest(req);
        res.status(413).send({
            error: isPostgresPayload
                ? `PostgreSQL JSON payload exceeds the configured ${postgresJsonBodyLimit} limit`
                : 'Request payload exceeds the configured 100mb limit',
            code: 'payload_too_large',
        });
        return;
    }
    next(error);
});

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
}

function setupProxyStreamWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (!reqUrl.pathname.startsWith('/proxy-stream-jobs/') || !reqUrl.pathname.endsWith('/ws')) {
                socket.destroy();
                return;
            }

            const auth = reqUrl.searchParams.get('risu-auth') || req.headers['risu-auth'];
            if (!await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const pathParts = reqUrl.pathname.split('/').filter(Boolean);
            const jobId = pathParts.length >= 3 ? pathParts[1] : '';
            const job = proxyStreamJobs.get(jobId);
            if (!job) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId);
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    wsServer.on('connection', (ws, _req, jobId) => {
        const job = proxyStreamJobs.get(jobId);
        if (!job) {
            ws.close();
            return;
        }

        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        for (const event of job.pendingEvents) {
            ws.send(event);
        }
        job.pendingEvents = [];
        job.pendingBytes = 0;

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = proxyStreamJobs.get(jobId);
            if (!currentJob) {
                return;
            }
            currentJob.clients.delete(ws);
            if (currentJob.done && currentJob.clients.size === 0) {
                cleanupJob(jobId);
            }
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    });
}

async function startServer() {
    try {
        console.log('[Server] Step 1: initializing storage...');
        await postgresStorage.initialize();
        console.log('[Server] Step 2: storage initialized, initializing asset storage...');
        await assetStorageManager.init();
        console.log('[Server] Step 3: asset storage initialized, checking bootstrap config...');
        if (!postgresManagedByEnvironment && !postgresConfigExists && postgresBootstrapUrl) {
            await persistPostgresServerConfig(postgresServerConfig);
        }
        // 자동 마이그레이션 제거: 사용자가 명시적으로 마이그레이션을 승인할 때만 수행.
        // /api/db-config POST (migrate: true) 또는 /api/database-v2/migrate-legacy 에서 트리거.
        console.log('[Server] Step 4: starting HTTP/HTTPS server...');
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();
        let server = null;

        if (httpsOptions) {
            // HTTPS
            server = https.createServer(httpsOptions, app);
            setupProxyStreamWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            server = http.createServer(app);
            setupProxyStreamWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

(async () => {
    setInterval(() => {
        const now = Date.now();
        for (const [jobId, job] of proxyStreamJobs.entries()) {
            if (!job.done && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                job.abortController.abort();
            }
            if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                cleanupJob(jobId);
                continue;
            }
            if (!job.done && now - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                cleanupJob(jobId);
            }
        }
    }, PROXY_STREAM_GC_INTERVAL_MS);
    await startServer();
})();
