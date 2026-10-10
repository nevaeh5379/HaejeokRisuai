import { expect, test } from "./fixtures";

test("safe mode skips plugin loading and preserves enabled settings", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click({ timeout: 120_000 });
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );
  await page.evaluate(async () => {
    const pluginStoreUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const { pluginStore } = await import(/* @vite-ignore */ pluginStoreUrl);
    await pluginStore.install(
      {
        name: "Safe mode probe",
        version: "3.0",
        enabled: true,
        arguments: {},
        realArg: {},
        argMeta: {},
        customLink: [],
      },
      'Risuai.pluginStorage.setItem("safeModeProbe", "executed");',
    );
  });

  await page.goto("/?safe=1");
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );
  const result = await page.evaluate(async () => {
    const pluginStoreUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const storageUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
    const pluginsUrl = "/src/ts/plugins/plugins.svelte.ts";
    const { pluginStore } = await import(/* @vite-ignore */ pluginStoreUrl);
    const { getSqlStorage } = await import(/* @vite-ignore */ storageUrl);
    const { loadPlugins, togglePluginEnabled } = await import(
      /* @vite-ignore */ pluginsUrl
    );
    const storage = await getSqlStorage();
    const enabled = pluginStore.plugins[0].enabled;
    await loadPlugins();
    await togglePluginEnabled(0);
    await togglePluginEnabled(0);
    return {
      enabled,
      stillEnabled: pluginStore.plugins[0].enabled,
      probe: await storage.loadPluginCustomStorageKey("safeModeProbe"),
    };
  });
  expect(result).toEqual({
    enabled: true,
    stillEnabled: true,
    probe: undefined,
  });
  await page.goto("/");
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const storageUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
        const { getSqlStorage } = await import(/* @vite-ignore */ storageUrl);
        return (await getSqlStorage()).loadPluginCustomStorageKey(
          "safeModeProbe",
        );
      }),
    )
    .toBe("executed");
});
