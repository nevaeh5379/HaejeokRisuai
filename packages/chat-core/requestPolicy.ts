import type { ChatFailureResponse, ChatModelResponse } from "./types.ts";

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
("use strict");

function containsBannedCharacterSet(
  text: string,
  bannedCharacterSets: readonly string[] | undefined,
): boolean;
function containsBannedCharacterSet(
  text?: any,
  bannedCharacterSets?: any,
): any {
  if (!bannedCharacterSets?.length) return false;
  for (const set of bannedCharacterSets) {
    const checkRegex: any = new RegExp(`\\p{Script=${set}}`, "gu");
    if (checkRegex.test(text)) return true;
  }
  return false;
}

function shouldFallbackOnBlankResponse(
  response: ChatModelResponse,
  fallbackIndex: number,
  fallbackCount: number,
  enabled: boolean,
): boolean;
function shouldFallbackOnBlankResponse(
  response?: any,
  fallbackIndex?: any,
  fallbackCount?: any,
  enabled?: any,
): any {
  return Boolean(
    enabled &&
    response.type === "success" &&
    fallbackIndex !== fallbackCount - 1 &&
    response.result.trim() === "",
  );
}

function isPluginModel(model?: any): any {
  return model === "custom" || Boolean(model?.startsWith("pluginmodel:::"));
}

function decideFailedRequestRetry(
  input: FailedRequestRetryInput,
): FailedRequestRetryDecision;
function decideFailedRequestRetry(input?: any): any {
  let retryCount: any = input.retryCount;
  const delayMs: any = input.response.failByServerError ? 1000 : 0;
  if (input.response.failByServerError && input.antiServerOverloads) {
    retryCount -= 0.5;
  }
  retryCount += 1;

  if (retryCount <= input.requestRetries) {
    return { action: "retry", retryCount, delayMs };
  }

  const lastFallback: any = input.fallbackIndex === input.fallbackCount - 1;
  return {
    action:
      lastFallback || isPluginModel(input.response.model)
        ? "return"
        : "fallback",
    retryCount,
    delayMs,
  };
}

export {
  containsBannedCharacterSet,
  shouldFallbackOnBlankResponse,
  decideFailedRequestRetry,
};
