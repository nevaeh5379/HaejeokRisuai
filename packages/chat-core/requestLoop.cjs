"use strict";

const {
  containsBannedCharacterSet,
  decideFailedRequestRetry,
  shouldFallbackOnBlankResponse,
} = require("./requestPolicy.cjs");

function hasUsableFallbackAfter(fallbackModels, fallbackIndex) {
  for (let index = fallbackIndex + 1; index < fallbackModels.length; index++) {
    if (fallbackModels[index]) return true;
  }
  return false;
}

function rejectedBannedResponse(response) {
  return {
    type: "fail",
    result:
      "Response contained a banned character set after exhausting retries.",
    noRetry: true,
    model: response.model,
  };
}

async function executeChatRequestFallbacks(options, runtime) {
  const fallbackModels = Array.isArray(options.fallbackModels)
    ? options.fallbackModels
    : [];
  let lastResponse;

  for (
    let fallbackIndex = 0;
    fallbackIndex < fallbackModels.length;
    fallbackIndex++
  ) {
    const fallbackModel = fallbackModels[fallbackIndex];
    if (fallbackIndex !== 0 && !fallbackModel) continue;

    let retryCount = 0;
    await runtime.beginFallback?.({
      fallbackIndex,
      fallbackCount: fallbackModels.length,
      fallbackModel,
    });

    while (true) {
      if (runtime.isAborted?.()) {
        return { type: "fail", result: "Aborted" };
      }

      const context = {
        fallbackIndex,
        fallbackCount: fallbackModels.length,
        fallbackModel,
        retryCount,
      };
      const response = await runtime.executeAttempt(context);
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
        const usedModel = fallbackModel || response.model;
        return usedModel ? { ...response, model: usedModel } : response;
      }

      const retryDecision = decideFailedRequestRetry({
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

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

module.exports = {
  executeChatRequestFallbacks,
};
