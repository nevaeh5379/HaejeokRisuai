import type { ChatModelResponse } from "./types.cjs";
import type { ProviderRoute } from "./providerRouting.cjs";

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

export function canExecuteProviderRoute<TRequest, TContext = unknown>(
  format: number,
  handlers: ProviderHandlers<TRequest, TContext>,
): boolean;
export function executeProviderRoute<TRequest, TContext = unknown>(
  format: number,
  request: TRequest,
  handlers: ProviderHandlers<TRequest, TContext>,
  options?: ExecuteProviderRouteOptions<TContext>,
): Promise<ChatModelResponse>;
