// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { createSqlDatabaseAdapter } from "./databaseAdapters.svelte";
import { normalizeDatabaseDefaults } from "./database.svelte";

describe("SQL database defaults", () => {
  it("normalizes an empty core database without eagerly loading deferred domains", async () => {
    const storage = {
      loadPrompts: vi.fn(async () => ({})),
    } as any;

    const adapter = createSqlDatabaseAdapter({} as any, storage);
    adapter.applyCoreDefaults!(normalizeDatabaseDefaults);

    expect(adapter.google).toEqual({ accessToken: "", projectId: "" });
    expect(adapter.openrouterProvider).toEqual({
      order: [],
      only: [],
      ignore: [],
    });
    expect(adapter.seperateModels).toEqual({
      memory: "",
      emotion: "",
      translate: "",
      otherAx: "",
    });
    expect(adapter.promptSettings).toMatchObject({
      assistantPrefill: "",
      postEndInnerFormat: "",
      maxThoughtTagDepth: -1,
    });
    expect(adapter.promptTemplate).toEqual([]);
    expect(adapter.instructChatTemplate).toBe("chatml");
    expect(adapter.customTokenizer).toBe("tik");
    expect(adapter.hypaModel).toBe("openai3small");
    expect(adapter.getLoadedDomains!()).not.toContain("prompts");

    await vi.waitFor(() => expect(storage.loadPrompts).toHaveBeenCalledOnce());
    expect(adapter.promptSettings).toMatchObject({ maxThoughtTagDepth: -1 });
  });

  it("migrates removed browser embedding models to the API default", () => {
    const adapter = createSqlDatabaseAdapter(
      { hypaModel: "MiniLMGPU" } as any,
      {} as any,
    );
    adapter.applyCoreDefaults!(normalizeDatabaseDefaults);

    expect(adapter.hypaModel).toBe("openai3small");
  });

  it("repairs partially populated nested settings", () => {
    const adapter = createSqlDatabaseAdapter(
      {
        openrouterProvider: { order: ["anthropic"] },
        fallbackModels: { model: [""] },
        seperateParameters: { memory: {} },
      } as any,
      {} as any,
    );
    adapter.applyCoreDefaults!(normalizeDatabaseDefaults);

    expect(adapter.openrouterProvider).toEqual({
      order: ["anthropic"],
      only: [],
      ignore: [],
    });
    expect(adapter.fallbackModels).toEqual({
      model: [],
      memory: [],
      emotion: [],
      translate: [],
      otherAx: [],
    });
    expect(adapter.seperateParameters).toEqual({
      memory: {},
      emotion: {},
      translate: {},
      otherAx: {},
      overrides: {},
    });
  });

  it("does not persist runtime lazy-loader methods as root settings", async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        getRevision: vi.fn(() => 0),
        commit: vi.fn(async () => ({ revision: 1 })),
      } as any;

      const adapter = createSqlDatabaseAdapter({} as any, storage);

      expect(adapter.ensureCharacterDetails).toBeTypeOf("function");
      expect(adapter.ensureChatMessages).toBeTypeOf("function");
      expect(adapter.loadOlderChatMessages).toBeTypeOf("function");

      await vi.advanceTimersByTimeAsync(301);
      expect(storage.commit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SQL chat message paging", () => {
  it("hydrates a recent page, prepends older pages, and can promote to full history", async () => {
    const recent = Array.from({ length: 24 }, (_, index) => ({
      chatId: `message-${76 + index}`,
      role: "char",
      data: `message ${76 + index}`,
    }));
    const older = Array.from({ length: 24 }, (_, index) => ({
      chatId: `message-${52 + index}`,
      role: "char",
      data: `message ${52 + index}`,
    }));
    const all = Array.from({ length: 100 }, (_, index) => ({
      chatId: `message-${index}`,
      role: "char",
      data: `message ${index}`,
    }));
    const storage = {
      loadChat: vi.fn(async (_chatId, options) => ({
        id: "chat-1",
        name: "Chat",
        note: "",
        localLore: [],
        message: recent,
        messageOffset: 76,
        messageTotal: 100,
        messagesFullyLoaded: false,
        messagesLoaded: true,
        detailsLoaded: true,
        requestedLimit: options?.messageLimit,
      })),
      loadChatMessagePage: vi.fn(async () => ({
        messages: older,
        offset: 52,
        total: 100,
        hasMore: true,
      })),
      loadChatMessages: vi.fn(async () => all),
    } as any;
    const database = {
      chatLoadInitialPages: 7,
      characters: [
        {
          chaId: "character-1",
          type: "character",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              note: "",
              localLore: [],
              message: [],
              messagesLoaded: false,
              detailsLoaded: false,
            },
          ],
        },
      ],
    } as any;
    const adapter = createSqlDatabaseAdapter(database, storage);

    await adapter.ensureChatMessages!("chat-1");
    const chat = adapter.characters[0].chats[0];
    expect(storage.loadChat).toHaveBeenCalledWith("chat-1", {
      messageLimit: 7,
    });
    expect(chat).toMatchObject({
      messageOffset: 76,
      messageTotal: 100,
      messagesFullyLoaded: false,
    });

    expect(await adapter.loadOlderChatMessages!("chat-1", 24)).toBe(24);
    expect(chat.message).toHaveLength(48);
    expect(chat.message[0].chatId).toBe("message-52");

    await adapter.ensureChatMessages!("chat-1", { full: true });
    expect(chat.message).toHaveLength(100);
    expect(chat).toMatchObject({
      messageOffset: 0,
      messageTotal: 100,
      messagesFullyLoaded: true,
    });
  });
});

describe("SQL domain preservation and loading", () => {
  it("preserves initially provided personas, modules, and lorebook without returning dummy defaults", () => {
    const initialData = {
      username: "Alice",
      personas: [
        { name: "Custom Persona 1", personaPrompt: "Prompt 1" },
        { name: "Custom Persona 2", personaPrompt: "Prompt 2" },
      ],
      modules: [{ id: "mod-1", name: "Module 1" }],
      loreBook: [{ name: "Lore 1", data: [] }],
    } as any;

    const storage = {} as any;
    const adapter = createSqlDatabaseAdapter(initialData, storage, [
      "personas",
      "modules",
      "loreBook",
    ]);

    expect(adapter.personas).toHaveLength(2);
    expect(adapter.personas[0].name).toBe("Custom Persona 1");
    expect(adapter.personas[1].name).toBe("Custom Persona 2");
    expect(adapter.modules).toHaveLength(1);
    expect(adapter.modules[0].name).toBe("Module 1");
    expect(adapter.loreBook).toHaveLength(1);
    expect(adapter.loreBook[0].name).toBe("Lore 1");
    expect(adapter.isDomainLoaded!("personas")).toBe(true);
    expect(adapter.isDomainLoaded!("modules")).toBe(true);
  });
});
