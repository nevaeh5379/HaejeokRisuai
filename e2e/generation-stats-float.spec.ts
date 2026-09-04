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

test.describe("Generation stats float position and toggle (E2E)", () => {
  test("configures floating window position and off option from settings and reflects in chat", async ({ page }) => {
    test.setTimeout(120_000);
    await waitForAppReady(page);

    // 1. Create and select a character to enter ChatScreen
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createNewCharacter, changeChar } = (await load(
        "/src/ts/characters.ts",
      )) as { createNewCharacter: () => number; changeChar: (idx: number) => Promise<void> };
      const idx = createNewCharacter();
      await changeChar(idx);
    });

    const tabList = page.locator("[data-chat-tab-list]");
    await expect(tabList).toBeVisible({ timeout: 10_000 });

    // 2. Open Settings -> Display Settings (menu index 3)
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsOpen, SettingsMenuIndex } = (await load(
        "/src/ts/stores.svelte.ts",
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(3);
      settingsOpen.set(true);
    });

    const displayHeading = page
      .locator("h2")
      .filter({ hasText: /Display|디스플레이/i })
      .first();
    await expect(displayHeading).toBeVisible({ timeout: 10_000 });

    // 3. Navigate to "Others" submenu in Display settings
    const othersTabButton = page.locator("div.h-16 button").last();
    await expect(othersTabButton).toBeVisible({ timeout: 5000 });
    await othersTabButton.click();

    // 4. Locate the generationStatsPosition setting
    const positionSetting = page.locator(
      '[data-setting-id="display.generationStatsPosition"]',
    );
    await expect(positionSetting).toBeVisible({ timeout: 5000 });

    const select = positionSetting.locator("select");
    await expect(select).toHaveValue("bottom-right");

    // 5. Test selecting each position and verifying state
    await select.selectOption("bottom-left");
    await expect(select).toHaveValue("bottom-left");

    let storedPosition = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      return settingsStore.state.generationStatsPosition;
    });
    expect(storedPosition).toBe("bottom-left");

    await select.selectOption("top-left");
    await expect(select).toHaveValue("top-left");

    await select.selectOption("top-right");
    await expect(select).toHaveValue("top-right");

    await select.selectOption("off");
    await expect(select).toHaveValue("off");

    storedPosition = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      return settingsStore.state.generationStatsPosition;
    });
    expect(storedPosition).toBe("off");

    // 6. Close Settings
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsOpen } = (await load(
        "/src/ts/stores.svelte.ts",
      )) as { settingsOpen: { set: (v: boolean) => void } };
      settingsOpen.set(false);
    });

    // 7. Verify float rendering at each position during generation
    // When off: float is NOT visible
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { startChatGenerationStats } = (await load(
        "/src/ts/process/chatGenerationStats.ts",
      )) as { startChatGenerationStats: (opts: any) => void };
      const { selectedCharID } = (await load(
        "/src/ts/stores.svelte.ts",
      )) as { selectedCharID: { subscribe: (fn: (v: number) => void) => () => void } };
      let charIdx = 0;
      const unsub = selectedCharID.subscribe((v: number) => {
        charIdx = v;
      });
      unsub();
      startChatGenerationStats({
        generationId: "test-gen-1",
        selectedChar: charIdx,
        selectedChat: 0,
        model: "gpt-4o",
      });
    });

    const floatBadge = page.locator('[data-testid="generation-stats-float"]');
    await expect(floatBadge).toHaveCount(0);

    // Switch to bottom-right -> float appears at bottom-right
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      settingsStore.state.generationStatsPosition = "bottom-right";
    });
    await expect(floatBadge).toBeVisible();
    await expect(floatBadge).toHaveAttribute("data-position", "bottom-right");
    await expect(floatBadge).toHaveClass(/bottom-20/);
    await expect(floatBadge).toHaveClass(/right-4/);

    // Switch to bottom-left -> float moves to bottom-left
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      settingsStore.state.generationStatsPosition = "bottom-left";
    });
    await expect(floatBadge).toHaveAttribute("data-position", "bottom-left");
    await expect(floatBadge).toHaveClass(/bottom-20/);
    await expect(floatBadge).toHaveClass(/left-4/);

    // Switch to top-left -> float moves to top-left
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      settingsStore.state.generationStatsPosition = "top-left";
    });
    await expect(floatBadge).toHaveAttribute("data-position", "top-left");
    await expect(floatBadge).toHaveClass(/top-16/);
    await expect(floatBadge).toHaveClass(/left-4/);

    // Switch to top-right -> float moves to top-right
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      settingsStore.state.generationStatsPosition = "top-right";
    });
    await expect(floatBadge).toHaveAttribute("data-position", "top-right");
    await expect(floatBadge).toHaveClass(/top-16/);
    await expect(floatBadge).toHaveClass(/right-4/);

    // Switch to off -> float disappears
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      settingsStore.state.generationStatsPosition = "off";
    });
    await expect(floatBadge).toHaveCount(0);

    // Clean up generation stats
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { cancelChatGenerationStats } = (await load(
        "/src/ts/process/chatGenerationStats.ts",
      )) as { cancelChatGenerationStats: (id: string) => void };
      cancelChatGenerationStats("test-gen-1");
    });
  });

  test("renders floating window during live chat generation and respects position and off option", async ({ page }) => {
    test.setTimeout(120_000);
    await waitForAppReady(page);

    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createNewCharacter, changeChar } = (await load(
        "/src/ts/characters.ts",
      )) as { createNewCharacter: () => number; changeChar: (idx: number) => Promise<void> };
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as { settingsStore: any };
      const { presetStore } = (await load(
        "/src/ts/stores/domain/presetStore.svelte.ts",
      )) as { presetStore: any };

      settingsStore.state.useStreaming = true;
      settingsStore.state.openAIKey = "e2e-fake-key";
      settingsStore.state.usePlainFetch = true;
      settingsStore.state.requestRetrys = 0;
      settingsStore.state.dynamicModelRegistry = false;
      settingsStore.state.autoContinueChat = false;
      settingsStore.state.generationStatsPosition = "bottom-left";
      presetStore.state.aiModel = "gpt-4o";

      const idx = createNewCharacter();
      await changeChar(idx);
    });

    const tabList = page.locator("[data-chat-tab-list]");
    await expect(tabList).toBeVisible({ timeout: 10_000 });

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    await page.route("https://api.openai.com/**", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({ json: { data: [] } });
        return;
      }
      await responseGate;
      const content = "Response finished.";
      await route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      });
    });

    try {
      await page.locator("textarea.text-input-area").fill("Hello!");
      await page.locator(".button-icon-send").click();

      // Floating window should appear at bottom-left while waiting/generating
      const floatBadge = page.locator('[data-testid="generation-stats-float"]');
      await expect(floatBadge).toBeVisible();
      await expect(floatBadge).toHaveAttribute("data-position", "bottom-left");
      await expect(floatBadge).toHaveClass(/bottom-20/);
      await expect(floatBadge).toHaveClass(/left-4/);

      // Dynamically toggle to off -> should hide immediately
      await page.evaluate(async () => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { settingsStore } = (await load(
          "/src/ts/stores/domain/settingsStore.svelte.ts",
        )) as { settingsStore: any };
        settingsStore.state.generationStatsPosition = "off";
      });
      await expect(floatBadge).toHaveCount(0);

      // Dynamically toggle to top-right -> should reappear at top-right
      await page.evaluate(async () => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { settingsStore } = (await load(
          "/src/ts/stores/domain/settingsStore.svelte.ts",
        )) as { settingsStore: any };
        settingsStore.state.generationStatsPosition = "top-right";
      });
      await expect(floatBadge).toBeVisible();
      await expect(floatBadge).toHaveAttribute("data-position", "top-right");
      await expect(floatBadge).toHaveClass(/top-16/);
      await expect(floatBadge).toHaveClass(/right-4/);

      releaseResponse();
      await expect(page.getByText("Response finished.", { exact: true })).toBeVisible();
    } finally {
      releaseResponse();
    }
  });
});
