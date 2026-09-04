import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function preparePluginLoad(page: Page, empty = false, failOnce = false) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );
  const skip = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  await skip.click({ timeout: 120_000 });
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
  );
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);

  return page.evaluate(
    async ({ empty, failOnce }) => {
      const settingsUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
      const loaderUrl = "/src/ts/stores/domain/deferredSettingsLoader.ts";
      const storageUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
      const storesUrl = "/src/ts/stores.svelte.ts";
      const langUrl = "/src/lang/index.ts";
      const { settingsStore } = await import(/* @vite-ignore */ settingsUrl);
      const { deferredSettingsLoader } = await import(
        /* @vite-ignore */ loaderUrl
      );
      const { getSqlStorage } = await import(/* @vite-ignore */ storageUrl);
      const { settingsOpen, SettingsMenuIndex } = await import(
        /* @vite-ignore */ storesUrl
      );
      const lang = await import(/* @vite-ignore */ langUrl);
      if (empty) await lang.changeLanguage("ko");
      const { language } = lang;
      const storage = await getSqlStorage();
      await deferredSettingsLoader.ensureAll();
      settingsStore.set(
        "plugins",
        empty
          ? []
          : [
              {
                name: "Deferred database plugin",
                script: "",
                arguments: {},
                realArg: {},
                argMeta: {},
                customLink: [],
                version: "3.0",
                enabled: false,
              },
            ],
      );
      await settingsStore.flush();
      // Keep the actual SQLite data, but restore the cold UI state.
      settingsStore.hydrateSettingKey("plugins", []);
      const control = { calls: 0, release: () => {} };
      const gate = new Promise<void>((resolve) => {
        control.release = resolve;
      });
      (window as any).__pluginLoad = control;
      const originalLoad = storage.loadSettingKey.bind(storage);
      storage.loadSettingKey = async (key: string) => {
        if (key === "plugins") {
          control.calls += 1;
          await gate;
          if (failOnce && control.calls === 1)
            throw new Error("Simulated plugin read failure");
        }
        return originalLoad(key);
      };
      deferredSettingsLoader.init({
        storage,
        unloadedKeys: ["plugins"],
        hydrateSettingKey: settingsStore.hydrateSettingKey.bind(settingsStore),
      });
      SettingsMenuIndex.set(-1);
      settingsOpen.set(true);
      return {
        plugin: language.plugin,
        loading: language.loading,
        empty: language.noPlugins,
        error: language.pluginLoadFailed,
        retry: language.pluginLoadRetry,
      };
    },
    { empty, failOnce },
  );
}

test("shows loading while the plugin settings database query is pending", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const labels = await preparePluginLoad(page);
  await page.getByRole("button", { name: labels.plugin, exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__pluginLoad.calls))
    .toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: labels.loading }),
  ).toBeVisible();
  await expect(page.getByText(labels.empty, { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__pluginLoad.release());
  await expect(
    page.getByText("Deferred database plugin", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: labels.loading }),
  ).toHaveCount(0);
});

test("mobile shows loading until an empty plugin query finishes, including reopening", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const labels = await preparePluginLoad(page, true);
  const openPlugins = () =>
    page.getByRole("button", { name: labels.plugin, exact: true }).click();
  await openPlugins();
  const loading = page.getByRole("status").filter({ hasText: labels.loading });
  await expect(loading).toBeVisible();
  await expect(page.getByText(labels.empty, { exact: true })).toHaveCount(0);

  // Leave and return before the same query completes; it must not load twice.
  const returnToMenu = () =>
    page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { SettingsMenuIndex } = await import(/* @vite-ignore */ storesUrl);
      SettingsMenuIndex.set(-1);
    });
  await returnToMenu();
  await openPlugins();
  await expect(loading).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__pluginLoad.calls))
    .toBe(1);
  await page.screenshot({
    path: "test-results/plugin-settings-loading-mobile.png",
  });
  await page.evaluate(() => (window as any).__pluginLoad.release());
  await expect(page.getByText(labels.empty, { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  await returnToMenu();
  await openPlugins();
  await expect(page.getByText(labels.empty, { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pluginLoad.calls)).toBe(1);
});

test("a failed plugin query offers retry instead of an empty list", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const labels = await preparePluginLoad(page, false, true);
  await page.getByRole("button", { name: labels.plugin, exact: true }).click();
  const loading = page.getByRole("status").filter({ hasText: labels.loading });
  await expect(loading).toBeVisible();
  await page.evaluate(() => (window as any).__pluginLoad.release());
  await expect(
    page.getByRole("alert").filter({ hasText: labels.error }),
  ).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.getByText(labels.empty, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: labels.retry, exact: true }).click();
  await expect(
    page.getByText("Deferred database plugin", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: labels.error }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pluginLoad.calls)).toBe(2);
});
