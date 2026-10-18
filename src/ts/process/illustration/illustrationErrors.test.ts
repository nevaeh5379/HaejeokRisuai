import { describe, expect, it } from "vitest";
import {
  describeIllustrationError,
  summarizeIllustrationError,
} from "@risuai/protocol/src/illustration.ts";
import {
  executeImageGeneration,
  type ImageGenerationSettings,
  type ImageGenerationRuntime,
} from "@risuai/protocol/src/imageGeneration.ts";

describe("illustration diagnostics", () => {
  it.each([
    [new TypeError("Failed to fetch"), "connection"],
    [new Error("fetch failed", { cause: { code: "ENOTFOUND" } }), "connection"],
    [new DOMException("request expired", "TimeoutError"), "timeout"],
    [new SyntaxError("Unexpected token <, api-key-secret"), "invalidResponse"],
    [new Error("The submodel returned no image tags"), "emptyTags"],
    [
      new Error(
        "Illustration instructions and current scene exceed the submodel context limit",
      ),
      "contextLimit",
    ],
    [new Error("Submodel HTTP 403"), "auth"],
    [new Error("HTTP 429 api-key-secret"), "rateLimit"],
    [new Error("The image provider returned no image"), "noImage"],
    [new Error("OpenAI Compatible API URL is not set"), "configuration"],
    [new Error("Image provider is not set"), "configuration"],
    [new Error("Unsupported image provider: unknown-bot"), "configuration"],
  ])("classifies %s as %s", (error, code) => {
    expect(describeIllustrationError(error, "tags").code).toBe(code);
    expect(summarizeIllustrationError(error)).not.toContain("api-key-secret");
  });

  it.each([401, 429, 503])(
    "preserves image provider HTTP %s without exposing its body",
    async (status) => {
      const settings = {
        sdProvider: "webui",
        webUiUrl: "https://provider.test",
        sdConfig: {},
      } as ImageGenerationSettings;
      const runtime = {
        fetchJson: async () => ({
          ok: false,
          status,
          data: { error: "api-key-secret" },
        }),
      } as unknown as ImageGenerationRuntime;
      let caught: unknown;
      try {
        await executeImageGeneration(settings, runtime, "tags", {}, "");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(describeIllustrationError(caught, "image")).toMatchObject({
        stage: "image",
        status,
      });
      expect(summarizeIllustrationError(caught)).not.toContain(
        "api-key-secret",
      );
    },
  );

  it("recognizes browser transport failures even when the platform assigns HTTP 400", async () => {
    const settings = {
      sdProvider: "webui",
      webUiUrl: "https://provider.test",
      sdConfig: {},
    } as ImageGenerationSettings;
    const runtime = {
      fetchJson: async () => ({
        ok: false,
        status: 400,
        data: "TypeError: Failed to fetch",
      }),
    } as unknown as ImageGenerationRuntime;
    await expect(
      executeImageGeneration(settings, runtime, "tags", {}, ""),
    ).rejects.toMatchObject({ code: "connection", status: undefined });
  });

  it("throws when image provider is unconfigured or unsupported", async () => {
    const runtime = {} as ImageGenerationRuntime;
    const emptyProviderSettings = {
      sdProvider: "",
    } as unknown as ImageGenerationSettings;
    await expect(
      executeImageGeneration(emptyProviderSettings, runtime, "tags", {}, ""),
    ).rejects.toThrow("Image provider is not set");

    const unsupportedProviderSettings = {
      sdProvider: "unknown-provider",
    } as unknown as ImageGenerationSettings;
    await expect(
      executeImageGeneration(
        unsupportedProviderSettings,
        runtime,
        "tags",
        {},
        "",
      ),
    ).rejects.toThrow("Unsupported image provider: unknown-provider");
  });
});
