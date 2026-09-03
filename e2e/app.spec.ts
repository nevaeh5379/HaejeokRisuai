import { expect, test } from "./fixtures";

/**
 * Smoke tests: the most basic checks that the app loads at all.
 * If these fail, everything else will fail too — so keep them tiny and fast.
 */
test.describe("app smoke", () => {
  test("boots past the static loading screen", async ({ page }) => {
    // `page.goto("/")` uses `baseURL` from playwright.config.ts
    await page.goto("/");

    // `#preloading` is the plain-HTML spinner baked into index.html.
    // src/main.ts removes it once the Svelte app has mounted, so an empty
    // locator means "the application actually started".
    await expect(page.locator("#preloading")).toHaveCount(0, { timeout: 30_000 });

    // "Haejeok RisuAI" is the hardcoded header brand text on the
    // first-run welcome screen (not localized, so it never changes).
    // `.first()` avoids a strict-mode failure when the brand also appears
    // in other elements such as the welcome title.
    await expect(page.getByText("Haejeok RisuAI").first()).toBeVisible({ timeout: 30_000 });
  });

  test("first run shows the welcome gateway", async ({ page }) => {
    await page.goto("/");

    // A brand-new browser context has no saved database, so
    // `didFirstSetup` is false and the app renders the welcome screen.
    // These are the three english gateway buttons of WelcomeRisu.svelte.
    await expect(page.getByText("Restore Data")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Quick AI Setup")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Skip & Explore")).toBeVisible({ timeout: 30_000 });
  });
});