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
const { isSecurePostgresConfigRequest } = require('./requestSecurity.cjs');
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
const { streamZip } = require('./zipStream.cjs');
const { createModelJobManager } = require('./modelJobs.cjs');
const {
    createRealtimeEventHub,
    describeSqlCommitChange,
    normalizeClientId,
} = require('./realtimeEvents.cjs');
const { createNodeChatExecutor } = require('./chatExecutor.cjs');
const { createNodeProviderExecutor } = require('./providerExecutor.cjs');
const { createHypaMemoryExecutor } = require('./hypaMemoryExecutor.cjs');
const {
    createEntryHeader: createLocalBackupEntryHeader,
    makeLegacyCompatibleDatabase: makeLegacyCompatibleBackupDatabase,
    encodeDatabase: encodeLocalBackupDatabase,
} = require('./localBackupFormat.cjs');
const { normalizePageInteger, paginateMessages } = require('./messagePagination.cjs');
const { countTokensBatch } = require('./tokenizeCount.cjs');
const { resolveLoreEntries } = require('./loreResolve.cjs');
const {
    configureVectorIndexPersistence,
    flushVectorIndexPersistence,
    getVectorIndexCacheStats,
    clearVectorIndexCache,
    checkVectorIndexRevision,
    syncVectorIndex,
    upsertVectorIndex,
    searchVectorIndex,
} = require('./vectorIndex.cjs');
const { matchLoreBatch } = require('./loreMatch.cjs');
const {
    describeStorageTarget,
    readStorageStartupSettings,
    runStartupStage,
    sanitizeSensitiveText,
    startupErrorHint,
} = require('./startupDiagnostics.cjs');
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
const storageStartupSettings = readStorageStartupSettings();

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

app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

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
configureVectorIndexPersistence(path.join(savePath, '__vector_indexes'));

const realtimeEventHub = createRealtimeEventHub();
const modelJobManager = createModelJobManager({
    saveDir: savePath,
    logger: console,
    onEvent: (phase, job, context) => realtimeEventHub.broadcast('model-job', {
        phase,
        job,
        sourceClientId: normalizeClientId(context?.sourceClientId),
    }),
});
const nodeChatExecutor = createNodeChatExecutor();
const nodeProviderExecutor = createNodeProviderExecutor();
const hypaMemoryExecutor = createHypaMemoryExecutor();
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

let primaryStorageRuntime = {
    status: postgresStorage.enabled ? 'starting' : 'unconfigured',
    vendor: dbVendor,
    error: null,
    attemptStartedAt: null,
    readyAt: null,
};
let primaryStorageAttempt = null;

function createPrimaryStorageFailure(error) {
    const rawCode = typeof error?.code === 'string' ? error.code : '';
    const message = sanitizeSensitiveText(error?.message || error || 'Unknown database error');
    return {
        code: rawCode || 'storage_connection_failed',
        message,
        hint: startupErrorHint(error),
        operation: sanitizeSensitiveText(error?.startupOperation || 'initialize SQL storage'),
        failedAt: new Date().toISOString(),
    };
}

function setPrimaryStorageRuntime(status, error = null) {
    primaryStorageRuntime = {
        status,
        vendor: dbVendor,
        error,
        attemptStartedAt: status === 'starting' ? new Date().toISOString() : primaryStorageRuntime.attemptStartedAt,
        readyAt: status === 'ready' ? new Date().toISOString() : primaryStorageRuntime.readyAt,
    };
}

function getPrimaryStorageRuntimeResponse() {
    return {
        status: primaryStorageRuntime.status,
        vendor: primaryStorageRuntime.vendor,
        error: primaryStorageRuntime.error,
        attemptStartedAt: primaryStorageRuntime.attemptStartedAt,
        readyAt: primaryStorageRuntime.readyAt,
    };
}

function isPrimaryStorageReady() {
    return primaryStorageRuntime.status === 'ready';
}

async function initializePrimaryStorage(storage, vendor, operation = `initialize ${vendor} storage`) {
    if (!storage.enabled) {
        if (storage === postgresStorage) setPrimaryStorageRuntime('unconfigured');
        return false;
    }

    if (primaryStorageAttempt?.storage === storage) {
        return await primaryStorageAttempt.guardedPromise;
    }

    if (storage === postgresStorage) setPrimaryStorageRuntime('starting');
    const rawPromise = Promise.resolve().then(() => storage.initialize());
    const guardedPromise = runStartupStage({
        scope: 'Server startup',
        operation,
        detail: describeStorageTarget(vendor, storage),
        timeoutMs: storageStartupSettings.startupTimeoutMs,
        heartbeatMs: storageStartupSettings.heartbeatMs,
    }, () => rawPromise);
    const attempt = { storage, rawPromise, guardedPromise };
    primaryStorageAttempt = attempt;

    rawPromise.then(() => {
        if (storage === postgresStorage) {
            setPrimaryStorageRuntime('ready');
            console.log(`[Server startup] ${vendor} storage became ready.`);
        } else if (typeof storage.close === 'function') {
            void storage.close().catch(() => {});
        }
    }, (error) => {
        if (storage === postgresStorage) {
            setPrimaryStorageRuntime('degraded', createPrimaryStorageFailure(error));
        }
    }).finally(() => {
        if (primaryStorageAttempt === attempt) primaryStorageAttempt = null;
    });

    try {
        await guardedPromise;
        return true;
    } catch (error) {
        if (storage === postgresStorage) {
            setPrimaryStorageRuntime('degraded', createPrimaryStorageFailure(error));
        }
        throw error;
    }
}

const recoveryApiPrefixes = [
    '/api/health',
    '/api/test_auth',
    '/api/login',
    '/api/crypto',
    '/api/set_password',
    '/api/db-config',
    '/api/postgres-config',
];

function isRecoveryApiRequest(req) {
    const path = String(req.originalUrl || req.url || '').split('?', 1)[0];
    return recoveryApiPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// SQL is the application's single source of truth. While it is unavailable,
// expose only the authentication/configuration surface needed to repair it.
// Static frontend files are registered before this middleware and remain
// available so the browser can render the recovery UI.
app.use('/api', (req, res, next) => {
    if (isPrimaryStorageReady() || isRecoveryApiRequest(req)) {
        next();
        return;
    }
    res.status(503).send({
        error: 'SQL storage is unavailable; restore the configured database connection before using application APIs.',
        code: 'storage_unavailable',
        runtime: getPrimaryStorageRuntimeResponse(),
    });
});

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
    const presetSummaries = (await postgresStorage.listBotPresets()).presets;
    payload.presets = {
        upserts: (await Promise.all(presetSummaries.map((summary) => postgresStorage.loadBotPreset(summary.id))))
            .filter(Boolean).map((result, position) => ({ id: result.preset.id, position, data: result.preset })),
        deletes: [], order: presetSummaries.map((summary) => summary.id),
        activeId: loaded.database.activeBotPresetId || presetSummaries[0]?.id,
    };
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

async function restoreBackupToMainDatabase(onProgress) {
    onProgress?.({ stage: 'reading', message: 'Reading data from backup database...', percentage: 10 });
    const loaded = await backupStorage.loadDatabase({ shallow: false });
    if (!loaded?.database) {
        throw new Error('Backup database has no valid data to restore');
    }
    const payload = buildFullBackupPayload(loaded.database);
    const presetSummaries = (await backupStorage.listBotPresets()).presets;
    payload.presets = {
        upserts: (await Promise.all(presetSummaries.map((summary) => backupStorage.loadBotPreset(summary.id))))
            .filter(Boolean).map((result, position) => ({ id: result.preset.id, position, data: result.preset })),
        deletes: [], order: presetSummaries.map((summary) => summary.id),
        activeId: loaded.database.activeBotPresetId || presetSummaries[0]?.id,
    };
    const settingsCount = payload.root?.upserts?.length ?? payload.rootUpserts?.length ?? 0;
    const charactersCount = payload.characters?.length || 0;
    const chatsCount = payload.chats?.length || 0;
    const messagesCount = payload.messages?.length || 0;
    const totalItems = settingsCount + charactersCount + chatsCount + messagesCount;

    onProgress?.({
        stage: 'preparing',
        message: 'Preparing data for main database restore...',
        percentage: 30,
        settingsCount,
        charactersCount,
        chatsCount,
        messagesCount,
        total: totalItems,
    });

    const state = await postgresStorage.getState();

    const handleStorageProgress = (subProgress) => {
        if (!subProgress) return;
        let mappedPercentage = 40;
        const subStage = subProgress.stage;
        let subMessage = subProgress.message;
        if (subStage === 'settings') {
            mappedPercentage = 45;
            subMessage = subMessage || `Restoring settings (${settingsCount})`;
        } else if (subStage === 'characters') {
            mappedPercentage = 60;
            subMessage = subMessage || `Restoring characters (${charactersCount})`;
        } else if (subStage === 'chats') {
            mappedPercentage = 75;
            subMessage = subMessage || `Restoring chats (${chatsCount})`;
        } else if (subStage === 'messages') {
            mappedPercentage = 90;
            subMessage = subMessage || `Restoring messages (${messagesCount})`;
        } else if (subStage === 'finalizing') {
            mappedPercentage = 98;
            subMessage = subMessage || 'Finalizing main database restore...';
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

    const syncResult = await postgresStorage.sync(
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
        message: 'Restore complete',
        percentage: 100,
        ...finalResult,
    });

    return finalResult;
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

function getAssetCatalogSourceId() {
    const storage = assetStorageManager.getStorage();
    if (storage.type !== 's3') return null;
    const config = assetStorageManager.s3Config || assetStorageManager.config || {};
    return JSON.stringify({
        type: 's3',
        endpoint: config.endpoint || 'aws',
        bucket: config.bucket || 'risuai-assets',
        // 'full-bucket' = the catalog mirrors every object in the bucket
        // (assets/, thumbnails/, database/...), not just the assets/ prefix.
        scope: 'full-bucket'
    });
}

function canUseAssetCatalog() {
    return Boolean(
        postgresStorage?.enabled &&
        typeof postgresStorage.isAssetCatalogInitialized === 'function' &&
        typeof postgresStorage.listAssetCatalog === 'function' &&
        typeof postgresStorage.replaceAssetCatalog === 'function'
    );
}

async function resolveCatalogedAssetKeys(storage, prefix = 'assets/', forceResync = false) {
    const sourceId = getAssetCatalogSourceId();
    if (!sourceId || !canUseAssetCatalog()) {
        return { keys: await storage.list(prefix), source: 'storage' };
    }
    try {
        const initialized = !forceResync &&
            await postgresStorage.isAssetCatalogInitialized(sourceId);
        if (initialized) {
            return { keys: await postgresStorage.listAssetCatalog(prefix), source: 'catalog' };
        }
        // Uninitialized (or forced): mirror the entire bucket so an
        // "initialized" catalog always means a complete listing.
        const fresh = await storage.getAssetDetails();
        await postgresStorage.replaceAssetCatalog(
            '',
            fresh.assets.map((asset) => ({ key: asset.key, size: asset.size })),
            sourceId
        );
        const keys = fresh.assets.map((asset) => asset.key)
            .filter((key) => !prefix || key.startsWith(prefix));
        return { keys, source: 'storage-sync' };
    } catch (error) {
        console.warn('[asset-catalog] SQL catalog unavailable; falling back to storage listing:', error?.message || error);
        return { keys: await storage.list(prefix), source: 'storage-fallback' };
    }
}

// Full-bucket catalog (re)synchronization. Lists S3 once and replaces every
// catalog row. Used by the explicit resync endpoint, post-migration sync, and
// the storage explorer's one-time initialization.
async function resyncAssetCatalogFull() {
    const storage = assetStorageManager.getStorage();
    if (storage.type !== 's3' || !assetStorageManager.s3Storage) {
        throw new Error('S3 storage is not active');
    }
    const sourceId = getAssetCatalogSourceId();
    if (!sourceId || !canUseAssetCatalog()) {
        throw new Error('SQL asset catalog is unavailable');
    }
    const fresh = await assetStorageManager.s3Storage.getAssetDetails();
    const count = await postgresStorage.replaceAssetCatalog(
        '',
        fresh.assets.map((asset) => ({ key: asset.key, size: asset.size })),
        sourceId
    );
    return { count, source: 'storage-sync' };
}

// Asset details for the storage explorer are catalog-only. An empty or
// uninitialized catalog is reported to the client so the user can explicitly
// approve the S3 listing required to populate it.
async function getCatalogedAssetDetails() {
    if (!assetStorageManager.s3Storage) return null;
    const sourceId = getAssetCatalogSourceId();
    if (!sourceId) return null;
    const config = assetStorageManager.s3Config || assetStorageManager.config || {};
    const initialized = await postgresStorage.isAssetCatalogInitialized(sourceId);
    let assets = [];
    if (initialized) {
        const rows = await postgresStorage.listAssetCatalogEntries('');
        assets = rows.map((row) => ({ key: row.key, size: row.size ?? 0, mtime: row.updatedAt ?? 0 }));
    }
    return {
        storageType: 's3',
        bucketName: config.bucket || '',
        endpoint: config.endpoint || 'AWS Standard',
        totalObjects: assets.length,
        totalSizeBytes: assets.reduce((sum, asset) => sum + (asset.size || 0), 0),
        assets,
        listSource: 'catalog',
        catalogEmpty: assets.length === 0
    };
}

// S3 remove() also deletes the derived thumbnail for every removed image, so
// catalog cleanup must account for those keys as well.
function deriveCatalogDeleteKeys(keys) {
    const result = [];
    for (const key of keys) {
        if (typeof key !== 'string' || key.length === 0) continue;
        result.push(key);
        if (!key.startsWith('thumbnails/')) {
            result.push(`thumbnails/${key}_128x128.webp`);
        }
    }
    return result;
}

async function upsertAssetCatalogEntries(entries) {
    const assetEntries = (Array.isArray(entries) ? entries : [])
        .filter((entry) => typeof entry?.key === 'string' && entry.key.length > 0);
    if (assetEntries.length === 0 || !canUseAssetCatalog() ||
        typeof postgresStorage.upsertAssetCatalog !== 'function') return;
    try {
        await postgresStorage.upsertAssetCatalog(assetEntries);
    } catch (error) {
        console.warn('[asset-catalog] Failed to record uploaded assets:', error?.message || error);
    }
}

async function upsertAssetCatalogKey(key, size = null) {
    await upsertAssetCatalogEntries([{ key, size }]);
}

async function removeAssetCatalogKeys(keys) {
    const assetKeys = (Array.isArray(keys) ? keys : [])
        .filter((key) => typeof key === 'string' && key.length > 0);
    if (assetKeys.length === 0 || !canUseAssetCatalog() ||
        typeof postgresStorage.removeAssetCatalog !== 'function') return;
    try {
        await postgresStorage.removeAssetCatalog(assetKeys);
    } catch (error) {
        console.warn('[asset-catalog] Failed to remove keys:', error?.message || error);
    }
}

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
    return value || '';
}

function normalizePostgresPoolMax(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new PostgresPayloadError('PostgreSQL pool size must be an integer from 1 to 100');
    }
    return parsed;
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
    if (postgresStorage.enabled && isPrimaryStorageReady()) {
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
        runtime: getPrimaryStorageRuntimeResponse(),
    };
}

async function hashJSON(json){
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

async function getAuthenticatedIndexScope(req) {
    const authHeader = normalizeAuthHeader(req.headers['risu-auth']);
    const parts = authHeader.split('.');
    if (parts.length !== 3) throw new TypeError('Invalid authentication token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (!payload?.pub) throw new TypeError('Authentication token has no public key');
    return await hashJSON(payload.pub);
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

app.get('/api/realtime/events', authenticatedRouteLimiter, requireNodeAuth, (req, res) => {
    realtimeEventHub.connect(req, res);
});

app.post('/api/realtime/generation-state', authenticatedRouteLimiter, requireNodeAuth, (req, res) => {
    const state = realtimeEventHub.updateGenerationState(
        req.body,
        req.headers['x-risu-client-id'],
    );
    if (!state) {
        res.status(400).send({ error: 'Invalid generation state payload' });
        return;
    }
    res.send({ success: true });
});

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
app.get('/hub-proxy/{*path}', authenticatedRouteLimiter, hubProxyFunc);

app.post('/proxy', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/proxy2', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/hub-proxy/{*path}', authenticatedRouteLimiter, hubProxyFunc);
modelJobManager.registerRoutes(app, {
    auth: checkProxyAuth,
    limiter: authenticatedRouteLimiter,
});
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

app.get('/api/health', (req, res) => {
    const runtime = getPrimaryStorageRuntimeResponse();
    const healthy = runtime.status === 'ready' || runtime.status === 'unconfigured';
    res.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        storage: runtime,
    });
});

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
const S3_BULK_UPLOAD_CONCURRENCY = Math.min(
    BULK_WRITE_MAX_OPEN_FILES,
    Math.max(1, parseInt(process.env.RISUAI_S3_BULK_UPLOAD_CONCURRENCY || '12', 10) || 12)
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

    let filePaths = req.body?.filePaths;
    const prefix = typeof req.body?.prefix === 'string'
        ? req.body.prefix.slice(0, 1024)
        : '';
    const isThumb = req.query.thumb === '1' || req.query.thumb === 'true' || req.body?.thumb === true || req.headers['x-thumbnail'] === 'true';
    const isDisplay = req.query.size === 'display' || req.body?.size === 'display';
    const reqWidth = parseInt(req.query.width || req.body?.width) || (isDisplay ? 512 : (isThumb ? 128 : undefined));
    const reqHeight = parseInt(req.query.height || req.body?.height) || (isDisplay ? 768 : (isThumb ? 128 : undefined));
    const useThumb = isThumb || isDisplay || Boolean(reqWidth && reqHeight);
    const thumbOptions = useThumb ? { width: reqWidth, height: reqHeight } : undefined;

    if (!Array.isArray(filePaths) && !prefix) {
        res.status(400).send({
            error: "filePaths isn't an array and prefix is missing."
        });
        return;
    }
    const storage = assetStorageManager.getStorage();
    if (prefix) {
        const resolved = prefix === 'assets/' && storage.type === 's3'
            ? await resolveCatalogedAssetKeys(storage, prefix)
            : { keys: await storage.list(prefix), source: 'storage' };
        const keys = resolved.keys;
        res.setHeader('x-risu-asset-list-source', resolved.source);
        filePaths = keys
            .filter((key) => typeof key === 'string' && key.startsWith(prefix))
            .map((key) => Buffer.from(key, 'utf8').toString('hex'));
    }
    res.setHeader('x-risu-total-files', String(filePaths.length));
    res.setHeader('Access-Control-Expose-Headers', 'x-risu-total-files, x-risu-asset-list-source');
    let fileId = 0;
    for (const filePath of filePaths) {
        if (!isHex(filePath)) continue;
        try {
            const result = useThumb && typeof storage.readThumbnail === 'function'
                ? await storage.readThumbnail(filePath, thumbOptions)
                : typeof storage.openReadStream === 'function'
                    ? await storage.openReadStream(filePath)
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

function normalizeCharxEntryName(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
        throw new Error('Invalid CharX entry name');
    }
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid CharX entry path: ${value}`);
    }
    return parts.join('/');
}

const charxExportJobs = new Map();
const CHARX_EXPORT_JOB_TTL_MS = 60 * 1000;
const CHARX_EXPORT_MAX_JOBS = 8;

function pruneCharxExportJobs() {
    const now = Date.now();
    for (const [id, job] of charxExportJobs) {
        if (job.expiresAt <= now) charxExportJobs.delete(id);
    }
}

app.post('/api/charx-export/jobs', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneCharxExportJobs();
    if (charxExportJobs.size >= CHARX_EXPORT_MAX_JOBS) {
        res.status(429).send({ error: 'Too many pending CharX exports' });
        return;
    }
    if (!Array.isArray(req.body?.entries) || req.body.entries.length === 0) {
        res.status(400).send({ error: 'Invalid CharX export manifest' });
        return;
    }
    try {
        let inlineCharacters = 0;
        for (const entry of req.body.entries) {
            normalizeCharxEntryName(entry?.name);
            if (typeof entry?.source === 'string') {
                const source = entry.source.replace(/\\/g, '/');
                if (!source.startsWith('assets/') || source.includes('\0') || source.split('/').includes('..')) {
                    throw new Error(`Invalid CharX asset source: ${entry.source}`);
                }
            } else if (typeof entry?.dataBase64 === 'string') {
                inlineCharacters += entry.dataBase64.length;
            } else {
                throw new Error(`CharX entry has no source or inline data: ${entry?.name}`);
            }
        }
        if (req.body.previewSource !== undefined) {
            const previewSource = req.body.previewSource?.replace?.(/\\/g, '/');
            if (typeof previewSource !== 'string' || !previewSource.startsWith('assets/') || previewSource.includes('\0') || previewSource.split('/').includes('..')) {
                throw new Error(`Invalid CharX JPEG preview source: ${req.body.previewSource}`);
            }
        }
        if (inlineCharacters > 44 * 1024 * 1024) {
            throw new Error('CharX inline metadata exceeds 32MB');
        }
    } catch (error) {
        res.status(400).send({ error: error.message });
        return;
    }
    const id = crypto.randomBytes(24).toString('base64url');
    let resolveCompletion;
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });
    charxExportJobs.set(id, {
        body: req.body,
        status: 'pending',
        error: null,
        completion,
        resolveCompletion,
        expiresAt: Date.now() + CHARX_EXPORT_JOB_TTL_MS,
    });
    res.send({ id, expiresInMs: CHARX_EXPORT_JOB_TTL_MS });
});

app.get('/api/charx-export/jobs/:jobId', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneCharxExportJobs();
    const job = charxExportJobs.get(req.params.jobId);
    if (!job) {
        res.status(404).send({ error: 'CharX export job not found or expired' });
        return;
    }
    if (job.status === 'pending' || job.status === 'streaming') {
        await job.completion;
    }
    res.send({ status: job.status, error: job.error });
    if (job.status === 'complete' || job.status === 'error') {
        charxExportJobs.delete(req.params.jobId);
    }
});

app.get('/api/charx-export/:jobId', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneCharxExportJobs();
    const job = charxExportJobs.get(req.params.jobId);
    if (!job) {
        res.status(404).send({ error: 'CharX export job not found or expired' });
        return;
    }
    if (job.status !== 'pending') {
        res.status(409).send({ error: 'CharX export download was already started' });
        return;
    }
    job.status = 'streaming';
    job.expiresAt = Number.POSITIVE_INFINITY;
    req.body = job.body;
    req.charxExportJob = job;
    const completed = await handleCharxExport(req, res);
    job.status = completed ? 'complete' : 'error';
    job.error ??= completed ? null : 'CharX download failed';
    job.body = null;
    job.expiresAt = Date.now() + CHARX_EXPORT_JOB_TTL_MS;
    job.resolveCompletion();
    job.resolveCompletion = null;
});

async function handleCharxExport(req, res) {
    if (!await checkAuth(req, res)) return false;

    try {
        const requestedEntries = req.body?.entries;
        if (!Array.isArray(requestedEntries) || requestedEntries.length === 0) {
            res.status(400).send({ error: 'CharX entries must contain at least one file' });
            return false;
        }

        const seenNames = new Set();
        let inlineBytes = 0;
        const storage = assetStorageManager.getStorage();
        const entries = requestedEntries.map((entry) => {
            const name = normalizeCharxEntryName(entry?.name);
            if (seenNames.has(name)) throw new Error(`Duplicate CharX entry: ${name}`);
            seenNames.add(name);

            if (typeof entry?.source === 'string') {
                const source = entry.source.replace(/\\/g, '/');
                if (!source.startsWith('assets/') || source.includes('\0') || source.split('/').includes('..')) {
                    throw new Error(`Invalid CharX asset source: ${entry.source}`);
                }
                return {
                    name,
                    open: async () => {
                        const result = typeof storage.openReadStream === 'function'
                            ? await storage.openReadStream(keyToHex(source))
                            : await storage.read(keyToHex(source));
                        if (!result.exists) throw new Error(`CharX asset not found: ${source}`);
                        const body = result.stream ?? result.buffer;
                        if (!body) throw new Error(`CharX asset is not readable: ${source}`);
                        const size = Number(result.contentLength ?? result.buffer?.length);
                        if (!Number.isSafeInteger(size) || size < 0) {
                            throw new Error(`CharX asset size is unavailable: ${source}`);
                        }
                        return { source: body, size };
                    }
                };
            }

            if (typeof entry?.dataBase64 !== 'string') {
                throw new Error(`CharX entry has no source or inline data: ${name}`);
            }
            const data = Buffer.from(entry.dataBase64, 'base64');
            inlineBytes += data.length;
            if (inlineBytes > 32 * 1024 * 1024) {
                throw new Error('CharX inline metadata exceeds 32MB');
            }
            return { name, size: data.length, source: data };
        });

        const isJpeg = req.body?.previewSource !== undefined;
        const requestedName = typeof req.body?.filename === 'string' ? req.body.filename : 'character.charx';
        const safeName = path.basename(requestedName).replace(/[\r\n"\\]/g, '_').slice(0, 200) || 'character.charx';
        const downloadName = isJpeg
            ? (/\.jpe?g$/i.test(safeName) ? safeName : `${safeName}.jpeg`)
            : (safeName.endsWith('.charx') ? safeName : `${safeName}.charx`);
        const asciiDownloadName = downloadName.replace(/[^\x20-\x7e]/g, '_');
        res.status(200);
        res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${asciiDownloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        let prefixSize = 0;
        if (req.body?.previewSource !== undefined) {
            const previewSource = req.body.previewSource?.replace?.(/\\/g, '/');
            if (typeof previewSource !== 'string' || !previewSource.startsWith('assets/') || previewSource.includes('\0') || previewSource.split('/').includes('..')) {
                throw new Error(`Invalid CharX JPEG preview source: ${req.body.previewSource}`);
            }
            const preview = typeof storage.openReadStream === 'function'
                ? await storage.openReadStream(keyToHex(previewSource))
                : await storage.read(keyToHex(previewSource));
            if (!preview.exists) throw new Error(`CharX JPEG preview not found: ${previewSource}`);
            const previewBody = preview.stream ?? preview.buffer;
            if (!previewBody) throw new Error(`CharX JPEG preview is not readable: ${previewSource}`);
            const { Readable } = require('stream');
            const sharp = require('sharp');
            const input = Buffer.isBuffer(previewBody) || previewBody instanceof Uint8Array
                ? Readable.from([previewBody])
                : Readable.from(previewBody);
            const jpegStream = input.pipe(sharp().jpeg({ quality: 85 }));
            for await (const chunk of jpegStream) {
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (!res.write(data)) await once(res, 'drain');
                prefixSize += data.length;
            }
        }

        await streamZip(res, entries, { initialOffset: prefixSize });
        await new Promise((resolve, reject) => {
            res.once('finish', resolve);
            res.once('error', reject);
            res.end();
        });
        return true;
    } catch (error) {
        if (req.charxExportJob) req.charxExportJob.error = error.message;
        if (!res.headersSent) {
            res.status(400).send({ error: error.message });
            return false;
        }
        console.error('[CharX export] Streaming failed:', error);
        res.destroy(error);
        return false;
    }
}

app.post('/api/charx-export', authenticatedRouteLimiter, handleCharxExport);

const localBackupJobs = new Map();
const LOCAL_BACKUP_JOB_TTL_MS = 60 * 1000;

function pruneLocalBackupJobs() {
    const now = Date.now();
    for (const [id, job] of localBackupJobs) {
        if (job.expiresAt <= now) localBackupJobs.delete(id);
    }
}

function settleLocalBackupJob(job, status, error = null) {
    job.status = status;
    job.error = error;
    job.expiresAt = Date.now() + LOCAL_BACKUP_JOB_TTL_MS;
    job.resolveCompletion?.();
    job.resolveCompletion = null;
}

async function writeLocalBackupHeader(output, name, size) {
    await writePacket(output, createLocalBackupEntryHeader(name, size));
}

async function writeLocalBackupEntry(output, name, source, size) {
    await writeLocalBackupHeader(output, name, size);
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        await writePacket(output, source);
        return;
    }
    for await (const chunk of source) {
        await writePacket(output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
}

async function buildPortableServerDatabase() {
    if (!postgresStorage.enabled) throw new Error('SQL storage is not configured');
    const loaded = await postgresStorage.loadDatabase({ shallow: false });
    if (!loaded?.database) throw new Error('Database is not initialized');
    const database = loaded.database;
    const summaries = (await postgresStorage.listBotPresets()).presets;
    const loadedPresets = (await Promise.all(summaries.map((summary) => postgresStorage.loadBotPreset(summary.id))))
        .filter(Boolean);
    database.botPresets = loadedPresets.map((result) => {
        const { id: _id, ...preset } = result.preset;
        return preset;
    });
    const activeId = database.activeBotPresetId;
    database.botPresetsId = Math.max(0, summaries.findIndex((summary) => summary.id === activeId));
    return database;
}

async function encodePortableServerDatabase(database, mode = 'native', coldStorageValues = new Map()) {
    const portable = mode === 'compatible'
        ? makeLegacyCompatibleBackupDatabase(database, coldStorageValues)
        : database;
    return await encodeLocalBackupDatabase(portable);
}

async function streamServerLocalBackup(res, mode = 'native') {
    const database = await buildPortableServerDatabase();
    const coldItems = typeof postgresStorage.listColdStorage === 'function'
        ? await postgresStorage.listColdStorage()
        : [];
    const loadedColdItems = [];
    const coldStorageValues = new Map();
    for (const summary of coldItems) {
        const loaded = await postgresStorage.loadColdStorage(summary.key);
        if (!loaded) continue;
        loadedColdItems.push({ key: summary.key, data: loaded.data });
        coldStorageValues.set(summary.key, loaded.data);
    }
    const databaseData = await encodePortableServerDatabase(database, mode, coldStorageValues);
    const storage = assetStorageManager.getStorage();
    const resolved = storage.type === 's3'
        ? await resolveCatalogedAssetKeys(storage, 'assets/')
        : { keys: await storage.list('assets/') };
    const assetKeys = resolved.keys.filter((key) => typeof key === 'string' && key.startsWith('assets/'));
    const inlayKeys = mode === 'native'
        ? (await storage.list('inlay_')).filter((key) =>
            typeof key === 'string' && /^inlay_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.risuinlay$/.test(key))
        : [];

    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    const dateStr = new Date().toISOString().slice(0, 10);
    const backupName = mode === 'compatible'
        ? `risu_compatible_backup_${dateStr}.risubackup`
        : `haejeokrisu_backup_${dateStr}.risubackup`;
    res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    for (const key of [...assetKeys, ...inlayKeys]) {
        const opened = typeof storage.openReadStream === 'function'
            ? await storage.openReadStream(keyToHex(key))
            : await storage.read(keyToHex(key));
        if (!opened.exists) continue;
        const source = opened.stream ?? opened.buffer;
        const size = Number(opened.contentLength ?? opened.buffer?.length);
        if (!source || !Number.isSafeInteger(size)) throw new Error(`Backup asset is not streamable: ${key}`);
        await writeLocalBackupEntry(res, key, source, size);
    }
    for (const item of loadedColdItems) {
        const data = Buffer.from(JSON.stringify(item.data), 'utf8');
        await writeLocalBackupEntry(res, `coldstorage_${item.key}.json`, data, data.length);
    }
    await writeLocalBackupEntry(res, 'database.risudat', databaseData, databaseData.length);
    await new Promise((resolve, reject) => {
        res.once('finish', resolve);
        res.once('error', reject);
        res.end();
    });
}

app.post('/api/local-backup/export/jobs', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneLocalBackupJobs();
    const mode = req.query.mode === 'compatible' ? 'compatible' : 'native';
    const id = crypto.randomBytes(24).toString('base64url');
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    localBackupJobs.set(id, {
        status: 'pending', error: null, completion, resolveCompletion, mode,
        expiresAt: Date.now() + LOCAL_BACKUP_JOB_TTL_MS,
    });
    res.send({ id });
});

app.get('/api/local-backup/export/jobs/:jobId', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneLocalBackupJobs();
    const job = localBackupJobs.get(req.params.jobId);
    if (!job) return res.status(404).send({ error: 'Local backup job not found or expired' });
    if (job.status === 'pending' || job.status === 'streaming') await job.completion;
    res.send({ status: job.status, error: job.error });
    localBackupJobs.delete(req.params.jobId);
});

app.get('/api/local-backup/export/:jobId', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    pruneLocalBackupJobs();
    const job = localBackupJobs.get(req.params.jobId);
    if (!job) return res.status(404).send({ error: 'Local backup job not found or expired' });
    if (job.status !== 'pending') return res.status(409).send({ error: 'Local backup download was already started' });
    job.status = 'streaming';
    job.expiresAt = Number.POSITIVE_INFINITY;
    try {
        await streamServerLocalBackup(res, job.mode || 'native');
        settleLocalBackupJob(job, 'complete');
    } catch (error) {
        console.error('[Local backup] Streaming export failed:', error);
        if (!res.headersSent) res.status(500).send({ error: error.message });
        else res.destroy(error);
        settleLocalBackupJob(job, 'error', error.message);
    }
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
    const completedCatalogEntries = [];
    const pendingFinalizations = new Set();
    let finalizationError = null;

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

                    // Backup/CharX bulk restores should not regenerate a thumbnail for
                    // every image. Required bot icons are generated lazily on first read.
                    const writer = storage.createWriteStream(encodedName, { generateThumbnail: false });
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
                    const finalize = file.writer.done()
                        .then(() => {
                            completedCatalogEntries.push({ key: file.name, size: Number(file.expectedSize) });
                        })
                        .catch((error) => {
                            finalizationError ??= error;
                        })
                        .finally(() => {
                            pendingFinalizations.delete(finalize);
                        });
                    pendingFinalizations.add(finalize);
                    if (storage.type !== 's3') {
                        await finalize;
                    } else if (pendingFinalizations.size >= S3_BULK_UPLOAD_CONCURRENCY) {
                        await Promise.race(pendingFinalizations);
                    }
                    if (finalizationError) throw finalizationError;
                    continue;
                }

                throw createBulkProtocolError(`Unknown bulk packet type: ${type}`);
            }

            pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
        }

        if (pending.length !== 0 || activeChunk || receivingFiles.size !== 0) {
            throw createBulkProtocolError('Bulk write request ended with an incomplete packet');
        }

        await Promise.all(pendingFinalizations);
        if (finalizationError) throw finalizationError;

        await upsertAssetCatalogEntries(completedCatalogEntries);
        res.send({ success: true, written: fileCount });
    } catch (error) {
        const inFlightFiles = [...receivingFiles.values()].map((file) => file.name);
        console.error(
            `[Server] write-bulk failed${inFlightFiles.length ? ` (in flight: ${inFlightFiles.join(', ')})` : ''}:`,
            error?.stack || error
        );
        await cleanup();
        await Promise.all(pendingFinalizations);
        if (error?.statusCode) {
            res.status(error.statusCode).send({ error: error.message });
            return;
        }
        next(error);
    }
});

async function replacePrimaryStorageConfiguration(vendor, params, { migrate = false } = {}) {
    if (!SUPPORTED_VENDORS.includes(vendor)) {
        throw new StoragePayloadError(`Unsupported vendor: ${vendor}`);
    }
    const normalized = normalizeVendorParams(vendor, params);
    if (!isVendorConfigComplete(vendor, normalized)) {
        throw new StoragePayloadError('Required connection parameters are missing');
    }

    // 후보 연결을 먼저 완전히 검증한다. 성공하기 전에는 현재 설정과
    // 현재 storage를 건드리지 않아 SQL 단일 진실성을 유지한다.
    const candidateStorage = instantiateVendorStorage(vendor, normalized, {
        poolMax: normalized.poolMax || 10,
    });
    const candidateInitPromise = Promise.resolve().then(() => candidateStorage.initialize());
    try {
        await runStartupStage({
            scope: 'Database recovery',
            operation: `validate replacement ${vendor} storage`,
            detail: describeStorageTarget(vendor, candidateStorage),
            timeoutMs: storageStartupSettings.startupTimeoutMs,
            heartbeatMs: storageStartupSettings.heartbeatMs,
        }, () => candidateInitPromise);
    } catch (error) {
        void candidateInitPromise.finally(() => candidateStorage.close?.()).catch(() => {});
        throw error;
    }

    const previousStored = readStoredDbConfig(savePath);
    const previousPostgresConfig = { ...postgresServerConfig };
    try {
        writeStoredDbConfig(savePath, {
            vendor,
            enabled: true,
            poolMax: normalized.poolMax || 10,
            params: normalized,
            backup: previousStored.backup,
        });
        if (vendor === 'postgres') {
            postgresServerConfig = {
                enabled: true,
                connectionString: normalized.connectionString,
                poolMax: normalized.poolMax || 10,
            };
            await persistPostgresServerConfig(postgresServerConfig);
        }
    } catch (persistError) {
        writeStoredDbConfig(savePath, previousStored);
        postgresServerConfig = previousPostgresConfig;
        await candidateStorage.close?.().catch(() => {});
        throw persistError;
    }

    const previousStorage = postgresStorage;
    postgresStorage = candidateStorage;
    dbVendor = vendor;
    storageManagedByEnvironment = isStorageManagedByEnvironment(dbVendor);
    setPrimaryStorageRuntime('ready');
    if (typeof previousStorage.close === 'function') {
        try { await previousStorage.close(); } catch (error) {
            console.warn('[db-config] Previous storage close failed:', sanitizeSensitiveText(error?.message || error));
        }
    }

    // database.bin 가져오기는 사용자가 명시적으로 요청한 경우에만 수행한다.
    if (migrate && postgresStorage.enabled) {
        try {
            await postgresStorage.migrateLegacyColdStorage(savePath);
        } catch (error) {
            console.warn('[db-config] Explicit legacy migration failed:', sanitizeSensitiveText(error?.message || error));
        }
    }

    const response = getDbConfigResponse();
    try {
        const state = await postgresStorage.getState();
        response.revision = state.revision;
        response.initialized = state.initialized;
    } catch {}
    return response;
}

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
    if (storageManagedByEnvironment) {
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

    try {
        if (typeof req.body?.enabled !== 'boolean') {
            throw new PostgresPayloadError('enabled must be a boolean');
        }
        if (!req.body.enabled) {
            res.status(400).send({
                error: 'SQL storage cannot be disabled because it is the application source of truth',
                code: 'storage_disable_not_supported',
            });
            return;
        }
        const connectionString = typeof req.body.connectionString === 'string' && req.body.connectionString.trim()
            ? req.body.connectionString.trim()
            : postgresServerConfig.connectionString;
        const poolMax = normalizePostgresPoolMax(req.body.poolMax ?? postgresServerConfig.poolMax);
        validatePostgresConnectionString(connectionString);
        await replacePrimaryStorageConfiguration('postgres', { connectionString, poolMax });
        res.send({ success: true, ...await getPostgresConfigResponse() });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_postgres_configuration' });
            return;
        }
        const failure = createPrimaryStorageFailure(error);
        res.status(502).send({
            error: failure.message,
            code: 'storage_connection_failed',
            failure,
            runtime: getPrimaryStorageRuntimeResponse(),
        });
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
    const effectiveVendor = stored.vendor || dbVendor;
    if (effectiveVendor === 'postgres') {
        const connectionString = params.connectionString || postgresServerConfig.connectionString || postgresStorage.connectionString || '';
        maskedParams.connectionString = maskPostgresConnectionString(connectionString);
        maskedParams.poolMax = params.poolMax || postgresServerConfig.poolMax || postgresStorage.poolMax || 10;
    } else if (effectiveVendor === 'oracle') {
        maskedParams.user = params.user || '';
        maskedParams.tnsAlias = params.tnsAlias || '';
        maskedParams.walletPath = params.walletPath || '';
        maskedParams.poolMax = params.poolMax || 10;
        // password/walletPassword는 마스킹
        maskedParams.hasPassword = Boolean(params.password);
        maskedParams.hasWalletPassword = Boolean(params.walletPassword);
    } else if (effectiveVendor === 'azure') {
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
        runtime: getPrimaryStorageRuntimeResponse(),
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
        res.send({ success: false, error: sanitizeSensitiveText(error.message || String(error)) });
    }
});

app.post('/api/db-config/retry', authenticatedRouteLimiter, async (req, res) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(409).send({
            error: 'SQL storage is not configured',
            code: 'storage_unconfigured',
            runtime: getPrimaryStorageRuntimeResponse(),
        });
        return;
    }
    try {
        await initializePrimaryStorage(postgresStorage, dbVendor, `retry ${dbVendor} storage connection`);
        const response = getDbConfigResponse();
        try {
            const state = await postgresStorage.getState();
            response.revision = state.revision;
            response.initialized = state.initialized;
        } catch {}
        res.send({ success: true, ...response });
    } catch (error) {
        res.status(503).send({
            error: sanitizeSensitiveText(error?.message || error),
            code: 'storage_connection_failed',
            runtime: getPrimaryStorageRuntimeResponse(),
        });
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
        const response = await replacePrimaryStorageConfiguration(
            req.body?.vendor,
            req.body?.params || {},
            { migrate: req.body?.migrate === true },
        );
        res.send({ success: true, ...response });
    } catch (error) {
        if (error instanceof StoragePayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_db_configuration' });
            return;
        }
        const failure = createPrimaryStorageFailure(error);
        res.status(502).send({
            error: failure.message,
            code: 'storage_connection_failed',
            failure,
            runtime: getPrimaryStorageRuntimeResponse(),
        });
    }
});

app.use('/api/database-v2', (req, res, next) => {
    if (isPrimaryStorageReady()) {
        next();
        return;
    }
    res.status(503).send({
        error: 'SQL storage is unavailable; restore the configured database connection before using application data.',
        code: 'storage_unavailable',
        runtime: getPrimaryStorageRuntimeResponse(),
    });
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

app.post('/api/db-backup/restore', authenticatedRouteLimiter, async (req, res, next) => {
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

        const result = await enqueueBackupWrite(() => restoreBackupToMainDatabase(sendProgress), 'full');

        res.write(JSON.stringify({
            type: 'done',
            success: true,
            ...(result || {}),
        }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).send({
                success: false,
                error: error?.message || 'Backup restore to main failed',
                code: 'backup_restore_failed',
            });
        } else {
            res.write(JSON.stringify({
                type: 'error',
                error: error?.message || 'Backup restore to main failed',
                code: 'backup_restore_failed',
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

nodeChatExecutor.registerRoutes(app, {
    auth: checkAuth,
    limiter: authenticatedRouteLimiter,
});
nodeProviderExecutor.registerRoutes(app, {
    auth: checkAuth,
    limiter: authenticatedRouteLimiter,
});
hypaMemoryExecutor.registerRoutes(app, {
    auth: checkAuth,
    limiter: authenticatedRouteLimiter,
    getScope: getAuthenticatedIndexScope,
});

app.post('/api/tokenize-count', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        const counts = countTokensBatch(req.body?.texts, req.body?.encoding);
        res.send({ counts });
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
            res.status(400).send({ error: error.message });
            return;
        }
        next(error);
    }
});

app.post('/api/lore-match-batch', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        const requests = Array.isArray(req.body?.requests) ? req.body.requests : [];
        if (messages.length > 10000) {
            res.status(400).send({ error: 'Too many lore scan messages' });
            return;
        }
        const results = matchLoreBatch(messages, requests, {
            username: req.body?.username,
            charName: req.body?.charName,
        });
        res.send({ results });
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
            res.status(400).send({ error: error.message });
            return;
        }
        next(error);
    }
});


app.post('/api/lore-resolve', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        const result = resolveLoreEntries(req.body?.messages, req.body?.entries, {
            username: req.body?.username,
            charName: req.body?.charName,
        });
        res.send(result);
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
            res.status(400).send({ error: error.message });
            return;
        }
        next(error);
    }
});

app.post('/api/vector-index/status', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const scope = await getAuthenticatedIndexScope(req);
        const scopedIndexId = `${scope}:${req.body?.indexId}`;
        if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'descriptors')) {
            res.send(checkVectorIndexRevision(scopedIndexId, req.body?.revision));
            return;
        }
        res.send(syncVectorIndex(
            scopedIndexId,
            req.body?.descriptors,
            req.body?.revision ?? null,
        ));
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return res.status(400).send({ error: error.message });
        next(error);
    }
});

app.post('/api/vector-index/upsert', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const scope = await getAuthenticatedIndexScope(req);
        res.send(upsertVectorIndex(`${scope}:${req.body?.indexId}`, req.body?.entries));
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return res.status(400).send({ error: error.message });
        next(error);
    }
});

app.post('/api/vector-index/search', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const scope = await getAuthenticatedIndexScope(req);
        const results = searchVectorIndex(
            `${scope}:${req.body?.indexId}`,
            req.body?.queries,
            req.body?.metric,
            req.body?.topK ?? null,
        );
        if (results === null) return res.status(404).send({ error: 'Vector index not found', code: 'vector_index_missing' });
        res.send({ results });
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return res.status(400).send({ error: error.message });
        next(error);
    }
});

app.get('/api/vector-index/cache', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const scope = await getAuthenticatedIndexScope(req);
        res.send({
            vector: await getVectorIndexCacheStats(`${scope}:`),
            query: hypaMemoryExecutor.getQueryCacheStats(scope),
        });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/vector-index/cache', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const scope = await getAuthenticatedIndexScope(req);
        res.send({
            vector: await clearVectorIndexCache(`${scope}:`),
            query: hypaMemoryExecutor.clearQueryCache(scope),
        });
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

app.get('/api/database-v2/presets', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        const result = await postgresStorage.listBotPresets();
        const etag = `"risu-presets-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Server-Timing', `sql;dur=${result.queryMs.toFixed(1)}, serialize;desc="streamed"`);
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end();
            return;
        }
        await sendCompressedJson(req, res, { presets: result.presets, hash: result.hash });
    } catch (error) {
        next(error);
    }
});

app.get('/api/database-v2/presets/:id', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
        res.status(400).send({ error: 'Invalid preset ID', code: 'invalid_preset_id' });
        return;
    }
    try {
        const result = await postgresStorage.loadBotPreset(req.params.id);
        if (!result) {
            res.status(404).send({ error: 'Preset not found', code: 'preset_not_found' });
            return;
        }
        const etag = `"risu-preset-${req.params.id}-${result.hash}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Server-Timing', `sql;dur=${result.queryMs.toFixed(1)}, serialize;desc="streamed"`);
        const requestEtag = normalizeAuthHeader(req.headers['if-none-match']);
        if (requestEtag.split(',').map((v) => v.trim()).includes(etag)) {
            res.status(304).end(); return;
        }
        await sendCompressedJson(req, res, { preset: result.preset, hash: result.hash });
    } catch (error) { next(error); }
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
        if (req.query.messageLimit !== undefined) {
            const page = paginateMessages(chat.message, {
                limit: normalizePageInteger(req.query.messageLimit, undefined),
            });
            chat.message = page.messages;
            chat.messageOffset = page.offset;
            chat.messageTotal = page.total;
            chat.messagesFullyLoaded = !page.hasMore;
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
        const messages = await postgresStorage.loadChatMessages(req.params.chatId, {
            mode: req.query.mode === 'generation' ? 'generation' : 'full',
        });
        if (req.query.limit !== undefined || req.query.before !== undefined) {
            const page = paginateMessages(messages, {
                before: normalizePageInteger(req.query.before, undefined),
                limit: normalizePageInteger(req.query.limit, undefined),
            });
            await sendCompressedJson(req, res, page);
            return;
        }
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

app.get('/api/database-v2/revisions/diff', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        if (typeof postgresStorage.getRevisionDiff !== 'function') {
            res.status(501).send({ error: 'Revision diff is not supported by current storage engine' });
            return;
        }
        const diff = await postgresStorage.getRevisionDiff(req.query.base, req.query.target);
        res.send({ diff });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_revision_diff' });
            return;
        }
        next(error);
    }
});

app.get('/api/database-v2/revisions/:id/details', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    try {
        if (typeof postgresStorage.getRevisionDetails !== 'function') {
            res.status(501).send({ error: 'Revision details are not supported by current storage engine' });
            return;
        }
        const details = await postgresStorage.getRevisionDetails(req.params.id);
        if (!details) {
            res.status(404).send({ error: 'Revision not found', code: 'revision_not_found' });
            return;
        }
        res.send({ details });
    } catch (error) {
        if (error instanceof PostgresPayloadError) {
            res.status(400).send({ error: error.message, code: 'invalid_revision_details' });
            return;
        }
        next(error);
    }
});

app.post(
    '/api/database-v2/revisions/preview-restore',
    authenticatedRouteLimiter,
    async (req, res, next) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            if (typeof postgresStorage.previewRestore !== 'function') {
                res.status(501).send({ error: 'Restore preview is not supported by current storage engine' });
                return;
            }
            const preview = await postgresStorage.previewRestore(req.body?.revisionId);
            res.send({ preview });
        } catch (error) {
            if (error instanceof PostgresPayloadError) {
                res.status(400).send({ error: error.message, code: 'invalid_preview_restore' });
                return;
            }
            next(error);
        }
    }
);

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
            realtimeEventHub.broadcast('database-change', {
                revision: result.revision,
                action: req.body?.action || 'sync',
                sourceClientId: normalizeClientId(req.headers['x-risu-client-id']),
                ...describeSqlCommitChange(req.body),
            });
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

// ── Direct SQL Mutation Endpoints (Domain Architecture) ──

app.put(
    '/api/db/settings/:key',
    authenticatedRouteLimiter,
    requireNodeAuth,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.updateSetting(req.params.key, req.body.value);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.delete(
    '/api/db/settings/:key',
    authenticatedRouteLimiter,
    requireNodeAuth,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.deleteSetting(req.params.key);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.post(
    '/api/db/bot-presets',
    authenticatedRouteLimiter,
    requireNodeAuth,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.saveBotPreset(req.body.preset, req.body.position);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.post(
    '/api/db/modules',
    authenticatedRouteLimiter,
    requireNodeAuth,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.saveModule(req.body.module);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.delete(
    '/api/db/modules/:id',
    authenticatedRouteLimiter,
    requireNodeAuth,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.deleteModule(req.params.id);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.post(
    '/api/db/chats/:chatId/messages',
    authenticatedRouteLimiter,
    requireNodeAuth,
    postgresJsonParser,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.saveMessage(req.params.chatId, req.body.message);
            res.send(result);
        } catch (error) {
            next(error);
        }
    }
);

app.delete(
    '/api/db/chats/:chatId/messages/:messageId',
    authenticatedRouteLimiter,
    requireNodeAuth,
    async (req, res, next) => {
        if (!postgresStorage.enabled) {
            res.status(404).send({ error: 'PostgreSQL storage is not configured', code: 'postgres_disabled' });
            return;
        }
        try {
            const result = await postgresStorage.deleteMessage(req.params.chatId, req.params.messageId);
            res.send(result);
        } catch (error) {
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

app.get('/api/database-v2/bot-stats', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    if (!postgresStorage.enabled) {
        res.status(404).send({ error: 'SQL storage is not configured', code: 'postgres_disabled' });
        return;
    }
    if (typeof postgresStorage.getBotChatStats !== 'function') {
        res.send({ stats: [] });
        return;
    }

    try {
        await sendCompressedJson(req, res, { stats: await postgresStorage.getBotChatStats() });
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



app.get('/api/storage-summary', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        // Never list S3 just to render the explorer summary. S3 statistics are
        // populated exclusively from the SQL catalog below.
        const summary = await assetStorageManager.getSummary({ skipS3Stats: true });
        if (summary.s3 && canUseAssetCatalog()) {
            try {
                const sourceId = getAssetCatalogSourceId();
                if (sourceId && await postgresStorage.isAssetCatalogInitialized(sourceId)) {
                    const stats = await postgresStorage.getAssetCatalogStats();
                    summary.s3 = {
                        ...summary.s3,
                        totalObjects: stats.totalObjects,
                        totalSizeBytes: stats.totalSizeBytes,
                        listSource: 'catalog'
                    };
                }
            } catch (error) {
                console.warn('[asset-catalog] SQL catalog stats unavailable; keeping S3 stats:', error?.message || error);
            }
        }
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
        const effectiveType = target === 'active'
            ? assetStorageManager.getStorage().type
            : target;
        if (effectiveType === 's3') {
            if (!canUseAssetCatalog()) {
                res.status(503).send({
                    error: 'SQL asset catalog is unavailable',
                    code: 'asset_catalog_unavailable'
                });
                return;
            }
            try {
                const details = await getCatalogedAssetDetails();
                if (details) {
                    res.send(details);
                    return;
                }
            } catch (error) {
                next(error);
                return;
            }
            res.status(503).send({
                error: 'SQL asset catalog is unavailable',
                code: 'asset_catalog_unavailable'
            });
            return;
        }
        const details = await assetStorageManager.getAssetDetails(target);
        res.send({ ...details, listSource: details.listSource || 'storage' });
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
        if (target === 's3' || (target === 'active' && assetStorageManager.getStorage().type === 's3')) {
            await removeAssetCatalogKeys(deriveCatalogDeleteKeys(keys));
        }
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

        if (assetStorageManager.getStorage().type === 's3' && canUseAssetCatalog()) {
            await resyncAssetCatalogFull().catch((error) => {
                console.warn('[asset-catalog] Post-migration catalog resync failed:', error?.message || error);
            });
        }

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
    const isDisplay = req.query.size === 'display';
    const reqWidth = parseInt(req.query.width) || (isDisplay ? 512 : (isThumb ? 128 : undefined));
    const reqHeight = parseInt(req.query.height) || (isDisplay ? 768 : (isThumb ? 128 : undefined));
    const useThumb = isThumb || isDisplay || Boolean(reqWidth && reqHeight);
    const thumbOptions = useThumb ? { width: reqWidth, height: reqHeight } : undefined;
    const target = req.query.target || req.headers['x-storage-target'] || 'active';
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
        let storage;
        if (target && target !== 'active') {
            storage = assetStorageManager.getStorageByType(target);
            if (!storage) {
                res.status(400).send({ error: `Unknown or unavailable storage target: ${target}` });
                return;
            }
        } else {
            storage = assetStorageManager.getStorage();
        }
        const result = useThumb && typeof storage.readThumbnail === 'function'
            ? await storage.readThumbnail(filePath, thumbOptions)
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
        await removeAssetCatalogKeys(
            deriveCatalogDeleteKeys(
                filePaths.map((filePath) => Buffer.from(filePath, 'hex').toString('utf8'))
            )
        );
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
        const prefix = typeof req.query.prefix === 'string'
            ? req.query.prefix.slice(0, 1024)
            : '';
        const resolved = prefix === 'assets/' && storage.type === 's3'
            ? await resolveCatalogedAssetKeys(storage, prefix)
            : { keys: await storage.list(prefix), source: 'storage' };
        const listed = resolved.keys;
        // Keep filtering here as a compatibility guard for custom storage
        // implementations that have not added prefix-aware listing yet.
        const content = prefix
            ? listed.filter((key) => typeof key === 'string' && key.startsWith(prefix))
            : listed;
        res.send({
            success: true,
            content,
            source: resolved.source,
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/asset-catalog/resync', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    const storage = assetStorageManager.getStorage();
    if (storage.type !== 's3') {
        res.status(400).send({ error: 'S3 storage is not active', code: 's3_not_active' });
        return;
    }
    if (!canUseAssetCatalog()) {
        res.status(400).send({ error: 'SQL asset catalog is unavailable', code: 'asset_catalog_unavailable' });
        return;
    }
    try {
        const result = await resyncAssetCatalogFull();
        res.send({ success: true, count: result.count, source: result.source });
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
        await upsertAssetCatalogKey(Buffer.from(filePath, 'hex').toString('utf8'), received);
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

const FRIENDLY_ERROR_MESSAGES = {
    InvalidAccessKeyId: 'S3 asset storage authentication failed: the access key ID is not valid (InvalidAccessKeyId). Check the S3 access key configuration.',
    InvalidClientTokenId: 'S3 asset storage authentication failed: the access key ID is not valid (InvalidClientTokenId). Check the S3 access key configuration.',
    SignatureDoesNotMatch: 'S3 asset storage authentication failed: the request signature does not match (SignatureDoesNotMatch). Check the S3 secret key configuration.',
    AccessDenied: 'S3 access denied (AccessDenied). Check the bucket permissions for this key.',
    NoSuchBucket: 'S3 bucket does not exist (NoSuchBucket).',
    BucketAlreadyExists: 'S3 bucket already exists (BucketAlreadyExists).',
    ENOENT: 'File or directory not found (ENOENT).',
    ENOSPC: 'Server disk is full (ENOSPC).',
    EACCES: 'File permission denied (EACCES).',
    EPERM: 'Operation not permitted (EPERM).',
    EMFILE: 'Too many open files (EMFILE).',
    ENFILE: 'Too many open files system-wide (ENFILE).',
    EROFS: 'Filesystem is read-only (EROFS).',
    EISDIR: 'Attempted to write to a directory (EISDIR).',
    ECONNREFUSED: 'Connection to the remote service was refused (ECONNREFUSED).',
    ECONNRESET: 'Connection to the remote service was reset (ECONNRESET).',
    ETIMEDOUT: 'Connection to the remote service timed out (ETIMEDOUT).',
    EAI_AGAIN: 'DNS lookup failed (EAI_AGAIN).',
    TimeoutError: 'Request timed out (TimeoutError).',
    ERR_STREAM_PREMATURE_CLOSE: 'The request stream was closed before it completed.',
};

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

    const statusCode = Number.isInteger(error?.status) ? error.status
        : Number.isInteger(error?.statusCode) ? error.statusCode
        : 500;
    const errorKey = [error?.name, error?.code, error?.type]
        .find((value) => typeof value === 'string' && Object.hasOwn(FRIENDLY_ERROR_MESSAGES, value));
    const rawMessage = error?.message || (error ? String(error) : 'Unknown error');
    const message = errorKey ? `${FRIENDLY_ERROR_MESSAGES[errorKey]} (${rawMessage})` : rawMessage;

    if (statusCode >= 500) {
        console.error(`[Server] Unhandled error on ${req.method} ${req.path}:`, error?.stack || error);
    }

    if (res.headersSent) {
        return next(error);
    }
    res.status(statusCode).send({
        error: message,
        code: errorKey || undefined,
    });
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

let activeHttpServer = null;
let shutdownInProgress = false;

function listenHttpServer(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
}

async function startServer() {
    try {
        const storageTarget = describeStorageTarget(dbVendor, postgresStorage);
        console.log(
            `[Server startup] Storage vendor: ${dbVendor}; target: ${storageTarget}; ` +
            `startup timeout: ${storageStartupSettings.startupTimeoutMs}ms; ` +
            `progress interval: ${storageStartupSettings.heartbeatMs}ms.`
        );
        try {
            await initializePrimaryStorage(
                postgresStorage,
                dbVendor,
                `Step 1/4 initialize ${dbVendor} storage`
            );
        } catch (error) {
            console.error(
                `[Server startup] SQL storage is unavailable; continuing in recovery mode: ` +
                sanitizeSensitiveText(error?.message || error)
            );
        }
        await runStartupStage({
            scope: 'Server startup',
            operation: 'Step 2/4 initialize asset storage',
            heartbeatMs: storageStartupSettings.heartbeatMs,
        }, () => assetStorageManager.init());
        await runStartupStage({
            scope: 'Server startup',
            operation: 'Step 3/4 persist bootstrap configuration',
            heartbeatMs: storageStartupSettings.heartbeatMs,
        }, async () => {
            if (!postgresManagedByEnvironment && !postgresConfigExists && postgresBootstrapUrl) {
                await persistPostgresServerConfig(postgresServerConfig);
            }
        });
        // 자동 마이그레이션 제거: 사용자가 명시적으로 마이그레이션을 승인할 때만 수행.
        // /api/db-config POST (migrate: true) 또는 /api/database-v2/migrate-legacy 에서 트리거.
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();
        const protocol = httpsOptions ? 'HTTPS' : 'HTTP';
        const server = httpsOptions
            ? https.createServer(httpsOptions, app)
            : http.createServer(app);
        activeHttpServer = server;
        setupProxyStreamWebSocket(server);

        await runStartupStage({
            scope: 'Server startup',
            operation: `Step 4/4 listen for ${protocol} requests`,
            detail: `port=${port}`,
            timeoutMs: 30000,
            heartbeatMs: storageStartupSettings.heartbeatMs,
        }, () => listenHttpServer(server, port));
        console.log(`[Server] ${protocol} server is running.`);
        console.log(`[Server] ${httpsOptions ? 'https' : 'http'}://localhost:${port}/`);
        if (!isPrimaryStorageReady()) {
            console.warn(
                `[Server startup] Recovery mode is active (${primaryStorageRuntime.status}). ` +
                'Application data APIs are locked until SQL storage is ready.'
            );
        }
    } catch (error) {
        console.error(
            `[Server startup] Fatal startup failure: ` +
            `${sanitizeSensitiveText(error?.name || 'Error')}: ${sanitizeSensitiveText(error?.message || error)}`
        );
        process.exit(1);
    }
}

async function shutdownServer(signal) {
    if (shutdownInProgress) {
        console.warn(`[Server shutdown] Received ${signal} while shutdown is already in progress.`);
        return;
    }
    shutdownInProgress = true;
    console.warn(`[Server shutdown] Received ${signal}; stopping HTTP and storage resources.`);
    const forceExitTimer = setTimeout(() => {
        console.error('[Server shutdown] Graceful shutdown exceeded 10s; forcing process exit.');
        process.exit(1);
    }, 10000);
    forceExitTimer.unref?.();

    try {
        if (activeHttpServer?.listening) {
            await new Promise((resolve) => activeHttpServer.close(resolve));
        }
        await flushVectorIndexPersistence();
        if (backupStorage && typeof backupStorage.close === 'function') {
            await backupStorage.close();
        }
        if (postgresStorage && typeof postgresStorage.close === 'function') {
            await postgresStorage.close();
        }
        clearTimeout(forceExitTimer);
        console.log(`[Server shutdown] Graceful shutdown after ${signal} completed.`);
        process.exit(0);
    } catch (error) {
        clearTimeout(forceExitTimer);
        console.error(
            `[Server shutdown] Shutdown after ${signal} failed: ` +
            sanitizeSensitiveText(error?.message || error)
        );
        process.exit(1);
    }
}

process.once('SIGTERM', () => void shutdownServer('SIGTERM'));
process.once('SIGINT', () => void shutdownServer('SIGINT'));

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
