import { describe, expect, it, vi } from "vitest";
import { RemoteAssetClient } from "./remoteAssetClient";
import type { NodeApiClient } from "./nodeApiClient";

function client(request: ReturnType<typeof vi.fn>) {
  return new RemoteAssetClient(
    { request } as unknown as NodeApiClient,
    async () => "auth",
  );
}
describe("remote storage write errors", () => {
  it("includes key, size, HTTP status and structured server details", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "write failed",
            code: "ENOSPC",
            details: "disk full",
          }),
          { status: 507 },
        ),
    );
    await expect(
      client(request).setItem("assets/한글.png", new Uint8Array(2048)),
    ).rejects.toThrow(
      /Key: assets\/한글.png\nSize: 2048 bytes \(2.00 KiB\)\nHTTP: 507[\s\S]*ENOSPC[\s\S]*disk full/,
    );
  });
  it("bounds and strips HTML proxy error details", async () => {
    const request = vi.fn(
      async () =>
        new Response(`<h1>Too large</h1>${"x".repeat(3000)}`, { status: 413 }),
    );
    const error = await client(request)
      .setItem("key", new Uint8Array())
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("<h1>");
    expect((error as Error).message.length).toBeLessThan(2200);
  });
  it("reports network failures and malformed successful responses", async () => {
    await expect(
      client(
        vi.fn(async () => {
          throw new Error("offline");
        }),
      ).setItem("key", new Uint8Array(1)),
    ).rejects.toThrow(/request failed[\s\S]*offline/);
    await expect(
      client(vi.fn(async () => new Response("not-json"))).setItem(
        "key",
        new Uint8Array(1),
      ),
    ).rejects.toThrow("invalid response");
  });
});
