import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore, messageStore } from "./stores/domain";
import { duplicateCharacter } from "./characters";
import type { character, groupChat, Chat, Message } from "./storage/schema";
import type { ISqlStorage } from "./storage/ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./storage/sqlCommit";
import { setSqlStorageForTesting } from "./storage/sqlStorageFactory";

const preLoadChatMock = vi.fn();
const getColdStorageItemMock = vi.fn();
vi.mock("./process/coldstorage.svelte", () => ({
  preLoadChat: (...args: any[]) => preLoadChatMock(...args),
  getColdStorageItem: (...args: any[]) => getColdStorageItemMock(...args),
}));

class MockSqlStorage {
  backendKind = "web-sqlite" as const;
  revision = 1;
  commits: SqlCommit[] = [];

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    this.commits.push(commit);
    this.revision += 1;
    return { revision: this.revision };
  }

  getRevision(): number {
    return this.revision;
  }

  isEnabled(): boolean {
    return true;
  }

  async close(): Promise<void> {}
  async loadDatabase(): Promise<any> {
    return {};
  }
  async replaceDatabase(): Promise<boolean> {
    return true;
  }
  async loadCharacter(id: string): Promise<any> {
    return null;
  }
  async loadChat(): Promise<any> {
    return null;
  }
  async loadChatMessagePage(): Promise<any> {
    return { messages: [], offset: 0, total: 0, hasMore: false };
  }
  async searchMessages(): Promise<any[]> {
    return [];
  }
}

function makeMessage(chatId: string, data: string, role: Message["role"] = "user"): Message {
  return { chatId, role, data };
}

function makeChat(id: string, messages: Message[], extra: Partial<Chat> = {}): Chat {
  return {
    id,
    name: "Chat 1",
    note: "",
    localLore: [],
    message: messages,
    messagesLoaded: true,
    messagesFullyLoaded: true,
    detailsLoaded: true,
    ...extra,
  } as Chat;
}

describe("duplicateCharacter", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    preLoadChatMock.mockReset();
    getColdStorageItemMock.mockReset();
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);
  });

  it("duplicates a fully hydrated character with fresh IDs and persisted messages", async () => {
    const chat1 = makeChat("chat-1", [
      makeMessage("m1", "hello"),
      makeMessage("m2", "hi there", "char"),
    ], {
      bookmarks: ["m1"],
      bookmarkNames: { m1: "Greeting" },
    });
    const chat2 = makeChat("chat-2", [
      makeMessage("m3", "another message"),
    ]);

    const sourceChar = {
      chaId: "char-1",
      type: "character",
      name: "Original Bot",
      chatPage: 0,
      chats: [chat1, chat2],
      detailsLoaded: true,
      globalLore: [{ key: "lore1", content: "some lore" }],
      triggerscript: [{ name: "trigger1" }],
    } as unknown as character;

    characterStore.init([sourceChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    expect(duplicated!.chaId).not.toBe("char-1");
    expect(duplicated!.name).toBe("Original Bot (Copy)");
    expect(characterStore.characters.length).toBe(2);

    const copyChar = characterStore.characters[1] as character;
    expect(copyChar.chats.length).toBe(2);

    // Chat 1 ID & messages
    expect(copyChar.chats[0].id).not.toBe("chat-1");
    expect(copyChar.chats[0].message.map((m) => m.data)).toEqual(["hello", "hi there"]);
    expect(copyChar.chats[0].message.map((m) => m.chatId)).not.toEqual(["m1", "m2"]);
    expect(new Set(copyChar.chats[0].message.map((m) => m.chatId)).size).toBe(2);

    // Bookmark remapping
    const newMsg1Id = copyChar.chats[0].message[0].chatId;
    expect(copyChar.chats[0].bookmarks).toEqual([newMsg1Id]);
    expect(copyChar.chats[0].bookmarkNames).toEqual({ [newMsg1Id!]: "Greeting" });

    // Chat 2 ID & messages
    expect(copyChar.chats[1].id).not.toBe("chat-2");
    expect(copyChar.chats[1].message.map((m) => m.data)).toEqual(["another message"]);
    expect(copyChar.chats[1].message[0].chatId).not.toBe("m3");

    // Details preserved
    expect(copyChar.globalLore).toEqual([{ key: "lore1", content: "some lore" }]);
    expect(copyChar.triggerscript).toEqual([{ name: "trigger1" }]);

    // SQL messages persisted
    expect(mockStorage.commits.some((c) => c.action === "chat-create-messages")).toBe(true);
  });

  it("hydrates shallow character details before duplicating", async () => {
    const shallowChar = {
      chaId: "char-shallow",
      type: "character",
      name: "Shallow Bot",
      chatPage: 0,
      chats: [makeChat("chat-s1", [makeMessage("ms1", "hi")])],
      detailsLoaded: false,
    } as unknown as character;

    mockStorage.loadCharacter = vi.fn().mockResolvedValue({
      chaId: "char-shallow",
      type: "character",
      name: "Shallow Bot",
      chatPage: 0,
      chats: [makeChat("chat-s1", [makeMessage("ms1", "hi")])],
      globalLore: [{ key: "hydratedKey", content: "hydratedContent" }],
      detailsLoaded: true,
    });

    characterStore.init([shallowChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    const copyChar = characterStore.characters[1] as character;
    expect(copyChar.globalLore).toEqual([
      { key: "hydratedKey", content: "hydratedContent" },
    ]);
  });

  it("preloads lazy chats before duplicating so messages are not lost", async () => {
    const lazyChat = makeChat("chat-lazy", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    });
    const testChar = {
      chaId: "char-lazy",
      type: "character",
      name: "Lazy Bot",
      chatPage: 0,
      chats: [lazyChat],
      detailsLoaded: true,
    } as unknown as character;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    preLoadChatMock.mockImplementation(async () => {
      const chat = characterStore.characters[0].chats[0];
      chat.message = [makeMessage("lazy-m1", "restored lazy message")];
      chat.messagesLoaded = true;
      chat.messagesFullyLoaded = true;
      chat.detailsLoaded = true;
    });

    const duplicated = await duplicateCharacter(0);

    expect(preLoadChatMock).toHaveBeenCalledWith(0, 0, { full: true });
    expect(duplicated).not.toBeNull();
    expect(duplicated!.chats[0].message.map((m) => m.data)).toEqual(["restored lazy message"]);
  });

  it("aborts duplication without creating a copy if chat hydration fails", async () => {
    const lazyChat = makeChat("chat-fail", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    });
    const testChar = {
      chaId: "char-fail",
      type: "character",
      name: "Fail Bot",
      chatPage: 0,
      chats: [lazyChat],
      detailsLoaded: true,
    } as unknown as character;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    preLoadChatMock.mockResolvedValue(undefined);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).toBeNull();
    expect(characterStore.characters.length).toBe(1);
  });

  it("aborts when shallow character details cannot be hydrated", async () => {
    const shallowChar = {
      chaId: "char-missing-details",
      type: "character",
      name: "Missing Details Bot",
      chatPage: 0,
      chats: [makeChat("chat-details", [makeMessage("md1", "hi")])],
      detailsLoaded: false,
    } as unknown as character;

    mockStorage.loadCharacter = vi.fn().mockResolvedValue(null);
    characterStore.init([shallowChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).toBeNull();
    expect(characterStore.characters).toHaveLength(1);
    expect(characterStore.characters[0].chaId).toBe("char-missing-details");
  });

  it("re-finds the source character after detail hydration reorders the list", async () => {
    const lazyChat = makeChat("chat-reordered-character", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
      messageTotal: 1,
    });
    const sourceChar = {
      chaId: "char-reordered",
      type: "character",
      name: "Reordered Bot",
      chatPage: 0,
      chats: [lazyChat],
      detailsLoaded: false,
    } as unknown as character;
    const otherChar = {
      chaId: "char-other",
      type: "character",
      name: "Other Bot",
      chatPage: 0,
      chats: [makeChat("other-chat", [makeMessage("other-m", "other")])],
      detailsLoaded: true,
    } as unknown as character;

    mockStorage.loadCharacter = vi.fn().mockImplementation(async () => {
      characterStore.characters = [otherChar, sourceChar];
      return {
        ...sourceChar,
        detailsLoaded: true,
        globalLore: [{ key: "loaded", content: "yes" }],
        chats: [lazyChat],
      };
    });
    preLoadChatMock.mockImplementation(async (characterIndex: number, chatIndex: number) => {
      const chat = characterStore.characters[characterIndex].chats[chatIndex];
      chat.message = [makeMessage("reordered-m", "loaded after reorder")];
      chat.messagesLoaded = true;
      chat.messagesFullyLoaded = true;
      chat.detailsLoaded = true;
    });

    characterStore.init([sourceChar, otherChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    expect(preLoadChatMock).toHaveBeenCalledWith(1, 0, { full: true });
    expect(characterStore.characters.some((c) => c.chaId === "char-other")).toBe(true);
    expect(duplicated!.chats[0].message[0].data).toBe("loaded after reorder");
  });

  it("tracks chats by identity when their order changes during hydration", async () => {
    const chatA = makeChat("chat-a", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
      messageTotal: 1,
    });
    const chatB = makeChat("chat-b", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
      messageTotal: 1,
    });
    const sourceChar = {
      chaId: "char-chat-reorder",
      type: "character",
      name: "Chat Reorder Bot",
      chatPage: 0,
      chats: [chatA, chatB],
      detailsLoaded: true,
    } as unknown as character;

    characterStore.init([sourceChar], mockStorage as unknown as ISqlStorage);
    let firstLoad = true;
    preLoadChatMock.mockImplementation(async (characterIndex: number, chatIndex: number) => {
      const char = characterStore.characters[characterIndex];
      const target = char.chats[chatIndex];
      target.message = [makeMessage(`${target.id}-m`, `loaded ${target.id}`)];
      target.messagesLoaded = true;
      target.messagesFullyLoaded = true;
      target.detailsLoaded = true;
      if (firstLoad) {
        firstLoad = false;
        char.chats.reverse();
      }
    });

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    expect(preLoadChatMock).toHaveBeenNthCalledWith(1, 0, 0, { full: true });
    expect(preLoadChatMock).toHaveBeenNthCalledWith(2, 0, 0, { full: true });
    expect(duplicated!.chats.map((chat) => chat.message[0].data).sort()).toEqual([
      "loaded chat-a",
      "loaded chat-b",
    ]);
  });

  it("does not overwrite another character when cold-storage loading reorders the list", async () => {
    const archivedChar = {
      chaId: "char-archived",
      type: "character",
      name: "Archived Bot",
      chatPage: 0,
      chats: [],
      coldstorage: "cold-key",
      detailsLoaded: false,
    } as unknown as character;
    const restoredChar = {
      chaId: "char-archived",
      type: "character",
      name: "Archived Bot",
      chatPage: 0,
      chats: [makeChat("restored-chat", [makeMessage("restored-m", "restored")])],
      detailsLoaded: true,
      globalLore: [{ key: "restored", content: "content" }],
    } as unknown as character;
    const otherChar = {
      chaId: "char-neighbor",
      type: "character",
      name: "Neighbor Bot",
      chatPage: 0,
      chats: [makeChat("neighbor-chat", [makeMessage("neighbor-m", "neighbor")])],
      detailsLoaded: true,
    } as unknown as character;

    characterStore.init([archivedChar, otherChar], mockStorage as unknown as ISqlStorage);
    getColdStorageItemMock.mockImplementation(async () => {
      characterStore.characters = [otherChar, archivedChar];
      return { character: restoredChar };
    });

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    expect(characterStore.characters.some((c) => c.chaId === "char-neighbor")).toBe(true);
    const restored = characterStore.characters.find((c) => c.chaId === "char-archived");
    expect(restored?.chats[0].message[0].data).toBe("restored");
    expect(duplicated!.chats[0].message[0].data).toBe("restored");
  });

  it("duplicates a group chat preserving group specific fields", async () => {
    const groupChar = {
      chaId: "group-1",
      type: "group",
      name: "Adventuring Party",
      chatPage: 0,
      chats: [makeChat("group-chat-1", [makeMessage("gm1", "Hello party")])],
      detailsLoaded: true,
      characters: ["char-a", "char-b"],
      characterTalks: [0.5, 0.5],
      characterActive: [true, true],
    } as unknown as groupChat;

    characterStore.init([groupChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateCharacter(0);

    expect(duplicated).not.toBeNull();
    expect(duplicated!.type).toBe("group");
    expect(duplicated!.name).toBe("Adventuring Party (Copy)");
    expect((duplicated as groupChat).characters).toEqual(["char-a", "char-b"]);
    expect((duplicated as groupChat).characterTalks).toEqual([0.5, 0.5]);
  });
});
