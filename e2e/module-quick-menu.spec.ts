import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Regression spec for the user report:
 *   "채팅 입력 옆에 있는 빠른 메뉴에 있는 모듈 버튼이 눌러도 모듈 창이 안뜨더라."
 *
 * Root cause: `ModuleChatMenu` (and `ChatList`) render their backdrop as
 *   `absolute w-full h-full z-40 ...`
 * without `top-0 left-0`. An absolutely positioned box with `top: auto`
 * uses its *static position*. Before the macOS chrome refactor the chat
 * screen was a direct flex child of `<main>`, so that static position was
 * the top-left of the viewport. Commit ec612d024 wrapped it in a plain
 * `<div class="... grow h-full min-w-0">`, so the static position became the
 * spot right *after* the (full-height) chat content — i.e. one viewport
 * height below the top. The menu was still in the DOM (so `toBeVisible()`
 * passed) but rendered entirely off-screen, which is why the user never saw
 * it.
 *
 * This test therefore asserts the module window is actually *in the
 * viewport*, not merely attached to the DOM.
 */

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

test("opens the module menu from the chat composer quick menu", async ({
  page,
}) => {
  await boot(page);
  await selectCharacter(page);

  // Open the quick menu next to the chat input (the hamburger button).
  const menuButton = page.locator(".rs-chat-menu-btn");
  await expect(menuButton).toBeVisible({ timeout: 15_000 });
  await menuButton.click();

  const popover = page.locator(".rs-chat-menu-popover");
  await expect(popover).toBeVisible({ timeout: 10_000 });

  // Click the "Modules" entry inside the quick menu.
  const modulesEntry = popover.getByText(/^(모듈|Modules)$/).first();
  await expect(modulesEntry).toBeVisible({ timeout: 10_000 });
  await modulesEntry.click();

  // The module picker overlay must appear *on screen*.
  const moduleMenu = page.getByText(
    /enable or disable modules for this chat|이 채팅 한정으로/i,
  );
  await expect(moduleMenu).toBeVisible({ timeout: 10_000 });
  await expect(moduleMenu).toBeInViewport({ timeout: 10_000 });

  // The centered dialog card itself must also be on screen.
  const dialogHeading = page.getByRole("heading", { name: /모듈|Modules/ });
  await expect(dialogHeading).toBeInViewport({ timeout: 10_000 });
});
