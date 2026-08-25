'use strict';

const {
  canExecuteProviderRoute,
  executeProviderRoute,
} = require('../../packages/chat-core/providerExecutor.cjs');
const { resolveProviderRoute } = require('../../packages/chat-core/providerRouting.cjs');
const {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
} = require('../../packages/chat-core/mistralProvider.cjs');
const {
  DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
} = require('../../packages/chat-core/openAIProvider.cjs');
const { LLM_FORMATS } = require('../../packages/protocol/modelFormat.cjs');
const {
  normalizeNodeProviderExecutionRequest,
  normalizeNodeProviderTransportRequest,
} = require('../../packages/protocol/providerExecution.cjs');

function normalizeEchoPayload(payload) {
  if (typeof payload.message !== 'string') {
    throw new TypeError('echo message must be a string');
  }
  const delayMs = payload.delayMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 3_600_000) {
    throw new RangeError('echo delayMs must be an integer from 0 to 3600000');
  }
  return { message: payload.message, delayMs };
}

function normalizeMistralPayload(payload) {
  if (!payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)) {
    throw new TypeError('mistral body must be an object');
  }
  if (typeof payload.apiKey !== 'string' || payload.apiKey.length > 16_384) {
    throw new TypeError('mistral apiKey must be a string up to 16384 characters');
  }
  const httpErrorPrefix = payload.httpErrorPrefix ?? '';
  if (typeof httpErrorPrefix !== 'string' || httpErrorPrefix.length > 4096) {
    throw new TypeError('mistral httpErrorPrefix must be a string up to 4096 characters');
  }
  const body = JSON.stringify(payload.body);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new RangeError('mistral body exceeds 16 MiB');
  }
  return { body, apiKey: payload.apiKey, httpErrorPrefix };
}

function normalizeOpenAITransportPayload(payload) {
  if (!payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)) {
    throw new TypeError('openai body must be an object');
  }
  if (!payload.headers || typeof payload.headers !== 'object' || Array.isArray(payload.headers)) {
    throw new TypeError('openai headers must be an object');
  }
  const headers = {};
  const forbiddenHeaders = new Set([
    'host',
    'connection',
    'content-length',
    'risu-auth',
  ]);
  for (const [key, value] of Object.entries(payload.headers)) {
    if (typeof value !== 'string') throw new TypeError('openai headers must contain string values');
    if (forbiddenHeaders.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const body = JSON.stringify(payload.body);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new RangeError('openai body exceeds 16 MiB');
  }
  return { body, headers };
}

function createNodeProviderExecutor({
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  fetchImpl = globalThis.fetch,
  extraHandlers = {},
  extraFormats = [],
} = {}) {
  const handlers = {
    echo: async (payload) => {
      const input = normalizeEchoPayload(payload);
      if (input.delayMs > 0) await sleep(input.delayMs);
      return { type: 'success', result: input.message };
    },
    openai: async (payload, context) => {
      const input = normalizeMistralPayload(payload);
      const response = await fetchImpl(DEFAULT_MISTRAL_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`,
        },
        body: input.body,
        signal: context?.signal,
        redirect: 'error',
      });
      const data = await response.json();
      return decodeMistralResponse(response.ok, data, input.httpErrorPrefix);
    },
    ...extraHandlers,
  };
  const formats = Object.freeze([LLM_FORMATS.Echo, LLM_FORMATS.Mistral, ...extraFormats]);
  const supportedFormats = new Set(formats);
  const routes = Object.freeze([...new Set(formats.map(resolveProviderRoute).filter(Boolean))]);
  const transportFormats = Object.freeze([LLM_FORMATS.OpenAICompatible]);
  const supportedTransportFormats = new Set(transportFormats);

  function supports(format) {
    return supportedFormats.has(format) && canExecuteProviderRoute(format, handlers);
  }

  function supportsTransport(format) {
    return supportedTransportFormats.has(format);
  }

  async function execute(rawInput, context = {}) {
    const normalized = normalizeNodeProviderExecutionRequest(rawInput);
    if (normalized.error) {
      const error = new TypeError(normalized.error);
      error.code = 'invalid_provider_execution';
      throw error;
    }
    const input = normalized.value;
    if (!supports(input.format)) return { handled: false };
    return {
      handled: true,
      response: await executeProviderRoute(input.format, input.payload, handlers, { context }),
    };
  }

  async function executeTransport(rawInput, context = {}) {
    const normalized = normalizeNodeProviderTransportRequest(rawInput);
    if (normalized.error) {
      const error = new TypeError(normalized.error);
      error.code = 'invalid_provider_transport';
      throw error;
    }
    const input = normalized.value;
    if (!supportsTransport(input.format)) return { handled: false };
    const payload = normalizeOpenAITransportPayload(input.payload);
    const response = await fetchImpl(DEFAULT_OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: payload.headers,
      body: payload.body,
      signal: context?.signal,
      redirect: 'error',
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      handled: true,
      response: { ok: response.ok, status: response.status, data },
    };
  }

  function registerRoutes(app, { auth, limiter } = {}) {
    const guards = limiter ? [limiter] : [];
    app.get('/api/chat-executor/providers', ...guards, async (req, res) => {
      if (auth && !await auth(req, res)) return;
      res.send({ formats, routes, transportFormats });
    });

    app.post('/api/chat-executor/provider', ...guards, async (req, res, next) => {
      if (auth && !await auth(req, res)) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortOnClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abort);
      res.once('close', abortOnClose);
      try {
        res.send(await execute(req.body, { signal: controller.signal }));
      } catch (error) {
        if (
          error?.code === 'invalid_provider_execution' ||
          error instanceof TypeError ||
          error instanceof RangeError
        ) {
          res.status(400).send({ error: error.message });
          return;
        }
        if (error?.name === 'AbortError' && controller.signal.aborted) return;
        next(error);
      } finally {
        req.off('aborted', abort);
        res.off('close', abortOnClose);
      }
    });

    app.post('/api/chat-executor/transport', ...guards, async (req, res, next) => {
      if (auth && !await auth(req, res)) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortOnClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abort);
      res.once('close', abortOnClose);
      try {
        res.send(await executeTransport(req.body, { signal: controller.signal }));
      } catch (error) {
        if (
          error?.code === 'invalid_provider_transport' ||
          error instanceof TypeError ||
          error instanceof RangeError
        ) {
          res.status(400).send({ error: error.message });
          return;
        }
        if (error?.name === 'AbortError' && controller.signal.aborted) return;
        next(error);
      } finally {
        req.off('aborted', abort);
        res.off('close', abortOnClose);
      }
    });
  }

  return {
    formats,
    routes,
    transportFormats,
    supports,
    supportsTransport,
    execute,
    executeTransport,
    registerRoutes,
    resolveRoute: resolveProviderRoute,
  };
}

module.exports = { createNodeProviderExecutor };
