// @vitest-environment node
import "tsx/cjs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { CorsRequest, CorsResponse } from "./remoteCors.cts";

const require = createRequire(import.meta.url);
const { createRemoteCorsMiddleware } = require("./remoteCors.cts") as {
  createRemoteCorsMiddleware: () => (
    req: CorsRequest,
    res: CorsResponse,
    next: () => void,
  ) => void;
};

function response() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    setHeader: (name: string, value: string) =>
      void headers.set(name.toLowerCase(), value),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return { res, headers };
}

function request(origin: string | undefined, method = "POST") {
  const headers: Record<string, string> = { host: "server.example" };
  if (origin) headers.origin = origin;
  return {
    method,
    protocol: "http",
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function invoke(
  req: ReturnType<typeof request>,
  res: ReturnType<typeof response>["res"],
  next = vi.fn(),
) {
  createRemoteCorsMiddleware()(req, res, next);
  return next;
}

describe("remote API CORS", () => {
  it.each([
    "https://server.example",
    "https://different.example",
    "http://localhost:5174",
    "http://127.0.0.1:6200",
    "tauri://localhost",
    "http://tauri.localhost",
    "capacitor://localhost",
    "null",
  ])("accepts origin %s without configuration", (origin) => {
    const { res, headers } = response();
    const next = invoke(request(origin), res);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(headers.get("access-control-allow-origin")).toBe(origin);
    expect(headers.get("vary")).toContain("Origin");
  });

  it("passes requests without Origin through", () => {
    const { res, headers } = response();
    expect(invoke(request(undefined), res)).toHaveBeenCalledOnce();
    expect(headers.has("access-control-allow-origin")).toBe(false);
  });

  it("answers preflight from a different origin", () => {
    const req = request("https://different.example", "OPTIONS");
    req.headers["access-control-request-headers"] =
      "content-type, risu-auth, x-risu-backup-upload-token, x-risu-client-id, last-event-id";
    const { res, headers } = response();
    const next = invoke(req, res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(headers.get("access-control-allow-origin")).toBe(
      "https://different.example",
    );
  });

  it("still rejects unsupported preflight headers", () => {
    const req = request("https://different.example", "OPTIONS");
    req.headers["access-control-request-headers"] = "x-surprise-header";
    const { res } = response();
    expect(invoke(req, res)).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "CORS header is not allowed" });
  });
});
