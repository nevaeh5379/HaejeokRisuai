import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore, messageStore } from "./stores/domain";
import { duplicateChat } from "./characters";
import { createChatCopyName } from "./globalApi.svelte";
import type { character, Chat, Message } from "./storage/database/schema";
import type { ISqlStorage } from "./storage/sql/ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./storage/sql/sqlCommit";
import { setSqlStorageForTesting } from "./storage/sql/sqlStorageFactory";

const preLoadChatMock = vi.fn();
vi.mock("./process/coldstorage.svelte", () => ({
  preLoadChat: (...args: any[]) => preLoadChatMock(...args),
  getColdStorageItem: vi.fn(),
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
  async replaceDatabase(): Promise<boolean> {
    return true;
  }
  async loadCharacter(): Promise<any> {
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

function makeMessage(
  chatId: string,
  data: string,
  role: Message["role"] = "user",
): Message {
  return { chatId, role, data };
}

function makeChat(
  id: string,
  messages: Message[],
  extra: Partial<Chat> = {},
): Chat {
  return {
    id,
    name: "Chat",
    note: "",
    localLore: [],
    message: messages,
    messagesLoaded: true,
    messagesFullyLoaded: true,
    ...extra,
  } as Chat;
}

describe("createChatCopyName", () => {
  it("generates unique copy names and strips an existing copy suffix", () => {
    const existing = [
      { name: "Main Story" },
      { name: "Main Story (Copy)" },
      { name: "Main Story (Copy 2)" },
    ];

    expect(createChatCopyName("Main Story (Copy)", "Copy", existing)).toBe(
      "Main Story (Copy 3)",
    );
  });

  it("falls back to Chat for an empty name", () => {
    expect(createChatCopyName("", "Copy", [])).toBe("Chat (Copy)");
  });
});

describe("duplicateChat", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    preLoadChatMock.mockReset();
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);
  });

  it("duplicates a hydrated chat with fresh chat and message IDs", async () => {
    const sourceChat = makeChat("chat-1", [
      makeMessage("m1", "hello"),
      makeMessage("m2", "hi there", "char"),
    ]);
    const testChar = {
      chaId: "char-1",
      type: "character",
      name: "Char",
      chatPage: 0,
      chats: [sourceChat],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateChat(0, 0);

    expect(duplicated).not.toBeNull();
    expect(duplicated!.id).not.toBe("chat-1");
    expect(duplicated!.name).toBe("Chat (Copy)");
    expect(duplicated!.message.map((m) => m.data)).toEqual([
      "hello",
      "hi there",
    ]);
    expect(duplicated!.message.map((m) => m.chatId)).not.toEqual(["m1", "m2"]);
    expect(new Set(duplicated!.message.map((m) => m.chatId)).size).toBe(2);
    expect(mockStorage.commits.some((c) => c.messages.length > 0)).toBe(true);
  });

  it("preloads a lazy chat before cloning so messages are not lost", async () => {
    const lazyChat = makeChat("chat-lazy", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    });
    const testChar = {
      chaId: "char-lazy",
      type: "character",
      name: "Lazy",
      chatPage: 0,
      chats: [lazyChat],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    // Simulate the storage hydration performed by preLoadChat callers.
    preLoadChatMock.mockImplementation(async () => {
      const chat = characterStore.characters[0].chats[0];
      chat.message = [makeMessage("lazy-m1", "restored")];
      chat.messagesLoaded = true;
      chat.messagesFullyLoaded = true;
      chat.detailsLoaded = true;
    });

    const duplicated = await duplicateChat(0, 0);

    expect(preLoadChatMock).toHaveBeenCalledWith(0, 0, { full: true });
    expect(duplicated!.message.map((m) => m.data)).toEqual(["restored"]);
  });

  it("aborts duplication when full chat hydration does not complete", async () => {
    const lazyChat = makeChat("chat-failed-load", [], {
      messagesLoaded: false,
      messagesFullyLoaded: false,
      detailsLoaded: false,
    });
    const testChar = {
      chaId: "char-failed-load",
      type: "character",
      name: "Failed Load",
      chatPage: 0,
      chats: [lazyChat],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    preLoadChatMock.mockResolvedValue(undefined);

    const duplicated = await duplicateChat(0, 0);

    expect(duplicated).toBeNull();
    expect(characterStore.characters[0].chats).toEqual([lazyChat]);
    expect(mockStorage.commits).toEqual([]);
  });

  it("remaps bookmarks and bookmarkNames to the duplicated message IDs", async () => {
    const sourceChat = makeChat(
      "chat-bm",
      [makeMessage("m1", "bookmarked"), makeMessage("m2", "plain", "char")],
      {
        bookmarks: ["m1", "m2"],
        bookmarkNames: { m1: "User| hello", m2: "Char| hi" },
      },
    );
    const testChar = {
      chaId: "char-bm",
      type: "character",
      name: "Bm",
      chatPage: 0,
      chats: [sourceChat],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateChat(0, 0);

    const m1New = duplicated!.message[0].chatId!;
    const m2New = duplicated!.message[1].chatId!;
    expect(duplicated!.bookmarks).toEqual([m1New, m2New]);
    expect(duplicated!.bookmarkNames).toEqual({
      [m1New]: "User| hello",
      [m2New]: "Char| hi",
    });
  });

  it("drops branch state and offsets the chat page when inserting before the active chat", async () => {
    const first = makeChat("chat-a", [makeMessage("a1", "one")]);
    const active = makeChat("chat-b", [makeMessage("b1", "two")], {
      branchState: {
        baseMessageIndex: 0,
        activeBranchId: "root",
        branches: [],
      },
    });
    const testChar = {
      chaId: "char-order",
      type: "character",
      name: "Order",
      chatPage: 1,
      chats: [first, active],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateChat(0, 0, { insertIndex: 0 });

    expect(duplicated!.branchState).toBeUndefined();
    expect(duplicated!.branch).toBeUndefined();
    expect(characterStore.characters[0].chats).toHaveLength(3);
    expect(characterStore.characters[0].chatPage).toBe(2);
    expect(characterStore.characters[0].chats[2].id).toBe("chat-b");
  });

  it("honors insertIndex when selecting the duplicated chat", async () => {
    const source = makeChat("chat-source", [makeMessage("s1", "one")]);
    const other = makeChat("chat-other", [makeMessage("o1", "two")]);
    const testChar = {
      chaId: "char-select-index",
      type: "character",
      name: "Select Index",
      chatPage: 0,
      chats: [source, other],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    characterStore.select(0);

    const duplicated = await duplicateChat(0, 0, {
      selectNew: true,
      insertIndex: 1,
    });

    expect(duplicated).not.toBeNull();
    expect(characterStore.characters[0].chats[1].id).toBe(duplicated!.id);
    expect(characterStore.characters[0].chatPage).toBe(1);
  });
  it("clears transient runtime state on the duplicated chat", async () => {
    const source = makeChat("chat-runtime", [makeMessage("r1", "streaming")], {
      isStreaming: true,
      activeStreamingDisplayOptimizationMode: "balanced",
      preventMessageCompaction: true,
    });
    const testChar = {
      chaId: "char-runtime",
      type: "character",
      name: "Runtime",
      chatPage: 0,
      chats: [source],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateChat(0, 0);

    expect(duplicated?.isStreaming).toBe(false);
    expect(duplicated?.activeStreamingDisplayOptimizationMode).toBeUndefined();
    expect(duplicated?.preventMessageCompaction).toBeUndefined();
  });

  it("rejects a loader that claims completion after returning fewer messages than expected", async () => {
    const source = makeChat(
      "chat-short-load",
      [makeMessage("recent", "recent")],
      {
        messagesFullyLoaded: false,
        messageTotal: 3,
        detailsLoaded: true,
      },
    );
    const testChar = {
      chaId: "char-short-load",
      type: "character",
      name: "Short Load",
      chatPage: 0,
      chats: [source],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    preLoadChatMock.mockImplementation(async () => {
      const chat = characterStore.characters[0].chats[0];
      chat.messagesFullyLoaded = true;
      chat.messageTotal = chat.message.length;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const duplicated = await duplicateChat(0, 0);

    expect(duplicated).toBeNull();
    expect(characterStore.characters[0].chats).toHaveLength(1);
    expect(characterStore.characters[0].chats[0].id).toBe("chat-short-load");
    expect(mockStorage.commits).toEqual([]);
    consoleSpy.mockRestore();
  });

  it("maps a legacy duplicate message ID bookmark to the first duplicated message", async () => {
    const source = makeChat(
      "chat-legacy-id",
      [
        makeMessage("duplicate-id", "first"),
        makeMessage("duplicate-id", "second", "char"),
      ],
      {
        bookmarks: ["duplicate-id"],
        bookmarkNames: { "duplicate-id": "Legacy bookmark" },
      },
    );
    const testChar = {
      chaId: "char-legacy-id",
      type: "character",
      name: "Legacy",
      chatPage: 0,
      chats: [source],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const duplicated = await duplicateChat(0, 0);

    const firstId = duplicated!.message[0].chatId!;
    const secondId = duplicated!.message[1].chatId!;
    expect(firstId).not.toBe(secondId);
    expect(duplicated!.bookmarks).toEqual([firstId]);
    expect(duplicated!.bookmarkNames).toEqual({ [firstId]: "Legacy bookmark" });
  });

  it("re-finds the source chat after async reordering and inserts beside it", async () => {
    const source = makeChat("chat-source-race", [makeMessage("s1", "source")]);
    const other = makeChat("chat-other-race", [
      makeMessage("o1", "other", "char"),
    ]);
    const testChar = {
      chaId: "char-race",
      type: "character",
      name: "Race",
      chatPage: 0,
      chats: [source, other],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    preLoadChatMock.mockImplementation(async () => {
      const char = characterStore.characters[0];
      char.chats = [char.chats[1], char.chats[0]];
    });

    const duplicated = await duplicateChat(0, 0);

    expect(duplicated?.message[0].data).toBe("source");
    expect(characterStore.characters[0].chats.map((chat) => chat.id)).toEqual([
      "chat-other-race",
      "chat-source-race",
      duplicated?.id,
    ]);
  });
});

describe("messageStore unique ID handling in persistNewChats", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);
  });

  it("assigns unique IDs when incoming messages repeat the same ID", async () => {
    const testChar = {
      chaId: "char-colliding",
      type: "character",
      name: "Colliding",
      chatPage: 0,
      chats: [makeChat("chat-new", [])],
    } as unknown as character;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    const messages = [
      makeMessage("same-id", "first"),
      makeMessage("same-id", "second", "char"),
    ];

    await messageStore.persistNewChats("char-colliding", [
      { chatId: "chat-new", messages },
    ]);

    const commit = mockStorage.commits.find(
      (candidate) => candidate.action === "chat-create-messages",
    );
    expect(commit).toBeDefined();
    const ids = commit!.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(2);
    expect(commit!.messageManifests[0].ids).toEqual(ids);
  });

  it("marks chat and chat manifest dirty so flushing commits to SQL storage for inactive character", async () => {
    const sourceChat = makeChat("chat-inactive-1", [
      makeMessage("m1", "hello"),
    ]);
    const char1 = {
      chaId: "char-inactive-target",
      type: "character",
      name: "Target Char",
      chatPage: 0,
      chats: [sourceChat],
    } as unknown as character;
    const char2 = {
      chaId: "char-active",
      type: "character",
      name: "Active Char",
      chatPage: 0,
      chats: [makeChat("chat-active-1", [])],
    } as unknown as character;

    characterStore.init([char1, char2], mockStorage as unknown as ISqlStorage);
    // Active character is char2 (index 1), duplicating chat on char1 (index 0)
    characterStore.select(1);

    const duplicated = await duplicateChat(0, 0);
    expect(duplicated).not.toBeNull();

    await characterStore.flush();

    const chatCommit = mockStorage.commits.find(
      (candidate) =>
        candidate.chats.some((c) => c.id === duplicated!.id) ||
        candidate.chatManifests.some(
          (m) => m.characterId === "char-inactive-target",
        ),
    );
    expect(chatCommit).toBeDefined();
    expect(chatCommit!.chats.some((c) => c.id === duplicated!.id)).toBe(true);
    expect(
      chatCommit!.chatManifests.some(
        (m) =>
          m.characterId === "char-inactive-target" &&
          m.ids.includes(duplicated!.id!),
      ),
    ).toBe(true);
  });
});
