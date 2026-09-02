import { expect, test } from "./fixtures";

async function waitForApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0);
}

test.describe("lazy chat variable hydration", () => {
  test("opening a slow chat cannot persist an empty variable state before hydration", async ({
    page,
  }) => {
    await waitForApp(page);

    const result = await page.evaluate(async () => {
      const characterStoreUrl =
        "/src/ts/stores/domain/characterStore.svelte.ts";
      const chatVarUrl = "/src/ts/parser/chatVar.svelte.ts";
      const { characterStore } = (await import(
        /* @vite-ignore */ characterStoreUrl
      )) as { characterStore: any };
      const { getChatVar, setChatVar } = (await import(
        /* @vite-ignore */ chatVarUrl
      )) as {
        getChatVar: (key: string) => string;
        setChatVar: (key: string, value: string) => boolean;
      };

      const clone = <T>(value: T): T => structuredClone(value);
      const persistedChats = new Map<string, any>([
        [
          "chat-1",
          {
            id: "chat-1",
            name: "Main",
            note: "",
            localLore: [],
            message: [],
            scriptstate: {
              $persisted: "heirloom",
              $untouched: "still-here",
            },
            GLGlobalVariables: { localToggle: "enabled" },
          },
        ],
        [
          "chat-2",
          {
            id: "chat-2",
            name: "Other",
            note: "",
            localLore: [],
            message: [],
            scriptstate: { $otherChat: "preserved" },
          },
        ],
      ]);
      let revision = 0;
      let releaseChatRead!: () => void;
      const chatReadGate = new Promise<void>((resolve) => {
        releaseChatRead = resolve;
      });
      const storage = {
        getRevision: () => revision,
        loadCharacter: async () => null,
        loadChat: async (chatId: string) => {
          await chatReadGate;
          const chat = persistedChats.get(chatId);
          return chat ? clone(chat) : null;
        },
        loadChatMessages: async () => [],
        loadChatMessagePage: async () => ({
          messages: [],
          offset: 0,
          total: 0,
          hasMore: false,
        }),
        commit: async (commit: any) => {
          for (const item of commit.chats ?? []) {
            const previous = persistedChats.get(item.id) ?? {
              id: item.id,
              message: [],
            };
            persistedChats.set(item.id, {
              ...previous,
              ...clone(item.data),
              id: item.id,
              message: previous.message,
            });
          }
          revision += 1;
          return { revision };
        },
      };

      characterStore.init(
        [
          {
            chaId: "char-1",
            type: "character",
            name: "Variable Test",
            firstMessage: "",
            chatPage: 0,
            detailsLoaded: true,
            chats: [
              {
                id: "chat-1",
                name: "Main",
                note: "",
                message: [],
                messagesLoaded: false,
                messagesFullyLoaded: false,
                detailsLoaded: false,
              },
              {
                id: "chat-2",
                name: "Other",
                note: "",
                message: [],
                messagesLoaded: false,
                messagesFullyLoaded: false,
                detailsLoaded: false,
              },
            ],
          },
        ],
        storage,
      );
      characterStore.select(0);

      const chat = characterStore.characters[0].chats[0];
      const wasLazy =
        chat.detailsLoaded === false && chat.scriptstate === undefined;
      const hydration = characterStore.ensureChatMessages("chat-1");

      // Rendering can query a variable before the async storage read returns.
      // A read must not manufacture an empty state that persistence mistakes
      // for a user edit.
      const valueBeforeHydration = getChatVar("persisted");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterRead = characterStore.hasPendingWrites();

      // A real script write during the same window must be retained, but the
      // incomplete summary still must not be flushed before storage hydration.
      const wroteDuringHydration = setChatVar("duringOpen", "new-value");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterDeferredWrite = characterStore.hasPendingWrites();
      await characterStore.flush();

      releaseChatRead();
      await hydration;
      await characterStore.flush();

      return {
        wasLazy,
        valueBeforeHydration,
        pendingAfterRead,
        wroteDuringHydration,
        pendingAfterDeferredWrite,
        inMemoryVariables:
          characterStore.characters[0].chats[0].scriptstate,
        persistedVariables: persistedChats.get("chat-1")?.scriptstate,
        persistedLocalVariables:
          persistedChats.get("chat-1")?.GLGlobalVariables,
        untouchedChatVariables: persistedChats.get("chat-2")?.scriptstate,
      };
    });

    expect(result).toEqual({
      wasLazy: true,
      valueBeforeHydration: "null",
      pendingAfterRead: false,
      wroteDuringHydration: true,
      pendingAfterDeferredWrite: false,
      inMemoryVariables: {
        $duringOpen: "new-value",
        $persisted: "heirloom",
        $untouched: "still-here",
      },
      persistedVariables: {
        $duringOpen: "new-value",
        $persisted: "heirloom",
        $untouched: "still-here",
      },
      persistedLocalVariables: { localToggle: "enabled" },
      untouchedChatVariables: { $otherChat: "preserved" },
    });
  });
});
