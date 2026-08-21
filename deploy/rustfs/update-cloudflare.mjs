import { isIP } from "node:net";
import { readFile } from "node:fs/promises";

const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
const recordName = (process.env.CLOUDFLARE_RECORD_NAME ?? "").toLowerCase();
const ipv6Enabled = process.env.CLOUDFLARE_IPV6 === "true";
const once = process.env.CLOUDFLARE_ONCE === "true";
const interval = Number(process.env.CLOUDFLARE_UPDATE_INTERVAL ?? "300");
const apiBase = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const ipv4Url = process.env.PUBLIC_IPV4_URL ?? "https://api.ipify.org";
const ipv6Url = process.env.PUBLIC_IPV6_URL ?? "https://api6.ipify.org";
const tokenFile = process.env.CLOUDFLARE_TOKEN_FILE ?? "/run/secrets/cloudflare_token";

function fail(message) {
  throw new Error(message);
}

function validateConfiguration() {
  if (!/^[0-9a-f]{32}$/i.test(zoneId)) fail("CLOUDFLARE_ZONE_ID must be a 32-character hexadecimal ID");
  if (!recordName) fail("CLOUDFLARE_RECORD_NAME is required");
  if (!Number.isInteger(interval) || interval < 60) fail("CLOUDFLARE_UPDATE_INTERVAL must be an integer of at least 60 seconds");
}

async function responseText(response, description) {
  const text = await response.text();
  if (!response.ok) fail(`${description} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text.trim();
}

async function getPublicAddress(url, family) {
  const response = await fetch(url, { headers: { Accept: "text/plain" } });
  const address = await responseText(response, `public IPv${family} lookup`);
  if (isIP(address) !== family) fail(`public IPv${family} lookup returned an invalid address: ${address}`);
  return address;
}

async function api(token, path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`Cloudflare API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body.success !== true) {
    const errors = Array.isArray(body.errors) ? body.errors.map((error) => error.message ?? error.code).join(", ") : text;
    fail(`Cloudflare API request failed (HTTP ${response.status}): ${errors || "unknown error"}`);
  }
  return body.result;
}

async function listRecords(token, type) {
  const query = new URLSearchParams({ type, name: recordName, per_page: "100" });
  const result = await api(token, `/zones/${zoneId}/dns_records?${query}`);
  if (!Array.isArray(result)) fail("Cloudflare record lookup returned an unexpected response");
  return result;
}

async function updateOnce() {
  validateConfiguration();
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) fail("The Cloudflare API token secret is empty");

  // Resolve and validate every requested address before making any DNS change.
  const addresses = { A: await getPublicAddress(ipv4Url, 4) };
  if (ipv6Enabled) addresses.AAAA = await getPublicAddress(ipv6Url, 6);

  const [aRecords, aaaaRecords, cnameRecords] = await Promise.all([
    listRecords(token, "A"),
    listRecords(token, "AAAA"),
    listRecords(token, "CNAME"),
  ]);
  if (cnameRecords.length > 0) fail(`${recordName} has a CNAME record; refusing to create A/AAAA records`);
  if (aRecords.length > 1) fail(`${recordName} has multiple A records; refusing an ambiguous update`);
  if (aaaaRecords.length > 1) fail(`${recordName} has multiple AAAA records; refusing an ambiguous update`);
  if (!ipv6Enabled && aaaaRecords.length === 1) {
    console.warn(`warning: ${recordName} already has an AAAA record; IPv6 updates are disabled and the record was left unchanged`);
  }

  for (const [type, content] of Object.entries(addresses)) {
    const records = type === "A" ? aRecords : aaaaRecords;
    if (records.length === 0) {
      await api(token, `/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type, name: recordName, content, ttl: 1, proxied: false }),
      });
      console.log(`created ${type} record for ${recordName}: ${content}`);
    } else if (records[0].content !== content) {
      await api(token, `/zones/${zoneId}/dns_records/${records[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      console.log(`updated ${type} record for ${recordName}: ${content}`);
    } else {
      console.log(`${type} record for ${recordName} is current: ${content}`);
    }
  }
}

async function main() {
  if (once) {
    await updateOnce();
    return;
  }
  for (;;) {
    try {
      await updateOnce();
    } catch (error) {
      console.error(`Cloudflare DDNS update failed; retrying at the next interval: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
