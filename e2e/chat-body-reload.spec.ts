import { expect, test } from "./fixtures";

async function waitForAppReady(
  page: import("@playwright/test").Page,
  firstBoot = false,
) {
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
  if (firstBoot) {
    await skipButton.waitFor({ state: "visible", timeout: 30_000 });
    await skipButton.click();
  }

  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return (
        text.trim().length > 0 &&
        !text.includes("Loading...") &&
        !text.includes("Initialising Database") &&
        !text.includes("Welcome to Haejeok RisuAI")
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

test("restores the persisted active chat body after an app reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await waitForAppReady(page, true);

  await page.evaluate(async () => {
    const characterModuleUrl = "/src/ts/characters.ts";
    const domainModuleUrl = "/src/ts/stores/domain/index.ts";
    const { createNewCharacter, changeChar } = (await import(
      /* @vite-ignore */ characterModuleUrl
    )) as {
      createNewCharacter: () => number;
      changeChar: (index: number) => Promise<void>;
    };
    const { characterStore, messageStore } = (await import(
      /* @vite-ignore */ domainModuleUrl
    )) as { characterStore: any; messageStore: any };

    const index = createNewCharacter();
    const character = characterStore.characters[index];
    character.name = "Reload regression character";
    const backgroundChat = {
      message: [],
      note: "",
      name: "Older chat",
      localLore: [],
      fmIndex: -1,
      id: crypto.randomUUID(),
    };
    const chat = {
      message: [],
      note: "",
      name: "Persisted chat",
      localLore: [],
      fmIndex: -1,
      id: crypto.randomUUID(),
    };
    character.chats = [backgroundChat, chat];
    character.chatPage = 1;
    characterStore.markCharacterDirty(character.chaId);
    characterStore.markChatDirty(backgroundChat.id);
    characterStore.markChatDirty(chat.id);
    characterStore.markChatManifestDirty(character.chaId);
    await characterStore.flush();
    await messageStore.persistNewChats(character.chaId, [
      { chatId: backgroundChat.id, messages: [] },
      { chatId: chat.id, messages: [] },
    ]);
    await messageStore.appendMessage(chat.id, {
      chatId: crypto.randomUUID(),
      role: "user",
      data: "Persisted user message",
      time: Date.now(),
    });
    await messageStore.appendMessage(chat.id, {
      chatId: crypto.randomUUID(),
      role: "char",
      data: "Persisted character reply",
      time: Date.now(),
    });
    await messageStore.flush();
    await changeChar(index);
  });

  await expect(page.getByText("Persisted user message")).toBeVisible();
  await expect(page.getByText("Persisted character reply")).toBeVisible();
  await expect(page.locator("[data-chat-tab-id]")).toHaveCount(1);

  await page.reload();
  await waitForAppReady(page);
  await page
    .getByRole("button", {
      name: "R Reload regression character",
      exact: true,
    })
    .click();

  await expect(page.getByText("Persisted user message")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Persisted character reply")).toBeVisible();
});
