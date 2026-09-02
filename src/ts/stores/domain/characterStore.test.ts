// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { characterStore } from "./characterStore.svelte";
import { settingsStore } from "./settingsStore.svelte";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import type { character, Chat, groupChat } from "../../storage/database/schema";

function makeChat(name: string): Chat {
  return {
    message: [],
    note: "",
    name,
    localLore: [],
  } as Chat;
}

function makeChar(name: string, chatCount = 1): character {
  return {
    type: "character",
    name,
    firstMessage: "",
    chats: Array.from({ length: chatCount }, (_, i) =>
      makeChat(`chat ${i + 1}`),
    ),
    chatPage: 0,
    chaId: `char-${name}-${Math.random().toString(36).slice(2)}`,
  } as unknown as character;
}

describe("CharacterStore", () => {
  let committed: SqlCommit[];
  let mockStorage: ISqlStorage;

  beforeEach(() => {
    committed = [];
    mockStorage = {
      getRevision: vi.fn(() => committed.length),
      loadCharacter: vi.fn(async () => null),
      loadChat: vi.fn(async () => null),
      loadChatMessages: vi.fn(async () => []),
      loadChatMessagePage: vi.fn(async () => ({
        messages: [],
        offset: 0,
        total: 0,
        hasMore: false,
      })),
      commit: vi.fn(async (commit: SqlCommit) => {
        committed.push(structuredClone(commit));
        return { revision: committed.length };
      }),
    } as unknown as ISqlStorage;
  });

  it("requeues the newest character state after a failed commit", async () => {
    vi.mocked(mockStorage.commit)
      .mockRejectedValueOnce(new Error("database locked"))
      .mockImplementation(async (commit: SqlCommit) => {
        committed.push(structuredClone(commit));
        return { revision: committed.length };
      });
    const char = makeChar("retry");
    characterStore.init([char], mockStorage);
    characterStore.characters[0].name = "first edit";
    characterStore.markCharacterDirty(char.chaId!);
    await characterStore.flush();
    expect(characterStore.hasPendingWrites()).toBe(true);

    characterStore.characters[0].name = "newest edit";
    characterStore.markCharacterDirty(char.chaId!);
    await characterStore.flush();

    expect(committed).toHaveLength(1);
    expect(committed[0].characters[0].data).toMatchObject({
      name: "newest edit",
    });
    expect(characterStore.hasPendingWrites()).toBe(false);
  });

  it("prefers the interactive character loader when the backend provides one", async () => {
    const shallow = makeChar("selection-loader", 0);
    shallow.detailsLoaded = false;
    const loaded = makeChar("selection-loader", 1);
    loaded.chaId = shallow.chaId;
    loaded.detailsLoaded = true;
    loaded.chats[0].id = "chat-selection-loader";
    const selectionLoader = vi.fn(async () => loaded);
    (mockStorage as any).loadCharacterForSelection = selectionLoader;
    characterStore.init([shallow], mockStorage);

    await characterStore.ensureCharacterDetails(shallow.chaId!);

    expect(selectionLoader).toHaveBeenCalledWith(shallow.chaId);
    expect(mockStorage.loadCharacter).not.toHaveBeenCalled();
  });

  it("persists interaction timestamps without rewriting the character tree", async () => {
    const char = makeChar("touch", 1);
    const charId = char.chaId!;
    characterStore.init([char], mockStorage);

    characterStore.touchCharacterInteraction(0, 123456789);
    await characterStore.flush();

    expect(characterStore.characters[0].lastInteraction).toBe(123456789);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      action: "character-touch",
      characters: [],
      characterTouches: [{ id: charId, lastInteraction: 123456789 }],
    });
  });

  it("keeps chat summaries returned by lazy character hydration", async () => {
    const shallow = makeChar("lazy", 0);
    shallow.detailsLoaded = false;
    const loaded = makeChar("lazy", 2);
    loaded.chaId = shallow.chaId;
    loaded.detailsLoaded = true;
    loaded.chats[0].id = "chat-lazy-1";
    loaded.chats[1].id = "chat-lazy-2";
    vi.mocked(mockStorage.loadCharacter).mockResolvedValue(loaded);
    characterStore.init([shallow], mockStorage);

    await characterStore.ensureCharacterDetails(shallow.chaId!);

    expect(characterStore.characters[0].chats.map((chat) => chat.id)).toEqual([
      "chat-lazy-1",
      "chat-lazy-2",
    ]);
    expect(characterStore.characters[0].detailsLoaded).toBe(true);
  });

  it("preserves the current chat order and selection during async hydration", async () => {
    const shallow = makeChar("stable-chat-selection", 2);
    shallow.detailsLoaded = false;
    shallow.chats[0].id = "chat-stable-a";
    shallow.chats[1].id = "chat-stable-b";

    const loaded = makeChar("stable-chat-selection", 3);
    loaded.chaId = shallow.chaId;
    loaded.detailsLoaded = true;
    loaded.chatPage = 0;
    loaded.chats[0].id = "chat-stable-b";
    loaded.chats[1].id = "chat-stable-a";
    loaded.chats[2].id = "chat-stable-new";

    let resolveLoad!: (value: character) => void;
    vi.mocked(mockStorage.loadCharacter).mockImplementationOnce(
      () => new Promise<character>((resolve) => (resolveLoad = resolve)),
    );
    characterStore.init([shallow], mockStorage);

    const hydration = characterStore.ensureCharacterDetails(shallow.chaId!);
    characterStore.characters[0].chatPage = 1;
    resolveLoad(loaded);
    await hydration;

    const hydrated = characterStore.characters[0];
    expect(hydrated.chats.map((chat) => chat.id)).toEqual([
      "chat-stable-a",
      "chat-stable-b",
      "chat-stable-new",
    ]);
    expect(hydrated.chats[hydrated.chatPage].id).toBe("chat-stable-b");
  });

  it("matches the initial SQL message page to the configured render window", async () => {
    const chars = [makeChar("initial-page")];
    const chat = chars[0].chats[0];
    chat.id = "chat-initial-page";
    chat.messagesLoaded = false;
    chat.detailsLoaded = false;
    vi.mocked(mockStorage.loadChat).mockResolvedValue({
      ...chat,
      message: [],
      messageOffset: 0,
      messageTotal: 0,
      messagesFullyLoaded: true,
      messagesLoaded: true,
      detailsLoaded: true,
    });
    settingsStore.hydrate((state) => {
      state.lowSpecMode = false;
      state.chatLoadInitialPages = 7;
    });
    characterStore.init(chars, mockStorage);

    await characterStore.ensureChatMessages(chat.id);

    expect(mockStorage.loadChat).toHaveBeenCalledWith(chat.id, {
      messageLimit: 7,
    });
  });

  it("does not write storage-hydrated active chat metadata back to SQL", async () => {
    const chars = [makeChar("active-hydration")];
    const chat = chars[0].chats[0];
    chat.id = "chat-active-hydration";
    chat.messagesLoaded = false;
    chat.detailsLoaded = false;
    delete (chat as any).localLore;
    vi.mocked(mockStorage.loadChat).mockResolvedValue({
      ...chat,
      note: "hydrated from storage",
      localLore: [{ key: "loaded" }] as any,
      message: [],
      messageOffset: 0,
      messageTotal: 0,
      messagesFullyLoaded: true,
      messagesLoaded: true,
      detailsLoaded: true,
    });
    characterStore.init(chars, mockStorage);
    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    await characterStore.ensureChatMessages(chat.id);
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();

    expect(characterStore.characters[0].chats[0].note).toBe(
      "hydrated from storage",
    );
    expect(committed).toHaveLength(0);
  });

  it("hydrates only messages when full generation history is requested from a paged chat", async () => {
    const chars = [makeChar("paged")];
    const chat = chars[0].chats[0];
    chat.id = "chat-paged";
    chat.message = [{ role: "user", data: "recent" } as any];
    chat.messagesLoaded = true;
    chat.detailsLoaded = true;
    chat.messagesFullyLoaded = false;
    chat.messageOffset = 2;
    chat.messageTotal = 3;

    const allMessages = [
      { role: "user", data: "oldest" },
      { role: "char", data: "older" },
      { role: "user", data: "recent" },
    ] as any[];
    vi.mocked(mockStorage.loadChatMessages).mockResolvedValue(allMessages);
    characterStore.init(chars, mockStorage);

    await characterStore.ensureChatMessages(chat.id, { full: true });

    const loadedChat = characterStore.characters[0].chats[0];
    expect(mockStorage.loadChatMessages).toHaveBeenCalledWith(chat.id, {
      mode: "full",
    });
    expect(mockStorage.loadChat).not.toHaveBeenCalled();
    expect(loadedChat.message).toEqual(allMessages);
    expect(loadedChat.messageOffset).toBe(0);
    expect(loadedChat.messageTotal).toBe(3);
    expect(loadedChat.messagesFullyLoaded).toBe(true);
  });

  it("uses lightweight generation history while preserving metadata from the loaded page", async () => {
    const chars = [makeChar("generation")];
    const chat = chars[0].chats[0];
    chat.id = "chat-generation";
    chat.message = [
      {
        chatId: "msg-recent",
        role: "char",
        data: "recent",
        generationInfo: { model: "model-a" },
        promptInfo: { promptName: "saved-prompt" },
      } as any,
    ];
    chat.messagesLoaded = true;
    chat.detailsLoaded = true;
    chat.messagesFullyLoaded = false;
    chat.messageOffset = 1;
    chat.messageTotal = 2;

    vi.mocked(mockStorage.loadChatMessages).mockResolvedValue([
      { chatId: "msg-old", role: "user", data: "old" } as any,
      { chatId: "msg-recent", role: "char", data: "recent" } as any,
    ]);
    characterStore.init(chars, mockStorage);

    await characterStore.ensureChatMessages(chat.id, {
      full: true,
      generation: true,
    });

    const loaded = characterStore.characters[0].chats[0];
    expect(mockStorage.loadChatMessages).toHaveBeenCalledWith(chat.id, {
      mode: "generation",
    });
    expect(loaded.message).toHaveLength(2);
    expect(loaded.message[0].generationInfo).toBeUndefined();
    expect(loaded.message[1].generationInfo?.model).toBe("model-a");
    expect(loaded.message[1].promptInfo?.promptName).toBe("saved-prompt");
  });

  it("reloads full message metadata after lightweight generation hydration", async () => {
    const chars = [makeChar("generation-upgrade")];
    const chat = chars[0].chats[0];
    chat.id = "chat-generation-upgrade";
    chat.message = [
      { chatId: "msg-recent", role: "char", data: "recent" } as any,
    ];
    chat.messagesLoaded = true;
    chat.detailsLoaded = true;
    chat.messagesFullyLoaded = false;
    chat.messageOffset = 1;
    chat.messageTotal = 2;

    vi.mocked(mockStorage.loadChatMessages)
      .mockResolvedValueOnce([
        { chatId: "msg-old", role: "user", data: "old" } as any,
        { chatId: "msg-recent", role: "char", data: "recent" } as any,
      ])
      .mockResolvedValueOnce([
        {
          chatId: "msg-old",
          role: "user",
          data: "old",
          promptInfo: { promptName: "old-prompt" },
        } as any,
        {
          chatId: "msg-recent",
          role: "char",
          data: "recent",
          generationInfo: { model: "model-b" },
        } as any,
      ]);
    characterStore.init(chars, mockStorage);

    await characterStore.ensureChatMessages(chat.id, {
      full: true,
      generation: true,
    });
    characterStore.characters[0].chats[0].message.push({
      chatId: "msg-local",
      role: "char",
      data: "not committed yet",
    } as any);
    await characterStore.ensureChatMessages(chat.id, { full: true });

    expect(mockStorage.loadChatMessages).toHaveBeenNthCalledWith(1, chat.id, {
      mode: "generation",
    });
    expect(mockStorage.loadChatMessages).toHaveBeenNthCalledWith(2, chat.id, {
      mode: "full",
    });
    const loaded = characterStore.characters[0].chats[0];
    expect(loaded.message[0].promptInfo?.promptName).toBe("old-prompt");
    expect(loaded.message[1].generationInfo?.model).toBe("model-b");
    expect(loaded.message[2]).toMatchObject({
      chatId: "msg-local",
      data: "not committed yet",
    });
  });

  it("upgrades an in-flight paged load when a full history request arrives", async () => {
    const chars = [makeChar("race")];
    const chat = chars[0].chats[0];
    chat.id = "chat-race";
    chat.messagesLoaded = false;
    chat.detailsLoaded = false;
    chat.messagesFullyLoaded = false;

    let resolvePartial!: (chat: Chat) => void;
    vi.mocked(mockStorage.loadChat).mockImplementationOnce(
      () => new Promise<Chat>((resolve) => (resolvePartial = resolve)),
    );
    vi.mocked(mockStorage.loadChatMessages).mockResolvedValue([
      { role: "user", data: "old" } as any,
      { role: "char", data: "new" } as any,
    ]);
    characterStore.init(chars, mockStorage);

    const partialLoad = characterStore.ensureChatMessages(chat.id);
    const fullLoad = characterStore.ensureChatMessages(chat.id, { full: true });
    resolvePartial({
      ...makeChat("partial"),
      id: chat.id,
      message: [{ role: "char", data: "new" } as any],
      messageOffset: 1,
      messageTotal: 2,
      messagesLoaded: true,
      messagesFullyLoaded: false,
      detailsLoaded: true,
    } as Chat);

    await Promise.all([partialLoad, fullLoad]);

    const loadedChat = characterStore.characters[0].chats[0];
    expect(mockStorage.loadChat).toHaveBeenCalledTimes(1);
    expect(mockStorage.loadChatMessages).toHaveBeenCalledTimes(1);
    expect(loadedChat.message).toHaveLength(2);
    expect(loadedChat.messagesFullyLoaded).toBe(true);
  });

  it("does not commit on init or selection", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);

    await new Promise((r) => setTimeout(r, 30));
    expect(mockStorage.commit).not.toHaveBeenCalled();

    characterStore.select(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("commits a mutation of the active character", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Active char mutation
    characterStore.characters[0].name = "renamed";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters).toHaveLength(1);
    expect(committed[0].characters![0].id).toBe(chars[0].chaId);
    const data = committed[0].characters![0].data as any;
    expect(data.name).toBe("renamed");
    // sqlCharacterData must not leak chats into the row payload
    expect(data.chats).toBeUndefined();
  });

  it("ignores message-body mutations in metadata observers", async () => {
    const chars = [makeChar("message-only")];
    chars[0].chats[0].message = [
      { chatId: "msg-1", role: "char", data: "before" } as any,
    ];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();
    committed.length = 0;

    characterStore.characters[0].chats[0].message[0].data = "streamed update";
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();

    expect(committed).toHaveLength(0);
  });

  it("ignores mutations of inactive characters", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Mutate the INACTIVE character
    characterStore.characters[1].name = "should-not-persist";
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();
    expect(committed.length).toBe(0);

    // Explicit mark still persists it
    characterStore.markCharacterDirty(characterStore.characters[1].chaId!);
    await characterStore.flush();
    expect(committed.length).toBe(1);
    expect(committed[0].characters![0].id).toBe(
      characterStore.characters[1].chaId,
    );
  });

  it("persists metadata of newly added chats without spurious commits on switch", async () => {
    const chars = [makeChar("a", 2)];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));
    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Add a new chat to the active character
    characterStore.characters[0].chats.push(makeChat("brand new"));
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    // The store assigned an id to the new chat and persisted its metadata
    const freshId = characterStore.characters[0].chats[2].id;
    expect(freshId).toBeTruthy();
    expect(committed[0].chats!.map((c) => c.id)).toContain(freshId);
    expect(committed[0].chatManifests!).toHaveLength(1);
    expect(committed[0].chatManifests![0].ids).toContain(freshId);

    committed.length = 0;

    // Switching between existing chats persists ONLY the character row
    // (chatPage lives inside sqlCharacterData) — never chat rows.
    characterStore.characters[0].chatPage = 1;
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();
    expect(committed.length).toBe(1);
    expect(committed[0].characters!.map((c) => c.id)).toContain(
      characterStore.characters[0].chaId,
    );
    expect(committed[0].characters![0].data).toHaveProperty("chatPage", 1);
    expect(committed[0].chats).toHaveLength(0);

    // ...but editing the newly-active chat does commit its own row
    characterStore.characters[0].chats[1].note = "edited note";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();
    expect(committed.length).toBe(2);
    expect(committed[1].chats![0].data).toHaveProperty("note", "edited note");
  });

  it("tracks character order changes and direct additions when selectedId is -1", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    // selectedId is -1 (default)
    expect(characterStore.selectedId).toBe(-1);

    // Push a new character directly (e.g. card import)
    const imported = makeChar("imported");
    characterStore.characters.push(imported);
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters).toHaveLength(1);
    expect(committed[0].characters![0].id).toBe(imported.chaId);
    expect(committed[0].characterIds).toHaveLength(3);

    committed.length = 0;

    // Reorder characters
    characterStore.characters.reverse();
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].action).toBe("order");
    expect(committed[0].characterIds).toEqual(
      characterStore.characters.map((c) => c.chaId),
    );
  });

  it("persists characters added via add() and handles remove()", async () => {
    const chars = [makeChar("a")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    const newChar = makeChar("added-via-method");
    const idx = characterStore.add(newChar);
    expect(idx).toBe(1);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters![0].id).toBe(newChar.chaId);
    expect(committed[0].characterIds).toContain(newChar.chaId);

    committed.length = 0;

    characterStore.remove(0);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characterIds).toEqual([newChar.chaId]);
    expect(committed[0].characterDeletes).toEqual([chars[0].chaId]);
  });

  it("records exact character IDs removed by direct array mutation", async () => {
    const chars = [makeChar("a"), makeChar("b"), makeChar("c")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    const removedId = chars[1].chaId;
    characterStore.characters.splice(1, 1);
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed).toHaveLength(1);
    expect(committed[0].characterDeletes).toEqual([removedId]);
    expect(committed[0].characterIds).toEqual([chars[0].chaId, chars[2].chaId]);
  });

  it("records exact chat IDs removed from the active character", async () => {
    const char = makeChar("chat-delete", 3);
    characterStore.init([char], mockStorage);
    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    const removedId = characterStore.characters[0].chats[1].id!;
    characterStore.characters[0].chats.splice(1, 1);
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed).toHaveLength(1);
    expect(committed[0].chatDeletes).toEqual([removedId]);
    expect(committed[0].chatManifests[0].ids).not.toContain(removedId);
  });

  it("compacts only old inactive character details outside the working set", async () => {
    vi.useFakeTimers();
    try {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = true;
      });
      const chars = [0, 1, 2, 3].map((index) => {
        const char = makeChar(`compact-${index}`);
        char.detailsLoaded = true;
        char.chats[0].id = `chat-compact-${index}`;
        char.chats[0].message = [
          { chatId: `msg-${index}`, role: "char", data: "resident" } as any,
        ];
        char.chats[0].messagesLoaded = true;
        char.chats[0].messagesFullyLoaded = true;
        (char as any).globalLore = [{ key: `heavy-${index}` }];
        return char;
      });
      chars[0].coldstorage = "legacy-cold-character";
      chars[0].coldStoragedChats = ["chat-compact-0"];
      characterStore.init(chars, mockStorage);
      characterStore.select(3);

      characterStore.releaseInactiveCharacterDetails(
        () => new Set(["chat-compact-1"]),
      );
      await vi.runAllTimersAsync();

      const evicted = characterStore.characters[0] as any;
      expect(evicted.detailsLoaded).toBe(false);
      expect(evicted.globalLore).toBeUndefined();
      expect(evicted.coldstorage).toBe("legacy-cold-character");
      expect(evicted.coldStoragedChats).toEqual(["chat-compact-0"]);
      expect(evicted.chats[0]).toMatchObject({
        id: "chat-compact-0",
        message: [],
        messagesLoaded: false,
        messagesFullyLoaded: false,
        detailsLoaded: false,
      });
      expect(characterStore.characters[1].detailsLoaded).toBe(true);
      expect(characterStore.characters[2].detailsLoaded).toBe(true);
      expect(characterStore.characters[3].detailsLoaded).toBe(true);
    } finally {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = false;
      });
      vi.useRealTimers();
    }
  });

  it("never compacts dirty characters or chats with compaction guards", async () => {
    vi.useFakeTimers();
    try {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = true;
      });
      const chars = [0, 1, 2, 3, 4].map((index) => {
        const char = makeChar(`guarded-${index}`);
        char.detailsLoaded = true;
        char.chats[0].id = `chat-guarded-${index}`;
        (char as any).globalLore = [{ key: `heavy-${index}` }];
        return char;
      });
      chars[1].chats[0].preventMessageCompaction = true;
      characterStore.init(chars, mockStorage);
      characterStore.select(4);
      characterStore.markCharacterDirty(chars[0].chaId!);

      characterStore.releaseInactiveCharacterDetails(() => new Set());
      await vi.advanceTimersByTimeAsync(0);

      expect(characterStore.characters[0].detailsLoaded).toBe(true);
      expect(characterStore.characters[1].detailsLoaded).toBe(true);
      expect(characterStore.characters[2].detailsLoaded).toBe(false);
      expect(characterStore.characters[3].detailsLoaded).toBe(true);
      expect(characterStore.characters[4].detailsLoaded).toBe(true);
    } finally {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = false;
      });
      vi.useRealTimers();
    }
  });

  it("re-checks protected chats before character detail eviction", async () => {
    vi.useFakeTimers();
    try {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = true;
      });
      const chars = [0, 1, 2].map((index) => {
        const char = makeChar(`dynamic-${index}`);
        char.detailsLoaded = true;
        char.chats[0].id = `chat-dynamic-${index}`;
        (char as any).globalLore = [{ key: `heavy-${index}` }];
        return char;
      });
      characterStore.init(chars, mockStorage);
      characterStore.select(2);
      const protectedIds = new Set<string>();

      characterStore.releaseInactiveCharacterDetails(() => protectedIds);
      protectedIds.add("chat-dynamic-0");
      await vi.runAllTimersAsync();

      expect(characterStore.characters[0].detailsLoaded).toBe(true);
    } finally {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = false;
      });
      vi.useRealTimers();
    }
  });

  it("rehydrates an evicted character without marking chat summaries as loaded", async () => {
    vi.useFakeTimers();
    try {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = true;
      });
      const chars = [0, 1, 2].map((index) => {
        const char = makeChar(`rehydrate-${index}`);
        char.detailsLoaded = true;
        char.chats[0].id = `chat-rehydrate-${index}`;
        (char as any).globalLore = [{ key: `old-${index}` }];
        return char;
      });
      const evictedId = chars[0].chaId!;
      characterStore.init(chars, mockStorage);
      characterStore.select(2);
      characterStore.releaseInactiveCharacterDetails(() => new Set());
      await vi.runAllTimersAsync();
      expect(characterStore.characters[0].detailsLoaded).toBe(false);

      const loaded = makeChar("rehydrated", 1);
      loaded.chaId = evictedId;
      loaded.detailsLoaded = true;
      loaded.chats[0].id = "chat-rehydrate-0";
      loaded.chats[0].detailsLoaded = false;
      (loaded as any).globalLore = [{ key: "restored" }];
      (mockStorage as any).loadCharacterForSelection = vi.fn(async () => loaded);

      await characterStore.ensureCharacterDetails(evictedId);

      const hydrated = characterStore.characters[0] as any;
      expect(hydrated.detailsLoaded).toBe(true);
      expect(hydrated.globalLore).toEqual([{ key: "restored" }]);
      expect(hydrated.chats[0].id).toBe("chat-rehydrate-0");
      expect(hydrated.chats[0].detailsLoaded).toBe(false);
    } finally {
      settingsStore.hydrate((state) => {
        state.lowSpecMode = false;
      });
      vi.useRealTimers();
    }
  });

  it("handles whole-object replacements via setCurrentCharacter and setCharacterByIndex", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Replace active character object
    const replacedActive = makeChar("a-replaced");
    replacedActive.chaId = chars[0].chaId;
    characterStore.setCurrentCharacter(replacedActive);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe("a-replaced");

    // Subsequent mutations to the new object are tracked
    committed.length = 0;
    characterStore.characters[0].name = "a-replaced-and-mutated";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe(
      "a-replaced-and-mutated",
    );

    // Replace inactive character object
    committed.length = 0;
    const replacedInactive = makeChar("b-replaced");
    replacedInactive.chaId = chars[1].chaId;
    characterStore.setCharacterByIndex(1, replacedInactive);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe("b-replaced");
  });
});
