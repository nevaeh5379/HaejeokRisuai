import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProxy } from "./proxyFetch";

afterEach(() => vi.unstubAllGlobals());

describe("header-routed proxy caching", () => {
  it("does not reuse a cached workflow file for object_info requests on the same proxy URL", async () => {
    const workflow = { id: "saved", revision: 1, nodes: [], links: [] };
    const definitions = {
      VAEDecode: { input: { required: { vae: ["VAE"] } } },
    };
    const serverResponses = new Map<string, unknown>([
      ["http://comfy:8188/userdata/workflows%2Fexample.json", workflow],
      ["http://comfy:8188/object_info", definitions],
      ["http://comfy:8188/object_info/VAEDecode", definitions],
    ]);
    const cached = new Response(JSON.stringify(workflow), {
      headers: {
        "Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT",
        ETag: '"workflow"',
      },
    });
    const network = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        // A fresh browser cache entry belongs to /proxy2, not to risu-url.
        if (init.cache !== "no-store") return cached.clone();
        const target = decodeURIComponent(
          new Headers(init.headers).get("risu-url")!,
        );
        network(target);
        return new Response(JSON.stringify(serverResponses.get(target)));
      }),
    );
    const request = (target: string) => ({
      method: "GET",
      headers: { "risu-url": encodeURIComponent(target) },
    });

    // Reproduce the prior transport's wrong response, then exercise the fix.
    expect(
      await (
        await fetch("/proxy2", request("http://comfy:8188/object_info"))
      ).json(),
    ).toEqual(workflow);
    for (const [target, expected] of serverResponses) {
      expect(
        await (await fetchProxy("/proxy2", request(target))).json(),
      ).toEqual(expected);
    }
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("preserves proxy authentication, method, body, cancellation, and upstream failures", async () => {
    const response = new Response("unavailable", { status: 503 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const options = {
      method: "POST",
      body: "prompt",
      signal: controller.signal,
      headers: { "risu-auth": "token", "risu-url": "target" },
      cache: "force-cache" as const,
    };
    expect(await fetchProxy("/proxy2", options)).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/proxy2", {
      ...options,
      cache: "no-store",
    });
  });
});
