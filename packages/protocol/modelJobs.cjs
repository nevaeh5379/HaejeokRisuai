'use strict';

const MODEL_JOB_STATUSES = Object.freeze(['running', 'done', 'failed', 'aborted']);
const MODEL_JOB_TERMINAL_STATUSES = Object.freeze(['done', 'failed', 'aborted']);
const MODEL_JOB_FILTERS = Object.freeze(['active', 'unclaimed']);
const DEFAULT_MODEL_JOB_MAX_BODY_BYTES = 16 * 1024 * 1024;

function normalizeModelJobCreateRequest(arg, { maxBodyBytes = DEFAULT_MODEL_JOB_MAX_BODY_BYTES } = {}) {
    const chatId = typeof arg?.chatId === 'string' ? arg.chatId : '';
    if (!chatId) return { error: 'chatId is required', httpStatus: 400 };

    let parsedUrl;
    try {
        parsedUrl = new URL(String(arg?.targetUrl || ''));
    } catch {
        return { error: 'Invalid target URL', httpStatus: 400 };
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { error: 'Invalid target URL', httpStatus: 400 };
    }

    const method = typeof arg?.method === 'string' ? arg.method.toUpperCase() : 'POST';
    if (method !== 'POST') return { error: 'Invalid method', httpStatus: 400 };

    const body = typeof arg?.body === 'string' ? arg.body : '';
    if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
        return { error: 'Request body too large', httpStatus: 413 };
    }

    return {
        value: {
            targetUrl: parsedUrl.toString(),
            targetOrigin: `${parsedUrl.origin}${parsedUrl.pathname}`,
            method,
            headers: arg?.headers,
            body,
            chatId,
            generationId: typeof arg?.generationId === 'string' ? arg.generationId : null,
            protocol: typeof arg?.protocol === 'string' ? arg.protocol : 'unknown',
            model: typeof arg?.model === 'string' ? arg.model.slice(0, 160) : null,
            speakerId: typeof arg?.speakerId === 'string' ? arg.speakerId.slice(0, 160) : null,
            streaming: arg?.streaming === true,
            recoverable: arg?.recoverable !== false,
            timeoutMs: arg?.timeoutMs,
        },
    };
}

module.exports = {
    MODEL_JOB_STATUSES,
    MODEL_JOB_TERMINAL_STATUSES,
    MODEL_JOB_FILTERS,
    DEFAULT_MODEL_JOB_MAX_BODY_BYTES,
    normalizeModelJobCreateRequest,
};
