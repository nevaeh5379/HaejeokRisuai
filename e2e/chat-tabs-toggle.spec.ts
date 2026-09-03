import { expect, test } from "./fixtures";

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
  await skipButton.waitFor({ state: "visible", timeout: 30_000 });
  await skipButton.click();

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );

  await expect(page.getByText("Loading...")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("Chat tabs toggle (E2E)", () => {
  test("toggles chat tabs UI visibility from display settings", async ({ page }) => {
    await waitForAppReady(page);

    // Create and select a character to enter ChatScreen
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as { createNewCharacter: () => number; changeChar: (idx: number) => Promise<void> };
      const idx = createNewCharacter();
      await changeChar(idx);
    });

    // 1. Verify tab UI is visible by default
    const tabList = page.locator("[data-chat-tab-list]");
    await expect(tabList).toBeVisible({ timeout: 10_000 });

    // 2. Open Settings -> Display Settings (menu index 3)
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = (await import(
        /* @vite-ignore */ storesUrl
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(3);
      settingsOpen.set(true);
    });

    // Verify Display Settings header is visible
    const displayHeading = page
      .locator("h2")
      .filter({ hasText: /Display|디스플레이/i })
      .first();
    await expect(displayHeading).toBeVisible({ timeout: 10_000 });

    // 3. Navigate to "Others" submenu in Display settings (3rd tab in the top tab bar)
    const othersTabButton = page.locator("div.h-16 button").last();
    await expect(othersTabButton).toBeVisible({ timeout: 5000 });
    await othersTabButton.click();

    // 4. Locate the showChatTabs setting
    const chatTabsSetting = page.locator('[data-setting-id="display.showChatTabs"]');
    await expect(chatTabsSetting).toBeVisible({ timeout: 5000 });

    // Check that checkbox is checked by default
    const checkbox = chatTabsSetting.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();

    // 5. Click the setting toggle to hide tabs
    await chatTabsSetting.locator("label").click();
    await expect(checkbox).not.toBeChecked();

    // Verify settingsStore state updated
    const showChatTabsValue = await page.evaluate(async () => {
      const settingsStoreUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
      const { settingsStore } = (await import(
        /* @vite-ignore */ settingsStoreUrl
      )) as { settingsStore: any };
      return settingsStore.state.showChatTabs;
    });
    expect(showChatTabsValue).toBe(false);

    // 6. Close Settings
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen } = (await import(
        /* @vite-ignore */ storesUrl
      )) as { settingsOpen: { set: (v: boolean) => void } };
      settingsOpen.set(false);
    });

    // 7. Verify tab UI is hidden
    await expect(tabList).toHaveCount(0);

    // 8. Reopen Settings and toggle it back ON
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = (await import(
        /* @vite-ignore */ storesUrl
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(3);
      settingsOpen.set(true);
    });
    await expect(displayHeading).toBeVisible({ timeout: 5000 });
    await othersTabButton.click();
    await expect(chatTabsSetting).toBeVisible({ timeout: 5000 });
    await chatTabsSetting.locator("label").click();
    await expect(checkbox).toBeChecked();

    // Close Settings
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen } = (await import(
        /* @vite-ignore */ storesUrl
      )) as { settingsOpen: { set: (v: boolean) => void } };
      settingsOpen.set(false);
    });

    // 9. Verify tab UI is visible again
    await expect(tabList).toBeVisible({ timeout: 5000 });
  });
});
