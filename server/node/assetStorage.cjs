const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const stream = require('stream');
const crypto = require('crypto');
const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    HeadBucketCommand,
    CreateBucketCommand,
    HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { pipeline } = require('stream/promises');

// Resolve NodeHttpHandler through @aws-sdk/client-s3's module graph so we
// don't depend on pnpm hoisting @smithy/node-http-handler to the top level.
const _s3Require = require('module').createRequire(require.resolve('@aws-sdk/client-s3'));
const { NodeHttpHandler } = _s3Require('@smithy/node-http-handler');

// Shared keep-alive agents so 19k+ sequential S3 requests reuse TCP/TLS
// connections instead of paying handshake cost per request.
function createHttpAgents() {
    const keepAlive = true;
    const keepAliveMsecs = 30000;
    // maxSockets should be at least migration concurrency so workers don't
    // queue on the socket pool. Default to 2x concurrency for headroom.
    const concurrency = Math.max(MIGRATE_CONCURRENCY, 1);
    const defaultMaxSockets = Math.max(128, concurrency * 2);
    const maxSockets = Math.max(
        defaultMaxSockets,
        parseInt(process.env.RISUAI_S3_MAX_SOCKETS || String(defaultMaxSockets), 10) || defaultMaxSockets
    );
    const agentOpts = { keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets: 64 };
    const httpAgent = new http.Agent(agentOpts);
    const httpsAgent = new https.Agent(agentOpts);
    // Swallow socket-level errors (EPIPE, ECONNRESET, etc.) so an abrupt peer
    // close does not crash the process via an unhandled 'error' event. The
    // SDK call that owns the socket surfaces the failure through its own
    // rejection; the agent only needs to stop Node from throwing here.
    const swallow = (err) => {
        if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ECONNABORTED') {
            console.warn('[S3 Storage] socket error:', err.message);
        }
    };
    httpAgent.on('error', swallow);
    httpsAgent.on('error', swallow);
    return { httpAgent, httpsAgent };
}

// Concurrency for migration/rollback. Override via RISUAI_MIGRATE_CONCURRENCY env.
// 64 is a good default for many ~1 MB files against a local RustFS/MinIO; for
// remote S3 with higher latency, 32 may be safer to avoid timeouts.
const MIGRATE_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.RISUAI_MIGRATE_CONCURRENCY || '64', 10) || 64
);
// Stream-upload threshold: files larger than this use streaming PutObject instead of buffer.
// Raised to 16 MiB so typical ~1 MB assets take the fast buffered path.
const MIGRATE_STREAM_THRESHOLD = 16 * 1024 * 1024;
// Progress callback throttle in ms (avoids flooding the client on large sets).
const MIGRATE_PROGRESS_INTERVAL_MS = 200;

// Run an async worker over `items` with bounded concurrency. Worker signature:
//   (item, index) => Promise<void>. Errors are returned, never thrown, so a single
//   failure does not abort the whole batch (caller decides via `errors`).
async function runWithConcurrency(items, worker, concurrency) {
    const c = Math.max(1, concurrency | 0);
    let index = 0;
    const workers = new Array(Math.min(c, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            const i = index++;
            try {
                await worker(items[i], i);
            } catch {
                // Swallow; worker is expected to record its own errors.
            }
        }
    });
    await Promise.all(workers);
}

let sharp = null;
try {
    sharp = require('sharp');
} catch (err) {
    // sharp optional / not available in certain lightweight envs
}

function isHex(str) {
    if (typeof str !== 'string' || str.length === 0 || str.length % 2 !== 0) {
        return false;
    }
    return /^[0-9a-fA-F]+$/.test(str);
}

function hexToKey(hex) {
    return Buffer.from(hex, 'hex').toString('utf-8');
}

function keyToHex(key) {
    return Buffer.from(key, 'utf-8').toString('hex');
}

function isImageKey(key) {
    const ext = key.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'apng', 'bmp', 'svg', 'ico', 'tiff', 'tif'].includes(ext);
}

async function createThumbnailBuffer(buffer, width = 128, height = 128) {
    if (!sharp) {
        return null;
    }
    try {
        return await sharp(buffer)
            .resize({
                width,
                height,
                fit: 'cover',
                withoutEnlargement: true
            })
            .webp({ quality: 80 })
            .toBuffer();
    } catch (err) {
        return null;
    }
}

async function removeThumbnailsForHex(thumbDir, hexPath) {
    if (!fs.existsSync(thumbDir)) return;
    const standardSizes = ['128x128', '256x256', '512x512', '64x64'];
    await Promise.all(standardSizes.map(size =>
        fs.promises.unlink(path.join(thumbDir, `${hexPath}_${size}.webp`)).catch(() => {})
    ));
}

function getContentType(key) {
    const ext = key.split('.').pop()?.toLowerCase();
    switch (ext) {
        // Images
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'svg': return 'image/svg+xml';
        case 'avif': return 'image/avif';
        case 'apng': return 'image/apng';
        case 'bmp': return 'image/bmp';
        case 'ico': return 'image/x-icon';
        case 'tiff':
        case 'tif': return 'image/tiff';

        // Videos
        case 'webm': return 'video/webm';
        case 'mp4': return 'video/mp4';
        case 'mkv': return 'video/x-matroska';
        case 'mov': return 'video/quicktime';
        case 'avi': return 'video/x-msvideo';
        case 'm4v': return 'video/x-m4v';
        case 'ogv': return 'video/ogg';

        // Audios
        case 'mp3': return 'audio/mpeg';
        case 'wav': return 'audio/wav';
        case 'ogg':
        case 'oga': return 'audio/ogg';
        case 'opus': return 'audio/opus';
        case 'flac': return 'audio/flac';
        case 'aac': return 'audio/aac';
        case 'm4a': return 'audio/mp4';
        case 'weba': return 'audio/webm';

        // Fonts
        case 'woff': return 'font/woff';
        case 'woff2': return 'font/woff2';
        case 'ttf': return 'font/ttf';
        case 'otf': return 'font/otf';

        // Documents & Data
        case 'json': return 'application/json';
        case 'txt': return 'text/plain';
        case 'css': return 'text/css';
        case 'bin': return 'application/octet-stream';
        default: return 'application/octet-stream';
    }
}

class LocalFsStorage {
    constructor(savePath) {
        this.savePath = savePath;
        this.type = 'fs';
    }

    async init() {
        if (!fs.existsSync(this.savePath)) {
            fs.mkdirSync(this.savePath, { recursive: true });
        }
    }

    async read(hexPath) {
        const fullPath = path.join(this.savePath, hexPath);
        if (!fs.existsSync(fullPath)) {
            return { exists: false };
        }
        const key = hexToKey(hexPath);
        return {
            exists: true,
            filePath: fullPath,
            stream: fs.createReadStream(fullPath),
            contentLength: (await fs.promises.stat(fullPath)).size,
            contentType: getContentType(key)
        };
    }

    async readThumbnail(hexPath, options = {}) {
        const width = options.width || 128;
        const height = options.height || 128;
        const key = hexToKey(hexPath);
        if (!isImageKey(key)) {
            return this.read(hexPath);
        }

        const thumbDir = path.join(this.savePath, '__thumbs');
        const thumbPath = path.join(thumbDir, `${hexPath}_${width}x${height}.webp`);
        if (fs.existsSync(thumbPath)) {
            const stat = await fs.promises.stat(thumbPath);
            return {
                exists: true,
                filePath: thumbPath,
                contentLength: stat.size,
                contentType: 'image/webp'
            };
        }

        const original = await this.read(hexPath);
        if (!original.exists) {
            return { exists: false };
        }

        try {
            const originalBuffer = await fs.promises.readFile(original.filePath);
            const thumbBuffer = await createThumbnailBuffer(originalBuffer, width, height);
            if (thumbBuffer) {
                if (!fs.existsSync(thumbDir)) {
                    fs.mkdirSync(thumbDir, { recursive: true });
                }
                await fs.promises.writeFile(thumbPath, thumbBuffer);
                return {
                    exists: true,
                    filePath: thumbPath,
                    buffer: thumbBuffer,
                    contentLength: thumbBuffer.length,
                    contentType: 'image/webp'
                };
            }
        } catch (err) {
            // fallback to original if thumbnail creation fails
        }

        return original;
    }

    async write(hexPath, content) {
        const fullPath = path.join(this.savePath, hexPath);
        await fs.promises.writeFile(fullPath, content);
        const key = hexToKey(hexPath);
        if (isImageKey(key)) {
            createThumbnailBuffer(content, 128, 128).then(async (thumbBuffer) => {
                if (thumbBuffer) {
                    const thumbDir = path.join(this.savePath, '__thumbs');
                    if (!fs.existsSync(thumbDir)) {
                        fs.mkdirSync(thumbDir, { recursive: true });
                    }
                    await fs.promises.writeFile(path.join(thumbDir, `${hexPath}_128x128.webp`), thumbBuffer);
                }
            }).catch(() => {});
        }
        return { success: true };
    }

    async writeFromPath(hexPath, sourcePath) {
        const fullPath = path.join(this.savePath, hexPath);
        try {
            await fs.promises.rename(sourcePath, fullPath);
        } catch (err) {
            await fs.promises.copyFile(sourcePath, fullPath);
            await fs.promises.unlink(sourcePath).catch(() => {});
        }
        const thumbDir = path.join(this.savePath, '__thumbs');
        await removeThumbnailsForHex(thumbDir, hexPath);
        const key = hexToKey(hexPath);
        if (isImageKey(key)) {
            fs.promises.readFile(fullPath).then(data => createThumbnailBuffer(data, 128, 128)).then(async (thumbBuffer) => {
                if (thumbBuffer) {
                    if (!fs.existsSync(thumbDir)) {
                        fs.mkdirSync(thumbDir, { recursive: true });
                    }
                    await fs.promises.writeFile(path.join(thumbDir, `${hexPath}_128x128.webp`), thumbBuffer);
                }
            }).catch(() => {});
        }
        return { success: true };
    }

    createWriteStream(hexPath) {
        const fullPath = path.join(this.savePath, hexPath);
        const fileStream = fs.createWriteStream(fullPath);
        const donePromise = new Promise((resolve, reject) => {
            fileStream.on('finish', async () => {
                try {
                    const thumbDir = path.join(this.savePath, '__thumbs');
                    await removeThumbnailsForHex(thumbDir, hexPath);
                    resolve({ success: true });
                } catch (err) {
                    reject(err);
                }
            });
            fileStream.on('error', reject);
        });
        return {
            stream: fileStream,
            done: () => donePromise,
            abort: async () => {
                fileStream.destroy();
                await fs.promises.unlink(fullPath).catch(() => {});
            }
        };
    }

    async remove(hexPaths) {
        const paths = Array.isArray(hexPaths) ? hexPaths : [hexPaths];
        const thumbDir = path.join(this.savePath, '__thumbs');
        for (const hp of paths) {
            const fullPath = path.join(this.savePath, hp);
            try {
                if (fs.existsSync(fullPath)) {
                    await fs.promises.rm(fullPath);
                }
            } catch (err) {
                // Ignore removal errors if file is absent
            }
            await removeThumbnailsForHex(thumbDir, hp);
        }
        return { success: true };
    }

    async list() {
        if (!fs.existsSync(this.savePath)) {
            return [];
        }
        const entries = await fs.promises.readdir(this.savePath);
        const result = [];
        for (const entry of entries) {
            if (entry.startsWith('__')) {
                continue;
            }
            if (isHex(entry)) {
                result.push(hexToKey(entry));
            }
        }
        return result;
    }

    async exists(hexPath) {
        return fs.existsSync(path.join(this.savePath, hexPath));
    }

    async getStats() {
        if (!fs.existsSync(this.savePath)) {
            return { totalObjects: 0, totalSizeBytes: 0 };
        }
        const entries = await fs.promises.readdir(this.savePath);
        let totalObjects = 0;
        let totalSizeBytes = 0;
        for (const entry of entries) {
            if (entry.startsWith('__')) continue;
            try {
                const stat = await fs.promises.stat(path.join(this.savePath, entry));
                if (stat.isFile()) {
                    totalObjects++;
                    totalSizeBytes += stat.size;
                }
            } catch {
                // Ignore stat errors
            }
        }
        return {
            storageType: 'fs',
            totalObjects,
            totalSizeBytes
        };
    }

    async getAssetDetails() {
        if (!fs.existsSync(this.savePath)) {
            return { storageType: 'fs', totalObjects: 0, totalSizeBytes: 0, assets: [] };
        }
        const entries = await fs.promises.readdir(this.savePath);
        const assets = [];
        let totalSizeBytes = 0;
        for (const entry of entries) {
            if (entry.startsWith('__') || !isHex(entry)) continue;
            try {
                const fullPath = path.join(this.savePath, entry);
                const stat = await fs.promises.stat(fullPath);
                if (stat.isFile()) {
                    const key = hexToKey(entry);
                    assets.push({
                        key,
                        size: stat.size,
                        mtime: stat.mtimeMs
                    });
                    totalSizeBytes += stat.size;
                }
            } catch {
                // Ignore stat error
            }
        }
        return {
            storageType: 'fs',
            totalObjects: assets.length,
            totalSizeBytes,
            assets
        };
    }

    async cleanLocalAssets() {
        if (!fs.existsSync(this.savePath)) {
            return { deleted: 0, freedBytes: 0 };
        }
        const entries = await fs.promises.readdir(this.savePath);
        let deleted = 0;
        let freedBytes = 0;
        for (const entry of entries) {
            if (entry.startsWith('__') || !isHex(entry)) continue;
            try {
                const fullPath = path.join(this.savePath, entry);
                const stat = await fs.promises.stat(fullPath);
                if (stat.isFile()) {
                    await fs.promises.unlink(fullPath);
                    deleted++;
                    freedBytes += stat.size;
                }
            } catch {
                // Ignore unlink error
            }
        }
        return { deleted, freedBytes };
    }
}

async function getS3BodyBuffer(body) {
    if (!body) return null;
    if (typeof body.transformToByteArray === 'function') {
        const bytes = await body.transformToByteArray();
        return Buffer.from(bytes);
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (body instanceof Uint8Array) {
        return Buffer.from(body);
    }
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

class S3AssetStorage {
    constructor(config, savePath = '') {
        this.config = {
            endpoint: config.endpoint || '',
            bucket: config.bucket || 'risuai-assets',
            accessKeyId: config.accessKeyId || '',
            secretAccessKey: config.secretAccessKey || '',
            region: config.region || 'us-east-1',
            forcePathStyle: config.forcePathStyle !== false,
            autoCreateBucket: config.autoCreateBucket !== false,
        };
        this.savePath = savePath || config.savePath || path.join(os.tmpdir(), 'risuai-s3-cache');
        this.thumbDir = path.join(this.savePath, '__s3_thumbs');
        this.type = 's3';
        this.client = S3AssetStorage.createClient(this.config);
    }

    static createClient(config) {
        const agents = createHttpAgents();
        const clientConfig = {
            region: config.region || 'us-east-1',
            forcePathStyle: config.forcePathStyle !== false,
            // Reuse a shared keep-alive agent pool so repeated S3 requests do
            // not pay TCP/TLS handshake cost on every call (critical for
            // 19k+ file migrations). Pass the agents directly via the handler
            // config so the SDK wires them onto every outgoing socket.
            requestHandler: new NodeHttpHandler({
                httpsAgent: agents.httpsAgent,
                httpAgent: agents.httpAgent,
                // Silence the "socket usage at capacity" warning by giving the
                // SDK more time to acquire a socket before it logs, and let
                // queued requests wait instead of warning loudly.
                socketAcquisitionWarningTimeout: 120000,
                // Hard cap on a single HTTP request; a stalled socket is
                // abandoned and the worker records an error instead of hanging.
                requestTimeout: 300000
            })
        };

        if (config.endpoint) {
            clientConfig.endpoint = config.endpoint;
        }

        const accessKeyId = (config.accessKeyId || '').trim();
        const secretAccessKey = (config.secretAccessKey || '').trim();

        if (accessKeyId && secretAccessKey) {
            clientConfig.credentials = {
                accessKeyId,
                secretAccessKey
            };
        } else if (config.endpoint) {
            if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
                clientConfig.credentials = {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                };
            } else if (process.env.RUSTFS_ACCESS_KEY && process.env.RUSTFS_SECRET_KEY) {
                clientConfig.credentials = {
                    accessKeyId: process.env.RUSTFS_ACCESS_KEY,
                    secretAccessKey: process.env.RUSTFS_SECRET_KEY
                };
            }
        }

        return new S3Client(clientConfig);
    }

    static async testConnection(config) {
        const accessKeyId = (config.accessKeyId || '').trim();
        const secretAccessKey = (config.secretAccessKey || '').trim();
        if (!accessKeyId || !secretAccessKey) {
            if (!process.env.AWS_ACCESS_KEY_ID && !process.env.RUSTFS_ACCESS_KEY) {
                return {
                    success: false,
                    bucketExists: false,
                    message: 'Access Key ID and Secret Access Key are required (e.g. "rustfsadmin" / "rustfsadmin" for RustFS).'
                };
            }
        }

        const client = S3AssetStorage.createClient(config);
        const bucket = config.bucket || 'risuai-assets';
        try {
            try {
                await client.send(new HeadBucketCommand({ Bucket: bucket }));
                return {
                    success: true,
                    bucketExists: true,
                    message: `Successfully connected to S3. Bucket "${bucket}" is accessible.`
                };
            } catch (headError) {
                if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
                    if (config.autoCreateBucket !== false) {
                        try {
                            await client.send(new CreateBucketCommand({ Bucket: bucket }));
                            return {
                                success: true,
                                bucketExists: true,
                                message: `Successfully connected to S3 and automatically created bucket "${bucket}".`
                            };
                        } catch (createError) {
                            return {
                                success: false,
                                bucketExists: false,
                                message: `Bucket "${bucket}" does not exist, and auto-creation failed: ${createError.message}`
                            };
                        }
                    }
                    return {
                        success: true,
                        bucketExists: false,
                        message: `Successfully connected to S3 endpoint, but bucket "${bucket}" was not found.`
                    };
                }
                throw headError;
            }
        } catch (error) {
            let msg = error.message;
            if (msg.includes('Could not load credentials from any providers')) {
                msg = 'Could not load S3 credentials. Please check your Access Key ID and Secret Access Key.';
            }
            return {
                success: false,
                bucketExists: false,
                message: `Failed to connect to S3 endpoint: ${msg}`
            };
        }
    }

    async init() {
        if (!fs.existsSync(this.thumbDir)) {
            try {
                fs.mkdirSync(this.thumbDir, { recursive: true });
            } catch {}
        }
        if (this.config.autoCreateBucket) {
            try {
                await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
            } catch (err) {
                if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                    try {
                        await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
                        console.log(`[S3 Storage] Created bucket "${this.config.bucket}"`);
                    } catch (createErr) {
                        console.warn(`[S3 Storage] Could not auto-create bucket "${this.config.bucket}": ${createErr.message}`);
                    }
                }
            }
        }
    }

    async read(hexPath) {
        const key = hexToKey(hexPath);
        try {
            const command = new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: key
            });
            const response = await this.client.send(command);
            const buffer = await getS3BodyBuffer(response.Body);
            return {
                exists: true,
                buffer: buffer,
                stream: buffer ? undefined : response.Body,
                contentType: response.ContentType || getContentType(key),
                contentLength: buffer ? buffer.length : response.ContentLength
            };
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return { exists: false };
            }
            throw err;
        }
    }

    async readThumbnail(hexPath, options = {}) {
        const width = options.width || 128;
        const height = options.height || 128;
        const key = hexToKey(hexPath);
        if (!isImageKey(key)) {
            return this.read(hexPath);
        }

        // 1. Check local server disk cache (0 S3 API calls, fastest)
        const localThumbPath = path.join(this.thumbDir, `${hexPath}_${width}x${height}.webp`);
        if (fs.existsSync(localThumbPath)) {
            try {
                const stat = await fs.promises.stat(localThumbPath);
                return {
                    exists: true,
                    filePath: localThumbPath,
                    contentLength: stat.size,
                    contentType: 'image/webp'
                };
            } catch {}
        }

        // 2. Check S3 thumbnail cache
        const thumbKey = `thumbnails/${key}_${width}x${height}.webp`;
        try {
            const command = new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: thumbKey
            });
            const response = await this.client.send(command);
            const buffer = await getS3BodyBuffer(response.Body);
            if (buffer && buffer.length > 0) {
                try {
                    if (!fs.existsSync(this.thumbDir)) {
                        fs.mkdirSync(this.thumbDir, { recursive: true });
                    }
                    await fs.promises.writeFile(localThumbPath, buffer);
                } catch {}

                return {
                    exists: true,
                    filePath: localThumbPath,
                    buffer: buffer,
                    contentType: 'image/webp',
                    contentLength: buffer.length
                };
            }
        } catch (err) {
            // If not found in S3, proceed to generate from original
        }

        // 3. Not in S3 thumbnail cache: read original from S3
        const original = await this.read(hexPath);
        if (!original.exists || !original.buffer || original.buffer.length === 0) {
            return { exists: false };
        }

        // 4. Generate thumbnail, cache locally and upload to S3
        try {
            const thumbBuffer = await createThumbnailBuffer(original.buffer, width, height);
            if (thumbBuffer && thumbBuffer.length > 0) {
                try {
                    if (!fs.existsSync(this.thumbDir)) {
                        fs.mkdirSync(this.thumbDir, { recursive: true });
                    }
                    await fs.promises.writeFile(localThumbPath, thumbBuffer);
                } catch {}

                this.client.send(new PutObjectCommand({
                    Bucket: this.config.bucket,
                    Key: thumbKey,
                    Body: thumbBuffer,
                    ContentType: 'image/webp'
                })).catch(err => {
                    console.warn(`[S3 Storage] Failed to cache thumbnail "${thumbKey}": ${err.message}`);
                });

                return {
                    exists: true,
                    filePath: localThumbPath,
                    buffer: thumbBuffer,
                    contentLength: thumbBuffer.length,
                    contentType: 'image/webp'
                };
            }
        } catch (err) {
            console.warn(`[S3 Storage] Thumbnail generation error for "${key}":`, err);
        }

        return original;
    }

    async eagerGenerateThumbnail(hexPath, key, buffer, width = 128, height = 128) {
        try {
            const thumbBuffer = await createThumbnailBuffer(buffer, width, height);
            if (thumbBuffer && thumbBuffer.length > 0) {
                const thumbKey = `thumbnails/${key}_${width}x${height}.webp`;
                const localThumbPath = path.join(this.thumbDir, `${hexPath}_${width}x${height}.webp`);
                try {
                    if (!fs.existsSync(this.thumbDir)) {
                        fs.mkdirSync(this.thumbDir, { recursive: true });
                    }
                    await fs.promises.writeFile(localThumbPath, thumbBuffer);
                } catch {}

                await this.client.send(new PutObjectCommand({
                    Bucket: this.config.bucket,
                    Key: thumbKey,
                    Body: thumbBuffer,
                    ContentType: 'image/webp'
                }));
            }
        } catch (err) {
            // Eager thumbnail generation is best-effort
        }
    }

    async write(hexPath, content) {
        const key = hexToKey(hexPath);
        const contentType = getContentType(key);
        const command = new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: content,
            ContentType: contentType
        });
        await this.client.send(command);

        if (isImageKey(key) && (Buffer.isBuffer(content) || content instanceof Uint8Array)) {
            this.eagerGenerateThumbnail(hexPath, key, Buffer.from(content)).catch(() => {});
        }

        return { success: true };
    }

    async writeFromPath(hexPath, sourcePath) {
        const key = hexToKey(hexPath);
        const contentType = getContentType(key);
        const stat = await fs.promises.stat(sourcePath);
        let fileBuffer = null;
        if (isImageKey(key)) {
            try {
                fileBuffer = await fs.promises.readFile(sourcePath);
            } catch {}
        }

        const stream = fs.createReadStream(sourcePath);
        const command = new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: stream,
            ContentType: contentType,
            ContentLength: stat.size
        });
        await this.client.send(command);
        await fs.promises.unlink(sourcePath).catch(() => {});

        if (fileBuffer) {
            this.eagerGenerateThumbnail(hexPath, key, fileBuffer).catch(() => {});
        }

        return { success: true };
    }

    createWriteStream(hexPath) {
        const key = hexToKey(hexPath);
        const contentType = getContentType(key);
        const passThrough = new stream.PassThrough();
        const chunks = isImageKey(key) ? [] : null;
        if (chunks) {
            passThrough.on('data', (chunk) => {
                if (chunks.length < 50) {
                    chunks.push(chunk);
                }
            });
        }
        const upload = new Upload({
            client: this.client,
            params: {
                Bucket: this.config.bucket,
                Key: key,
                Body: passThrough,
                ContentType: contentType
            },
            partSize: 5 * 1024 * 1024,
            leavePartsOnError: false
        });
        const donePromise = upload.done().then(() => {
            if (chunks && chunks.length > 0) {
                const fullBuffer = Buffer.concat(chunks);
                this.eagerGenerateThumbnail(hexPath, key, fullBuffer).catch(() => {});
            }
            return { success: true };
        });
        return {
            stream: passThrough,
            done: () => donePromise,
            abort: async () => {
                passThrough.destroy();
                try {
                    await upload.abort();
                } catch {}
            }
        };
    }

    async remove(hexPaths) {
        const paths = Array.isArray(hexPaths) ? hexPaths : [hexPaths];
        if (paths.length === 0) return { success: true };

        // Clean local thumbnail cache
        if (fs.existsSync(this.thumbDir)) {
            try {
                const thumbFiles = await fs.promises.readdir(this.thumbDir);
                for (const hp of paths) {
                    for (const tf of thumbFiles) {
                        if (tf.startsWith(hp)) {
                            await fs.promises.rm(path.join(this.thumbDir, tf)).catch(() => {});
                        }
                    }
                }
            } catch {}
        }

        const originalKeys = paths.map(p => hexToKey(p));
        const thumbKeys = originalKeys.map(k => `thumbnails/${k}_128x128.webp`);
        const allKeys = [...originalKeys, ...thumbKeys];

        if (allKeys.length === 1) {
            try {
                await this.client.send(new DeleteObjectCommand({
                    Bucket: this.config.bucket,
                    Key: allKeys[0]
                }));
            } catch (err) {
                // Ignore if not found
            }
            return { success: true };
        }

        // Batch delete in chunks of 1000
        const objects = allKeys.map(k => ({ Key: k }));
        for (let i = 0; i < objects.length; i += 1000) {
            const chunk = objects.slice(i, i + 1000);
            await this.client.send(new DeleteObjectsCommand({
                Bucket: this.config.bucket,
                Delete: {
                    Objects: chunk,
                    Quiet: true
                }
            }));
        }
        return { success: true };
    }

    async generateMissingThumbnails(onProgress) {
        const allImageKeys = [];
        const existingThumbs = new Set();
        let continuationToken = undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                ContinuationToken: continuationToken
            });
            const response = await this.client.send(command);
            if (response.Contents) {
                for (const item of response.Contents) {
                    if (!item.Key) continue;
                    if (item.Key.startsWith('thumbnails/')) {
                        existingThumbs.add(item.Key);
                    } else if (isImageKey(item.Key)) {
                        allImageKeys.push(item.Key);
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        const total = allImageKeys.length;
        let created = 0;
        let skipped = 0;
        const errors = [];

        for (let i = 0; i < allImageKeys.length; i++) {
            const key = allImageKeys[i];
            const hexPath = keyToHex(key);
            const thumbKey = `thumbnails/${key}_128x128.webp`;

            if (existingThumbs.has(thumbKey)) {
                skipped++;
            } else {
                try {
                    const original = await this.read(hexPath);
                    if (original.exists && original.buffer && original.buffer.length > 0) {
                        const thumbBuffer = await createThumbnailBuffer(original.buffer, 128, 128);
                        if (thumbBuffer && thumbBuffer.length > 0) {
                            await this.client.send(new PutObjectCommand({
                                Bucket: this.config.bucket,
                                Key: thumbKey,
                                Body: thumbBuffer,
                                ContentType: 'image/webp'
                            }));
                            const localThumbPath = path.join(this.thumbDir, `${hexPath}_128x128.webp`);
                            try {
                                if (!fs.existsSync(this.thumbDir)) {
                                    fs.mkdirSync(this.thumbDir, { recursive: true });
                                }
                                await fs.promises.writeFile(localThumbPath, thumbBuffer);
                            } catch {}
                            created++;
                        } else {
                            errors.push(`Failed to generate thumbnail for ${key}`);
                        }
                    } else {
                        errors.push(`Could not read original file for ${key}`);
                    }
                } catch (err) {
                    errors.push(`Error generating thumbnail for ${key}: ${err.message}`);
                }
            }

            if (onProgress && (i % 5 === 0 || i === allImageKeys.length - 1)) {
                onProgress({
                    type: 'progress',
                    current: i + 1,
                    total,
                    created,
                    skipped,
                    percentage: total > 0 ? Math.round(((i + 1) / total) * 100) : 100,
                    currentKey: key
                });
            }
        }

        return { total, created, skipped, errors };
    }

    async list() {
        const keys = [];
        let continuationToken = undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                ContinuationToken: continuationToken
            });
            const response = await this.client.send(command);
            if (response.Contents) {
                for (const item of response.Contents) {
                    if (item.Key && !item.Key.startsWith('thumbnails/')) {
                        keys.push(item.Key);
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return keys;
    }

    async exists(hexPath) {
        const key = hexToKey(hexPath);
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.config.bucket,
                Key: key
            }));
            return true;
        } catch (err) {
            return false;
        }
    }

    async getStats() {
        let totalObjects = 0;
        let totalSizeBytes = 0;
        let continuationToken = undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                ContinuationToken: continuationToken
            });
            const response = await this.client.send(command);
            if (response.Contents) {
                for (const item of response.Contents) {
                    totalObjects++;
                    totalSizeBytes += (item.Size || 0);
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return {
            storageType: 's3',
            bucketName: this.config.bucket,
            endpoint: this.config.endpoint || 'AWS Standard',
            totalObjects,
            totalSizeBytes
        };
    }

    async getAssetDetails() {
        const assets = [];
        let totalSizeBytes = 0;
        let continuationToken = undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                ContinuationToken: continuationToken
            });
            const response = await this.client.send(command);
            if (response.Contents) {
                for (const item of response.Contents) {
                    if (item.Key) {
                        const size = item.Size || 0;
                        assets.push({
                            key: item.Key,
                            size,
                            mtime: item.LastModified ? new Date(item.LastModified).getTime() : Date.now()
                        });
                        totalSizeBytes += size;
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return {
            storageType: 's3',
            bucketName: this.config.bucket,
            endpoint: this.config.endpoint || 'AWS Standard',
            totalObjects: assets.length,
            totalSizeBytes,
            assets
        };
    }

    async migrateFromLocal(savePath, onProgress) {
        if (!fs.existsSync(savePath)) {
            return { total: 0, migrated: 0, skipped: 0, errors: [] };
        }
        const entries = await fs.promises.readdir(savePath);
        const hexEntries = entries.filter(e => !e.startsWith('__') && isHex(e));
        const total = hexEntries.length;

        // Skip the exists-check entirely when RISUAI_MIGRATE_SKIP_EXISTS_CHECK is
        // set, or when the bucket is empty (first migration). S3 PutObject is
        // idempotent, so re-uploading an existing key is safe and avoids both the
        // full ListObjectsV2 round-trips (100k keys = 100 pages) and the 100k-key
        // in-memory Set. This is the single biggest win on large sets.
        let existingKeys = null;
        const skipExistsCheck = process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK === '1'
            || process.env.RISUAI_MIGRATE_SKIP_EXISTS_CHECK === 'true';
        if (!skipExistsCheck) {
            try {
                const listed = await this.list();
                if (listed.length === 0) {
                    // Empty bucket: no point tracking exists for every file.
                    existingKeys = null;
                } else {
                    existingKeys = new Set(listed);
                }
            } catch {
                existingKeys = null;
            }
        }

        let migrated = 0;
        let skipped = 0;
        let completed = 0;
        const errors = [];
        let lastProgressSent = 0;

        const sendProgress = (currentKey) => {
            if (!onProgress) return;
            const now = Date.now();
            const isFinal = completed >= total;
            if (!isFinal && now - lastProgressSent < MIGRATE_PROGRESS_INTERVAL_MS) return;
            lastProgressSent = now;
            onProgress({
                current: completed,
                total,
                migrated,
                skipped,
                percentage: total > 0 ? Math.round((completed / total) * 100) : 100,
                currentKey
            });
        };

        const worker = async (hexName) => {
            const key = hexToKey(hexName);
            try {
                const filePath = path.join(savePath, hexName);
                const stat = await fs.promises.stat(filePath);
                if (!stat.isFile()) {
                    // Non-file entries still count toward progress.
                    return;
                }

                // Skip if already in S3 (only when we have a populated set).
                // The database.bin is always re-uploaded so the S3 copy tracks
                // the latest local state rather than the version present at
                // migration time.
                if (existingKeys && existingKeys.has(key) && key !== 'database/database.bin') {
                    skipped++;
                    return;
                }

                // Upload directly with PutObjectCommand, bypassing this.write()
                // so we skip eager thumbnail generation during migration.
                // Generating thumbnails inline doubles PUT count and adds
                // sharp CPU contention; thumbnails can be generated on-demand
                // (readThumbnail) or via the dedicated "generate thumbnails" tool.
                const contentType = getContentType(key);
                if (stat.size > MIGRATE_STREAM_THRESHOLD) {
                    const rs = fs.createReadStream(filePath);
                    rs.on('error', () => { /* pipeline/send rejects; nothing to do here */ });
                    await this.client.send(new PutObjectCommand({
                        Bucket: this.config.bucket,
                        Key: key,
                        Body: rs,
                        ContentType: contentType,
                        ContentLength: stat.size
                    }));
                } else {
                    const data = await fs.promises.readFile(filePath);
                    await this.client.send(new PutObjectCommand({
                        Bucket: this.config.bucket,
                        Key: key,
                        Body: data,
                        ContentType: contentType
                    }));
                }
                migrated++;
            } catch (err) {
                errors.push(`Failed to migrate ${key}: ${err.message}`);
            } finally {
                completed++;
                sendProgress(key);
            }
        };

        await runWithConcurrency(hexEntries, worker, MIGRATE_CONCURRENCY);
        sendProgress('');

        return { total, migrated, skipped, errors };
    }

    async rollbackToLocal(savePath, onProgress) {
        if (!fs.existsSync(savePath)) {
            fs.mkdirSync(savePath, { recursive: true });
        }
        const keys = await this.list();
        const total = keys.length;

        let downloaded = 0;
        let completed = 0;
        let lastProgressSent = 0;
        const errors = [];

        const sendProgress = (currentKey) => {
            if (!onProgress) return;
            const now = Date.now();
            const isFinal = completed >= total;
            if (!isFinal && now - lastProgressSent < MIGRATE_PROGRESS_INTERVAL_MS) return;
            lastProgressSent = now;
            onProgress({
                current: completed,
                total,
                downloaded,
                percentage: total > 0 ? Math.round((completed / total) * 100) : 100,
                currentKey
            });
        };

        const worker = async (key) => {
            const hexName = keyToHex(key);
            try {
                const localFilePath = path.join(savePath, hexName);
                const result = await this.read(hexName);
                if (result.exists) {
                    if (result.stream) {
                        // Stream-to-disk (E): avoids buffering whole body in memory.
                        const ws = fs.createWriteStream(localFilePath);
                        ws.on('error', () => { /* pipeline rejects; nothing to do */ });
                        await pipeline(result.stream, ws);
                    } else if (result.buffer) {
                        await fs.promises.writeFile(localFilePath, result.buffer);
                    }
                    downloaded++;
                }
            } catch (err) {
                errors.push(`Failed to rollback ${key}: ${err.message}`);
            } finally {
                completed++;
                sendProgress(key);
            }
        };

        await runWithConcurrency(keys, worker, MIGRATE_CONCURRENCY);
        sendProgress('');

        return { total, downloaded, errors };
    }
}

class AssetStorageManager {
    constructor(savePath) {
        this.savePath = savePath;
        this.configFile = path.join(savePath, '__s3_config.json');
        this.managedByEnvironment = Boolean(
            process.env.RISU_S3_ENDPOINT ||
            process.env.S3_ENDPOINT ||
            process.env.RISU_S3_BUCKET ||
            process.env.S3_BUCKET
        );

        this.localFs = new LocalFsStorage(savePath);
        this.s3Storage = null;
        this.activeStorage = this.localFs;
        this.config = this.loadConfig();
    }

    loadConfig() {
        const envEndpoint = process.env.RISU_S3_ENDPOINT || process.env.S3_ENDPOINT || '';
        const envBucket = process.env.RISU_S3_BUCKET || process.env.S3_BUCKET || 'risuai-assets';
        const envAccessKey = process.env.RISU_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || process.env.RUSTFS_ACCESS_KEY || '';
        const envSecretKey = process.env.RISU_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || process.env.RUSTFS_SECRET_KEY || '';
        const envRegion = process.env.RISU_S3_REGION || process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
        const envEnabled = (process.env.RISU_STORAGE_TYPE === 's3' || process.env.RISU_S3_ENABLED === 'true' || Boolean(envEndpoint));

        let stored = {
            enabled: false,
            endpoint: '',
            bucket: 'risuai-assets',
            accessKeyId: '',
            secretAccessKey: '',
            region: 'us-east-1',
            forcePathStyle: true,
            autoCreateBucket: true
        };

        if (fs.existsSync(this.configFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                stored = { ...stored, ...parsed };
            } catch (err) {
                console.warn(`[S3 Storage] Could not parse ${this.configFile}: ${err.message}`);
            }
        } else if (!this.managedByEnvironment && process.env.RISU_S3_BOOTSTRAP_ENDPOINT) {
            // Bootstrap seed
            stored = {
                enabled: true,
                endpoint: process.env.RISU_S3_BOOTSTRAP_ENDPOINT,
                bucket: process.env.RISU_S3_BOOTSTRAP_BUCKET || 'risuai-assets',
                accessKeyId: process.env.RISU_S3_BOOTSTRAP_KEY || 'rustfsadmin',
                secretAccessKey: process.env.RISU_S3_BOOTSTRAP_SECRET || 'rustfsadmin',
                region: 'us-east-1',
                forcePathStyle: true,
                autoCreateBucket: true
            };
            this.saveStoredConfig(stored);
        }

        if (this.managedByEnvironment) {
            return {
                enabled: envEnabled,
                endpoint: envEndpoint,
                bucket: envBucket,
                accessKeyId: envAccessKey,
                secretAccessKey: envSecretKey,
                region: envRegion,
                forcePathStyle: process.env.RISU_S3_FORCE_PATH_STYLE !== 'false',
                autoCreateBucket: process.env.RISU_S3_AUTO_CREATE_BUCKET !== 'false',
                managedByEnvironment: true
            };
        }

        return {
            ...stored,
            managedByEnvironment: false
        };
    }

    saveStoredConfig(config) {
        if (this.managedByEnvironment) {
            throw new Error('S3 configuration is managed by server environment variables and cannot be modified via API.');
        }
        const dataToSave = {
            enabled: Boolean(config.enabled),
            endpoint: config.endpoint || '',
            bucket: config.bucket || 'risuai-assets',
            accessKeyId: config.accessKeyId || '',
            secretAccessKey: config.secretAccessKey || '',
            region: config.region || 'us-east-1',
            forcePathStyle: config.forcePathStyle !== false,
            autoCreateBucket: config.autoCreateBucket !== false
        };
        fs.writeFileSync(this.configFile, JSON.stringify(dataToSave, null, 2), { mode: 0o600 });
        this.config = { ...dataToSave, managedByEnvironment: false };
    }

    async init() {
        await this.localFs.init();
        if (this.config.enabled && (this.config.endpoint || this.config.bucket)) {
            try {
                this.s3Storage = new S3AssetStorage(this.config, this.savePath);
                await this.s3Storage.init();
                this.activeStorage = this.s3Storage;
                console.log(`[Storage] Initialized S3 storage (${this.config.endpoint || 'AWS Standard'} -> ${this.config.bucket})`);
            } catch (err) {
                console.error(`[Storage] S3 initialization failed, falling back to Local FS: ${err.message}`);
                this.activeStorage = this.localFs;
            }
        } else {
            this.activeStorage = this.localFs;
            console.log(`[Storage] Using Local FileSystem storage (${this.savePath})`);
        }
    }

    async setConfig(newConfig) {
        const mergedConfig = {
            ...this.config,
            ...newConfig,
            accessKeyId: (newConfig.accessKeyId !== undefined && newConfig.accessKeyId !== '')
                ? newConfig.accessKeyId.trim()
                : this.config.accessKeyId,
            secretAccessKey: (newConfig.secretAccessKey !== undefined && newConfig.secretAccessKey !== '')
                ? newConfig.secretAccessKey.trim()
                : this.config.secretAccessKey,
        };

        if (mergedConfig.enabled) {
            // Test connection first
            const testResult = await S3AssetStorage.testConnection(mergedConfig);
            if (!testResult.success) {
                throw new Error(testResult.message);
            }
            this.saveStoredConfig(mergedConfig);
            this.s3Storage = new S3AssetStorage(this.config, this.savePath);
            await this.s3Storage.init();
            this.activeStorage = this.s3Storage;
        } else {
            this.saveStoredConfig({ ...mergedConfig, enabled: false });
            this.activeStorage = this.localFs;
        }
        return this.getPublicConfig();
    }

    getPublicConfig() {
        return {
            enabled: Boolean(this.config.enabled),
            storageType: this.activeStorage.type,
            endpoint: this.config.endpoint || '',
            bucket: this.config.bucket || 'risuai-assets',
            region: this.config.region || 'us-east-1',
            forcePathStyle: this.config.forcePathStyle !== false,
            autoCreateBucket: this.config.autoCreateBucket !== false,
            accessKeyId: this.config.accessKeyId || '',
            hasSecretAccessKey: Boolean(this.config.secretAccessKey),
            accessKeyDisplay: this.config.accessKeyId
                ? `${this.config.accessKeyId.slice(0, 4)}****`
                : '',
            managedByEnvironment: this.managedByEnvironment
        };
    }

    getStorage() {
        return this.activeStorage;
    }

    createWriteStream(hexPath) {
        return this.activeStorage.createWriteStream(hexPath);
    }

    async writeFromPath(hexPath, sourcePath) {
        return await this.activeStorage.writeFromPath(hexPath, sourcePath);
    }

    async getSummary() {
        const localFsStats = await this.localFs.getStats();
        let s3Stats = null;
        if (this.s3Storage) {
            try {
                s3Stats = await this.s3Storage.getStats();
            } catch {
                // Ignore S3 error
            }
        }
        return {
            activeType: this.activeStorage.type,
            localFs: localFsStats,
            s3: s3Stats,
            config: this.getPublicConfig()
        };
    }

    async getAssetDetails(target = 'active') {
        if (target === 'fs') {
            return await this.localFs.getAssetDetails();
        } else if (target === 's3' && this.s3Storage) {
            return await this.s3Storage.getAssetDetails();
        }
        return await this.activeStorage.getAssetDetails();
    }

    async deleteAssetKeys(keys, target = 'active') {
        if (!Array.isArray(keys) || keys.length === 0) {
            return { deleted: 0 };
        }
        const hexPaths = keys.map(k => keyToHex(k));
        if (target === 'fs') {
            await this.localFs.remove(hexPaths);
        } else if (target === 's3' && this.s3Storage) {
            await this.s3Storage.remove(hexPaths);
        } else {
            await this.activeStorage.remove(hexPaths);
        }
        return { deleted: keys.length };
    }

    async generateMissingThumbnails(onProgress) {
        if (!this.s3Storage) {
            throw new Error('S3 storage is not active');
        }
        return await this.s3Storage.generateMissingThumbnails(onProgress);
    }

    async cleanLocalAssets() {
        return await this.localFs.cleanLocalAssets();
    }

    /**
     * Read the raw bytes of database.bin from a specific side.
     * @param {'local'|'s3'} side
     * @returns {Promise<Buffer|null>} null if not present
     */
    async readDatabaseBin(side) {
        const DB_KEY = 'database/database.bin';
        const hexPath = keyToHex(DB_KEY);
        if (side === 's3') {
            if (!this.s3Storage) {
                return null;
            }
            const r = await this.s3Storage.read(hexPath);
            if (!r.exists) {
                return null;
            }
            if (r.buffer) {
                return r.buffer;
            }
            if (r.filePath) {
                return await fs.promises.readFile(r.filePath);
            }
            if (r.stream) {
                const chunks = [];
                for await (const chunk of r.stream) {
                    chunks.push(Buffer.from(chunk));
                }
                return Buffer.concat(chunks);
            }
            return Buffer.alloc(0);
        }
        // local
        const fullPath = path.join(this.localFs.savePath, hexPath);
        if (!fs.existsSync(fullPath)) {
            return null;
        }
        return await fs.promises.readFile(fullPath);
    }

    /**
     * Resolve a database.bin divergence by overwriting both sides with the
     * user-chosen copy and returning the chosen bytes.
     * @param {'local'|'s3'} keep
     * @returns {Promise<{bytes: Buffer|null, error?: string}>}
     */
    async resolveDatabaseBinConflict(keep) {
        const DB_KEY = 'database/database.bin';
        const hexPath = keyToHex(DB_KEY);

        const chosen = await this.readDatabaseBin(keep);
        if (!chosen || chosen.length === 0) {
            return { bytes: null, error: `Selected side (${keep}) has no database.bin` };
        }

        // Write chosen bytes to both sides so they agree.
        // Local FS:
        try {
            await this.localFs.write(hexPath, chosen);
        } catch (err) {
            return { bytes: chosen, error: `Failed to write local copy: ${err.message}` };
        }
        // S3 (if configured):
        if (this.s3Storage) {
            try {
                await this.s3Storage.write(hexPath, chosen);
            } catch (err) {
                return { bytes: chosen, error: `Failed to write S3 copy: ${err.message}` };
            }
        }
        return { bytes: chosen };
    }

    /**
     * Compute SHA-256 hashes of the database.bin stored on the local FS and
     * on S3 (when configured), so the client can detect a divergence at boot
     * and prompt the user for which copy to keep.
     *
     * Returns: { activeType, local: { exists, hash, size } | null,
     *            s3: { exists, hash, size } | null, same: boolean|null }
     */
    async getDatabaseBinHashes() {
        const hashBuffer = (buf) => {
            const h = crypto.createHash('sha256');
            h.update(buf);
            return h.digest('hex');
        };

        const result = {
            activeType: this.activeStorage.type,
            local: null,
            s3: null,
            same: null
        };

        // Local FS hash (always available — localFs is always present).
        try {
            const buf = await this.readDatabaseBin('local');
            if (buf) {
                result.local = { exists: true, hash: hashBuffer(buf), size: buf.length };
            } else {
                result.local = { exists: false, hash: null, size: 0 };
            }
        } catch (err) {
            result.local = { exists: false, hash: null, size: 0, error: err.message };
        }

        // S3 hash (only when S3 is configured).
        if (this.s3Storage) {
            try {
                const buf = await this.readDatabaseBin('s3');
                if (buf) {
                    result.s3 = { exists: true, hash: hashBuffer(buf), size: buf.length };
                } else {
                    result.s3 = { exists: false, hash: null, size: 0 };
                }
            } catch (err) {
                result.s3 = { exists: false, hash: null, size: 0, error: err.message };
            }
        }

        if (result.local && result.s3) {
            if (!result.local.exists || !result.s3.exists) {
                result.same = result.local.exists === result.s3.exists;
            } else {
                result.same = result.local.hash === result.s3.hash;
            }
        }
        return result;
    }
}

module.exports = {
    isHex,
    hexToKey,
    keyToHex,
    getContentType,
    isImageKey,
    createThumbnailBuffer,
    runWithConcurrency,
    LocalFsStorage,
    S3AssetStorage,
    AssetStorageManager
};
