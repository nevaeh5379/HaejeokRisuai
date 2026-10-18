import type {
  ChatFailureResponse,
  ChatSuccessResponse,
} from "../chat-core/types.ts";

import type { ProviderRoute } from "../chat-core/providerRouting.ts";

export interface NodeProviderExecutionRequest {
  format: number;
  payload: Record<string, unknown>;
}

export type NodeProviderSerializableResponse =
  ChatSuccessResponse | ChatFailureResponse;

export type NodeProviderExecutionResult =
  | { handled: false }
  | { handled: true; response: NodeProviderSerializableResponse };

export interface NodeProviderCapabilities {
  formats: number[];
  routes: ProviderRoute[];
  transportFormats?: number[];
}

export interface NodeProviderTransportRequest {
  format: number;
  payload: Record<string, unknown>;
}

export type NodeProviderTransportResult =
  | { handled: false }
  | {
      handled: true;
      response: {
        ok: boolean;
        status: number;
        data: unknown;
      };
    };
("use strict");

function normalizeNodeProviderExecutionRequest(
  input: unknown,
): { value: NodeProviderExecutionRequest } | { error: string };
function normalizeNodeProviderExecutionRequest(input?: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Request body must be an object" };
  }
  if (
    !Number.isInteger(input.format) ||
    input.format < 0 ||
    input.format > 1000
  ) {
    return { error: "format must be an integer from 0 to 1000" };
  }
  if (
    !input.payload ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    return { error: "payload must be an object" };
  }
  return {
    value: {
      format: input.format,
      payload: input.payload,
    },
  };
}

const normalizeNodeProviderTransportRequest: any =
  normalizeNodeProviderExecutionRequest;

export {
  normalizeNodeProviderExecutionRequest,
  normalizeNodeProviderTransportRequest,
};
