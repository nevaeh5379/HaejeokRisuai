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
  cancelStreamedFetch: vi.fn(async () => {}),
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
            cancelStreamedFetch: native.cancelStreamedFetch,
          }
        : actual.registerPlugin(name),
  };
});

import { fetchNative, globalFetch } from "./globalApi.svelte";
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

function pendingResponse(options: { headers?: boolean; end?: boolean } = {}) {
  let complete: (result: { success: boolean; error: string }) => void;
  let reject: (error: Error) => void;
  let started: (id: string) => void;
  const id = new Promise<string>((resolve) => {
    started = resolve;
  });
  const result = new Promise<{ success: boolean; error: string }>(
    (resolve, fail) => {
      complete = resolve;
      reject = fail;
    },
  );
  native.streamedFetch.mockImplementationOnce(({ id }) => {
    if (options.headers !== false) {
      native.listener?.({ type: "headers", id, status: 200, body: {} });
      native.listener?.({
        type: "chunk",
        id,
        body: Buffer.from(image).toString("base64"),
      });
    }
    if (options.end) native.listener?.({ type: "end", id });
    started(id);
    return result;
  });
  return {
    id,
    complete: (success: boolean, error = "") => complete({ success, error }),
    reject: (error: Error) => reject(error),
  };
}

describe("globalFetch binary responses on Android", () => {
  beforeEach(() => {
    native.isCapacitor = true;
    native.streamedFetch.mockReset();
    native.cancelStreamedFetch.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected browser fetch");
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a binary download after chunks arrive and cancels the native request", async () => {
    const pending = pendingResponse();
    const abort = new AbortController();
    const result = globalFetch("https://example.test/audio.wav", {
      method: "GET",
      rawResponse: true,
      abortSignal: abort.signal,
    });
    const id = await pending.id;
    abort.abort();
    await expect(result).resolves.toMatchObject({ ok: false, status: 400 });
    expect(native.cancelStreamedFetch).toHaveBeenCalledExactlyOnceWith({ id });
    // Late native events must be ignored after the request's queue is removed.
    native.listener?.({
      type: "chunk",
      id,
      body: Buffer.from(archive).toString("base64"),
    });
    native.listener?.({ type: "end", id });
    pending.complete(true);
  });

  it("aborts a native request that is still waiting for headers", async () => {
    const pending = pendingResponse({ headers: false });
    const abort = new AbortController();
    const response = fetchNative(url, {
      method: "GET",
      signal: abort.signal,
      logFetch: false,
    });
    const rejected = expect(response).rejects.toMatchObject({
      name: "AbortError",
    });
    const id = await pending.id;
    abort.abort();
    await rejected;
    expect(native.cancelStreamedFetch).toHaveBeenCalledExactlyOnceWith({ id });
    pending.complete(false, "Request aborted");
  });

  it("keeps timeout cancellation effective after returning response headers", async () => {
    vi.useFakeTimers();
    const pending = pendingResponse();
    const response = await fetchNative(url, {
      method: "GET",
      requestTimeoutMs: 25,
      logFetch: false,
    });
    const rejected = expect(response.arrayBuffer()).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(native.cancelStreamedFetch).toHaveBeenCalledExactlyOnceWith({
      id: await pending.id,
    });
    pending.complete(false, "Request aborted");
  });

  it("cancels the native connection when the response body is cancelled", async () => {
    const pending = pendingResponse();
    const response = await fetchNative(url, { method: "GET", logFetch: false });
    await response.body.cancel();
    expect(native.cancelStreamedFetch).toHaveBeenCalledExactlyOnceWith({
      id: await pending.id,
    });
    pending.complete(false, "Request aborted");
  });

  it("propagates a failed terminal event instead of returning partial image bytes", async () => {
    const pending = pendingResponse();
    const result = globalFetch("https://example.test/image.png", {
      method: "GET",
      rawResponse: true,
    });
    const id = await pending.id;
    native.listener?.({
      type: "end",
      id,
      success: false,
      error: "Connection reset",
    });
    await expect(result).resolves.toMatchObject({
      ok: false,
      data: expect.stringContaining("Connection reset"),
    });
    pending.complete(false, "Connection reset");
  });

  it("waits for a delayed native failure after a bare end event", async () => {
    const pending = pendingResponse({ end: true });
    const result = globalFetch(url, { body: {}, rawResponse: true });
    await pending.id;
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    pending.complete(false, "Connection reset");
    await expect(result).resolves.toMatchObject({
      ok: false,
      data: expect.stringContaining("Connection reset"),
    });
  });

  it("waits for native success before completing a bare end event", async () => {
    const pending = pendingResponse({ end: true });
    const response = await fetchNative(url, { method: "GET", logFetch: false });
    const bytes = response.arrayBuffer();
    let settled = false;
    void bytes.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    pending.complete(true);
    expect(new Uint8Array(await bytes)).toEqual(image);
  });

  it("propagates a rejected native call after partial chunks without an end event", async () => {
    const pending = pendingResponse();
    const result = globalFetch(url, { body: {}, rawResponse: true });
    await pending.id;
    pending.reject(new Error("Native transport failed"));
    await expect(result).resolves.toMatchObject({
      ok: false,
      data: expect.stringContaining("Native transport failed"),
    });
  });

  it("reports a native failure before headers instead of waiting indefinitely", async () => {
    const pending = pendingResponse({ headers: false });
    const result = globalFetch(url, { body: {}, rawResponse: true });
    await pending.id;
    pending.complete(false, "Connection refused");
    await expect(result).resolves.toMatchObject({
      ok: false,
      data: expect.stringContaining("Connection refused"),
    });
  });

  it("releases the abort listener after a completed download", async () => {
    respond(image);
    const abort = new AbortController();
    const response = await fetchNative(url, {
      method: "GET",
      signal: abort.signal,
      logFetch: false,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
    abort.abort();
    expect(native.cancelStreamedFetch).not.toHaveBeenCalled();
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
