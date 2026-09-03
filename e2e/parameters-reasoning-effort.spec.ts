import { expect, test } from "./fixtures";

/**
 * E2E test reproducing and verifying fix for:
 * [SettingsStore] reasoningEffort is owned by PresetStore
 * when navigating to Parameters settings with a model that supports reasoning effort (e.g. o3-mini).
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

  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skipButton.click();
  }

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );
}

test.describe("Parameters settings - Reasoning Effort", () => {
  test("renders Reasoning Effort segmented control without crashing on SettingsStore", async ({
    page,
  }) => {
    // Capture page errors (uncaught exceptions)
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err);
    });

    await waitForAppReady(page);

    // Set model to o3-mini which has 'reasoning_effort' parameter
    await page.evaluate(async () => {
      const presetStoreUrl = "/src/ts/stores/domain/presetStore.svelte.ts";
      const { presetStore } = (await import(
        /* @vite-ignore */ presetStoreUrl
      )) as { presetStore: any };
      presetStore.state.aiModel = "o3-mini";

      // Open Settings -> Bot Settings -> Parameters (submenu 1)
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = (await import(
        /* @vite-ignore */ storesUrl
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(1);
      settingsOpen.set(true);
    });

    // Click "Parameters" tab in settings
    const paramsButton = page
      .locator("button")
      .filter({ hasText: /Parameters|파라미터/i })
      .first();
    await expect(paramsButton).toBeVisible();
    await paramsButton.click();

    // Verify Reasoning Effort label is visible
    const reasoningLabel = page.getByText("Reasoning Effort");
    await expect(reasoningLabel).toBeVisible({ timeout: 5000 });

    // Click "High" option on the segmented control
    const highButton = page.getByRole("button", { name: "High", exact: true });
    await expect(highButton).toBeVisible();
    await highButton.click();

    // Verify presetStore.state.reasoningEffort was updated to 2
    const updatedEffort = await page.evaluate(async () => {
      const presetStoreUrl = "/src/ts/stores/domain/presetStore.svelte.ts";
      const { presetStore } = (await import(
        /* @vite-ignore */ presetStoreUrl
      )) as { presetStore: any };
      return presetStore.state.reasoningEffort;
    });
    expect(updatedEffort).toBe(2);

    // Check that no SettingsStore errors were thrown
    const settingsStoreError = pageErrors.find((e) =>
      e.message.includes("[SettingsStore] reasoningEffort is owned by PresetStore"),
    );
    expect(settingsStoreError).toBeUndefined();
    expect(pageErrors).toHaveLength(0);
  });
});
