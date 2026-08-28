import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore, messageStore } from "./stores/domain";
import { duplicateChat } from "./characters";
import type { character, Chat, Message } from "./storage/schema";
import type { ISqlStorage } from "./storage/ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./storage/sqlCommit";
import { setSqlStorageForTesting } from "./storage/sqlStorageFactory";

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
  async loadDatabase(): Promise<any> {
    return {};
  }
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

function makeMessage(chatId: string, data: string, role: Message["role"] = "user"): Message {
  return { chatId, role, data };
}

function makeChat(id: string, messages: Message[], extra: Partial<Chat> = {}): Chat {
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

describe("duplicateChat", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(duplicated!.message.map((m) => m.data)).toEqual(["hello", "hi there"]);
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
      lazyChat.message = [makeMessage("lazy-m1", "restored")];
      lazyChat.messagesLoaded = true;
      lazyChat.messagesFullyLoaded = true;
      lazyChat.detailsLoaded = true;
    });

    const duplicated = await duplicateChat(0, 0);

    expect(preLoadChatMock).toHaveBeenCalledWith(0, 0, { full: true });
    expect(duplicated!.message.map((m) => m.data)).toEqual(["restored"]);
  });

  it("remaps bookmarks and bookmarkNames to the duplicated message IDs", async () => {
    const sourceChat = makeChat("chat-bm", [
      makeMessage("m1", "bookmarked"),
      makeMessage("m2", "plain", "char"),
    ], {
      bookmarks: ["m1", "m2"],
      bookmarkNames: { m1: "User| hello", m2: "Char| hi" },
    });
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
});