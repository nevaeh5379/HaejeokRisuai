import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SERVICE_WORKER_PROTOCOL_VERSION,
  hasCompatibleServiceWorkerController,
} from "./serviceWorkerProtocol";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker protocol", () => {
  it("rejects an HTML app-shell response from an unhandled /sw/init request", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {} },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!doctype html><html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(hasCompatibleServiceWorkerController()).resolves.toBe(false);
  });

  it("rejects a stale service worker protocol", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {} },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("v2", { status: 200 })),
    );

    await expect(hasCompatibleServiceWorkerController()).resolves.toBe(false);
  });

  it("accepts the current service worker protocol without caching the probe", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {} },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(SERVICE_WORKER_PROTOCOL_VERSION, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(hasCompatibleServiceWorkerController()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/sw/init", { cache: "no-store" });
  });

  it("keeps the public service worker handshake version in sync", async () => {
    const source = await readFile(
      resolve(process.cwd(), "public/sw.js"),
      "utf8",
    );

    expect(source).toContain(
      `case "init": {\n          event.respondWith(new Response("${SERVICE_WORKER_PROTOCOL_VERSION}"));`,
    );
  });
});
