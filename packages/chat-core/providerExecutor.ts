import type { ChatModelResponse } from "./types.ts";
import type { ProviderRoute } from "./providerRouting.ts";
import { resolveProviderRoute } from "./providerRouting.ts";

export type ProviderHandler<TRequest, TContext = unknown> = (
  request: TRequest,
  context?: TContext,
) => Promise<ChatModelResponse>;

export type ProviderHandlers<TRequest, TContext = unknown> = Partial<
  Record<ProviderRoute, ProviderHandler<TRequest, TContext>>
>;

export interface ProviderExecutor<TRequest> {
  execute(format: number, request: TRequest): Promise<ChatModelResponse>;
}

export interface ExecuteProviderRouteOptions<TContext = unknown> {
  unknownModelMessage?: string;
  unsupportedRouteMessage?: (route: ProviderRoute) => string;
  context?: TContext;
}

function canExecuteProviderRoute<TRequest, TContext = unknown>(
  format: number,
  handlers: ProviderHandlers<TRequest, TContext>,
): boolean {
  const route = resolveProviderRoute(format);
  return Boolean(route && typeof handlers?.[route] === "function");
}

async function executeProviderRoute<TRequest, TContext = unknown>(
  format: number,
  request: TRequest,
  handlers: ProviderHandlers<TRequest, TContext>,
  options: ExecuteProviderRouteOptions<TContext> = {},
): Promise<ChatModelResponse> {
  const route = resolveProviderRoute(format);
  if (!route) {
    return {
      type: "fail",
      result: options.unknownModelMessage || "Unknown model",
      noRetry: true,
    };
  }

  const handler = handlers?.[route];
  if (typeof handler !== "function") {
    return {
      type: "fail",
      result:
        options.unsupportedRouteMessage?.(route) ||
        `Unsupported provider route: ${route}`,
      noRetry: true,
    };
  }

  if (options.context === undefined) return handler(request);
  return handler(request, options.context);
}

export { canExecuteProviderRoute, executeProviderRoute };
