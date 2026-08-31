import { expect, test } from "./fixtures";

async function waitForDomainStores(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
  await page.waitForFunction(
    async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as { moduleStore: { loaded: boolean } };
      return moduleStore.loaded;
    },
    undefined,
    { timeout: 120_000 },
  );
}

test.describe("domain store boundaries", () => {
  test("stale character settings stay out of the startup settings domain", async ({
    page,
  }) => {
    await waitForDomainStores(page);

    const result = await page.evaluate(async () => {
      const webStorageUrl =
        "/src/ts/storage/sql/sqlite/web/webSqliteStorage.ts";
      const defaultsUrl = "/src/ts/storage/database/databaseDefaults.ts";
      const { WebSqliteStorage } = (await import(
        /* @vite-ignore */ webStorageUrl
      )) as {
        WebSqliteStorage: new () => unknown;
      };
      const { normalizeSettingsDefaults } = (await import(
        /* @vite-ignore */ defaultsUrl
      )) as {
        normalizeSettingsDefaults: (settings: Record<string, unknown>) => void;
      };

      const storage = new WebSqliteStorage() as {
        init: () => Promise<boolean>;
        rpc?: {
          exec: (sql: string, bind?: unknown[]) => Promise<void>;
          selectOne: (
            sql: string,
            bind?: unknown[],
          ) => Promise<Record<string, unknown> | null>;
        };
        loadStartupData: () => Promise<{
          settings: Record<string, unknown>;
          characters: unknown[];
        } | null>;
      };
      await storage.init();
      if (!storage.rpc) throw new Error("Web SQLite RPC is not initialized");

      await storage.rpc.exec(
        "INSERT OR REPLACE INTO system_settings " +
          "(key, domain, value_type, text_value) " +
          "VALUES (?, 'root', 'string', 'stale-character-payload')",
        ["characters"],
      );
      const staleRow = await storage.rpc.selectOne(
        "SELECT key FROM system_settings WHERE key = ?",
        ["characters"],
      );

      let strictOwnershipError = "";
      try {
        normalizeSettingsDefaults({ characters: [] });
      } catch (error) {
        strictOwnershipError = String(error);
      }

      const startup = await storage.loadStartupData();
      return {
        staleRowExists: staleRow?.key === "characters",
        strictOwnershipError,
        startupContainsCharactersSetting: Object.prototype.hasOwnProperty.call(
          startup?.settings ?? {},
          "characters",
        ),
        startupCharacterDomainIsSeparate: Array.isArray(startup?.characters),
      };
    });

    expect(result.staleRowExists).toBe(true);
    expect(result.strictOwnershipError).toContain(
      "characters is owned by another domain store",
    );
    expect(result.startupContainsCharactersSetting).toBe(false);
    expect(result.startupCharacterDomainIsSeparate).toBe(true);
  });

  test("plugin compatibility API reads and creates modules through ModuleStore", async ({
    page,
  }) => {
    await waitForDomainStores(page);

    const result = await page.evaluate(async () => {
      const pluginsUrl = "/src/ts/plugins/plugins.svelte.ts";
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const settingsStoreUrl =
        "/src/ts/stores/domain/settingsStore.svelte.ts";
      const { getV2PluginAPIs } = (await import(
        /* @vite-ignore */ pluginsUrl
      )) as {
        getV2PluginAPIs: () => {
          getDatabase: () => Record<string, unknown>;
          setDatabase: (database: Record<string, unknown>) => Promise<void>;
        };
      };
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as {
        moduleStore: {
          modules: Array<{ id: string; name: string; description: string }>;
          flush: () => Promise<void>;
        };
      };
      const { settingsStore } = (await import(
        /* @vite-ignore */ settingsStoreUrl
      )) as {
        settingsStore: {
          set: (key: string, value: unknown) => void;
        };
      };

      const existingModule = {
        id: "existing-playwright-module",
        name: "Existing Playwright Module",
        description: "Must survive plugin module creation",
      };
      moduleStore.modules = [existingModule];
      await moduleStore.flush();

      let reproducedMisrouteError = "";
      try {
        settingsStore.set("modules", []);
      } catch (error) {
        reproducedMisrouteError = String(error);
      }

      const pluginApi = getV2PluginAPIs();
      const databaseBefore = pluginApi.getDatabase();
      const snapshotModules = (value: unknown) =>
        Array.from(
          value as Array<{
            id: string;
            name: string;
            description: string;
          }>,
          ({ id, name, description }) => ({ id, name, description }),
        );
      const modulesBefore = snapshotModules(databaseBefore.modules);
      const module = {
        id: "playwright-plugin-module",
        name: "Playwright Plugin Module",
        description: "Created through the plugin compatibility database API",
      };
      let applyError = "";
      try {
        await pluginApi.setDatabase({ modules: [module] });
        await moduleStore.flush();
      } catch (error) {
        applyError = String(error);
      }

      const databaseAfter = pluginApi.getDatabase();
      return {
        modulesWasEnumerable: Object.keys(databaseBefore).includes("modules"),
        modulesBefore,
        modulesAfter: snapshotModules(databaseAfter.modules),
        storedModules: snapshotModules(moduleStore.modules),
        applyError,
        reproducedMisrouteError,
      };
    });

    expect(result.modulesWasEnumerable).toBe(true);
    expect(result.modulesBefore).toEqual([
      expect.objectContaining({ id: "existing-playwright-module" }),
    ]);
    expect(result.reproducedMisrouteError).toContain(
      "[SettingsStore] modules is owned by another domain store",
    );
    expect(result.applyError).toBe("");
    expect(result.modulesAfter).toEqual([
      expect.objectContaining({ id: "existing-playwright-module" }),
      expect.objectContaining({ id: "playwright-plugin-module" }),
    ]);
    expect(result.storedModules).toEqual(result.modulesAfter);
  });
});
