import { describe, expect, it, vi } from "vitest";
import {
  executeImageGeneration,
  type ImageGenerationSettings,
  type ImageGenerationRuntime,
} from "./imageGeneration.cts";

describe("Fal image generation", () => {
  const settings = {
    sdProvider: "fal",
    falModel: "fal-ai/flux-pro",
    falToken: "secret",
    sdConfig: { width: 512, height: 512 },
  } as ImageGenerationSettings;

  it.each(["image/png", "image/jpeg; charset=utf-8", "image/webp"])(
    "downloads %s images without forwarding credentials",
    async (contentType) => {
      const bytes = new Uint8Array([1, 2, 3]);
      const fetchJson = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: { images: [{ url: "https://images.example/result" }] },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: bytes,
          headers: { "content-type": contentType },
        });
      const result = await executeImageGeneration(
        settings,
        { fetchJson } as unknown as ImageGenerationRuntime,
        "sunset",
        {},
        "",
      );
      expect(result).toBe(`data:${contentType.split(";")[0]};base64,AQID`);
      expect(fetchJson).toHaveBeenNthCalledWith(
        2,
        "https://images.example/result",
        { method: "GET", rawResponse: true },
      );
    },
  );

  it("preserves download failures as image-stage HTTP errors", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { images: [{ url: "https://images.example/result" }] },
      })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null });
    await expect(
      executeImageGeneration(
        settings,
        { fetchJson } as unknown as ImageGenerationRuntime,
        "sunset",
        {},
        "",
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
