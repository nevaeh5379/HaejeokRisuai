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

  await page.evaluate(async () => {
    const path = "/src/ts/stores.svelte.ts";
    const { settingsOpen, SettingsMenuIndex } = await import(
      /* @vite-ignore */ path
    );
    SettingsMenuIndex.set(14);
    settingsOpen.set(true);
  });

  await expect(
    page.getByRole("button", { name: /Modules|모듈/i, exact: true }).last(),
  ).toBeVisible();

  await page.locator("button:has(svg.lucide-plus)").first().click();
  const moduleInputs = page.locator('input[placeholder=""]');
  await moduleInputs.nth(0).fill("E2E Download Module");
  await moduleInputs
    .nth(1)
    .fill("Verifies the browser module download pipeline");
  await page
    .getByRole("button", { name: /Create Module|모듈 만들기/i, exact: true })
    .click();

  await page.evaluate(async () => {
    const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const { moduleStore } = await import(/* @vite-ignore */ path);
    const module = moduleStore.modules.find(
      (entry: { name: string }) => entry.name === "E2E Download Module",
    );
    module.lorebook = [
      {
        key: "roundtrip",
        comment: "Round-trip lore",
        content: "round-trip lore content",
        insertorder: 10,
        mode: "normal",
        alwaysActive: false,
        selective: false,
      },
    ];
    module.regex = [{ type: "editinput", in: "round-trip", out: "preserved" }];
    module.trigger = [
      {
        comment: "Round-trip button",
        type: "manual",
        conditions: [],
        effect: [
          {
            type: "triggerlua",
            code: 'function onButtonClick(id, button) if button == "round-trip" then addChat(id, "user", "preserved") end end',
          },
        ],
      },
    ];
  });

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

  const roundTrip = await page.evaluate(async (encoded) => {
    const characterCardsUrl = "/src/ts/characterCards.ts";
    const interchangeabilityUrl = "/src/ts/interchangeability.ts";
    const { importCharacterProcess } = await import(
      /* @vite-ignore */ characterCardsUrl
    );
    const { convertCharacterToModule } = await import(
      /* @vite-ignore */ interchangeabilityUrl
    );
    const character = await importCharacterProcess({
      name: "E2E Download Module.module.charx",
      data: Buffer.from(encoded, "base64"),
      returnCharacter: true,
    });
    if (!character || typeof character === "number") return null;
    const module = convertCharacterToModule(character);
    return {
      lore: module.lorebook?.some(
        (entry: { comment?: string }) => entry.comment === "Round-trip lore",
      ),
      regex: module.regex?.some(
        (entry: { in?: string }) => entry.in === "round-trip",
      ),
      trigger: module.trigger?.some(
        (entry: { comment?: string }) => entry.comment === "Round-trip button",
      ),
    };
  }, Buffer.from(bytes).toString("base64"));
  expect(roundTrip).toEqual({ lore: true, regex: true, trigger: true });
});
