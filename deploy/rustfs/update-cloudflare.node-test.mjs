import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const script = new URL("./update-cloudflare.mjs", import.meta.url);
const zone = "0123456789abcdef0123456789abcdef";

async function fixture(records = {}, options = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/ip4" || url.pathname === "/ip6") {
      if (options.hangAddressLookup) return;
      response.end(url.pathname === "/ip4" ? (options.ipv4 ?? "203.0.113.4") : (options.ipv6 ?? "2001:db8::4"));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url, body: body ? JSON.parse(body) : undefined });
    if (options.authFailure) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ message: "authentication failed" }] }));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ success: true, result: records[url.searchParams.get("type")] ?? [] }));
    } else {
      response.end(JSON.stringify({ success: true, result: { id: "changed" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "risuai-cf-test-"));
  const token = join(directory, "token");
  await writeFile(token, "test-token", { mode: 0o600 });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    env: {
      ...process.env,
      CLOUDFLARE_ZONE_ID: zone,
      CLOUDFLARE_RECORD_NAME: "chat.example.com",
      CLOUDFLARE_TOKEN_FILE: token,
      CLOUDFLARE_API_BASE: `${base}/api`,
      PUBLIC_IPV4_URL: `${base}/ip4`,
      PUBLIC_IPV6_URL: `${base}/ip6`,
      CLOUDFLARE_ONCE: "true",
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true });
    },
  };
}

function run(env, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script.pathname], { env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("patches only content and preserves an existing record's settings", async () => {
  const f = await fixture({ A: [{ id: "a1", content: "192.0.2.1", ttl: 120, proxied: true }] });
  try {
    const result = await run(f.env);
    assert.equal(result.code, 0, result.stderr);
    const patch = f.calls.find((call) => call.method === "PATCH");
    assert.deepEqual(patch.body, { content: "203.0.113.4" });
  } finally { await f.close(); }
});

test("creates DNS-only automatic-TTL A and optional AAAA records", async () => {
  const f = await fixture();
  try {
    const result = await run({ ...f.env, CLOUDFLARE_IPV6: "true" });
    assert.equal(result.code, 0, result.stderr);
    const creates = f.calls.filter((call) => call.method === "POST").map((call) => call.body);
    assert.deepEqual(creates, [
      { type: "A", name: "chat.example.com", content: "203.0.113.4", ttl: 1, proxied: false },
      { type: "AAAA", name: "chat.example.com", content: "2001:db8::4", ttl: 1, proxied: false },
    ]);
  } finally { await f.close(); }
});

test("warns about an existing AAAA record when IPv6 updates are disabled", async () => {
  const f = await fixture({ A: [{ id: "a1", content: "203.0.113.4" }], AAAA: [{ id: "v6", content: "2001:db8::9" }] });
  try {
    const result = await run(f.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /AAAA record.*left unchanged/);
    assert.equal(f.calls.some((call) => call.method === "PATCH"), false);
  } finally { await f.close(); }
});

test("validates every requested public address before reading or writing DNS", async () => {
  const f = await fixture({}, { ipv6: "not-an-ipv6-address" });
  try {
    const result = await run({ ...f.env, CLOUDFLARE_IPV6: "true" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid address/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("refuses duplicate records and CNAME conflicts before writing", async (t) => {
  for (const [name, records, message] of [
    ["duplicates", { A: [{ id: "1" }, { id: "2" }] }, /multiple A records/],
    ["CNAME", { CNAME: [{ id: "c1" }] }, /CNAME record/],
  ]) {
    await t.test(name, async () => {
      const f = await fixture(records);
      try {
        const result = await run(f.env);
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
        assert.equal(f.calls.some((call) => call.method !== "GET"), false);
      } finally { await f.close(); }
    });
  }
});

test("reports Cloudflare authentication failures", async () => {
  const f = await fixture({}, { authFailure: true });
  try {
    const result = await run(f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /authentication failed/);
  } finally { await f.close(); }
});

test("rejects permanent configuration errors before entering the retry loop", async () => {
  const f = await fixture();
  try {
    const result = await run({ ...f.env, CLOUDFLARE_ONCE: "false", CLOUDFLARE_UPDATE_INTERVAL: "invalid" });
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /UPDATE_INTERVAL must be an integer/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("rejects invalid booleans and endpoint schemes", async (t) => {
  const f = await fixture();
  try {
    for (const [name, env, message] of [
      ["boolean", { CLOUDFLARE_IPV6: "yes" }, /IPV6 must be true or false/],
      ["URL", { PUBLIC_IPV4_URL: "file:///etc/passwd" }, /must use HTTP or HTTPS/],
    ]) {
      await t.test(name, async () => {
        const result = await run({ ...f.env, ...env });
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
      });
    }
  } finally { await f.close(); }
});

test("aborts a stalled address lookup at the configured deadline", async () => {
  const f = await fixture({}, { hangAddressLookup: true });
  try {
    const result = await run({ ...f.env, CLOUDFLARE_REQUEST_TIMEOUT: "1" }, 3000);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /timed out after 1 seconds/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
