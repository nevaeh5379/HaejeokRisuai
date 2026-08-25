import type { ChatFailureResponse, ChatModelResponse } from "./types.cjs";

export function containsBannedCharacterSet(
  text: string,
  bannedCharacterSets: readonly string[] | undefined,
): boolean;

export function shouldFallbackOnBlankResponse(
  response: ChatModelResponse,
  fallbackIndex: number,
  fallbackCount: number,
  enabled: boolean,
): boolean;

export interface FailedRequestRetryInput {
  response: ChatFailureResponse;
  retryCount: number;
  requestRetries: number;
  antiServerOverloads: boolean;
  fallbackIndex: number;
  fallbackCount: number;
}

export interface FailedRequestRetryDecision {
  action: "retry" | "fallback" | "return";
  retryCount: number;
  delayMs: number;
}

export function decideFailedRequestRetry(
  input: FailedRequestRetryInput,
): FailedRequestRetryDecision;
