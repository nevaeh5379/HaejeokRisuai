// Temporary probe: does the app's Served-Worker streamed download work in
// this headless Chromium + Vite dev environment?
// Run: node e2e-swprobe.mjs  (from the project root)
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (m) => console.log("[console]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://127.0.0.1:5174/");
await page.waitForTimeout(6000); // let the app boot + register the SW

const result = await page.evaluate(async () => {
  const regs = (
    await navigator.serviceWorker.getRegistrations()
  ).map((r) => r.active?.scriptURL ?? r.installing?.scriptURL ?? "?");
  const ctrl = navigator.serviceWorker.controller;
  const out = { controllerScriptURL: ctrl?.scriptURL ?? null, registrations: regs };

  // 1) plain fetch interception check (sw.js answers /sw/init with "v2")
  const initResp = await fetch("/sw/init").then((r) => r.text());
  out.swInitResponse = initResp.slice(0, 40);

  // 2) raw SW fetch interception check for /sw/download (expect 404 "not found")
  const missing = await fetch("/sw/download?id=probe-missing").then((r) => r.text());
  out.downloadMissingResponse = missing.startsWith("Download stream")
    ? "SW_INTERCEPTED_404"
    : missing.slice(0, 40);

  // 3) replicate the app's streamed-download handshake via fetch()
  if (ctrl) {
    const id = "probe-stream-" + Math.random().toString(36).slice(2);
    const ch = new MessageChannel();
    ctrl.postMessage(
      { type: "REGISTER_STREAM_DOWNLOAD", id, filename: "probe.bin" },
      [ch.port2],
    );
    ch.port1.postMessage(new TextEncoder().encode("HELLO-FROM-SW"));
    ch.port1.postMessage({ done: true });
    await new Promise((r) => setTimeout(r, 300));
    const resp = await fetch("/sw/download?id=" + id);
    const body = await resp.text();
    out.streamViaFetch = {
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      body: body.slice(0, 40),
    };
  }
  return out;
});
console.log(JSON.stringify(result, null, 2));

// 4) replicate the actual app flow: <a download> click + waitForEvent('download')
const anchorId = "probe-anchor-" + Math.random().toString(36).slice(2);
const downloadPromise = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
await page.evaluate((id) => {
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl) return "no-controller";
  const ch = new MessageChannel();
  ctrl.postMessage(
    { type: "REGISTER_STREAM_DOWNLOAD", id, filename: "probe-anchor.jpeg" },
    [ch.port2],
  );
  ch.port1.postMessage(new TextEncoder().encode("ANCHOR-TEST"));
  ch.port1.postMessage({ done: true });
  const a = document.createElement("a");
  a.href = "/sw/download?id=" + id;
  a.download = "probe-anchor.jpeg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return "clicked";
}, anchorId);
const download = await downloadPromise;
if (download) {
  const fp = await download.path();
  const { readFileSync } = await import("node:fs");
  const head = readFileSync(fp).subarray(0, 40).toString("utf8");
  console.log("ANCHOR_DOWNLOAD:", {
    suggested: download.suggestedFilename(),
    head: JSON.stringify(head),
  });
} else {
  console.log("ANCHOR_DOWNLOAD: no download event fired");
}

await browser.close();