'use strict';

const { resolveProviderRoute } = require('./providerRouting.cjs');

function canExecuteProviderRoute(format, handlers) {
  const route = resolveProviderRoute(format);
  return Boolean(route && typeof handlers?.[route] === 'function');
}

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

  if (options.context === undefined) return handler(request);
  return handler(request, options.context);
}

module.exports = { canExecuteProviderRoute, executeProviderRoute };
