// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

let upstream: Server;
let server: ChildProcess;
let root: string;
let proxyUrl: string;
let targetUrl: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "risu-proxy-test-"));
  await writeFile(join(root, "__password"), "test-auth");
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("base64"),
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  targetUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api`;
  const portReservation = createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  proxyUrl = `http://127.0.0.1:${port}/proxy2`;
  server = spawn(process.execPath, [resolve("server/node/server.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      RISU_SAVE_PATH: root,
      DB_VENDOR: "postgres",
      RISU_HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Server startup timed out: ${output}`)),
      15000,
    );
    server.once("error", reject);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${output}`));
    });
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("HTTP server is running")) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout!.on("data", onOutput);
    server.stderr!.on("data", onOutput);
  });
}, 20000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGKILL");
    await exited;
  }
  if (upstream)
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([
  ["GET", "", "application/json"],
  ["POST", '{ "prompt": "hello" }', "application/json"],
  [
    "POST",
    "grant_type=refresh_token&token=a%2Bb",
    "application/x-www-form-urlencoded",
  ],
  ["PUT", "plain text", "text/plain"],
  ["PATCH", Buffer.from([0, 255, 128, 10]), "application/octet-stream"],
  ["DELETE", "", "application/json"],
] as const)(
  "preserves a native %s request with %s",
  async (method, body, contentType) => {
    const response = await fetch(proxyUrl, {
      method,
      headers: {
        "risu-auth": "test-auth",
        "risu-url": encodeURIComponent(targetUrl),
        "risu-header": encodeURIComponent(
          JSON.stringify({
            "Content-Type": contentType,
            Authorization: "Bearer provider-token",
          }),
        ),
        "Content-Type": "application/octet-stream",
      },
      body: method === "GET" || method === "DELETE" ? undefined : body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method,
      contentType,
      authorization: "Bearer provider-token",
      body: Buffer.from(body).toString("base64"),
    });
  },
);

it("still accepts the existing JSON proxy protocol", async () => {
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "risu-auth": "test-auth",
      "risu-url": encodeURIComponent(targetUrl),
      "risu-header": encodeURIComponent(
        JSON.stringify({ "Content-Type": "application/json" }),
      ),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    method: "POST",
    body: Buffer.from('{"prompt":"hello"}').toString("base64"),
  });
});
