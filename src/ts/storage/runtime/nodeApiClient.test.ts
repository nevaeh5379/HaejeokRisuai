import { describe, expect, it, vi } from "vitest";
import {
  NodeApiClient,
  NodeApiCompatibilityError,
} from "./nodeApiClient";

const profile = {
  version: 1 as const,
  mode: "remote" as const,
  baseUrl: "https://storage.example:7443",
  allowInsecureHttp: false,
};

describe("NodeApiClient", () => {
  it("resolves every API request against the configured origin", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new NodeApiClient(profile, fetcher);
    await client.request("/api/health?full=1");
    expect(fetcher).toHaveBeenCalledWith(
      "https://storage.example:7443/api/health?full=1",
      undefined,
    );
    expect(() => client.resolve("api/health")).toThrow(/must start/);
  });

  it("rejects an old server instead of falling back", async () => {
    const client = new NodeApiClient(
      profile,
      async () => new Response(null, { status: 404 }),
    );
    await expect(client.getCapabilities()).rejects.toBeInstanceOf(
      NodeApiCompatibilityError,
    );
  });

  it("requires SQL, asset, and data-change capabilities", async () => {
    const client = new NodeApiClient(
      profile,
      async () =>
        Response.json({
          apiVersion: 1,
          features: {
            sqlStorage: true,
            assetStorage: false,
            dataChangeEvents: true,
          },
        }),
    );
    await expect(client.getCapabilities()).rejects.toThrow(
      /does not provide the required/,
    );
  });
});
