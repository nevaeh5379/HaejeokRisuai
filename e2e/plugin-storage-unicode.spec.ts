import { expect, test } from "./fixtures";

async function waitForApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
    undefined,
    { timeout: 120_000 },
  );
}

function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key.includes("\0") || containsNul(child),
  );
}

test("plugin storage preserves NUL-containing text through Node SQL storage", async ({
  page,
}) => {
  await waitForApp(page);

  let persistedValue: unknown;
  let rejectedWrites = 0;

  await page.route("**/api/db-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        revision: 0,
        runtime: { status: "ready" },
      }),
    });
  });
  await page.route("**/api/database-v2/commit", async (route) => {
    const payload = route.request().postDataJSON() as {
      pluginStorage?: { upserts?: Array<{ key: string; value: unknown }> };
    };
    const upsert = payload.pluginStorage?.upserts?.find(
      ({ key }) => key === "wiglore-memory",
    );
    if (containsNul(upsert?.value)) {
      rejectedWrites++;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "unsupported Unicode escape sequence" }),
      });
      return;
    }
    persistedValue = upsert?.value;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1 }),
    });
  });
  await page.route(
    "**/api/database-v2/plugin-custom-storage/keys/wiglore-memory",
    async (route) => {
      if (persistedValue === undefined) {
        await route.fulfill({ status: 404 });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "wiglore-memory",
          value: persistedValue,
          hash: "playwright-plugin-storage-hash",
        }),
      });
    },
  );

  const result = await page.evaluate(async () => {
    const pluginsUrl = "/src/ts/plugins/plugins.svelte.ts";
    const settingsStoreUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const nodeStorageUrl =
      "/src/ts/storage/sql/postgres/nodePostgresStorage.ts";
    const { getV2PluginAPIs } = (await import(
      /* @vite-ignore */ pluginsUrl
    )) as {
      getV2PluginAPIs: () => {
        pluginStorage: {
          setItem: (key: string, value: unknown) => void;
        };
      };
    };
    const { settingsStore } = (await import(
      /* @vite-ignore */ settingsStoreUrl
    )) as {
      settingsStore: {
        dispose: () => void;
        init: (settings: Record<string, unknown>, storage: unknown) => void;
        flush: () => Promise<void>;
        hasPendingWrites: () => boolean;
      };
    };
    const { NodePostgresStorage } = (await import(
      /* @vite-ignore */ nodeStorageUrl
    )) as {
      NodePostgresStorage: new (getAuth: () => Promise<string>) => {
        loadPluginCustomStorageKey: (key: string) => Promise<unknown>;
      };
    };

    const storage = new NodePostgresStorage(async () => "playwright-auth");
    settingsStore.dispose();
    settingsStore.init({ pluginCustomStorage: {} }, storage);

    const expected = {
      summary: "memory before\0memory after",
      nested: ["ordinary text", "another\0NUL"],
    };
    getV2PluginAPIs().pluginStorage.setItem("wiglore-memory", expected);
    await settingsStore.flush();
    const pendingAfterFlush = settingsStore.hasPendingWrites();
    const loaded = await storage.loadPluginCustomStorageKey("wiglore-memory");
    settingsStore.dispose();

    return { expected, loaded, pendingAfterFlush };
  });

  expect(rejectedWrites).toBe(0);
  expect(result.pendingAfterFlush).toBe(false);
  expect(result.loaded).toEqual(result.expected);
});
