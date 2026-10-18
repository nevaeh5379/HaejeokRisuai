import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0, {
    timeout: 120_000,
  });

  const skip = page.getByText(/Skip & Explore|직접 설정할래요/i).first();
  if (
    await skip
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
  await expect(page.getByText("Welcome to Haejeok RisuAI")).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function selectCharacter(page: Page) {
  await page.evaluate(async () => {
    const charUrl = "/src/ts/characters.ts";
    const { createNewCharacter, changeChar } = (await import(
      /* @vite-ignore */ charUrl
    )) as {
      createNewCharacter: () => number;
      changeChar: (idx: number) => Promise<void>;
    };
    const idx = createNewCharacter();
    await changeChar(idx);
  });
}

async function enableMobileGui(page: Page) {
  await page.evaluate(async () => {
    const settingsUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { settingsStore } = (await import(
      /* @vite-ignore */ settingsUrl
    )) as { settingsStore: { state: { betaMobileGUI: boolean } } };
    settingsStore.state.betaMobileGUI = true;
    const storesUrl = "/src/ts/stores.svelte.ts";
    const { syncMobileGUI } = (await import(
      /* @vite-ignore */ storesUrl
    )) as { syncMobileGUI: () => void };
    syncMobileGUI();
  });
}

test("opens the module menu from the mobile header quick menu", async ({
  page,
}) => {
  await boot(page);
  await enableMobileGui(page);
  await selectCharacter(page);

  const quickMenuButton = page.getByRole("button", {
    name: "Chat quick menu",
  });
  await expect(quickMenuButton).toBeVisible({ timeout: 15_000 });
  await quickMenuButton.click();

  const modulesEntry = page.getByText("대화 모듈", { exact: true }).first();
  await expect(modulesEntry).toBeVisible({ timeout: 10_000 });
  await modulesEntry.click();

  const moduleMenu = page.getByText(
    /enable or disable modules for this chat|이 채팅 한정으로/i,
  );
  await expect(moduleMenu).toBeVisible({ timeout: 10_000 });
  await expect(moduleMenu).toBeInViewport({ timeout: 10_000 });
});

test("opens the module menu from the mobile composer quick menu", async ({
  page,
}) => {
  await boot(page);
  await enableMobileGui(page);
  await selectCharacter(page);

  const menuButton = page.locator(".rs-chat-menu-btn");
  await expect(menuButton).toBeVisible({ timeout: 15_000 });
  await menuButton.click();

  const popover = page.locator(".rs-chat-menu-popover");
  await expect(popover).toBeVisible({ timeout: 10_000 });

  const modulesEntry = popover.getByText(/^(모듈|Modules)$/).first();
  await expect(modulesEntry).toBeVisible({ timeout: 10_000 });
  await modulesEntry.click();

  const moduleMenu = page.getByText(
    /enable or disable modules for this chat|이 채팅 한정으로/i,
  );
  await expect(moduleMenu).toBeVisible({ timeout: 10_000 });
  await expect(moduleMenu).toBeInViewport({ timeout: 10_000 });
});
