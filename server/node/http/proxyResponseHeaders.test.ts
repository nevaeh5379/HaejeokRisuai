import { describe, expect, it } from "vitest";
import { proxyResponseHeaders } from "./proxyResponseHeaders";

describe("proxy response cache policy", () => {
  it("prevents a cacheable ComfyUI workflow file from becoming a cached /proxy2 response", () => {
    const upstream = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT",
      ETag: '"workflow"',
      "Content-Disposition": 'attachment; filename="workflow.json"',
    });
    const forwarded = proxyResponseHeaders(upstream);
    expect(forwarded.get("Cache-Control")).toBe("no-store");
    expect(forwarded.get("Content-Type")).toBe("application/json");
    expect(forwarded.get("Content-Disposition")).toBe(
      upstream.get("Content-Disposition"),
    );
    expect(upstream.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("blocks heuristic caching when only a last-modified validator is provided", () => {
    expect(
      proxyResponseHeaders(
        new Headers({ "Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT" }),
      ).get("Cache-Control"),
    ).toBe("no-store");
  });

  it("retains the existing filtering of decompressed encoding and upstream page policies", () => {
    const headers = proxyResponseHeaders(
      new Headers({
        "Content-Encoding": "gzip",
        "Content-Security-Policy": "default-src 'none'",
        "Content-Security-Policy-Report-Only": "default-src 'none'",
        "Clear-Site-Data": '"storage"',
        "Content-Type": "text/event-stream",
      }),
    );
    for (const key of [
      "Content-Encoding",
      "Content-Security-Policy",
      "Content-Security-Policy-Report-Only",
      "Clear-Site-Data",
    ])
      expect(headers.has(key)).toBe(false);
    expect(headers.get("Content-Type")).toBe("text/event-stream");
  });
});
