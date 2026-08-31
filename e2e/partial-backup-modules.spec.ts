import { expect, test } from "./fixtures";

/**
 * E2E test reproducing the loss of modules during partial local backup save/restore.
 *
 * Steps:
 * 1. Open the app and create/install multiple arbitrary modules into moduleStore.
 * 2. Trigger a partial local backup (`SavePartialLocalBackup`) and capture the downloaded backup file.
 * 3. In a fresh new browser context (clean environment), restore the saved backup file.
 * 4. Verify whether the installed modules are preserved after restore.
 *    (Fails if modules are omitted from the partial backup snapshot).
 */

async function waitForAppReady(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );
}

test.describe("partial local backup module persistence", () => {
  test("preserves installed modules across partial local backup save and restore in a fresh context", async ({
    page,
    browser,
  }, testInfo) => {
    await waitForAppReady(page);

    const testModules = [
      {
        id: "test-module-alpha",
        name: "Test Module Alpha",
        description: "Alpha module description for partial backup test",
        lorebook: [
          {
            key: "alpha-lore",
            content: "Alpha lore content",
            insertion_order: 1,
            enabled: true,
          },
        ],
        regex: [
          {
            comment: "alpha-regex",
            findRegex: "alpha_find",
            replaceString: "alpha_replace",
            disabled: false,
          },
        ],
        trigger: [],
      },
      {
        id: "test-module-beta",
        name: "Test Module Beta",
        description: "Beta module description with custom triggers",
        lorebook: [],
        regex: [],
        trigger: [
          {
            comment: "beta-trigger",
            type: "start",
            script: "console.log('beta trigger')",
          },
        ],
      },
    ];

    // 1. Create and install multiple arbitrary modules into moduleStore
    await page.evaluate(async (modulesToInstall) => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as {
        moduleStore: {
          installModule: (module: any) => Promise<void>;
          flush: () => Promise<void>;
          modules: any[];
        };
      };

      for (const mod of modulesToInstall) {
        await moduleStore.installModule(mod);
      }
      await moduleStore.flush();
    }, testModules);

    // Verify modules exist before backup
    const beforeBackupModules = await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const { moduleStore } = (await import(
        /* @vite-ignore */ moduleStoreUrl
      )) as {
        moduleStore: { modules: { id: string; name: string }[] };
      };
      return moduleStore.modules.map((m) => ({ id: m.id, name: m.name }));
    });

    expect(beforeBackupModules).toEqual(
      expect.arrayContaining([
        { id: "test-module-alpha", name: "Test Module Alpha" },
        { id: "test-module-beta", name: "Test Module Beta" },
      ]),
    );

    // 2. Perform partial local backup and capture the downloaded stream from Service Worker
    const saveOutcomePromise = page.evaluate(async () => {
      let downloadUrl = "";
      const origPostMessage = navigator.serviceWorker.controller!.postMessage.bind(
        navigator.serviceWorker.controller,
      );
      navigator.serviceWorker.controller!.postMessage = (
        data: any,
        transfer: any,
      ) => {
        if (data?.type === "REGISTER_STREAM_DOWNLOAD" && data.id) {
          downloadUrl = `/sw/download?id=${data.id}`;
        }
        return origPostMessage(data, transfer);
      };

      const backupUrl = "/src/ts/drive/backuplocal.ts";
      const { SavePartialLocalBackup } = (await import(
        /* @vite-ignore */ backupUrl
      )) as { SavePartialLocalBackup: () => Promise<void> };

      const savePromise = (async () => {
        try {
          await SavePartialLocalBackup();
          return "completed";
        } catch (error) {
          return `failed: ${error}`;
        }
      })();

      // Wait until writer registers stream download with the service worker
      while (!downloadUrl) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Fetch the full backup stream directly from the Service Worker
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch download stream: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const saveOutcome = await savePromise;
      if (saveOutcome !== "completed") {
        throw new Error(`SavePartialLocalBackup failed: ${saveOutcome}`);
      }

      return Array.from(new Uint8Array(buffer));
    });

    await page.getByRole("button", { name: "YES" }).click();
    await page.getByRole("button", { name: "YES" }).click();

    const backupBytes = await saveOutcomePromise;
    expect(backupBytes.length).toBeGreaterThan(0);

    // 3. Create a fresh clean context (new environment) to restore the backup file
    const freshContext = await browser.newContext();
    await freshContext.addInitScript(() => {
      localStorage.setItem("haejeok_tos_2026_08_23", "true");
    });
    const freshPage = await freshContext.newPage();

    try {
      await waitForAppReady(freshPage);

      // Verify fresh environment starts without our test modules
      const initialModules = await freshPage.evaluate(async () => {
        const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = (await import(
          /* @vite-ignore */ moduleStoreUrl
        )) as {
          moduleStore: { modules: { id: string }[] };
        };
        return moduleStore.modules;
      });
      expect(initialModules).toHaveLength(0);

      // Restore the partial backup file
      await freshPage.evaluate(async (bytesIn) => {
        const backupUrl = "/src/ts/drive/backuplocal.ts";
        const { restoreLocalBackupFile } = (await import(
          /* @vite-ignore */ backupUrl
        )) as { restoreLocalBackupFile: (file: File) => Promise<void> };
        const file = new File([new Uint8Array(bytesIn)], "partial_backup.bin");
        await restoreLocalBackupFile(file);
      }, backupBytes);

      // Page reloads after restore
      await freshPage.waitForLoadState("domcontentloaded");
      await freshPage.waitForFunction(
        async () => {
          const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
          const { moduleStore } = (await import(
            /* @vite-ignore */ moduleStoreUrl
          )) as {
            moduleStore: { loaded: boolean };
          };
          return moduleStore?.loaded === true;
        },
        undefined,
        { timeout: 60_000 },
      );

      // 4. Assert that the modules were preserved after restore
      const restoredModules = await freshPage.evaluate(async () => {
        const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = (await import(
          /* @vite-ignore */ moduleStoreUrl
        )) as {
          moduleStore: {
            modules: { id: string; name: string; description: string }[];
          };
        };
        return moduleStore.modules.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
        }));
      });

      // THIS IS EXPECTED TO FAIL when modules are missing from the backup snapshot:
      expect(restoredModules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "test-module-alpha",
            name: "Test Module Alpha",
          }),
          expect.objectContaining({
            id: "test-module-beta",
            name: "Test Module Beta",
          }),
        ]),
      );
    } finally {
      await freshContext.close();
    }
  });
});
