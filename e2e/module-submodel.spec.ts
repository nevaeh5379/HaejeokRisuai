import { expect, test } from "./fixtures";

/**
 * E2E test for the per-module auxiliary model feature:
 * - Boots app with OPFS SQLite WASM ready
 * - Enters Settings -> Module Settings
 * - Creates a new module with an assigned auxiliary model via ModelList UI
 * - Verifies the auxiliary model button label and options
 * - Verifies the auxiliary model badge is rendered in the module list
 * - Verifies editing the module preserves the auxiliary model in the UI
 * - Verifies runtime trigger propagation and module interchangeability in the browser
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

  // If welcome screen is visible, skip to main app
  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skipButton.click();
  }

  // Ensure main interface is ready
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );
}

test.describe("Per-module auxiliary model (E2E)", () => {
  test("creates a module with auxiliary model and verifies UI badge, editing, and runtime propagation", async ({
    page,
  }) => {
    await waitForAppReady(page);

    // 1. Open Settings -> Module Settings (index 14)
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = (await import(
        /* @vite-ignore */ storesUrl
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(14);
      settingsOpen.set(true);
    });

    // Verify Module Settings header is rendered
    const moduleHeading = page.locator("h2").filter({ hasText: /Modules|모듈/i }).first();
    await expect(moduleHeading).toBeVisible({ timeout: 10_000 });

    // 2. Click Plus button to open Create Module view (mode = 1)
    const plusButton = page.locator("button:has(svg.lucide-plus), button:has(svg.lucide-folder-plus)").first();
    await expect(plusButton).toBeVisible();
    await plusButton.click();

    // Verify we entered Create Module mode
    const createHeading = page.locator("h2").filter({ hasText: /Create Module|모듈 생성/i }).first();
    await expect(createHeading).toBeVisible();

    // 3. Fill in Module Name
    const nameInput = page.locator("input[type='text']").first();
    await nameInput.fill("E2E Test Module");

    // 4. Verify ModelList shows default placeholder for auxiliary model
    const auxModelButton = page
      .locator("button")
      .filter({ hasText: /Default \(Global Auxiliary Model\)|기본값 \(전역 보조 모델\)/i })
      .first();
    await expect(auxModelButton).toBeVisible();

    // 5. Click the ModelList button to open dropdown modal
    await auxModelButton.click();

    // Click OpenAI accordion to expand its models
    const openaiButton = page.locator("div.fixed").getByText("OpenAI", { exact: true });
    await expect(openaiButton).toBeVisible();
    await openaiButton.click();

    // Click "GPT 5.5" model button inside the expanded accordion
    const pickedModelName = "GPT 5.5";
    const modelOption = page.locator("div.fixed").getByText(pickedModelName, { exact: true });
    await expect(modelOption).toBeVisible();
    await modelOption.click();

    // Verify button text updated to the picked model
    await expect(
      page.locator("button").filter({ hasText: pickedModelName }).first(),
    ).toBeVisible();

    // 6. Click "Create Module" to save the module
    const saveButton = page.getByRole("button", { name: /Create Module|모듈 생성/i }).last();
    await saveButton.click();

    // 7. Verify we are back in module list, and the module row shows the auxiliary model badge
    await expect(page.getByText("E2E Test Module")).toBeVisible();
    const subModelBadge = page
      .locator("span")
      .filter({ hasText: new RegExp(pickedModelName, "i") })
      .first();
    await expect(subModelBadge).toBeVisible();

    // 8. Click Edit on the created module and verify ModelList preserves the model
    const editButton = page.locator("button:has(svg.lucide-square-pen)").first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const editHeading = page.locator("h2").filter({ hasText: /Edit Module|모듈 수정/i }).first();
    await expect(editHeading).toBeVisible();

    // Verify ModelList still displays the configured auxiliary model in edit mode
    await expect(
      page.locator("button").filter({ hasText: pickedModelName }).first(),
    ).toBeVisible();

    // Return to module list
    const updateButton = page.getByRole("button", { name: /Edit Module|모듈 수정/i }).last();
    await updateButton.click();
    await expect(moduleHeading).toBeVisible();

    // 9. Verify in-browser runtime behavior
    const runtimeValidation = await page.evaluate(async () => {
      const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
      const modulesUrl = "/src/ts/process/modules.ts";
      const interchangeUrl = "/src/ts/interchangeability.ts";

      const { moduleStore } = (await import(/* @vite-ignore */ moduleStoreUrl)) as {
        moduleStore: any;
      };
      const { getModuleTriggers } = (await import(/* @vite-ignore */ modulesUrl)) as {
        getModuleTriggers: (char?: any, overrideIds?: string[]) => any[];
      };
      const { convertModuleToCharacter, convertCharacterToModule } = (await import(
        /* @vite-ignore */ interchangeUrl
      )) as {
        convertModuleToCharacter: (m: any) => any;
        convertCharacterToModule: (c: any) => any;
      };

      const installed = moduleStore.modules.find(
        (m: any) => m.name === "E2E Test Module",
      );
      if (!installed || !installed.subModel) {
        return { success: false, reason: "Module or subModel missing in store" };
      }

      // Add a test trigger to verify propagation
      installed.trigger = [
        {
          comment: "Runtime Trigger Test",
          type: "manual",
          conditions: [],
          effect: [],
        },
      ];

      const triggers = getModuleTriggers(undefined, [installed.id]);
      const trigger = triggers.find((t) => t.comment === "Runtime Trigger Test");
      if (!trigger || trigger.subModel !== installed.subModel) {
        return {
          success: false,
          reason: `Trigger subModel was not propagated: ${trigger?.subModel}`,
        };
      }

      // Verify character interchangeability
      const char = convertModuleToCharacter(installed);
      if (char.extentions?.moduleSubModel !== installed.subModel) {
        return { success: false, reason: "subModel missing in character extensions" };
      }

      const mod = convertCharacterToModule(char);
      if (mod.subModel !== installed.subModel) {
        return { success: false, reason: "subModel not restored from character" };
      }

      return {
        success: true,
        subModel: installed.subModel,
      };
    });

    expect(runtimeValidation.success).toBe(true);
    expect(runtimeValidation.subModel).toBeTruthy();
  });
});
