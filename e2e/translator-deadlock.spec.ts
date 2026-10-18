import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// Regression cases: use only real UI inputs, without replacing API responses,
// importing app modules, or writing application storage directly.
for (const scenario of [
  {
    name: "default twelve paragraphs start a DeepLX request",
    legacy: false,
    combine: false,
    single: false,
  },
  {
    name: "legacy one paragraph starts a DeepLX request",
    legacy: true,
    combine: false,
    single: true,
  },
  {
    name: "legacy twelve paragraphs start a DeepLX request",
    legacy: true,
    combine: false,
    single: false,
  },
  {
    name: "legacy combined single paragraph starts a DeepLX request",
    legacy: true,
    combine: true,
    single: true,
  },
]) {
  test(scenario.name, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const endpoint = process.env.E2E_DEEPLX_URL ?? "http://localhost:1188";
    const evidence = {
      requests: [] as string[],
      failures: [] as string[],
      responses: [] as number[],
      inputs: [] as string[],
      errors: [] as string[],
    };
    page.on("request", (request) => {
      if (request.url().startsWith(endpoint) && request.method() === "POST")
        evidence.requests.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (request.url().startsWith(endpoint))
        evidence.failures.push(request.failure()?.errorText ?? "unknown");
    });
    page.on("response", (response) => {
      if (response.url().startsWith(endpoint))
        evidence.responses.push(response.status());
    });
    page.on("pageerror", (error) => evidence.errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "log" &&
        message.text().includes("rain had stopped")
      )
        evidence.inputs.push(message.text());
    });
    try {
      await page.goto("/");
      await expect(page.locator("#preloading")).toHaveCount(0, {
        timeout: 90_000,
      });
      await expect(page.getByRole("button").first()).toBeVisible({
        timeout: 120_000,
      });
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await page.getByRole("button", { name: "Skip & Explore" }).click();
      await expect(page.getByText("Welcome to Haejeok RisuAI")).toHaveCount(0);
      await expect(page.locator(".rs-sidebar-menu-button")).toBeVisible({
        timeout: 90_000,
      });
      await page.locator(".rs-sidebar-menu-button").click();
      await page.locator(".rs-sidebar-menu-popover button").first().click();
      await expect(
        page.getByRole("button", { name: "Language", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await page
        .locator('[data-setting-id="lang.translatorLang"] select')
        .selectOption("ko");
      await page
        .locator('[data-setting-id="lang.translatorType"] select')
        .selectOption("deeplX");
      await page
        .locator('[data-setting-id="lang.deeplXUrl"] input')
        .fill(endpoint);
      for (const [id, checked] of [
        ["legacyTranslation", scenario.legacy],
        ["combineTranslation", scenario.combine],
      ] as const) {
        const setting = page.locator(`[data-setting-id="lang.${id}"]`);
        if (
          (await setting.locator('input[type="checkbox"]').isChecked()) !==
          checked
        )
          await setting.locator("label").click();
        await expect(setting.locator('input[type="checkbox"]')).toBeChecked({
          checked,
        });
      }
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .locator("button")
        .filter({
          has: page.locator('svg path[d="M12 6v6m0 0v6m0-6h6m-6 0H6"]'),
        })
        .click();
      await page
        .getByRole("button", { name: "Create from Scratch", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Character", exact: true })
        .click();
      await page
        .getByRole("button", { name: "First Message", exact: true })
        .click();
      await page
        .locator("textarea")
        .first()
        .fill(
          "The rain had stopped by the time Iris reached the station.\n\nShe folded her umbrella and looked for the evening train.\n\nAn old clock above the ticket office showed half past six.\n\nThe platform was quiet except for a distant announcement.\n\nA shopkeeper was closing the little bakery near the stairs.\n\nIris bought the last warm loaf before he locked the door.\n\nShe carried it carefully through the crowded waiting room.\n\nNear the window, a child was drawing mountains on a map.\n\nHis father pointed toward the hills beyond the town.\n\nA train whistle finally sounded from the other platform.\n\nIris checked her ticket and picked up her suitcase.\n\nFor the first time that day, she felt ready to leave.",
        );
      if (scenario.single)
        await page
          .locator("textarea")
          .first()
          .fill("The rain had stopped by the time Iris reached the station.");
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(
        page.locator(".button-icon-translate").first(),
      ).toBeVisible();
      await page.locator(".button-icon-translate").first().click();
      await expect.poll(() => evidence.requests.length).toBeGreaterThan(0);
      await expect
        .poll(() => evidence.failures.length + evidence.responses.length, {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      const dismiss = page.getByRole("button", { name: "OK", exact: true });
      if (await dismiss.isVisible()) await dismiss.click();
      await expect(
        page.locator(".button-icon-translate.translating"),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("translation.png"),
        fullPage: true,
      });
      expect(evidence.errors).toEqual([]);
      expect(evidence.inputs.length).toBeGreaterThan(0);
      if (scenario.legacy) expect(evidence.inputs[0]).toContain("<p>");
      else expect(evidence.inputs[0]).not.toContain("<p>");
    } finally {
      const evidencePath = testInfo.outputPath("translation-evidence.json");
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      await testInfo.attach("translation-evidence", {
        path: evidencePath,
        contentType: "application/json",
      });
    }
  });
}
