import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const updater = fileURLToPath(new URL("./update-dynv6.sh", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "risuai-dynv6-test-"));
  const bin = join(directory, "bin");
  const token = join(directory, "token");
  const log = join(directory, "curl.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const curl = join(bin, "curl");
  await writeFile(
    curl,
    `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_CURL_LOG"
case "$*:$FAKE_CURL_FAIL" in
  *ipv4.dynv6.com*:ipv4) exit 22 ;;
  *ipv6.dynv6.com*:ipv6) exit 22 ;;
esac
printf 'updated'
`,
  );
  await chmod(curl, 0o755);
  await writeFile(token, "test-token", { mode: 0o600 });
  return {
    directory,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DYNV6_TOKEN_FILE: token,
      DYNV6_ZONE: "chat.dynv6.net",
      DYNV6_ONCE: "true",
      DYNV6_UPDATE_INTERVAL: "60",
      FAKE_CURL_LOG: log,
    },
    async calls() {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    async close() {
      await rm(directory, { recursive: true });
    },
  };
}

function run(env, { signalAfterOutput = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [updater], { env });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (signalAfterOutput && !signalled) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("performs a bounded one-shot IPv4 update", async () => {
  const f = await fixture();
  try {
    const result = await run(f.env);
    assert.equal(result.code, 0, result.stderr);
    const calls = await f.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--connect-timeout 10/);
    assert.match(calls[0], /--max-time 30/);
    assert.match(calls[0], /ipv4\.dynv6\.com/);
  } finally {
    await f.close();
  }
});

test("does not mask an IPv4 curl failure or continue to IPv6", async () => {
  const f = await fixture();
  try {
    const result = await run({ ...f.env, DYNV6_IPV6: "true", FAKE_CURL_FAIL: "ipv4" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /IPv4 update failed/);
    assert.equal((await f.calls()).length, 1);
  } finally {
    await f.close();
  }
});

test("reports a partial dual-stack update as failure", async () => {
  const f = await fixture();
  try {
    const result = await run({ ...f.env, DYNV6_IPV6: "true", FAKE_CURL_FAIL: "ipv6" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /IPv6 update failed after the IPv4 update/);
    assert.equal((await f.calls()).length, 2);
  } finally {
    await f.close();
  }
});

test("rejects invalid permanent settings before curl", async (t) => {
  for (const [name, override, message] of [
    ["interval", { DYNV6_UPDATE_INTERVAL: "0" }, /must be from 60 to 86400/],
    ["boolean", { DYNV6_IPV6: "yes" }, /must be true or false/],
    ["hostname", { DYNV6_ZONE: "bad_name" }, /valid fully qualified hostname/],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const result = await run({ ...f.env, ...override });
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
        assert.equal((await f.calls()).length, 0);
      } finally {
        await f.close();
      }
    });
  }
});

test("terminates its background interval sleep cleanly", async () => {
  const f = await fixture();
  try {
    const result = await run({ ...f.env, DYNV6_ONCE: "false" }, { signalAfterOutput: true });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  } finally {
    await f.close();
  }
});
