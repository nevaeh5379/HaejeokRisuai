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
  await skipButton.waitFor({ state: "visible", timeout: 30_000 });
  await skipButton.click();

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );

  await expect(page.getByText("Loading...")).toHaveCount(0, { timeout: 30_000 });
}

async function enableSaveIconSetting(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const settingsStoreUrl = "/src/ts/stores/domain/settingsStore.svelte.ts";
    const { settingsStore } = (await import(
      /* @vite-ignore */ settingsStoreUrl
    )) as { settingsStore: any };
    settingsStore.state.showSavingIcon = true;
    await settingsStore.flush();
  });
}

test.describe("Save indicator icon (E2E)", () => {
  test("displays save confirmation icon when enabled and auto-hides after delay", async ({ page }) => {
    await waitForAppReady(page);

    // 1. Initially, save indicator should not be visible
    const saveIndicator = page.locator("[data-save-indicator]");
    await expect(saveIndicator).toHaveCount(0);

    // 2. Open Settings -> Display Settings (menu index 3)
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen, SettingsMenuIndex } = (await import(
        /* @vite-ignore */ storesUrl
      )) as {
        settingsOpen: { set: (v: boolean) => void };
        SettingsMenuIndex: { set: (v: number) => void };
      };
      SettingsMenuIndex.set(3);
      settingsOpen.set(true);
    });

    // Verify Display Settings header is visible
    const displayHeading = page
      .locator("h2")
      .filter({ hasText: /Display|디스플레이/i })
      .first();
    await expect(displayHeading).toBeVisible({ timeout: 10_000 });

    // 3. Navigate to "Others" submenu in Display settings (3rd tab in the top tab bar)
    const othersTabButton = page.locator("div.h-16 button").last();
    await expect(othersTabButton).toBeVisible({ timeout: 5000 });
    await othersTabButton.click();

    // 4. Locate the showSavingIcon setting
    const savingIconSetting = page.locator('[data-setting-id="display.showSavingIcon"]');
    await expect(savingIconSetting).toBeVisible({ timeout: 5000 });

    const checkbox = savingIconSetting.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();

    // 5. Toggle ON "저장 아이콘 표시"
    await savingIconSetting.locator("label").click();
    await expect(checkbox).toBeChecked();

    // 6. The setting commit occurs -> save indicator appears (even with Settings open, due to z-50)
    await expect(saveIndicator).toBeVisible({ timeout: 5000 });
    await expect(saveIndicator).toHaveClass(/z-50/);
    await expect(saveIndicator).toHaveAttribute("data-save-indicator", /saving|saved/);

    // 7. Verify it auto-hides after ~2.5s timer expires
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // 8. Close Settings
    await page.evaluate(async () => {
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { settingsOpen } = (await import(
        /* @vite-ignore */ storesUrl
      )) as { settingsOpen: { set: (v: boolean) => void } };
      settingsOpen.set(false);
    });
  });

  test("displays save icon when creating a new character", async ({ page }) => {
    await waitForAppReady(page);
    await enableSaveIconSetting(page);

    const saveIndicator = page.locator("[data-save-indicator]");
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // Create new character
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const { createNewCharacter } = (await import(
        /* @vite-ignore */ charUrl
      )) as { createNewCharacter: () => number };
      createNewCharacter();
    });

    // Save indicator should appear for character creation
    await expect(saveIndicator).toBeVisible({ timeout: 5000 });
    await expect(saveIndicator).toHaveAttribute("data-save-indicator", /saving|saved/);

    // And auto-hide after delay
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });
  });

  test("displays save icon when sending a message", async ({ page }) => {
    await waitForAppReady(page);
    await enableSaveIconSetting(page);

    const saveIndicator = page.locator("[data-save-indicator]");
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // Create a character with a persisted chat and enter chat
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as {
        createNewCharacter: () => number;
        changeChar: (idx: number) => Promise<void>;
      };
      const { characterStore, messageStore } = (await import(
        /* @vite-ignore */ domainUrl
      )) as { characterStore: any; messageStore: any };

      const idx = createNewCharacter();
      const char = characterStore.characters[idx];
      const newChat = {
        message: [],
        note: "",
        name: "Chat 1",
        localLore: [],
        fmIndex: -1,
        id: crypto.randomUUID(),
      };
      char.chats = [newChat];
      characterStore.markChatDirty(newChat.id);
      characterStore.markChatManifestDirty(char.chaId);
      await characterStore.flush();
      await messageStore.persistNewChat(char.chaId, newChat.id, newChat.message);
      await changeChar(idx);
    });

    // Wait for setup indicators to clear
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // Send a message via messageStore
    await page.evaluate(async () => {
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { characterStore, messageStore } = (await import(
        /* @vite-ignore */ domainUrl
      )) as { characterStore: any; messageStore: any };
      const currentChat = characterStore.currentChat;
      if (currentChat?.id) {
        await messageStore.appendMessage(currentChat.id, {
          chatId: crypto.randomUUID(),
          role: "user",
          data: "Test user message",
        });
      }
    });

    // Save indicator should appear for message append
    await expect(saveIndicator).toBeVisible({ timeout: 5000 });
    await expect(saveIndicator).toHaveAttribute("data-save-indicator", /saving|saved/);

    // And auto-hide after delay
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });
  });

  test("displays save icon when branching a chat", async ({ page }) => {
    await waitForAppReady(page);
    await enableSaveIconSetting(page);

    const saveIndicator = page.locator("[data-save-indicator]");
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // Create a character with a persisted chat containing an initial message
    await page.evaluate(async () => {
      const charUrl = "/src/ts/characters.ts";
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { createNewCharacter, changeChar } = (await import(
        /* @vite-ignore */ charUrl
      )) as {
        createNewCharacter: () => number;
        changeChar: (idx: number) => Promise<void>;
      };
      const { characterStore, messageStore } = (await import(
        /* @vite-ignore */ domainUrl
      )) as { characterStore: any; messageStore: any };

      const idx = createNewCharacter();
      const char = characterStore.characters[idx];
      const forkMsgId = crypto.randomUUID();
      const newChat = {
        message: [],
        note: "",
        name: "Chat 1",
        localLore: [],
        fmIndex: -1,
        id: crypto.randomUUID(),
      };
      char.chats = [newChat];
      characterStore.markChatDirty(newChat.id);
      characterStore.markChatManifestDirty(char.chaId);
      await characterStore.flush();
      await messageStore.persistNewChat(char.chaId, newChat.id, newChat.message);
      await changeChar(idx);

      // Append initial message so a fork message exists
      await messageStore.appendMessage(newChat.id, {
        chatId: forkMsgId,
        role: "user",
        data: "First message to branch from",
      });
    });

    // Wait for setup indicators to clear
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });

    // Branch the chat via getSqlBranchStorage
    await page.evaluate(async () => {
      const factoryUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { getSqlBranchStorage } = (await import(
        /* @vite-ignore */ factoryUrl
      )) as { getSqlBranchStorage: () => Promise<any> };
      const { characterStore } = (await import(
        /* @vite-ignore */ domainUrl
      )) as { characterStore: any };

      const currentChat = characterStore.currentChat;
      if (currentChat?.id) {
        const storage = await getSqlBranchStorage();
        await storage.createChatBranch({
          id: crypto.randomUUID(),
          chatId: currentChat.id,
          forkMessageId: currentChat.message?.[0]?.chatId,
          reason: "manual",
          createdAt: Date.now(),
        });
      }
    });

    // Save indicator should appear for branch creation
    await expect(saveIndicator).toBeVisible({ timeout: 5000 });
    await expect(saveIndicator).toHaveAttribute("data-save-indicator", /saving|saved/);

    // And auto-hide after delay
    await expect(saveIndicator).toHaveCount(0, { timeout: 6000 });
  });
});
