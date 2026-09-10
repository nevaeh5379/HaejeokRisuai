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
    const client = new NodeApiClient(profile, async () =>
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
    await expect(
      client.getStorageSyncSummary("sync-auth"),
    ).resolves.toMatchObject({
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
    await expect(client.getStorageSyncSummary("sync-auth")).rejects.toThrow(
      /does not support/,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates sync sessions with auth and surfaces revision conflicts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          apiVersion: 1,
          features: {
            sqlStorage: true,
            assetStorage: true,
            dataChangeEvents: true,
            storageSync: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { code: "revision_conflict", currentRevision: 12 },
          { status: 409 },
        ),
      );
    const client = new NodeApiClient(profile, fetcher);
    await expect(
      client.createStorageSyncSession(
        { direction: "local-to-remote", expectedRevision: 11, peerRevision: 4 },
        "sync-auth",
      ),
    ).rejects.toMatchObject({ currentRevision: 12 });
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "risu-auth": "sync-auth" }),
    });
  });

  it("plans assets and uploads chunks through the configured server", async () => {
    const assetId = "a".repeat(64);
    const digest = "b".repeat(64);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: "receiving-assets",
          assets: [
            {
              id: assetId,
              key: "assets/a.bin",
              size: 3,
              sha256: digest,
              offset: 0,
              state: "pending",
            },
          ],
          skippedCount: 0,
          missingCount: 1,
          totalBytes: 3,
          remainingBytes: 3,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: assetId,
          offset: 3,
          state: "ready",
          status: "assets-ready",
        }),
      );
    const client = new NodeApiClient(profile, fetcher);
    const plan = await client.planStorageSyncAssets(
      "session-1",
      [{ key: "assets/a.bin", size: 3, sha256: digest }],
      "sync-auth",
    );
    expect(plan.remainingBytes).toBe(3);
    await expect(
      client.uploadStorageSyncAssetChunk(
        "session-1",
        assetId,
        0,
        new Uint8Array([1, 2, 3]),
        "sync-auth",
      ),
    ).resolves.toMatchObject({ offset: 3, state: "ready" });
    expect(fetcher.mock.calls[1][0]).toContain(`/assets/${assetId}?offset=0`);
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({
        "content-type": "application/octet-stream",
        "risu-auth": "sync-auth",
      }),
    });
  });

  it("preserves structured asset staging errors", async () => {
    const client = new NodeApiClient(profile, async () =>
      Response.json(
        { error: "expected offset 4", code: "offset_mismatch" },
        { status: 409 },
      ),
    );
    await expect(
      client.getStorageSyncAssetPlan("session-1", "sync-auth"),
    ).rejects.toMatchObject({
      code: "offset_mismatch",
      status: 409,
      message: "expected offset 4",
    });
  });

  it("plans and uploads the resumable SQL stream", async () => {
    const digest = "c".repeat(64);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          formatVersion: 1,
          size: 3,
          recordCount: 1,
          sha256: digest,
          offset: 0,
          state: "pending",
          status: "receiving-sql",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          formatVersion: 1,
          size: 3,
          recordCount: 1,
          sha256: digest,
          offset: 3,
          state: "ready",
          status: "sql-ready",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          recordCount: 1,
          sourceRevision: 7,
          counts: { meta: 1 },
        }),
      );
    const client = new NodeApiClient(profile, fetcher);
    await expect(
      client.planStorageSyncSql(
        "session-1",
        { formatVersion: 1, size: 3, recordCount: 1, sha256: digest },
        "sync-auth",
      ),
    ).resolves.toMatchObject({ offset: 0, state: "pending" });
    await expect(
      client.uploadStorageSyncSqlChunk(
        "session-1",
        0,
        new Uint8Array([1, 2, 3]),
        "sync-auth",
      ),
    ).resolves.toMatchObject({ offset: 3, state: "ready" });
    expect(fetcher.mock.calls[1][0]).toContain("/sql?offset=0");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT" });
    await expect(
      client.validateStorageSyncSql("session-1", "sync-auth"),
    ).resolves.toMatchObject({
      recordCount: 1,
      sourceRevision: 7,
      counts: { meta: 1 },
    });
    expect(fetcher.mock.calls[2][0]).toContain("/sql/validate");
    expect(fetcher.mock.calls[2][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "risu-auth": "sync-auth" }),
    });
  });

  it("preserves structured SQL staging errors", async () => {
    const client = new NodeApiClient(profile, async () =>
      Response.json(
        { error: "SQL checksum mismatch", code: "sql_checksum_mismatch" },
        { status: 422 },
      ),
    );
    await expect(
      client.getStorageSyncSqlPlan("session-1", "sync-auth"),
    ).rejects.toMatchObject({
      code: "sql_checksum_mismatch",
      status: 422,
      message: "SQL checksum mismatch",
    });
  });
  it("runs finalize preflight through the configured server", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({
        status: "ready",
        targetRevision: 11,
        sourceRevision: 7,
        recordCount: 42,
        skippedAssetsVerified: 3,
      }),
    );
    const client = new NodeApiClient(profile, fetcher);
    await expect(
      client.preflightStorageSyncFinalize("session-1", "sync-auth"),
    ).resolves.toMatchObject({
      status: "ready",
      targetRevision: 11,
      sourceRevision: 7,
      recordCount: 42,
    });
    expect(fetcher.mock.calls[0][0]).toContain("/finalize/preflight");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "risu-auth": "sync-auth" }),
    });
  });

  it("finalizes a staged session and validates idempotent completed results", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({
        status: "completed",
        revision: 12,
        revisionId: 44,
        targetRevisionBefore: 11,
        sourceRevision: 7,
        recordCount: 42,
        assetsApplied: 3,
        recoveryId: "session-1",
        recoveryPromoted: true,
        recoveryWarning: null,
      }),
    );
    const client = new NodeApiClient(profile, fetcher);
    await expect(
      client.finalizeStorageSync("session-1", "sync-auth"),
    ).resolves.toMatchObject({
      status: "completed",
      revision: 12,
      sourceRevision: 7,
      assetsApplied: 3,
    });
    expect(fetcher.mock.calls[0][0]).toContain("/finalize");
    expect(fetcher.mock.calls[0][0]).not.toContain("/finalize/preflight");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "risu-auth": "sync-auth" }),
    });
  });
});
