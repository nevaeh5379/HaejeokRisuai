import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, zipSync } from "fflate";
import {
  executeImageGeneration,
  type ImageGenerationRuntime,
  type ImageGenerationSettings,
} from "@risuai/protocol/src/imageGeneration.ts";

const native = vi.hoisted(() => ({
  isCapacitor: true,
  listener: null as ((event: unknown) => void) | null,
  streamedFetch: vi.fn(),
}));

vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  get isCapacitor() {
    return native.isCapacitor;
  },
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    registerPlugin: (name: string) =>
      name === "StreamedFetch"
        ? {
            addListener: async (
              _name: string,
              listener: typeof native.listener,
            ) => {
              native.listener = listener;
              return { remove: async () => {} };
            },
            streamedFetch: native.streamedFetch,
          }
        : actual.registerPlugin(name),
  };
});

import { globalFetch } from "./globalApi.svelte";
import { processZip } from "./process/processzip";

const url = "https://image.novelai.net/ai/generate-image";
const image = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 192]);
const archive = zipSync({ "image_0.png": image });

function respond(
  bytes: Uint8Array,
  status = 200,
  contentType = "application/zip",
) {
  native.streamedFetch.mockImplementationOnce(async ({ id }) => {
    native.listener?.({
      type: "headers",
      id,
      status,
      body: { "content-type": contentType },
    });
    // Split inside the archive so byte preservation is checked across chunks.
    for (let offset = 0; offset < bytes.length; offset += 17) {
      native.listener?.({
        type: "chunk",
        id,
        body: Buffer.from(bytes.subarray(offset, offset + 17)).toString(
          "base64",
        ),
      });
    }
    native.listener?.({ type: "end", id });
    return { success: true, error: "" };
  });
}

describe("globalFetch binary responses on Android", () => {
  beforeEach(() => {
    native.isCapacitor = true;
    native.streamedFetch.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected browser fetch");
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a NovelAI ZIP through native chunks instead of patched text fetch", async () => {
    const patchedFetch = vi.fn(
      async () =>
        new Response(new TextDecoder().decode(archive), {
          headers: { "content-type": "application/zip" },
        }),
    );
    vi.stubGlobal("fetch", patchedFetch);
    respond(archive);
    const body = { input: "landscape", model: "nai-diffusion-4-full" };
    const result = await globalFetch(url, {
      body,
      headers: { Authorization: "Bearer test-token" },
      rawResponse: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(archive);
    expect(unzipSync(result.data)["image_0.png"]).toEqual(image);
    expect(patchedFetch).not.toHaveBeenCalled();
    expect(native.streamedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
      }),
    );
  });

  it("preserves an HTTP error status and raw JSON error body", async () => {
    const bytes = new TextEncoder().encode('{"message":"Unauthorized"}');
    respond(bytes, 401, "application/json");
    const result = await globalFetch(url, { body: {}, rawResponse: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.data).toEqual(bytes);
  });

  it("decodes the native ZIP through the shared NovelAI image-generation handler", async () => {
    respond(archive);
    const result = await executeImageGeneration(
      {
        sdProvider: "novelai",
        NAIImgUrl: url,
        NAIApiKey: "test-token",
        NAIImgModel: "nai-diffusion-4-full",
        NAIImgConfig: {
          width: 512,
          height: 512,
          steps: 28,
          scale: 5,
          sampler: "k_euler",
        },
      } as ImageGenerationSettings,
      {
        fetchJson: globalFetch,
        unzipImage: processZip,
      } as unknown as ImageGenerationRuntime,
      "landscape",
      {},
      "low quality",
    );

    expect(result).toBe(
      `data:image/png;base64,${Buffer.from(image).toString("base64")}`,
    );
    const request = native.streamedFetch.mock.calls[0][0];
    expect(
      JSON.parse(Buffer.from(request.body, "base64").toString()),
    ).toMatchObject({
      input: "landscape",
      action: "generate",
      model: "nai-diffusion-4-full",
      parameters: { negative_prompt: "low quality" },
    });
  });

  it("keeps web binary responses on browser fetch", async () => {
    native.isCapacitor = false;
    const browserFetch = vi.fn(async () => new Response(archive));
    vi.stubGlobal("fetch", browserFetch);
    const result = await globalFetch(url, { body: {}, rawResponse: true });

    expect(result.data).toEqual(archive);
    expect(browserFetch).toHaveBeenCalledOnce();
    expect(native.streamedFetch).not.toHaveBeenCalled();
  });

  it("keeps Android JSON responses on the existing fetch path", async () => {
    const browserFetch = vi.fn(async () => Response.json({ remaining: 10 }));
    vi.stubGlobal("fetch", browserFetch);
    const result = await globalFetch(
      "https://image.novelai.net/user/subscription",
      {
        method: "GET",
      },
    );

    expect(result.data).toEqual({ remaining: 10 });
    expect(browserFetch).toHaveBeenCalledOnce();
    expect(native.streamedFetch).not.toHaveBeenCalled();
  });
});
