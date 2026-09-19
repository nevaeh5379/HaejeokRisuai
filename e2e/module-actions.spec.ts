import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

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
  // The module store hydrates asynchronously from SQLite; installing modules
  // before hydration completes races init() overwriting the in-memory module
  // list with the database snapshot.
  await page.waitForFunction(async () => {
    const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
    const { moduleStore } = await import(/* @vite-ignore */ path);
    return moduleStore.loaded === true;
  });
}

test("runs an enabled module button and applies the module to the character", async ({
  page,
}) => {
  await boot(page);

  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createBlankChar } = await load("/src/ts/characterDefaults.ts");
    const { characterStore } = await load(
      "/src/ts/stores/domain/characterStore.svelte.ts",
    );
    const { moduleStore } = await load(
      "/src/ts/stores/domain/moduleStore.svelte.ts",
    );
    const { selectedCharID } = await load("/src/ts/stores.svelte.ts");

    await moduleStore.installModule({
      id: "e2e-module-actions",
      name: "E2E Module Actions",
      description: "Exercises module buttons and character application",
      lorebook: [
        {
          key: "e2e-lore",
          comment: "E2E applied lore",
          content: "applied lore content",
          insertorder: 100,
          mode: "normal",
          alwaysActive: false,
          selective: false,
          extentions: { risu_case_sensitive: false },
        },
      ],
      regex: [
        {
          type: "editinput",
          in: "before-apply",
          out: "after-apply",
        },
      ],
      trigger: [
        JSON.stringify({
          comment: "E2E module action",
          type: "manual",
          conditions: [],
          effect: [
            {
              type: "triggerlua",
              code: `
                function onButtonClick(id, button)
                  if button == "e2e-module-action" then
                    addChat(id, "user", "module button worked")
                  end
                end
              `,
            },
          ],
        }),
      ],
    });

    const character = createBlankChar();
    character.name = "E2E Module Character";
    // Older cards and partially migrated backups can omit these optional
    // collections. Module activation and application must still work.
    delete character.globalLore;
    delete character.customscript;
    delete character.triggerscript;
    character.chats[0].id = "e2e-module-chat";
    character.chats[0].modules = ["e2e-module-actions"];
    character.chats[0].message = [
      {
        role: "char",
        data: '<button class="button-default" risu-btn="e2e-module-action">Run module action</button>',
        chatId: "e2e-module-message",
      },
    ];
    const characterIndex = characterStore.add(character);
    characterStore.select(characterIndex);
    selectedCharID.set(characterIndex);
    characterStore.markChatDirty("e2e-module-chat");
    characterStore.markChatManifestDirty(character.chaId);
    await characterStore.flush();
  });

  const actionButton = page.getByRole("button", {
    name: "Run module action",
    exact: true,
  });
  await expect(actionButton).toBeVisible();
  await actionButton.click();
  await expect(
    page.getByText("module button worked", { exact: true }),
  ).toBeVisible();

  await page.evaluate(() => {
    const modulesUrl = "/src/ts/process/modules.ts";
    void import(/* @vite-ignore */ modulesUrl).then(({ applyModule }) =>
      applyModule(),
    );
  });

  const moduleChoice = page.getByText("E2E Module Actions", { exact: true });
  await expect(moduleChoice).toBeVisible();
  await moduleChoice.locator("..").locator("button").last().click();
  await expect(
    page.getByText(/successfully applied|성공적으로 적용/i),
  ).toBeVisible();

  const applied = await page.evaluate(async () => {
    const path = "/src/ts/stores/domain/characterStore.svelte.ts";
    const { characterStore } = await import(/* @vite-ignore */ path);
    const character = characterStore.currentCharacter;
    return {
      lore: character.globalLore?.some(
        (entry: { comment?: string }) => entry.comment === "E2E applied lore",
      ),
      regex: character.customscript?.some(
        (entry: { in?: string }) => entry.in === "before-apply",
      ),
      trigger: character.triggerscript?.some(
        (entry: { comment?: string }) => entry.comment === "E2E module action",
      ),
    };
  });
  expect(applied).toEqual({ lore: true, regex: true, trigger: true });
});
