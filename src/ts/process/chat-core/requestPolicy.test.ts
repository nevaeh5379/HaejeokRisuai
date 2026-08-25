import { describe, expect, it } from "vitest";
import {
  containsBannedCharacterSet,
  decideFailedRequestRetry,
  shouldFallbackOnBlankResponse,
} from "./requestPolicy";

describe("chat request policy", () => {
  it("detects configured Unicode scripts in successful text", () => {
    expect(containsBannedCharacterSet("hello 한글", ["Hangul"])).toBe(true);
    expect(containsBannedCharacterSet("hello", ["Hangul"])).toBe(false);
  });

  it("moves to fallback only for blank successful responses before the last fallback", () => {
    expect(shouldFallbackOnBlankResponse(
      { type: "success", result: "   " }, 0, 2, true,
    )).toBe(true);
    expect(shouldFallbackOnBlankResponse(
      { type: "success", result: "ok" }, 0, 2, true,
    )).toBe(false);
  });

  it("counts ordinary failures as one retry", () => {
    expect(decideFailedRequestRetry({
      response: { type: "fail", result: "no" },
      retryCount: 0,
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackIndex: 0,
      fallbackCount: 2,
    })).toEqual({ action: "retry", retryCount: 1, delayMs: 0 });
  });

  it("counts overload failures as half a retry when overload protection is enabled", () => {
    expect(decideFailedRequestRetry({
      response: { type: "fail", result: "busy", failByServerError: true },
      retryCount: 0,
      requestRetries: 2,
      antiServerOverloads: true,
      fallbackIndex: 0,
      fallbackCount: 2,
    })).toEqual({ action: "retry", retryCount: 0.5, delayMs: 1000 });
  });

  it("switches fallback after exhausting retries", () => {
    expect(decideFailedRequestRetry({
      response: { type: "fail", result: "no" },
      retryCount: 2,
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackIndex: 0,
      fallbackCount: 2,
    }).action).toBe("fallback");
  });

  it("returns the failure when retries are exhausted on the last or plugin model", () => {
    expect(decideFailedRequestRetry({
      response: { type: "fail", result: "no" },
      retryCount: 2,
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackIndex: 1,
      fallbackCount: 2,
    }).action).toBe("return");
    expect(decideFailedRequestRetry({
      response: { type: "fail", result: "no", model: "pluginmodel:::x" },
      retryCount: 2,
      requestRetries: 2,
      antiServerOverloads: false,
      fallbackIndex: 0,
      fallbackCount: 2,
    }).action).toBe("return");
  });
});
