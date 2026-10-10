import type { ChatModelResponse } from "./types.ts";

export interface ChatRequestFallbackOptions {
  fallbackModels: readonly string[];
  requestRetries: number;
  antiServerOverloads: boolean;
  fallbackWhenBlankResponse: boolean;
  bannedCharacterSets?: readonly string[];
}

export interface ChatRequestAttemptContext {
  fallbackIndex: number;
  fallbackCount: number;
  fallbackModel: string;
  retryCount: number;
}

export interface ChatRequestFallbackRuntime {
  beginFallback?(
    context: Omit<ChatRequestAttemptContext, "retryCount">,
  ): void | Promise<void>;
  executeAttempt(
    context: ChatRequestAttemptContext,
  ): Promise<ChatModelResponse>;
  isAborted?(): boolean;
  sleep?(delayMs: number): Promise<void>;
}
("use strict");

import {
  containsBannedCharacterSet,
  decideFailedRequestRetry,
  shouldFallbackOnBlankResponse,
} from "./requestPolicy.ts";

function hasUsableFallbackAfter(
  fallbackModels?: any,
  fallbackIndex?: any,
): any {
  for (
    let index: any = fallbackIndex + 1;
    index < fallbackModels.length;
    index++
  ) {
    if (fallbackModels[index]) return true;
  }
  return false;
}

function rejectedBannedResponse(response?: any): any {
  return {
    type: "fail",
    result:
      "Response contained a banned character set after exhausting retries.",
    noRetry: true,
    model: response.model,
  };
}

function executeChatRequestFallbacks(
  options: ChatRequestFallbackOptions,
  runtime: ChatRequestFallbackRuntime,
): Promise<ChatModelResponse>;
async function executeChatRequestFallbacks(
  options?: any,
  runtime?: any,
): Promise<any> {
  const fallbackModels: any = Array.isArray(options.fallbackModels)
    ? options.fallbackModels
    : [];
  let lastResponse: any;

  for (
    let fallbackIndex: any = 0;
    fallbackIndex < fallbackModels.length;
    fallbackIndex++
  ) {
    const fallbackModel: any = fallbackModels[fallbackIndex];
    if (fallbackIndex !== 0 && !fallbackModel) continue;

    let retryCount: any = 0;
    await runtime.beginFallback?.({
      fallbackIndex,
      fallbackCount: fallbackModels.length,
      fallbackModel,
    });

    while (true) {
      if (runtime.isAborted?.()) {
        return { type: "fail", result: "Aborted" };
      }

      const context: any = {
        fallbackIndex,
        fallbackCount: fallbackModels.length,
        fallbackModel,
        retryCount,
      };
      const response: any = await runtime.executeAttempt(context);
      lastResponse = response;

      if (runtime.isAborted?.()) {
        return { type: "fail", result: "Aborted" };
      }

      if (
        response.type === "success" &&
        containsBannedCharacterSet(response.result, options.bannedCharacterSets)
      ) {
        retryCount += 1;
        if (retryCount <= options.requestRetries) continue;
        if (hasUsableFallbackAfter(fallbackModels, fallbackIndex)) break;
        return rejectedBannedResponse(response);
      }

      if (
        shouldFallbackOnBlankResponse(
          response,
          fallbackIndex,
          fallbackModels.length,
          options.fallbackWhenBlankResponse,
        )
      ) {
        break;
      }

      if (response.type !== "fail" || response.noRetry) {
        const usedModel: any = fallbackModel || response.model;
        return usedModel ? { ...response, model: usedModel } : response;
      }

      const retryDecision: any = decideFailedRequestRetry({
        response,
        retryCount,
        requestRetries: options.requestRetries,
        antiServerOverloads: options.antiServerOverloads,
        fallbackIndex,
        fallbackCount: fallbackModels.length,
      });
      retryCount = retryDecision.retryCount;
      if (retryDecision.delayMs > 0) {
        await (runtime.sleep ?? defaultSleep)(retryDecision.delayMs);
      }
      if (retryDecision.action === "return") return response;
      if (retryDecision.action === "fallback") break;
    }
  }

  return lastResponse ?? { type: "fail", result: "All models failed" };
}

function defaultSleep(delayMs?: any): any {
  return new Promise((resolve?: any) => setTimeout(resolve, delayMs));
}

export { executeChatRequestFallbacks };
