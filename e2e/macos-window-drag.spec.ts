import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 720 } });

async function prepareMacOSWindow(page: Page) {
  await page.route(/\/src\/ts\/platform\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'export const isTauriMacOS = tauriOsType === "macos";',
      "export const isTauriMacOS = true;",
    );
    await route.fulfill({ response, body });
  });
  await page.route(
    /\/src\/ts\/nativeWindowChrome\.ts(?:\?|$)/,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /import \{ getCurrentWindow \} from "[^"]+";/,
        `const getCurrentWindow = () => ({
        startDragging: async () => window.__windowCommands.push("drag"),
        toggleMaximize: async () => window.__windowCommands.push("maximize"),
      });`,
      );
      await route.fulfill({ response, body });
    },
  );
  await page.addInitScript(() => {
    const commands: string[] = [];
    Object.assign(window, { __windowCommands: commands });
    // Model Tauri's native attribute handler, which checks the actual target.
    document.addEventListener("mousedown", (event) => {
      if (
        event.button === 0 &&
        event.target instanceof HTMLElement &&
        event.target.hasAttribute("data-tauri-drag-region")
      ) {
        commands.push(event.detail === 2 ? "maximize" : "drag");
      }
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click();
  await expect(page.locator(".rs-main-menu")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.classList.add("tauri-macos-vibrancy");
  });
}

async function clickUnmarkedHeader(page: Page) {
  const point = await page.evaluate(() => {
    const interactive =
      'button, a, input, textarea, select, label, summary, [contenteditable], [draggable="true"], [role="button"], [role="tab"], [role="slider"], [role="menuitem"]';
    const content = document
      .querySelector(".rs-main-content")!
      .getBoundingClientRect();
    for (let x = Math.max(90, content.left + 8); x < innerWidth - 8; x += 8) {
      const target = document.elementFromPoint(x, 16);
      if (
        target &&
        !target.closest(interactive) &&
        !target.hasAttribute("data-tauri-drag-region")
      )
        return { x, y: 16 };
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

async function commands(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __windowCommands: string[] })
        .__windowCommands,
  );
}

test("drags the macOS window with chat tabs hidden", async ({ page }) => {
  await prepareMacOSWindow(page);
  await page.evaluate(async () => {
    const charactersUrl = "/src/ts/characters.ts";
    const settingsUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { createNewCharacter, changeChar } = await import(
      /* @vite-ignore */ charactersUrl
    );
    const { settingsStore } = await import(/* @vite-ignore */ settingsUrl);
    settingsStore.state.showChatTabs = false;
    await changeChar(createNewCharacter());
  });
  await expect(page.locator(".default-chat-screen")).toBeVisible();
  await expect(page.locator("[data-chat-tab-list]")).toHaveCount(0);
  await clickUnmarkedHeader(page);
  await expect.poll(() => commands(page)).toEqual(["drag"]);
});

test("drags the macOS window from the scrolled main menu header", async ({
  page,
}) => {
  await prepareMacOSWindow(page);
  await page.evaluate(async () => {
    const charactersUrl = "/src/ts/characters.ts";
    const { createNewCharacter } = await import(
      /* @vite-ignore */ charactersUrl
    );
    for (let i = 0; i < 24; i++) createNewCharacter();
  });
  await expect(
    page.locator(".rs-main-menu [data-tauri-drag-region]").first(),
  ).toBeVisible();
  await page.locator(".rs-main-menu").evaluate((menu) => {
    menu.scrollTop = 160;
  });
  await expect
    .poll(() =>
      page.locator(".rs-main-menu").evaluate((menu) => menu.scrollTop),
    )
    .toBeGreaterThan(0);
  await clickUnmarkedHeader(page);
  await expect.poll(() => commands(page)).toEqual(["drag"]);
});

test("keeps native drag regions and chat tab buttons working", async ({
  page,
}) => {
  await prepareMacOSWindow(page);
  const menuHeader = page.locator(
    ".rs-main-menu > div[data-tauri-drag-region]",
  );
  await menuHeader.click({ position: { x: 100, y: 16 } });
  await expect.poll(() => commands(page)).toEqual(["drag"]);
  await page.evaluate(async () => {
    const charactersUrl = "/src/ts/characters.ts";
    const { createNewCharacter, changeChar } = await import(
      /* @vite-ignore */ charactersUrl
    );
    await changeChar(createNewCharacter());
  });
  const tab = page.locator("[data-chat-tab-list] > button").first();
  await expect(tab).toBeVisible();
  await tab.click({ position: { x: 20, y: 8 } });
  expect(await commands(page)).toEqual(["drag"]);
});
