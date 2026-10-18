import { expect, test } from "./fixtures";

test("shares the SQLite worker across hot module replacements and preserves stored data", async ({
  page,
}) => {
  let workerCount = 0;
  page.on("worker", (worker) => {
    if (worker.url().includes("webSqliteWorker")) workerCount++;
  });
  await page.route("**/sqlite-module-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>SQLite test</title>",
    }),
  );
  await page.goto("/sqlite-module-test");

  const result = await page.evaluate(async () => {
    const path = "/src/ts/storage/sql/sqlite/web/webSqliteStorage.ts";
    const timestamp = Date.now();
    const load = (version: number) =>
      import(/* @vite-ignore */ `${path}?t=${timestamp + version}`);
    const firstModule = await load(1);
    const first = new firstModule.WebSqliteStorage();
    const initialized = await first.init();
    await first.rpc.exec("CREATE TABLE hmr_probe (value TEXT)");
    await first.rpc.exec("INSERT INTO hmr_probe VALUES ('before')");
    const pendingWrite = first.rpc.exec("UPDATE hmr_probe SET value = 'after'");

    // Vite reevaluates the source with a new URL while retaining the module's
    // hot data. Without that state the first worker keeps the OPFS lock and
    // this second instance fails to initialize, even in a single tab.
    const secondModule = await load(2);
    const second = new secondModule.WebSqliteStorage();
    const replacementInitialized = await second.init();
    const sharedRpc = first.rpc === second.rpc;
    await pendingWrite;
    const row = await second.rpc.selectOne("SELECT value FROM hmr_probe");
    await second.close();

    // Closing through the replacement must clear the shared state as well,
    // so the next instance can reopen the same database without losing data.
    const thirdModule = await load(3);
    const third = new thirdModule.WebSqliteStorage();
    const reopened = await third.init();
    const persisted = await third.rpc.selectOne("SELECT value FROM hmr_probe");
    await third.close();
    return {
      initialized,
      replacementInitialized,
      sharedRpc,
      row,
      reopened,
      persisted,
    };
  });

  expect(result).toEqual({
    initialized: true,
    replacementInitialized: true,
    sharedRpc: true,
    row: { value: "after" },
    reopened: true,
    persisted: { value: "after" },
  });
  expect(workerCount).toBe(2);
});
