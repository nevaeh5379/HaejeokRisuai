'use strict';

const { resolveProviderRoute } = require('./providerRouting.cjs');

async function executeProviderRoute(format, request, handlers, options = {}) {
  const route = resolveProviderRoute(format);
  if (!route) {
    return {
      type: 'fail',
      result: options.unknownModelMessage || 'Unknown model',
      noRetry: true,
    };
  }

  const handler = handlers?.[route];
  if (typeof handler !== 'function') {
    return {
      type: 'fail',
      result: options.unsupportedRouteMessage?.(route) || `Unsupported provider route: ${route}`,
      noRetry: true,
    };
  }

  return handler(request);
}

module.exports = { executeProviderRoute };
