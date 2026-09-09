import { describe, expect, it, vi } from "vitest";
import {
  createSameOriginNodeApiClient,
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
  it("keeps the Node-hosted web app on explicit same-origin paths", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createSameOriginNodeApiClient(
      fetcher,
      "https://server.example",
    );
    await client.request("/api/health?full=1");
    expect(fetcher).toHaveBeenCalledWith("/api/health?full=1", undefined);
  });

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

  it("loads a validated storage sync summary from capable servers", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/api/client-capabilities")) {
        return Response.json({
          apiVersion: 1,
          features: {
            sqlStorage: true,
            assetStorage: true,
            dataChangeEvents: true,
            storageSync: true,
          },
        });
      }
      return Response.json({
        protocolVersion: 1,
        revision: 9,
        initialized: true,
        records: {
          settings: 2,
          characters: 3,
          chats: 4,
          messages: 5,
          total: 14,
        },
        assets: { count: 6, sizeBytes: 700 },
      });
    });
    const client = new NodeApiClient(profile, fetcher);
    await expect(client.getStorageSyncSummary()).resolves.toMatchObject({
      revision: 9,
      records: { total: 14 },
      assets: { count: 6, sizeBytes: 700 },
    });
  });

  it("refuses storage sync when the server does not advertise it", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        apiVersion: 1,
        features: {
          sqlStorage: true,
          assetStorage: true,
          dataChangeEvents: true,
        },
      }),
    );
    const client = new NodeApiClient(profile, fetcher);
    await expect(client.getStorageSyncSummary()).rejects.toThrow(/does not support/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

});
