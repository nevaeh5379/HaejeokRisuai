'use strict';

const {
  canExecuteProviderRoute,
  executeProviderRoute,
} = require('../../packages/chat-core/providerExecutor.cjs');
const { resolveProviderRoute } = require('../../packages/chat-core/providerRouting.cjs');
const { LLM_FORMATS } = require('../../packages/protocol/modelFormat.cjs');
const {
  normalizeNodeProviderExecutionRequest,
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

function createNodeProviderExecutor({
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  extraHandlers = {},
  extraFormats = [],
} = {}) {
  const handlers = {
    echo: async (payload) => {
      const input = normalizeEchoPayload(payload);
      if (input.delayMs > 0) await sleep(input.delayMs);
      return { type: 'success', result: input.message };
    },
    ...extraHandlers,
  };
  const formats = Object.freeze([LLM_FORMATS.Echo, ...extraFormats]);
  const supportedFormats = new Set(formats);
  const routes = Object.freeze([...new Set(formats.map(resolveProviderRoute).filter(Boolean))]);

  function supports(format) {
    return supportedFormats.has(format) && canExecuteProviderRoute(format, handlers);
  }

  async function execute(rawInput) {
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
      response: await executeProviderRoute(input.format, input.payload, handlers),
    };
  }

  function registerRoutes(app, { auth, limiter } = {}) {
    const guards = limiter ? [limiter] : [];
    app.get('/api/chat-executor/providers', ...guards, async (req, res) => {
      if (auth && !await auth(req, res)) return;
      res.send({ formats, routes });
    });

    app.post('/api/chat-executor/provider', ...guards, async (req, res, next) => {
      if (auth && !await auth(req, res)) return;
      try {
        res.send(await execute(req.body));
      } catch (error) {
        if (
          error?.code === 'invalid_provider_execution' ||
          error instanceof TypeError ||
          error instanceof RangeError
        ) {
          res.status(400).send({ error: error.message });
          return;
        }
        next(error);
      }
    });
  }

  return {
    formats,
    routes,
    supports,
    execute,
    registerRoutes,
    resolveRoute: resolveProviderRoute,
  };
}

module.exports = { createNodeProviderExecutor };
