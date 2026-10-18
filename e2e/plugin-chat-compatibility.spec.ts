import { expect, test } from "./fixtures";

test("plugin snapshots and writes preserve request tags and two chat states after reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
  );
  await page
    .getByRole("button", { name: /Skip & Explore|직접 설정할래요/i })
    .click();
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );

  const seeded = await page.evaluate(async () => {
    const charactersUrl = "/src/ts/characters.ts";
    const domainUrl = "/src/ts/stores/domain/index.ts";
    const pluginsUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const storageUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
    const apiUrl = "/src/ts/plugins/apiV3/v3.svelte.ts";
    const { createNewCharacter, changeChar } = (await import(
      /* @vite-ignore */ charactersUrl
    )) as typeof import("../src/ts/characters");
    const { characterStore, messageStore } = (await import(
      /* @vite-ignore */ domainUrl
    )) as typeof import("../src/ts/stores/domain");
    const { pluginStore } = (await import(
      /* @vite-ignore */ pluginsUrl
    )) as typeof import("../src/ts/stores/domain/pluginStore.svelte");
    const { getSqlStorage } = (await import(
      /* @vite-ignore */ storageUrl
    )) as typeof import("../src/ts/storage/sql/sqlStorageFactory");
    const { executePluginV3 } = (await import(
      /* @vite-ignore */ apiUrl
    )) as typeof import("../src/ts/plugins/apiV3/v3.svelte");
    const storage = await getSqlStorage();
    const index = createNewCharacter();
    const character = characterStore.characters[index];
    character.name = "Plugin compatibility regression";
    character.chatPage = 0;
    character.chats = [0, 1].map((chatIndex) => ({
      id: crypto.randomUUID(),
      name: `Chat ${chatIndex}`,
      note: "",
      localLore: [],
      fmIndex: -1,
      scriptstate: { $plugin: "before" },
      message: Array.from(
        { length: chatIndex === 0 ? 14 : 2 },
        (_, messageIndex) => ({
          chatId: crypto.randomUUID(),
          role: messageIndex % 2 ? ("char" as const) : ("user" as const),
          data: `message ${chatIndex}:${messageIndex}`,
        }),
      ),
    }));
    characterStore.markCharacterDirty(character.chaId);
    await messageStore.persistNewChats(
      character.chaId,
      character.chats.map((chat) => ({
        chatId: chat.id!,
        messages: chat.message,
      })),
    );
    const siblingIndex = createNewCharacter();
    characterStore.characters[siblingIndex].name = "Reorder sibling";
    characterStore.characters[siblingIndex].chats = [];
    const siblingId = characterStore.characters[siblingIndex].chaId;
    await characterStore.flush();
    await changeChar(index);
    characterStore.characters[index].chats[0] = (await storage.loadChat(
      character.chats[0].id!,
      { messageLimit: 12 },
    ))!;
    characterStore.select(index);
    const plugin = await pluginStore.install(
      {
        name: "Chat compatibility test",
        arguments: {},
        realArg: {},
        argMeta: {},
        customLink: [],
        version: "3.0",
        enabled: false,
      },
      `
try {
  const prior = await risuai.pluginStorage.getItem('compatibility-result');
  if (!prior) {
    const index = await risuai.getCurrentCharacterIndex();
    const character = await risuai.getCharacter();
    character.chats[0].scriptstate.$plugin = 'first-after';
    character.chats[1].scriptstate.$plugin = 'second-after';
    character.chats[0].message[0].data += ' <request-id>older-request</request-id>';
    await risuai.setCharacter(character);
    const chat = await risuai.getChatFromIndex(index, 0);
    chat.message[12].data += ' <request-id>current-request</request-id>';
    await risuai.setChatToIndex(index, 0, chat);
    const database = await risuai.getDatabase(['characters']);
    const original = database.characters.find(value => value.chaId === character.chaId);
    const sibling = database.characters.find(value => value.name === 'Reorder sibling');
    const added = { ...original, chaId: crypto.randomUUID(), name: 'Added by plugin', chats: [], chatPage: 0 };
    database.characters = [sibling, original, added];
    await risuai.setDatabase(database);

  }
  const character = await risuai.getCharacter();
  const database = await risuai.getDatabase(['characters']);
  await risuai.pluginStorage.setItem('compatibility-result', {
    ids: database.characters.map(value => value.chaId),
    names: database.characters.map(value => value.name),
    selected: character.chaId,
    run: (prior?.run ?? 0) + 1, length: character.chats[0].message.length,
    role: character.chats[0].message[12].role,
    states: character.chats.map(chat => chat.scriptstate.$plugin),
    older: character.chats[0].message[0].data,
    current: character.chats[0].message[12].data,
  });
} catch (error) {
  await risuai.pluginStorage.setItem('compatibility-result', { error: String(error) });
}
`,
    );
    await executePluginV3(plugin);

    return {
      characterId: character.chaId,
      siblingId,
      chatId: character.chats[0].id!,
    };
  });
  const readResult = () =>
    page.evaluate(async () => {
      const url = "/src/ts/plugins/plugins.svelte.ts";
      const { getV2PluginAPIs } = (await import(
        /* @vite-ignore */ url
      )) as typeof import("../src/ts/plugins/plugins.svelte");
      return getV2PluginAPIs().pluginStorage.getItem("compatibility-result");
    });
  await page.getByRole("button", { name: "YES", exact: true }).click();
  await expect.poll(readResult).toMatchObject({
    run: 1,
    length: 14,
    role: "user",
    selected: seeded.characterId,
    ids: [seeded.siblingId, seeded.characterId, expect.any(String)],
    names: [
      "Reorder sibling",
      "Plugin compatibility regression",
      "Added by plugin",
    ],
  });
  const firstResult = await readResult();
  const saved = await page.evaluate(async (chatId) => {
    const domainUrl = "/src/ts/stores/domain/index.ts";
    const storageUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
    const { characterStore, settingsStore } = (await import(
      /* @vite-ignore */ domainUrl
    )) as typeof import("../src/ts/stores/domain");
    const { getSqlStorage } = (await import(
      /* @vite-ignore */ storageUrl
    )) as typeof import("../src/ts/storage/sql/sqlStorageFactory");
    await characterStore.flush();
    await settingsStore.flush();
    return {
      stored: (await (await getSqlStorage()).loadChat(chatId))!.message[12]
        .data,
      residentLength: characterStore.currentChat!.message.length,
    };
  }, seeded.chatId);
  expect(saved.stored).toContain("current-request");
  expect(saved.residentLength).toBe(12);

  await page.reload();
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
  );
  await page.waitForFunction(
    () => performance.getEntriesByName("plugins-ready").length > 0,
  );
  await page.evaluate(async (characterId) => {
    const charactersUrl = "/src/ts/characters.ts";
    const domainUrl = "/src/ts/stores/domain/index.ts";
    const pluginsUrl = "/src/ts/stores/domain/pluginStore.svelte.ts";
    const apiUrl = "/src/ts/plugins/apiV3/v3.svelte.ts";
    const { changeChar } = (await import(
      /* @vite-ignore */ charactersUrl
    )) as typeof import("../src/ts/characters");
    const { characterStore } = (await import(
      /* @vite-ignore */ domainUrl
    )) as typeof import("../src/ts/stores/domain");
    const { pluginStore } = (await import(
      /* @vite-ignore */ pluginsUrl
    )) as typeof import("../src/ts/stores/domain/pluginStore.svelte");
    const { executePluginV3 } = (await import(
      /* @vite-ignore */ apiUrl
    )) as typeof import("../src/ts/plugins/apiV3/v3.svelte");
    await changeChar(
      characterStore.characters.findIndex(
        (character) => character.chaId === characterId,
      ),
    );
    const plugin = pluginStore.getByName("Chat compatibility test")!;
    await executePluginV3(plugin);
  }, seeded.characterId);

  await expect.poll(readResult).toMatchObject({
    run: 2,
    ids: firstResult.ids,
    names: firstResult.names,
    selected: seeded.characterId,
    states: ["first-after", "second-after"],
    older: expect.stringContaining("older-request"),
    current: expect.stringContaining("current-request"),
  });
});
