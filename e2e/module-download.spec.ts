import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "./fixtures";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0, {
    timeout: 120_000,
  });

  await page.waitForFunction(
    () => !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 30_000 },
  );
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const response = await fetch("/sw/init", { cache: "no-store" });
          return response.text();
        }),
      { timeout: 30_000 },
    )
    .toBe("v3");

  const skip = page.getByText(/Skip & Explore|직접 설정할래요/i).first();
  if (
    await skip
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
  await expect(page.getByText("Welcome to Haejeok RisuAI")).toHaveCount(0);
}

test("downloads a module as a real CharX archive instead of the HTML app shell", async ({
  page,
}, testInfo) => {
  await boot(page);

  const settingsButton = page.getByRole("button", {
    name: /Settings|설정/i,
    exact: true,
  });
  if ((await settingsButton.count()) === 0) {
    await page.locator("button").first().click();
  }
  if ((await settingsButton.count()) > 0) {
    await settingsButton.first().click();
  } else {
    await page.locator("button:has(svg.lucide-settings)").click();
  }
  await page
    .getByRole("button", { name: /Modules|모듈/i, exact: true })
    .click();

  await page.locator("button:has(svg.lucide-plus)").first().click();
  const moduleInputs = page.locator('input[placeholder=""]');
  await moduleInputs.nth(0).fill("E2E Download Module");
  await moduleInputs
    .nth(1)
    .fill("Verifies the browser module download pipeline");
  await page
    .getByRole("button", { name: /Create Module|모듈 만들기/i, exact: true })
    .click();

  const row = page
    .getByText("E2E Download Module", { exact: true })
    .locator("..");
  await expect(row).toBeVisible();
  await row.locator("button:has(svg.lucide-share-2)").click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByText(/^CharX \(/).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("E2E Download Module.module.charx");
  const savedPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedPath);
  expect(await download.failure()).toBeNull();
  await expect(page).toHaveURL("/");

  const bytes = new Uint8Array(await readFile(savedPath));
  const prefix = strFromU8(bytes.subarray(0, Math.min(bytes.length, 128)));
  expect(prefix.toLowerCase()).not.toContain("<!doctype html");
  expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

  const archive = unzipSync(bytes);
  expect(Object.keys(archive)).toContain("card.json");
  const card = JSON.parse(strFromU8(archive["card.json"]));
  expect(card.spec).toBe("chara_card_v3");
  expect(card.data.name).toBe("E2E Download Module");
});
