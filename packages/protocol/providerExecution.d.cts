import type { ChatFailureResponse, ChatSuccessResponse } from "../chat-core/types.cjs";
import type { ProviderRoute } from "../chat-core/providerRouting.cjs";

export interface NodeProviderExecutionRequest {
  format: number;
  payload: Record<string, unknown>;
}

export type NodeProviderSerializableResponse = ChatSuccessResponse | ChatFailureResponse;

export type NodeProviderExecutionResult =
  | { handled: false }
  | { handled: true; response: NodeProviderSerializableResponse };

export interface NodeProviderCapabilities {
  routes: ProviderRoute[];
}

export function normalizeNodeProviderExecutionRequest(input: unknown):
  | { value: NodeProviderExecutionRequest }
  | { error: string };
