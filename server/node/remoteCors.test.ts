import { describe, expect, it, vi } from "vitest";

const {
  createRemoteCorsMiddleware,
  parseAllowedOrigins,
} = require("./remoteCors.cjs");

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

function request(origin: string | undefined, method = "GET") {
  const headers: Record<string, string> = { host: "server.example" };
  if (origin) headers.origin = origin;
  return {
    method,
    protocol: "https",
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

describe("remote API CORS", () => {
  it("accepts exact configured origins and emits Vary", () => {
    const middleware = createRemoteCorsMiddleware(
      parseAllowedOrigins("https://app.example, http://localhost:5174"),
    );
    const { res, headers } = response();
    const next = vi.fn();
    middleware(request("https://app.example"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(headers.get("vary")).toContain("Origin");
  });

  it("allows the server's own origin without configuration", () => {
    const middleware = createRemoteCorsMiddleware(new Set());
    const { res } = response();
    const next = vi.fn();
    middleware(request("https://server.example"), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects unlisted origins", () => {
    const middleware = createRemoteCorsMiddleware(new Set());
    const { res } = response();
    const next = vi.fn();
    middleware(request("https://attacker.example"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "cors_denied" });
  });

  it("answers valid preflight and rejects unknown headers", () => {
    const middleware = createRemoteCorsMiddleware(
      new Set(["https://app.example"]),
    );
    const allowed = request("https://app.example", "OPTIONS");
    allowed.headers["access-control-request-headers"] =
      "content-type, risu-auth, x-risu-client-id";
    const allowedResponse = response();
    middleware(allowed, allowedResponse.res, vi.fn());
    expect(allowedResponse.res.statusCode).toBe(204);

    const denied = request("https://app.example", "OPTIONS");
    denied.headers["access-control-request-headers"] = "x-surprise-header";
    const deniedResponse = response();
    middleware(denied, deniedResponse.res, vi.fn());
    expect(deniedResponse.res.statusCode).toBe(403);
  });

  it("requires exact origin configuration", () => {
    expect(() => parseAllowedOrigins("*")).toThrow(/exact origins/);
    expect(() => parseAllowedOrigins("https://example.com/path")).toThrow(
      /Invalid CORS origin/,
    );
  });
});
