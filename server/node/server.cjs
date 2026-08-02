const express = require('express');
const app = express();
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
const http = require('http');
const path = require('path');
const net = require('net');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const {once} = require('events')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
const openid = require('openid-client');

let password = ''
let knownPublicKeysHashes = []

const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

const knownPublicKeysPath = path.join(process.cwd(), 'save', '__known_public_key_hashes.json')
if(existsSync(knownPublicKeysPath)){
    const knownPublicKeysRaw = readFileSync(knownPublicKeysPath, 'utf-8');
    knownPublicKeysHashes = JSON.parse(knownPublicKeysRaw);
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const hexRegex = /^[0-9a-fA-F]+$/;
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 30000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_PENDING_EVENTS = 512;
const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const proxyStreamJobs = new Map();
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
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false){
    try {
        const authHeader = normalizeAuthHeader(req.headers['risu-auth']);

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
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
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
const BACKUP_RESTORE_CONTENT_TYPE = 'application/x-risu-backup';
const BACKUP_RESTORE_MAX_NAME_BYTES = 1024 * 1024;
const BACKUP_RESTORE_MAX_FILES = 100000;
const BACKUP_RESTORE_SESSION_TTL_MS = 30 * 60 * 1000;
const backupRestoreSessions = new Map();

function isBackupRestoreSpecialEntry(name) {
    return name === 'database.risudat'
        || name === 'encryption.risudat'
        || /^(?:coldstorage[/_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/.test(name);
}

async function removeBackupRestoreFiles(files) {
    await Promise.all(files.map((file) =>
        fs.rm(file.temporaryPath, { force: true }).catch(() => {})
    ));
}

async function removeBackupRestoreSession(restoreId) {
    const session = backupRestoreSessions.get(restoreId);
    if (!session) return;
    backupRestoreSessions.delete(restoreId);
    if (session.cleanupTimer) {
        clearTimeout(session.cleanupTimer);
    }
    await removeBackupRestoreFiles(Array.from(session.entries.values()));
}

async function cleanExpiredBackupRestoreSessions() {
    const expiredBefore = Date.now() - BACKUP_RESTORE_SESSION_TTL_MS;
    for (const [restoreId, session] of backupRestoreSessions) {
        if (session.createdAt < expiredBefore) {
            await removeBackupRestoreSession(restoreId);
        }
    }
}

function createBulkProtocolError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

app.post('/api/restore-backup', authenticatedRouteLimiter, async(req, res, next) => {
    if (!await checkAuth(req, res)) return;

    if (!req.is(BACKUP_RESTORE_CONTENT_TYPE)) {
        res.status(415).send({ error: `Content-Type must be ${BACKUP_RESTORE_CONTENT_TYPE}` });
        return;
    }

    await cleanExpiredBackupRestoreSessions();

    const restoreId = crypto.randomUUID();
    const completedFiles = [];
    const entryNames = new Set();
    let currentFile = null;
    let phase = 'nameLength';
    const lengthBuffer = Buffer.alloc(4);
    let lengthOffset = 0;
    let nameBuffer = null;
    let nameOffset = 0;
    let entryName = '';
    let entryDataLength = 0;
    let entryDataReceived = 0;
    let fileCount = 0;

    const cleanup = async() => {
        if (currentFile) {
            try {
                await currentFile.fileHandle.close();
            } catch {}
        }
        await removeBackupRestoreFiles(completedFiles);
    };

    const startEntry = async() => {
        if (entryNames.has(entryName)) {
            throw createBulkProtocolError(`Duplicate backup entry: ${entryName}`);
        }
        if (fileCount >= BACKUP_RESTORE_MAX_FILES) {
            throw createBulkProtocolError('Too many backup entries');
        }

        const temporaryPath = path.join(savePath, `__restore-${restoreId}-${crypto.randomUUID()}`);
        currentFile = {
            name: entryName,
            dataLength: entryDataLength,
            temporaryPath,
            fileHandle: await fs.open(temporaryPath, 'wx'),
            special: isBackupRestoreSpecialEntry(entryName)
        };
        entryNames.add(entryName);
        fileCount += 1;
    };

    const finishEntry = async() => {
        await currentFile.fileHandle.close();
        delete currentFile.fileHandle;
        completedFiles.push(currentFile);
        currentFile = null;
        entryName = '';
        entryDataLength = 0;
        entryDataReceived = 0;
        phase = 'nameLength';
    };

    try {
        for await (const incomingChunk of req) {
            let chunkOffset = 0;
            while (chunkOffset < incomingChunk.length) {
                if (phase === 'nameLength' || phase === 'dataLength') {
                    const copyLength = Math.min(
                        lengthBuffer.length - lengthOffset,
                        incomingChunk.length - chunkOffset
                    );
                    incomingChunk.copy(
                        lengthBuffer,
                        lengthOffset,
                        chunkOffset,
                        chunkOffset + copyLength
                    );
                    lengthOffset += copyLength;
                    chunkOffset += copyLength;
                    if (lengthOffset < lengthBuffer.length) continue;

                    const length = lengthBuffer.readUInt32LE(0);
                    lengthOffset = 0;
                    if (phase === 'nameLength') {
                        if (length === 0 || length > BACKUP_RESTORE_MAX_NAME_BYTES) {
                            throw createBulkProtocolError('Invalid backup entry name length');
                        }
                        nameBuffer = Buffer.alloc(length);
                        nameOffset = 0;
                        phase = 'name';
                    } else {
                        entryDataLength = length;
                        entryDataReceived = 0;
                        await startEntry();
                        phase = 'data';
                        if (entryDataLength === 0) {
                            await finishEntry();
                        }
                    }
                    continue;
                }

                if (phase === 'name') {
                    const copyLength = Math.min(
                        nameBuffer.length - nameOffset,
                        incomingChunk.length - chunkOffset
                    );
                    incomingChunk.copy(
                        nameBuffer,
                        nameOffset,
                        chunkOffset,
                        chunkOffset + copyLength
                    );
                    nameOffset += copyLength;
                    chunkOffset += copyLength;
                    if (nameOffset === nameBuffer.length) {
                        entryName = nameBuffer.toString('utf8');
                        nameBuffer = null;
                        phase = 'dataLength';
                    }
                    continue;
                }

                const copyLength = Math.min(
                    entryDataLength - entryDataReceived,
                    incomingChunk.length - chunkOffset
                );
                await writeFileChunk(
                    currentFile.fileHandle,
                    incomingChunk.subarray(chunkOffset, chunkOffset + copyLength)
                );
                entryDataReceived += copyLength;
                chunkOffset += copyLength;
                if (entryDataReceived === entryDataLength) {
                    await finishEntry();
                }
            }
        }

        if (phase !== 'nameLength' || lengthOffset !== 0 || currentFile) {
            throw createBulkProtocolError('Backup ended with an incomplete entry');
        }

        const specialEntries = new Map();
        for (const file of completedFiles) {
            if (file.special) {
                specialEntries.set(file.name, file);
                continue;
            }
            const storageKey = `assets/${file.name}`;
            const targetPath = path.join(savePath, Buffer.from(storageKey, 'utf8').toString('hex'));
            await fs.rename(file.temporaryPath, targetPath);
        }

        const specialFiles = Array.from(specialEntries.values());
        if (specialFiles.length > 0) {
            const session = {
                createdAt: Date.now(),
                entries: specialEntries,
                cleanupTimer: null
            };
            session.cleanupTimer = setTimeout(() => {
                removeBackupRestoreSession(restoreId).catch((error) => {
                    console.error('Failed to clean expired backup restore session:', error);
                });
            }, BACKUP_RESTORE_SESSION_TTL_MS);
            session.cleanupTimer.unref?.();
            backupRestoreSessions.set(restoreId, session);
        }

        res.send({
            restoreId,
            entries: Array.from(specialEntries.keys())
        });
    } catch (error) {
        await cleanup();
        if (error?.statusCode) {
            res.status(error.statusCode).send({ error: error.message });
            return;
        }
        next(error);
    }
});

app.get('/api/restore-backup-entry', authenticatedRouteLimiter, async(req, res, next) => {
    if (!await checkAuth(req, res)) return;

    const restoreId = req.headers['restore-id'];
    const encodedName = req.headers['entry-name'];
    const session = typeof restoreId === 'string'
        ? backupRestoreSessions.get(restoreId)
        : null;
    if (!session || typeof encodedName !== 'string') {
        res.status(404).send({ error: 'Backup restore session not found' });
        return;
    }

    if (encodedName.length % 2 !== 0 || !hexRegex.test(encodedName)) {
        res.status(400).send({ error: 'Invalid backup entry name' });
        return;
    }
    const name = Buffer.from(encodedName, 'hex').toString('utf8');
    const file = session.entries.get(name);
    if (!file) {
        res.status(404).send({ error: 'Backup entry not found' });
        return;
    }

    try {
        res.type('application/octet-stream');
        const fileHandle = await fs.open(file.temporaryPath, 'r');
        await pipeline(fileHandle.createReadStream(), res);
    } catch (error) {
        next(error);
    }
});

app.delete('/api/restore-backup-session', authenticatedRouteLimiter, async(req, res) => {
    if (!await checkAuth(req, res)) return;
    const restoreId = req.headers['restore-id'];
    if (typeof restoreId === 'string') {
        await removeBackupRestoreSession(restoreId);
    }
    res.send({ success: true });
});

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

    const filePaths = req.body?.filePaths

    if (!Array.isArray(filePaths)) {
        res.status(400).send({
            error: "filePaths isn't an array."
        });
        return;
    }
    let fileId = 0;
    for (const filePath of filePaths) {
        const fileHandle = await fs.open(path.join(savePath, filePath), 'r')
        const stat = await fileHandle.stat()
        const name = Buffer.from(filePath, 'hex').toString('utf8')
        try {
            await writePacket(res, createHeaderPacket(fileId, name, stat.size));

            const stream = fileHandle.createReadStream({autoClose: false})
            for await (const chunk of stream) {
                await writePacket(res, createChunkPacket(fileId, chunk))
            }
            await writePacket(res, createEndPacket(fileId))
            fileId += 1;
        } catch {

        } finally {
            await fileHandle.close();
        }
    }

    res.end();
})

app.post('/api/write-bulk', authenticatedRouteLimiter, async(req, res, next) => {
    if (!await checkAuth(req, res)) return;

    if (!req.is(BULK_WRITE_CONTENT_TYPE)) {
        res.status(415).send({ error: `Content-Type must be ${BULK_WRITE_CONTENT_TYPE}` });
        return;
    }

    const receivingFiles = new Map();
    const targetPaths = new Set();
    const completedFiles = [];
    let pending = Buffer.alloc(0);
    let fileCount = 0;

    const cleanup = async() => {
        const temporaryFiles = [];
        for (const file of receivingFiles.values()) {
            try {
                await file.fileHandle.close();
            } catch {}
            temporaryFiles.push(file.temporaryPath);
        }
        for (const file of completedFiles) {
            temporaryFiles.push(file.temporaryPath);
        }
        await Promise.all(temporaryFiles.map((temporaryPath) =>
            fs.rm(temporaryPath, { force: true }).catch(() => {})
        ));
    };

    try {
        for await (const incomingChunk of req) {
            pending = Buffer.concat([pending, incomingChunk]);
            let offset = 0;

            while (offset < pending.length) {
                const available = pending.length - offset;
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

                    const nameStart = offset + 9;
                    const nameEnd = nameStart + nameLength;
                    const name = pending.subarray(nameStart, nameEnd).toString('utf8');
                    const expectedSize = pending.readBigUInt64BE(nameEnd);
                    const encodedName = Buffer.from(name, 'utf8').toString('hex');
                    const targetPath = path.join(savePath, encodedName);
                    if (targetPaths.has(targetPath)) {
                        throw createBulkProtocolError(`Duplicate bulk file name: ${name}`);
                    }

                    const temporaryPath = path.join(savePath, `__bulk-${crypto.randomUUID()}`);
                    const fileHandle = await fs.open(temporaryPath, 'wx');
                    receivingFiles.set(fileId, {
                        name,
                        expectedSize,
                        receivedSize: 0n,
                        targetPath,
                        temporaryPath,
                        fileHandle
                    });
                    targetPaths.add(targetPath);
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

                    const packetLength = 1 + 4 + 4 + chunkSize;
                    if (available < packetLength) break;

                    const file = receivingFiles.get(fileId);
                    if (!file) {
                        throw createBulkProtocolError(`Chunk for unknown bulk file ID: ${fileId}`);
                    }

                    const nextSize = file.receivedSize + BigInt(chunkSize);
                    if (nextSize > file.expectedSize) {
                        throw createBulkProtocolError(`Too much data for bulk file: ${file.name}`);
                    }

                    await writeFileChunk(
                        file.fileHandle,
                        pending.subarray(offset + 9, offset + packetLength)
                    );
                    file.receivedSize = nextSize;
                    offset += packetLength;
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

                    await file.fileHandle.close();
                    receivingFiles.delete(fileId);
                    completedFiles.push(file);
                    offset += 5;
                    continue;
                }

                throw createBulkProtocolError(`Unknown bulk packet type: ${type}`);
            }

            pending = pending.subarray(offset);
        }

        if (pending.length !== 0 || receivingFiles.size !== 0) {
            throw createBulkProtocolError('Bulk write request ended with an incomplete packet');
        }

        for (const file of completedFiles) {
            await fs.rename(file.temporaryPath, file.targetPath);
        }
        completedFiles.length = 0;

        res.send({ success: true, written: fileCount });
    } catch (error) {
        await cleanup();
        if (error?.statusCode) {
            res.status(error.statusCode).send({ error: error.message });
            return;
        }
        next(error);
    }
})

app.get('/api/read', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
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
    try {
        if(!existsSync(path.join(savePath, filePath))){
            res.send();
        }
        else{
            res.setHeader('Content-Type','application/octet-stream');
            res.sendFile(path.join(savePath, filePath));
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

        try {
            await fs.rm(path.join(savePath, filePath));
            res.send({
                success: true,
            });
        } catch (error) {
            next(error);
        }
    }
    
});

app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const data = (await fs.readdir(path.join(savePath))).map((v) => {
            return Buffer.from(v, 'hex').toString('utf-8')
        })
        res.send({
            success: true,
            content: data
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
    const fileContent = req.body
    if (!filePath || !fileContent) {
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

    try {
        await fs.writeFile(path.join(savePath, filePath), fileContent);
        res.send({
            success: true
        });
    } catch (error) {
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
        const discovery = await openid.discovery('https://account.sionyw.com/','','');
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

    let tokens = await openid.authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    writeFileSync(authCodePath, tokens.access_token, 'utf-8')

    res.send(tokens)
            
})

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
