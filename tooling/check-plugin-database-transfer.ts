import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium } from "@playwright/test";

// Exercise the real, minified nonce bridge in an opaque-origin sandbox. This
// catches errors that an in-process DOM mock (or an unminified toString) misses.
const workspace = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "risuai-database-transfer-"));
const entry = join(directory, "fixture.svelte.ts");
const modulePath = (path: string) =>
  JSON.stringify(resolve(workspace, path).replaceAll("\\", "/"));
await writeFile(
  entry,
  `
import { SandboxHost } from ${modulePath("src/ts/plugins/apiV3/factory.ts")};
import { prepareDatabaseSnapshot } from ${modulePath("src/ts/plugins/apiV3/databaseSnapshot.svelte.ts")};

export async function check(mode: "legacy" | "transfer") {
  const database: any = $state({
    characters: [{ chaId: "character", chats: [{ id: "chat", message: Array.from({ length: 10000 }, (_, i) => ({ role: "char", data: "message " + i })) }] }],
    theme: "light",
    pluginCustomStorage: { date: new Date(0), bytes: new Uint8Array([1, 2]), map: new Map([["value", { data: "map" }]]), set: new Set(["set"]), sparse: new Array(4), value: undefined },
  });
  database.characters[0].chats[0].alias = database.characters[0].chats[0].message;
  database.pluginCustomStorage.sparse[2] = "present";
  const nativeShared = { data: "native shared" };
  database.pluginCustomStorage.map.set("shared", nativeShared);
  database.pluginCustomStorage.nativePadding = Array.from({ length: 1000 }, (_, i) => ({ data: "padding " + i }));
  database.pluginCustomStorage.secondMap = new Map([["shared", nativeShared]]);
  database.pluginCustomStorage.set.add(nativeShared);
  const keys = ["characters", "theme", "pluginCustomStorage"];
  const payload = async (source: any, selected: string[], includeOnly: string[] | "all") => {
    if (mode === "transfer") return prepareDatabaseSnapshot(source, selected, async () => [], includeOnly);
    const result: any = {};
    for (const key of selected) if (includeOnly === "all" || includeOnly.includes(key)) result[key] = $state.snapshot(source[key]);
    return result;
  };
  const host = new SandboxHost({
    _getPropertiesForInitialization: () => ({ list: [] }),
    _getAliases: () => ({}),
    getDatabase: (includeOnly: string[] | "all" = "all") => {
      if (includeOnly !== "all" && includeOnly.includes("cycle")) {
        const cyclic: any = { data: "cycle" }; cyclic.self = cyclic;
        return payload({ characters: [cyclic] }, ["characters"], "all");
      }
      if (includeOnly !== "all" && includeOnly.includes("uncloneable")) return payload({ characters: [{ bad: () => "uncloneable" }] }, ["characters"], "all");
      if (includeOnly !== "all" && includeOnly.includes("stream")) return payload({ stream: new ReadableStream({ start(controller) { controller.enqueue("stream body"); controller.close(); } }) }, ["stream"], "all");
      if (includeOnly !== "all" && includeOnly.includes("failure")) return payload({ characters: [database.characters[0], { get failure() { throw new Error("Read failed"); } }] }, ["characters"], "all");
      return payload(database, keys, includeOnly);
    },
    setDatabase: (value: any) => { if (value.characters) database.characters = value.characters; },
  });
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const completed = new Promise<any>((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow && event.data?.type === "FIXTURE_RESULT") {
        window.removeEventListener("message", listener);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      }
    };
    window.addEventListener("message", listener);
  });
  try {
    const checkCode = \`
      const [all, selected, empty] = await Promise.all([risuai.getDatabase(), risuai.getDatabase(["characters"]), risuai.getDatabase([])]);
      const chat = all.characters[0].chats[0];
      const storage = all.pluginCustomStorage;
      if (chat.message.length !== 10000 || selected.characters[0].chats[0].message[9999].data !== "message 9999") throw new Error("Missing history");
      if (chat.alias !== chat.message) throw new Error("Lost graph identity");
      if (!(storage.date instanceof Date) || storage.date.getTime() !== 0 || !(storage.bytes instanceof Uint8Array) || storage.bytes[1] !== 2) throw new Error("Lost native type");
      if (!(storage.map instanceof Map) || storage.map.get("value").data !== "map" || !(storage.set instanceof Set) || !storage.set.has("set")) throw new Error("Lost collection");
      if (storage.map.get("shared") !== storage.secondMap.get("shared") || !storage.set.has(storage.map.get("shared"))) throw new Error("Lost native child identity across batches");
      if (0 in storage.sparse || storage.sparse.length !== 4 || storage.sparse[2] !== "present" || !Object.hasOwn(storage, "value")) throw new Error("Lost sparse/undefined values");
      if (Object.keys(selected).join() !== "characters" || Object.keys(empty).length !== 0) throw new Error("Incorrect includeOnly");
      if (Object.keys(storage).join() !== "date,bytes,map,set,sparse,value,nativePadding,secondMap") throw new Error("Changed native-field property order");
      chat.message[0].data = "edited";
      const original = await risuai.getDatabase(["characters"]);
      if (original.characters[0].chats[0].message[0].data !== "message 0") throw new Error("Result is not detached");
      await risuai.setDatabase({ characters: all.characters });
      const saved = await risuai.getDatabase(["characters"]);
      if (saved.characters[0].chats[0].message[0].data !== "edited") throw new Error("Legacy save round trip failed");
      const streamed = await risuai.getDatabase(["stream"]);
      const reader = streamed.stream.getReader();
      if ((await reader.read()).value !== "stream body" || !(await reader.read()).done) throw new Error("Root stream failed");
      let rejected = false;
      try { await risuai.getDatabase(["failure"]); } catch (e) { rejected = e.message === "Read failed"; }
      if (!rejected) throw new Error("Partial failure resolved as a database");
      let uncloneableRejected = false;
      try { await risuai.getDatabase(["uncloneable"]); } catch (e) { uncloneableRejected = e.message.includes("could not be cloned"); }
      if (!uncloneableRejected) throw new Error("Uncloneable value was silently dropped");
      if (graphMode === "transfer") {
        const cyclic = await risuai.getDatabase(["cycle"]);
        if (cyclic.characters[0].self !== cyclic.characters[0]) throw new Error("Guest lost cycle identity");
      }
      const afterFailure = await risuai.getDatabase(["theme"]);
      if (afterFailure.theme !== "light") throw new Error("Bridge stalled after failure");
      return { messages: saved.characters[0].chats[0].message.length, graph: true, native: true, selections: true, detached: true, save: true, stream: true, failure: true };
    \`;
    host.run(iframe, '(async () => { try { const result = await (async () => { const graphMode = ' + JSON.stringify(mode) + ';' + checkCode + '})(); window.parent.postMessage({ type: "FIXTURE_RESULT", result }, "*"); } catch (error) { window.parent.postMessage({ type: "FIXTURE_RESULT", error: error.message }, "*"); } })();');
    const result = await completed;
    if (database.pluginCustomStorage.bytes.byteLength !== 2) throw new Error("Original binary buffer detached");
    return result;
  } finally { host.terminate(); iframe.remove(); }
}
`,
  "utf8",
);

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [svelte()],
    build: {
      write: false,
      minify: true,
      lib: { entry, formats: ["iife"], name: "PluginDatabaseFixture" },
    },
  });
  const bundles = Array.isArray(output) ? output : [output];
  const bundle = bundles
    .flatMap((value) => ("output" in value ? value.output : []))
    .find((value) => value.type === "chunk");
  assert(
    bundle && bundle.type === "chunk",
    "No browser fixture bundle generated",
  );
  browser = await chromium.launch();
  const results: unknown[] = [];
  for (const mode of ["legacy", "transfer"]) {
    const page = await browser.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("https://database-bridge.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("https://database-bridge.test/");
    await page.addScriptTag({ content: bundle.code });
    results.push(
      await Promise.race([
        page.evaluate(
          (mode) => (globalThis as any).PluginDatabaseFixture.check(mode),
          mode,
        ),
        new Promise((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Browser bridge check timed out")),
            30000,
          );
          timeout.unref();
        }),
      ]),
    );
    assert.deepEqual(pageErrors, [], "Unexpected browser script error");
    await page.close();
  }
  assert.deepEqual(results[1], results[0]);
  console.log(
    "Minified Chromium sandbox: legacy and graph-transfer results match",
    results[1],
  );
} finally {
  await browser?.close();
  await unlink(entry);
  await rmdir(directory);
}
