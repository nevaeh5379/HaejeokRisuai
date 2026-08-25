import { describe, expect, it } from "vitest";
import { DEFAULT_MISTRAL_API_URL } from "@risuai/chat-core/mistralProvider.cjs";
import {
  resolveMistralRequestUrl,
  shouldUseNodeMistralTransport,
} from "./mistralRequest";

describe("Mistral request adapter", () => {
  it("uses the official Mistral endpoint by default", () => {
    expect(resolveMistralRequestUrl()).toBe(DEFAULT_MISTRAL_API_URL);
    expect(shouldUseNodeMistralTransport(DEFAULT_MISTRAL_API_URL)).toBe(true);
  });

  it("preserves custom Mistral endpoints on the browser transport path", () => {
    const url = "https://mistral-proxy.example/v1/chat/completions";
    expect(resolveMistralRequestUrl(url)).toBe(url);
    expect(shouldUseNodeMistralTransport(url)).toBe(false);
  });
});
