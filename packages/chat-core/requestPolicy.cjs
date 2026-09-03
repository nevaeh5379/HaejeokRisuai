"use strict";

function containsBannedCharacterSet(text, bannedCharacterSets) {
  if (!bannedCharacterSets?.length) return false;
  for (const set of bannedCharacterSets) {
    const checkRegex = new RegExp(`\\p{Script=${set}}`, "gu");
    if (checkRegex.test(text)) return true;
  }
  return false;
}

function shouldFallbackOnBlankResponse(
  response,
  fallbackIndex,
  fallbackCount,
  enabled,
) {
  return Boolean(
    enabled &&
    response.type === "success" &&
    fallbackIndex !== fallbackCount - 1 &&
    response.result.trim() === "",
  );
}

function isPluginModel(model) {
  return model === "custom" || Boolean(model?.startsWith("pluginmodel:::"));
}

function decideFailedRequestRetry(input) {
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
    action:
      lastFallback || isPluginModel(input.response.model)
        ? "return"
        : "fallback",
    retryCount,
    delayMs,
  };
}

module.exports = {
  containsBannedCharacterSet,
  shouldFallbackOnBlankResponse,
  decideFailedRequestRetry,
};
