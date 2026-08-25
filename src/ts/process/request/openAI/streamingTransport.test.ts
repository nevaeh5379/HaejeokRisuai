import { describe, expect, it } from "vitest";
import { isBrowserBlockedOpenAIStreamingUrl } from "./streamingTransport";

describe("OpenAI streaming transport", () => {
  it("blocks browser streaming to local endpoints", () => {
    expect(isBrowserBlockedOpenAIStreamingUrl(
      "http://localhost:5000/v1/chat/completions",
      { isTauri: false, isNodeServer: false },
    )).toBe(true);
    expect(isBrowserBlockedOpenAIStreamingUrl(
      "http://0.0.0.0:5000/v1/chat/completions",
      { isTauri: false, isNodeServer: false },
    )).toBe(true);
  });

  it("allows local streaming from native runtimes", () => {
    expect(isBrowserBlockedOpenAIStreamingUrl(
      "http://localhost:5000/v1/chat/completions",
      { isTauri: true, isNodeServer: false },
    )).toBe(false);
  });

});
