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

test("keeps settings above the dynamic sidebar and clear of macOS traffic lights", async ({
  page,
}) => {
  await waitForAppReady(page);

  await page.evaluate(async () => {
    document.documentElement.classList.add("tauri-macos-vibrancy");

    const storesUrl = "/src/ts/stores.svelte.ts";
    const { settingsOpen, sideBarStore } = (await import(
      /* @vite-ignore */ storesUrl
    )) as {
      settingsOpen: { set: (value: boolean) => void };
      sideBarStore: { set: (value: boolean) => void };
    };
    sideBarStore.set(true);
    settingsOpen.set(true);
  });

  const settingsBackdrop = page.locator(".rs-setting-backdrop");
  const settingsDialog = page.locator(".rs-setting-cont-2");
  const sidebarLayer = page.locator(".risu-dynamic-sidebar-layer");
  await expect(settingsBackdrop).toBeVisible();
  await expect(settingsDialog).toBeVisible();
  await expect(sidebarLayer).toBeVisible();

  const layout = await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>(
      ".rs-setting-backdrop",
    );
    const dialog = document.querySelector<HTMLElement>(".rs-setting-cont-2");
    const sidebar = document.querySelector<HTMLElement>(
      ".risu-dynamic-sidebar-layer",
    );
    if (!backdrop || !dialog || !sidebar) return null;

    const topSurface = document.elementsFromPoint(40, 100).find((element) => {
      return (
        element.closest(".rs-setting-backdrop") ||
        element.closest(".risu-dynamic-sidebar-layer")
      );
    });

    return {
      backdropZIndex: getComputedStyle(backdrop).zIndex,
      sidebarZIndex: getComputedStyle(sidebar).zIndex,
      dialogTop: dialog.getBoundingClientRect().top,
      titlebarClearance: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--risu-macos-settings-titlebar-clearance",
        ),
      ),
      topSurface:
        topSurface?.closest(".rs-setting-backdrop") === backdrop
          ? "settings"
          : "sidebar",
    };
  });

  expect(layout).not.toBeNull();
  expect(Number(layout?.backdropZIndex)).toBeGreaterThan(
    Number(layout?.sidebarZIndex),
  );
  expect(layout?.dialogTop).toBeGreaterThanOrEqual(
    layout?.titlebarClearance ?? Number.NaN,
  );
  expect(layout?.topSurface).toBe("settings");
});

test("centers and enables dragging on the narrow macOS settings header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 600 });
  await waitForAppReady(page);

  await page.evaluate(async () => {
    document.documentElement.classList.add("tauri-macos-vibrancy");

    const storesUrl = "/src/ts/stores.svelte.ts";
    const { settingsOpen, SettingsMenuIndex } = (await import(
      /* @vite-ignore */ storesUrl
    )) as {
      settingsOpen: { set: (value: boolean) => void };
      SettingsMenuIndex: { set: (value: number) => void };
    };
    SettingsMenuIndex.set(1);
    settingsOpen.set(true);
  });

  const settings = page.locator(".rs-setting-cont");
  const title = settings.getByRole("heading");
  const backButton = settings.getByRole("button", { name: "Back" });
  const closeButton = settings.getByRole("button", { name: "Close" });
  const dragRegion = settings.locator(".rs-setting-mobile-drag-region");
  await expect(settings).toBeVisible();
  await expect(title).toBeVisible();
  await expect(backButton).toBeVisible();
  await expect(closeButton).toBeVisible();
  await expect(dragRegion).toBeVisible();
  await expect(dragRegion).toHaveAttribute("data-tauri-drag-region", "true");

  const layout = await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>(".rs-setting-cont h1");
    const back = document.querySelector<HTMLElement>(
      '.rs-setting-cont button[aria-label="Back"]',
    );
    const close = document.querySelector<HTMLElement>(
      '.rs-setting-cont button[aria-label="Close"]',
    );
    const dragRegion = document.querySelector<HTMLElement>(
      ".rs-setting-mobile-drag-region",
    );
    if (!heading || !back || !close || !dragRegion) return null;

    const rootStyle = getComputedStyle(document.documentElement);
    const rawTrafficLightWidth = rootStyle
      .getPropertyValue("--risu-macos-traffic-lights-width")
      .trim();
    const trafficLightWidth = rawTrafficLightWidth.endsWith("rem")
      ? Number.parseFloat(rawTrafficLightWidth) *
        Number.parseFloat(rootStyle.fontSize)
      : Number.parseFloat(rawTrafficLightWidth);

    const headingRect = heading.getBoundingClientRect();
    const backRect = back.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const titleHitTarget = document.elementFromPoint(
      headingRect.left + headingRect.width / 2,
      headingRect.top + headingRect.height / 2,
    );
    const backHitTarget = document.elementFromPoint(
      backRect.left + backRect.width / 2,
      backRect.top + backRect.height / 2,
    );
    const closeHitTarget = document.elementFromPoint(
      closeRect.left + closeRect.width / 2,
      closeRect.top + closeRect.height / 2,
    );
    return {
      titleLeft: headingRect.left,
      titleCenter: headingRect.left + headingRect.width / 2,
      viewportCenter: window.innerWidth / 2,
      backLeft: backRect.left,
      trafficLightWidth,
      titleHitsDragRegion:
        titleHitTarget?.closest(".rs-setting-mobile-drag-region") ===
        dragRegion,
      backHitsButton: backHitTarget?.closest("button") === back,
      closeHitsButton: closeHitTarget?.closest("button") === close,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.titleLeft).toBeGreaterThanOrEqual(
    layout?.trafficLightWidth ?? Number.NaN,
  );
  expect(layout?.backLeft).toBeGreaterThanOrEqual(
    layout?.trafficLightWidth ?? Number.NaN,
  );
  expect(
    Math.abs((layout?.titleCenter ?? 0) - (layout?.viewportCenter ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(layout?.titleHitsDragRegion).toBe(true);
  expect(layout?.backHitsButton).toBe(true);
  expect(layout?.closeHitsButton).toBe(true);
});
