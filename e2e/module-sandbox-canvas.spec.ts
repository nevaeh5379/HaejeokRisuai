import { expect, test } from "./fixtures";

async function waitForAppReady(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      document.body !== null &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );

  const skipButton = page.getByRole("button", { name: /Skip & Explore/i });
  if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skipButton.click();
  }

  await page.waitForFunction(
    () =>
      document.body !== null &&
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );
  // The module store hydrates asynchronously from SQLite; installing modules
  // before hydration completes races init() overwriting the in-memory module
  // list with the database snapshot.
  await page.waitForFunction(async () => {
    const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const { moduleStore } = await import(/* @vite-ignore */ path);
    return moduleStore.loaded === true;
  });
}

test("edits module bundles on a free-position canvas", async ({ page }) => {
  await waitForAppReady(page);

  await page.evaluate(async () => {
    const moduleStoreUrl = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const storesUrl = "/src/ts/stores.svelte.ts";
    const { moduleStore } = (await import(
      /* @vite-ignore */ moduleStoreUrl
    )) as { moduleStore: any };
    const { settingsOpen, SettingsMenuIndex } = (await import(
      /* @vite-ignore */ storesUrl
    )) as {
      settingsOpen: { set: (value: boolean) => void };
      SettingsMenuIndex: { set: (value: number) => void };
    };

    await moduleStore.installModule({
      id: "canvas-test-module",
      name: "Lightboard",
      description: "",
    });
    SettingsMenuIndex.set(14);
    settingsOpen.set(true);
  });

  await page.getByRole("button", { name: "Bundles" }).click();
  await page.getByRole("button", { name: "New bundle" }).click();

  const node = page.getByTestId("module-sandbox-node");
  await expect(node).toBeVisible();

  await node.getByRole("combobox", { name: "Modules" }).selectOption(
    "canvas-test-module",
  );
  await node.getByRole("button", { name: "Add" }).click();
  await expect(node.getByText("Lightboard", { exact: true })).toBeVisible();

  const before = await node.boundingBox();
  const header = node.getByRole("toolbar");
  const box = await header.boundingBox();
  expect(before).not.toBeNull();
  expect(box).not.toBeNull();
  if (!before || !box) return;

  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2 + 70, {
    steps: 5,
  });
  await page.mouse.up();

  const after = await node.boundingBox();
  expect(after?.x).toBeGreaterThan(before.x + 80);
  expect(after?.y).toBeGreaterThan(before.y + 50);

  await page.screenshot({
    path: "work/visualizations/module-sandbox-canvas.png",
    fullPage: true,
  });
});
