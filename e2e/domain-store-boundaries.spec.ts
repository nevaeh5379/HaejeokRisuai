import { expect, test } from "./fixtures";

async function waitForDomainStores(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
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
          getSafeGlobalThis: () => {
            DBState: { db: Record<string, unknown> };
          };
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
      (globalThis as typeof globalThis & { __pluginApis__: unknown })
        .__pluginApis__ = pluginApi;
      const databaseBefore = pluginApi.getSafeGlobalThis().DBState.db;
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
        (databaseBefore.modules as Array<typeof module>).push(module);
        await pluginApi.setDatabase({ modules: databaseBefore.modules });
        await moduleStore.flush();
      } catch (error) {
        applyError = String(error);
      }

      const databaseAfter = pluginApi.getSafeGlobalThis().DBState.db;
      return {
        databaseType: typeof databaseBefore,
        modulesWasEnumerable: Object.keys(databaseBefore).includes("modules"),
        modulesBefore,
        modulesAfter: snapshotModules(databaseAfter.modules),
        storedModules: snapshotModules(moduleStore.modules),
        applyError,
        reproducedMisrouteError,
      };
    });

    expect(result.databaseType).toBe("object");
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

  test("API v3 plugin renders the module list and remains responsive after creation", async ({
    page,
  }) => {
    page.on("console", async (message) => {
      if (message.text().startsWith("Original response:")) {
        console.log(
          "[plugin-rpc]",
          JSON.stringify(
            await Promise.all(message.args().map((argument) => argument.jsonValue())),
          ),
        );
      }
    });
    await waitForDomainStores(page);

    await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const pluginsUrl = "/src/ts/plugins/plugins.svelte.ts";
      const pluginV3Url = "/src/ts/plugins/apiV3/v3.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as {
        moduleStore: {
          modules: Array<{ id: string; name: string; description: string }>;
          flush: () => Promise<void>;
        };
      };
      const { executePluginV3 } = (await import(
        /* @vite-ignore */ pluginV3Url
      )) as {
        executePluginV3: (plugin: Record<string, unknown>) => Promise<void>;
      };
      const { getV2PluginAPIs } = (await import(
        /* @vite-ignore */ pluginsUrl
      )) as {
        getV2PluginAPIs: () => {
          getDatabase: () => { modules: Array<{ name: string }> };
        };
      };

      moduleStore.modules = [
        {
          id: "visible-existing-module",
          name: "Visible Existing Module",
          description: "Must be rendered inside the plugin iframe",
        },
      ];
      await moduleStore.flush();
      if (
        getV2PluginAPIs().getDatabase().modules[0]?.name !==
        "Visible Existing Module"
      ) {
        throw new Error("Compatibility database cannot read the seeded module");
      }

      const existingFrames = new Set(document.querySelectorAll("iframe"));
      await executePluginV3({
        name: "Module List E2E",
        displayName: "Module List E2E",
        version: "3.0",
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        script: `
          document.body.innerHTML = \`
            <main>
              <ul data-testid="module-list"></ul>
              <button data-testid="create-module" type="button">Create module</button>
              <output data-testid="plugin-status">ready</output>
            </main>
          \`;

          const renderModules = async () => {
            const db = await risuai.getDatabase(["modules"]);
            if (!Array.isArray(db?.modules)) {
              throw new Error("Plugin database did not return a modules array");
            }
            document.querySelector('[data-testid="module-list"]').textContent =
              db.modules.map((module) => module.name).join(" | ");
          };

          document.querySelector('[data-testid="create-module"]').addEventListener("click", async () => {
            const status = document.querySelector('[data-testid="plugin-status"]');
            status.textContent = "saving";
            await risuai.setDatabase({
              modules: [{
                id: "visible-created-module",
                name: "Visible Created Module",
                description: "Created from the API v3 iframe",
              }],
            });
            await renderModules();
            status.textContent = "ready";
          });

          try {
            await renderModules();
          } catch (error) {
            document.querySelector('[data-testid="plugin-status"]').textContent =
              "error: " + error.message;
          }
          await risuai.showContainer("fullscreen");
        `,
      });

      const pluginFrame = Array.from(document.querySelectorAll("iframe")).find(
        (frame) => !existingFrames.has(frame),
      );
      if (!pluginFrame) throw new Error("API v3 plugin iframe was not created");
      pluginFrame.dataset.testid = "module-list-plugin-frame";
    });

    const consentButton = page.getByRole("button", {
      name: "YES",
      exact: true,
    });
    const pluginFrame = page.frameLocator(
      'iframe[data-testid="module-list-plugin-frame"]',
    );
    const moduleList = pluginFrame.getByTestId("module-list");

    const parentModulesBeforeConsent = await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as { moduleStore: { modules: Array<{ name: string }> } };
      return moduleStore.modules.map((module) => module.name);
    });
    console.log(
      "[parent-modules-before-consent]",
      JSON.stringify(parentModulesBeforeConsent),
    );

    await expect
      .poll(
        async () => {
          if (await consentButton.isVisible()) {
            await consentButton.click();
            return true;
          }
          const text = await moduleList.textContent();
          return Boolean(text && text.trim().length > 0);
        },
        { timeout: 10000 },
      )
      .toBe(true);

    const parentModuleNames = await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as { moduleStore: { modules: Array<{ name: string }> } };
      return moduleStore.modules.map((module) => module.name);
    });
    console.log("[parent-modules]", JSON.stringify(parentModuleNames));

    await expect(pluginFrame.getByTestId("plugin-status")).toHaveText("ready");
    await expect(moduleList).toContainText("Visible Existing Module");
    await pluginFrame.getByTestId("create-module").click();
    await expect(pluginFrame.getByTestId("plugin-status")).toHaveText("ready");
    await expect(moduleList).toContainText("Visible Existing Module");
    await expect(moduleList).toContainText("Visible Created Module");

    const storedModuleNames = await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as {
        moduleStore: { modules: Array<{ name: string }> };
      };
      return moduleStore.modules.map((module) => module.name);
    });
    expect(storedModuleNames).toEqual([
      "Visible Existing Module",
      "Visible Created Module",
    ]);
  });
});
