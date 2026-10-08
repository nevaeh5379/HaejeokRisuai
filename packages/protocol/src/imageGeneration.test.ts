import { describe, expect, it, vi } from "vitest";
import {
  executeImageGeneration,
  createComfyUrlBuilder,
  getComfyGenerationConfig,
  type ImageGenerationSettings,
  type ImageGenerationRuntime,
} from "./imageGeneration.cts";

describe("ComfyUI workflow library", () => {
  const workflow = JSON.stringify({
    "1": {
      class_type: "Text",
      inputs: { text: "{{risu_prompt}} / {{risu_neg}}", seed: 1 },
    },
  });
  const config = {
    workflow: "legacy",
    workflows: [
      { id: "a", name: "A", workflow: "other" },
      { id: "b", name: "B", workflow },
    ],
    selectedWorkflowId: "b",
    timeout: 30,
    posNodeID: "",
    negNodeID: "",
    posInputName: "text",
    negInputName: "text",
  };

  it("snapshots only the selected workflow and preserves legacy settings", () => {
    expect(getComfyGenerationConfig(config)).toEqual({
      workflow,
      timeout: 30,
      posNodeID: "",
      negNodeID: "",
      posInputName: "text",
      negInputName: "text",
    });
    expect(
      getComfyGenerationConfig({ ...config, selectedWorkflowId: "missing" })
        .workflow,
    ).toBe("other");
    expect(
      getComfyGenerationConfig({ ...config, workflows: [] }).workflow,
    ).toBe("legacy");
  });

  it.each([
    "http://localhost:8188",
    "http://localhost:8188/",
    "http://localhost:8188/api",
    "http://localhost:8188/api/",
  ])("retains the base path and query for %s", (base) => {
    const url = new URL(
      createComfyUrlBuilder(base)("/userdata?dir=workflows&recurse=true"),
    );
    expect(url.pathname).toBe(
      base.includes("api") ? "/api/userdata" : "/userdata",
    );
    expect(url.searchParams.get("dir")).toBe("workflows");
    expect(
      createComfyUrlBuilder(base)("/userdata/workflows%2Fexample.json"),
    ).toContain("workflows%2Fexample.json");
  });

  it("generates from the selected workflow without mutating it or requiring a user ID", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { prompt_id: "job" } });
    const fetchNative = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job: {
              outputs: {
                "2": {
                  images: [
                    { filename: "image.png", subfolder: "", type: "output" },
                  ],
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const result = await executeImageGeneration(
      {
        sdProvider: "comfyui",
        comfyUiUrl: "http://localhost:8188/api/",
        comfyConfig: config,
      } as ImageGenerationSettings,
      { fetchJson, fetchNative } as unknown as ImageGenerationRuntime,
      "sunset",
      {},
      "bad",
    );
    expect(result).toBe("data:image/png;base64,AQID");
    expect(fetchJson.mock.calls[0][1].body.prompt["1"].inputs.text).toBe(
      "sunset / bad",
    );
    expect(fetchJson.mock.calls[0][1].headers).not.toHaveProperty("comfy-user");
    expect(fetchNative.mock.calls[0][1].headers).not.toHaveProperty(
      "comfy-user",
    );
    expect(config.workflows[1].workflow).toBe(workflow);
  });
});

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
