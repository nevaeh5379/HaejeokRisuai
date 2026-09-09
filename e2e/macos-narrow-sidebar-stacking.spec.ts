import { expect, test } from "./fixtures";

test.use({ viewport: { width: 900, height: 600 } });

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
}

test("keeps the narrow macOS sidebar above the chat tab strip", async ({
  page,
}) => {
  await waitForAppReady(page);

  await page.evaluate(async () => {
    document.documentElement.classList.add("tauri-macos-vibrancy");

    const charactersUrl = "/src/ts/characters.ts";
    const { createNewCharacter, changeChar } = (await import(
      /* @vite-ignore */ charactersUrl
    )) as {
      createNewCharacter: () => number;
      changeChar: (idx: number) => Promise<void>;
    };
    const idx = createNewCharacter();
    await changeChar(idx);

    const storesUrl = "/src/ts/stores.svelte.ts";
    const { sideBarStore } = (await import(/* @vite-ignore */ storesUrl)) as {
      sideBarStore: { set: (value: boolean) => void };
    };
    sideBarStore.set(true);
  });

  const sidebar = page.locator(".rs-sidebar-panel.dynamic-sidebar");
  const tabStrip = page.locator(".rs-chat-tab-strip-shell");
  await expect(sidebar).toBeVisible();
  await expect(tabStrip).toBeVisible();

  const stacking = await page.evaluate(() => {
    const sidebarPanel = document.querySelector<HTMLElement>(
      ".rs-sidebar-panel.dynamic-sidebar",
    );
    const sidebarLayer = sidebarPanel?.closest<HTMLElement>(
      ".risu-dynamic-sidebar-layer",
    );
    const tabs = document.querySelector<HTMLElement>(
      ".rs-chat-tab-strip-shell",
    );
    if (!sidebarPanel || !sidebarLayer || !tabs) return null;

    const sidebarRect = sidebarPanel.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const x = Math.max(sidebarRect.left, tabsRect.left) + 24;
    const y = Math.max(sidebarRect.top, tabsRect.top) + 24;
    const topSurface = document
      .elementsFromPoint(x, y)
      .find((element) => element === sidebarPanel || element === tabs);

    return {
      sidebarZIndex: getComputedStyle(sidebarLayer).zIndex,
      tabZIndex: getComputedStyle(tabs).zIndex,
      topSurface: topSurface === sidebarPanel ? "sidebar" : "tabs",
    };
  });

  expect(stacking).not.toBeNull();
  expect(stacking?.sidebarZIndex).toBe("50");
  expect(stacking?.tabZIndex).toBe("40");
  expect(stacking?.topSurface).toBe("sidebar");
});
