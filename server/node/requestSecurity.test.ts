import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  hostnameFromHostHeader,
  isLoopbackHostname,
  isSecurePostgresConfigRequest,
} = require("./requestSecurity.cjs");

function request({
  secure = false,
  remoteAddress = "::ffff:172.18.0.1",
  headers = {},
}: {
  secure?: boolean;
  remoteAddress?: string;
  headers?: Record<string, string>;
} = {}) {
  return { secure, headers, socket: { remoteAddress } };
}

describe("database configuration transport checks", () => {
  it("recognizes loopback host headers behind Docker port forwarding", () => {
    expect(hostnameFromHostHeader("localhost:6001")).toBe("localhost");
    expect(hostnameFromHostHeader("127.0.0.1:6001")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("[::1]:6001")).toBe("::1");
    expect(isLoopbackHostname("dev.localhost")).toBe(true);
  });

  it("allows localhost browser requests even when Docker hides the client loopback address", () => {
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { host: "localhost:6001" },
        }),
      ),
    ).toBe(true);
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { host: "127.0.0.1:6001" },
        }),
      ),
    ).toBe(true);
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { host: "[::1]:6001" },
        }),
      ),
    ).toBe(true);
  });

  it("still rejects plain HTTP requests addressed to non-loopback hosts", () => {
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { host: "192.168.1.20:6001" },
        }),
      ),
    ).toBe(false);
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { host: "example.com" },
        }),
      ),
    ).toBe(false);
  });

  it("continues to allow HTTPS and direct loopback connections", () => {
    expect(isSecurePostgresConfigRequest(request({ secure: true }))).toBe(true);
    expect(
      isSecurePostgresConfigRequest(request({ remoteAddress: "127.0.0.1" })),
    ).toBe(true);
    expect(
      isSecurePostgresConfigRequest(
        request({
          headers: { "x-forwarded-proto": "https" },
        }),
      ),
    ).toBe(true);
  });
});
