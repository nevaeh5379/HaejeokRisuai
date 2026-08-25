import type { ChatModelResponse } from "./types.cjs";
import type { ProviderRoute } from "./providerRouting.cjs";

export type ProviderHandler<TRequest> = (
  request: TRequest,
) => Promise<ChatModelResponse>;

export type ProviderHandlers<TRequest> = Partial<
  Record<ProviderRoute, ProviderHandler<TRequest>>
>;

export interface ProviderExecutor<TRequest> {
  execute(format: number, request: TRequest): Promise<ChatModelResponse>;
}

export interface ExecuteProviderRouteOptions {
  unknownModelMessage?: string;
  unsupportedRouteMessage?: (route: ProviderRoute) => string;
}

export function executeProviderRoute<TRequest>(
  format: number,
  request: TRequest,
  handlers: ProviderHandlers<TRequest>,
  options?: ExecuteProviderRouteOptions,
): Promise<ChatModelResponse>;
