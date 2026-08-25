import type { ChatFailureResponse, ChatModelResponse } from "./types";

export function containsBannedCharacterSet(
  text: string,
  bannedCharacterSets: readonly string[] | undefined,
): boolean {
  if (!bannedCharacterSets?.length) return false;
  for (const set of bannedCharacterSets) {
    const checkRegex = new RegExp(`\\p{Script=${set}}`, "gu");
    if (checkRegex.test(text)) return true;
  }
  return false;
}

export function shouldFallbackOnBlankResponse(
  response: ChatModelResponse,
  fallbackIndex: number,
  fallbackCount: number,
  enabled: boolean,
): boolean {
  return Boolean(
    enabled &&
      response.type === "success" &&
      fallbackIndex !== fallbackCount - 1 &&
      response.result.trim() === "",
  );
}

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

function isPluginModel(model?: string): boolean {
  return model === "custom" || Boolean(model?.startsWith("pluginmodel:::"));
}

export function decideFailedRequestRetry(
  input: FailedRequestRetryInput,
): FailedRequestRetryDecision {
  let retryCount = input.retryCount;
  const delayMs = input.response.failByServerError ? 1000 : 0;
  if (input.response.failByServerError && input.antiServerOverloads) {
    retryCount -= 0.5;
  }
  retryCount += 1;

  if (retryCount <= input.requestRetries) {
    return { action: "retry", retryCount, delayMs };
  }

  const lastFallback = input.fallbackIndex === input.fallbackCount - 1;
  return {
    action: lastFallback || isPluginModel(input.response.model) ? "return" : "fallback",
    retryCount,
    delayMs,
  };
}
