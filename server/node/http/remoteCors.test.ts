// @vitest-environment node
import "tsx/cjs";
import express from "express";
import type { RequestHandler } from "express";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createRemoteCorsMiddleware } = require("./remoteCors.cts") as {
  createRemoteCorsMiddleware: () => RequestHandler;
};

describe("remote API CORS", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api", createRemoteCorsMiddleware());
    app.use(express.json());
    app.post("/api/crypto", (req, res) => res.json({ data: req.body.data }));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves a JSON API request from a different origin", async () => {
    const response = await fetch(`${baseUrl}/api/crypto`, {
      method: "POST",
      headers: {
        origin: "https://client.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: "example" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: "example" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://client.example",
    );
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "etag",
    );
  });

  it("allows remote API methods and authentication headers in preflight", async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,risu-auth,file-path",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://client.example",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    );
    const allowedHeaders = response.headers
      .get("access-control-allow-headers")
      ?.split(",");
    expect(allowedHeaders).toEqual(
      expect.arrayContaining(["content-type", "risu-auth", "file-path"]),
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });
});
