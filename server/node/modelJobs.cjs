'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { once } = require('events');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const TAIL_WAIT_MS = 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RETAIN_TERMINAL = 50;
const RETAIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const TERMINAL = new Set(['done', 'failed', 'aborted']);

function normalizeTimeout(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(parsed)));
}

function normalizeHeaders(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    const blocked = new Set([
        'connection', 'content-length', 'host', 'proxy-authorization',
        'proxy-authenticate', 'risu-auth', 'risu-timeout-ms', 'te',
        'trailer', 'transfer-encoding', 'upgrade'
    ]);
    for (const [rawKey, rawValue] of Object.entries(input)) {
        if (typeof rawKey !== 'string' || typeof rawValue !== 'string') continue;
        const key = rawKey.toLowerCase();
        if (!blocked.has(key)) out[key] = rawValue;
    }
    out['accept-encoding'] = 'identity';
    return out;
}

function requestUpstream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const headers = { ...arg.headers, host: parsed.host };
        if (arg.bodyBuffer) headers['content-length'] = String(arg.bodyBuffer.length);
        let settled = false;
        let upstreamResponse = null;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const req = client.request(parsed, { method: arg.method, headers }, (res) => {
            if (settled) return res.destroy();
            settled = true;
            upstreamResponse = res;
            resolve({
                status: res.statusCode || 502,
                headers: res.headers,
                body: res
            });
        });
        req.on('error', fail);
        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });
        if (arg.signal) {
            const abort = () => {
                const error = new Error('Model job aborted');
                error.name = 'AbortError';
                upstreamResponse?.destroy(error);
                req.destroy(error);
            };
            if (arg.signal.aborted) return abort();
            arg.signal.addEventListener('abort', abort, { once: true });
        }
        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

function createModelJobManager({ saveDir, logger = console } = {}) {
    const root = path.join(saveDir || path.join(process.cwd(), 'save'), 'model-jobs');
    const metadataPath = path.join(root, 'index.json');
    fs.mkdirSync(root, { recursive: true });

    let records = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (Array.isArray(parsed)) records = parsed;
    } catch { /* first run or damaged sidecar */ }

    const activeJobs = new Map();
    let writeChain = Promise.resolve();

    function journalPath(jobId) {
        return path.join(root, `${jobId}.journal`);
    }

    function persist() {
        const snapshot = JSON.stringify(records, null, 2);
        writeChain = writeChain.then(async () => {
            const tmp = `${metadataPath}.tmp`;
            await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
            await fsp.rename(tmp, metadataPath);
        }).catch((error) => logger.error('[model-jobs] metadata write failed', error));
        return writeChain;
    }

    function findRecord(jobId) {
        return records.find((record) => record.id === jobId) || null;
    }

    function publicRecord(record) {
        if (!record) return null;
        return { ...record, bytes: activeJobs.get(record.id)?.bytesWritten ?? record.bytes ?? 0 };
    }
    function notify(job) {
        const waiters = job.waiters.splice(0);
        for (const wake of waiters) wake();
    }

    function waitForEvent(jobId) {
        const job = activeJobs.get(jobId);
        if (!job) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const index = job.waiters.indexOf(wake);
                if (index >= 0) job.waiters.splice(index, 1);
                resolve();
            }, TAIL_WAIT_MS);
            const wake = () => {
                clearTimeout(timer);
                resolve();
            };
            job.waiters.push(wake);
            if (!activeJobs.has(jobId)) notify(job);
        });
    }

    function cleanup() {
        const now = Date.now();
        const terminal = records.filter((record) => TERMINAL.has(record.status));
        const removable = terminal
            .filter((record) => record.claimed || record.recoverable === false)
            .filter((record) => (record.endedAt || record.createdAt) < now - RETAIN_AGE_MS);
        const protectedIds = new Set(records.filter((record) => !record.claimed && record.recoverable !== false).map((record) => record.id));
        const overflow = terminal.slice().sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt)).slice(RETAIN_TERMINAL);
        const deleteIds = new Set(removable.map((record) => record.id));
        for (const record of overflow) {
            if (!protectedIds.has(record.id)) deleteIds.add(record.id);
        }
        if (deleteIds.size === 0) return;
        records = records.filter((record) => !deleteIds.has(record.id));
        for (const id of deleteIds) {
            try { fs.unlinkSync(journalPath(id)); } catch { /* already gone */ }
        }
        void persist();
    }

    async function runJob(job, arg) {
        const stream = fs.createWriteStream(journalPath(job.id), { flags: 'a' });
        let writeError = null;
        stream.on('error', (error) => { writeError ||= error; });
        let failure = null;
        try {
            const upstream = await requestUpstream(arg.targetUrl, {
                method: arg.method,
                headers: arg.headers,
                bodyBuffer: arg.bodyBuffer,
                timeoutMs: arg.timeoutMs,
                signal: job.controller.signal
            });
            const record = findRecord(job.id);
            if (record) {
                record.upstreamStatus = upstream.status;
                record.contentType = upstream.headers['content-type'] || null;
                await persist();
            }
            for await (const chunk of upstream.body) {
                if (job.controller.signal.aborted) break;
                if (!chunk || chunk.length === 0) continue;
                if (writeError) throw writeError;
                const ok = stream.write(chunk);
                job.bytesWritten += chunk.length;
                notify(job);
                if (!ok) await once(stream, 'drain');
            }
            if (writeError) throw writeError;
            if (job.controller.signal.aborted) {
                const error = new Error('Model job aborted');
                error.name = 'AbortError';
                throw error;
            }
        } catch (error) {
            failure = error;
        } finally {
            await new Promise((resolve) => stream.end(resolve));
            if (!failure && writeError) failure = writeError;
            const record = findRecord(job.id);
            if (record) {
                record.status = !failure
                    ? 'done'
                    : (failure.name === 'AbortError' || job.controller.signal.aborted)
                        ? 'aborted'
                        : 'failed';
                record.error = record.status === 'failed' ? String(failure?.message || failure) : null;
                record.endedAt = Date.now();
                record.bytes = job.bytesWritten;
                await persist();
            }
            activeJobs.delete(job.id);
            notify(job);
        }
    }
    function createJob(arg) {
        const chatId = typeof arg?.chatId === 'string' ? arg.chatId : '';
        if (!chatId) return { error: 'chatId is required', httpStatus: 400 };
        let parsedUrl;
        try { parsedUrl = new URL(String(arg.targetUrl || '')); }
        catch { return { error: 'Invalid target URL', httpStatus: 400 }; }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return { error: 'Invalid target URL', httpStatus: 400 };
        }
        const method = typeof arg.method === 'string' ? arg.method.toUpperCase() : 'POST';
        if (method !== 'POST') return { error: 'Invalid method', httpStatus: 400 };
        const body = typeof arg.body === 'string' ? arg.body : '';
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
            return { error: 'Request body too large', httpStatus: 413 };
        }
        const recoverable = arg.recoverable !== false;
        if (recoverable) {
            const running = records.find((record) =>
                record.chatId === chatId && record.status === 'running' && record.recoverable !== false
            );
            if (running) {
                return { error: 'A generation is already running for this chat', httpStatus: 409, jobId: running.id };
            }
        }

        const id = crypto.randomUUID();
        const createdAt = Date.now();
        const record = {
            id, chatId,
            generationId: typeof arg.generationId === 'string' ? arg.generationId : null,
            protocol: typeof arg.protocol === 'string' ? arg.protocol : 'unknown',
            model: typeof arg.model === 'string' ? arg.model.slice(0, 160) : null,
            speakerId: typeof arg.speakerId === 'string' ? arg.speakerId.slice(0, 160) : null,
            targetOrigin: `${parsedUrl.origin}${parsedUrl.pathname}`,
            streaming: arg.streaming === true,
            recoverable,
            status: 'running',
            upstreamStatus: null,
            contentType: null,
            error: null,
            createdAt,
            endedAt: null,
            bytes: 0,
            claimed: false
        };
        records.push(record);
        fs.closeSync(fs.openSync(journalPath(id), 'w'));
        const job = {
            id,
            controller: new AbortController(),
            waiters: [],
            bytesWritten: 0
        };
        activeJobs.set(id, job);
        void persist();
        const runPromise = runJob(job, {
            targetUrl: parsedUrl.toString(),
            method,
            headers: normalizeHeaders(arg.headers),
            bodyBuffer: body ? Buffer.from(body, 'utf8') : undefined,
            timeoutMs: normalizeTimeout(arg.timeoutMs)
        }).catch((error) => logger.error('[model-jobs] run failed', error));
        return { jobId: id, runPromise };
    }

    function getJob(jobId) {
        return publicRecord(findRecord(jobId));
    }

    function listJobs(filter) {
        if (filter === 'active') {
            return records
                .filter((record) => record.status === 'running' && record.recoverable !== false)
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(publicRecord);
        }
        if (filter === 'unclaimed') {
            return records
                .filter((record) => TERMINAL.has(record.status) && record.status !== 'aborted')
                .filter((record) => record.recoverable !== false && !record.claimed)
                .sort((a, b) => a.createdAt - b.createdAt)
                .map(publicRecord);
        }
        return null;
    }

    async function claimJob(jobId) {
        const record = findRecord(jobId);
        if (!record) return { error: 'Job not found', httpStatus: 404 };
        if (!TERMINAL.has(record.status)) {
            return { error: 'Job is still running', httpStatus: 409 };
        }
        record.claimed = true;
        await persist();
        return { success: true };
    }

    async function deleteJob(jobId) {
        const record = findRecord(jobId);
        if (!record) return { error: 'Job not found', httpStatus: 404 };
        const active = activeJobs.get(jobId);
        if (active) {
            active.controller.abort();
            return { success: true, aborted: true };
        }
        records = records.filter((item) => item.id !== jobId);
        try { await fsp.unlink(journalPath(jobId)); } catch { /* already gone */ }
        await persist();
        return { success: true, deleted: true };
    }

    async function streamJob(jobId, res) {
        let record = findRecord(jobId);
        if (!record) {
            res.status(404).send({ error: 'Job not found' });
            return;
        }
        let clientGone = false;
        res.on('close', () => { clientGone = true; });

        while (!clientGone && record.status === 'running' && record.upstreamStatus == null && activeJobs.has(jobId)) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            record = findRecord(jobId);
            if (!record) return;
        }
        if (clientGone) return;
        res.status(200);
        res.set('content-type', record.contentType || 'application/octet-stream');
        res.set('cache-control', 'no-cache, no-transform');
        res.set('x-accel-buffering', 'no');
        res.set('x-model-job-id', record.id);
        res.set('x-model-job-status', record.status);
        if (record.upstreamStatus != null) {
            res.set('x-model-job-upstream-status', String(record.upstreamStatus));
        }
        res.flushHeaders();

        let handle;
        try {
            handle = await fsp.open(journalPath(jobId), 'r');
        } catch {
            res.end();
            return;
        }
        try {
            let offset = 0;
            let sawTerminal = false;
            while (!clientGone) {
                const buffer = Buffer.allocUnsafe(64 * 1024);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                if (bytesRead > 0) {
                    offset += bytesRead;
                    const ok = res.write(buffer.subarray(0, bytesRead));
                    if (!ok && !clientGone) {
                        await Promise.race([once(res, 'drain'), once(res, 'close')]);
                    }
                    continue;
                }
                if (sawTerminal) break;
                if (!activeJobs.has(jobId)) {
                    sawTerminal = true;
                    continue;
                }
                await waitForEvent(jobId);
            }
        } finally {
            await handle.close();
        }
        if (!clientGone) res.end();
    }

    function registerRoutes(app, { auth, limiter } = {}) {
        const guards = limiter ? [limiter] : [];
        const ensureAuth = async (req, res) => !auth || await auth(req, res);

        app.post('/api/model-jobs', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            const result = createJob({
                targetUrl: req.body?.targetUrl,
                method: req.body?.method,
                headers: req.body?.headers,
                body: req.body?.body,
                chatId: req.body?.chatId,
                generationId: req.body?.generationId,
                protocol: req.body?.protocol,
                model: req.body?.model,
                speakerId: req.body?.speakerId,
                streaming: req.body?.streaming === true,
                recoverable: req.body?.recoverable !== false,
                timeoutMs: req.body?.timeoutMs
            });
            if (result.error) {
                res.status(result.httpStatus || 400).send({ error: result.error, jobId: result.jobId });
                return;
            }
            res.send({ jobId: result.jobId });
        });

        app.get('/api/model-jobs', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            const filter = req.query.active ? 'active' : req.query.unclaimed ? 'unclaimed' : null;
            const jobs = listJobs(filter);
            if (!jobs) return res.status(400).send({ error: 'active=1 or unclaimed=1 is required' });
            res.send({ jobs });
        });

        app.get('/api/model-jobs/:id/stream', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            await streamJob(req.params.id, res);
        });

        app.get('/api/model-jobs/:id', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            const job = getJob(req.params.id);
            if (!job) return res.status(404).send({ error: 'Job not found' });
            res.send(job);
        });

        app.post('/api/model-jobs/:id/claim', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            const result = await claimJob(req.params.id);
            if (result.error) return res.status(result.httpStatus || 400).send({ error: result.error });
            res.send(result);
        });

        app.delete('/api/model-jobs/:id', ...guards, async (req, res) => {
            if (!await ensureAuth(req, res)) return;
            const result = await deleteJob(req.params.id);
            if (result.error) return res.status(result.httpStatus || 400).send({ error: result.error });
            res.send(result);
        });
    }

    const restartTime = Date.now();
    let recoveredRestartRows = false;
    for (const record of records) {
        if (record.status !== 'running') continue;
        record.status = 'failed';
        record.error = 'server restart interrupted the upstream request';
        record.endedAt = restartTime;
        recoveredRestartRows = true;
    }
    if (recoveredRestartRows) void persist();

    cleanup();
    const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();

    return {
        registerRoutes,
        createJob,
        getJob,
        listJobs,
        claimJob,
        deleteJob,
        streamJob,
        cleanup,
        journalPath,
        async close() {
            clearInterval(cleanupTimer);
            for (const job of activeJobs.values()) job.controller.abort();
            await Promise.allSettled([...activeJobs.keys()].map(async (id) => {
                while (activeJobs.has(id)) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }));
            await writeChain;
        }
    };
}

module.exports = {
    createModelJobManager,
    normalizeHeaders
};
