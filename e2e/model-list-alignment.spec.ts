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

test("Capture ModelList modal alignment", async ({ page }) => {
  await waitForAppReady(page);

  // Enable beta toggle
  await page.evaluate(async () => {
    const settingsStoreUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { settingsStore } = (await import(
      /* @vite-ignore */ settingsStoreUrl
    )) as { settingsStore: any };
    await settingsStore.set("enableModuleSubModel", true);

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

  // Open Create Module view
  const plusButton = page.locator("button:has(svg.lucide-plus)").first();
  await expect(plusButton).toBeVisible();
  await plusButton.click();

  // Click ModelList trigger button
  const auxModelButton = page
    .locator("button")
    .filter({ hasText: /Default \(Global Auxiliary Model\)|기본값 \(전역 보조 모델\)/i })
    .first();
  await expect(auxModelButton).toBeVisible();
  await auxModelButton.click();

  // Wait for modal
  const modalHeader = page.locator("h1").filter({ hasText: /Model|모델/i });
  await expect(modalHeader).toBeVisible();

  // Verify top-level items have uniform centered text alignment
  const oobaBtn = page.getByRole("button", { name: "Ooba", exact: true });
  await expect(oobaBtn).toBeVisible();
  const oobaAlign = await oobaBtn.evaluate((el) => window.getComputedStyle(el).textAlign);
  expect(oobaAlign).toBe("center");

  const openRouterBtn = page.getByRole("button", { name: "OpenRouter", exact: true });
  await expect(openRouterBtn).toBeVisible();
  const openRouterAlign = await openRouterBtn.evaluate((el) => window.getComputedStyle(el).textAlign);
  expect(openRouterAlign).toBe("center");

  const koboldBtn = page.getByRole("button", { name: "Kobold", exact: true });
  await expect(koboldBtn).toBeVisible();
  const koboldAlign = await koboldBtn.evaluate((el) => window.getComputedStyle(el).textAlign);
  expect(koboldAlign).toBe("center");

  const noneBtn = page
    .locator("button")
    .filter({ hasText: /Default \(Global Auxiliary Model\)|기본값 \(전역 보조 모델\)/i })
    .first();
  await expect(noneBtn).toBeVisible();
  const noneAlign = await noneBtn.evaluate((el) => window.getComputedStyle(el).textAlign);
  expect(noneAlign).toBe("center");

  // Take screenshot of the modal unexpanded
  await page.screenshot({ path: "test-results/model-list-modal.png" });

  // Click OpenAI to expand
  const openaiBtn = page.getByRole("button", { name: "OpenAI", exact: true });
  await openaiBtn.click();

  // Take screenshot of the modal with OpenAI expanded
  await page.screenshot({ path: "test-results/model-list-modal-expanded.png" });
});
