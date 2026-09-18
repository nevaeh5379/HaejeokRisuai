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

  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  await skipButton.waitFor({ state: "visible", timeout: 30_000 });
  await skipButton.click();
  await expect(page.getByText("Loading...")).toHaveCount(0, {
    timeout: 30_000,
  });
}

test.describe("recent sessions", () => {
  test("opening a bot refreshes only its active session", async ({ page }) => {
    test.setTimeout(180_000);
    await waitForAppReady(page);

    const fixture = await page.evaluate(async () => {
      const charactersUrl = "/src/ts/characters.ts";
      const characterStoreUrl =
        "/src/ts/stores/domain/characterStore.svelte.ts";
      const storesUrl = "/src/ts/stores.svelte.ts";
      const { createNewCharacter } = (await import(
        /* @vite-ignore */ charactersUrl
      )) as { createNewCharacter: () => number };
      const { characterStore } = (await import(
        /* @vite-ignore */ characterStoreUrl
      )) as { characterStore: any };
      const { selectedCharID } = (await import(
        /* @vite-ignore */ storesUrl
      )) as { selectedCharID: { set: (value: number) => void } };

      const botIndex = createNewCharacter();
      const otherIndex = createNewCharacter();
      const bot = characterStore.characters[botIndex];
      const other = characterStore.characters[otherIndex];
      const makeChat = (id: string, name: string, lastDate?: number) => ({
        id,
        name,
        note: "",
        localLore: [],
        fmIndex: -1,
        message: [],
        detailsLoaded: true,
        messagesLoaded: true,
        messagesFullyLoaded: true,
        ...(lastDate === undefined ? {} : { lastDate }),
      });

      bot.name = "Session Flood Bot";
      bot.lastInteraction = 1;
      bot.chatPage = 0;
      bot.chats = [
        makeChat("flood-active", "Active session"),
        makeChat("flood-sibling-1", "Inactive session one"),
        makeChat("flood-sibling-2", "Inactive session two"),
      ];

      other.name = "Actually Recent Bot";
      other.lastInteraction = 2;
      other.chatPage = 0;
      other.chats = [
        makeChat(
          "actually-recent",
          "Actually recent session",
          Date.now() - 60_000,
        ),
      ];

      for (const character of [bot, other]) {
        characterStore.markCharacterDirty(character.chaId);
        characterStore.markChatManifestDirty(character.chaId);
        for (const chat of character.chats) {
          characterStore.markChatDirty(chat.id);
        }
      }
      await characterStore.flush();
      selectedCharID.set(-1);

      return { botId: bot.chaId };
    });

    const cards = page.locator(".rs-recent-session-card");
    await expect(cards).toHaveCount(4, { timeout: 15_000 });
    await expect(cards.first()).toContainText("Actually Recent Bot");

    // Exercise the same sidebar avatar and Home controls a user taps. The
    // character touch is intentionally still in the store's delayed write
    // window when Home remounts RecentSessionsList.
    await page.locator(`[data-char-id="${fixture.botId}"]`).first().click();
    await expect(page.locator(".default-chat-pane")).toBeVisible({
      timeout: 15_000,
    });
    await page.locator(".rs-sidebar-menu-button").first().click();
    await page
      .locator(".rs-sidebar-menu-popover")
      .locator("button")
      .nth(1)
      .click();

    await expect(cards).toHaveCount(4, { timeout: 15_000 });
    await expect(cards.nth(0)).toContainText("Active session");
    await expect(cards.nth(1)).toContainText("Actually recent session");
    await expect(cards.nth(2)).toContainText("Inactive session");
  });
});
