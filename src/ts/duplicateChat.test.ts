import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { messageStore } from "./stores/domain/messageStore.svelte";
import { createChatCopyName } from "./globalApi.svelte";
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

describe("createChatCopyName", () => {
  it("generates Copy name when no copies exist", () => {
    const existing = [{ name: "Main Story" }];
    expect(createChatCopyName("Main Story", "Copy", existing)).toBe("Main Story (Copy)");
  });

  it("increments copy index when (Copy) already exists", () => {
    const existing = [{ name: "Main Story" }, { name: "Main Story (Copy)" }];
    expect(createChatCopyName("Main Story", "Copy", existing)).toBe("Main Story (Copy 2)");
  });

  it("increments copy index when multiple numbered copies exist", () => {
    const existing = [
      { name: "Main Story" },
      { name: "Main Story (Copy)" },
      { name: "Main Story (Copy 2)" },
    ];
    expect(createChatCopyName("Main Story (Copy)", "Copy", existing)).toBe("Main Story (Copy 3)");
  });

  it("handles empty or whitespace originalName safely", () => {
    expect(createChatCopyName("", "Copy", [])).toBe("Chat (Copy)");
  });
});

describe("duplicateChat", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);
  });

  it("preloads chat, regenerates message IDs, and remaps bookmarks properly", async () => {
    const testChar: character = {
      chaId: "char-1",
      type: "character",
      name: "Hero",
      chatPage: 0,
      chats: [
        {
          id: "chat-original",
          name: "Episode 1",
          branch: "some-branch",
          branchState: {
            baseMessageIndex: 0,
            activeBranchId: "b-1",
            branches: [],
          },
          bookmarks: ["orig-msg-1", "orig-msg-2"],
          bookmarkNames: {
            "orig-msg-1": "First Encounter",
            "orig-msg-2": "Climax",
          },
          message: [
            { chatId: "orig-msg-1", role: "user", data: "Hello" },
            { chatId: "orig-msg-2", role: "char", data: "Greetings!" },
          ],
          messagesLoaded: false,
          messagesFullyLoaded: false,
        } as any,
      ],
    } as any;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    preLoadChatMock.mockImplementation(async (charIdx, chatIdx, opts) => {
      const char = characterStore.characters[charIdx];
      if (char?.chats?.[chatIdx]) {
        char.chats[chatIdx].messagesLoaded = true;
        char.chats[chatIdx].messagesFullyLoaded = true;
      }
    });

    const duplicated = await duplicateChat(0, 0, { selectNew: true });

    expect(preLoadChatMock).toHaveBeenCalledWith(0, 0, { full: true });
    expect(duplicated).not.toBeNull();
    expect(duplicated?.id).not.toBe("chat-original");
    expect(duplicated?.name).toBe("Episode 1 (Copy)");
    expect(duplicated?.branch).toBeUndefined();
    expect(duplicated?.branchState).toBeUndefined();
    expect(duplicated?.messagesLoaded).toBe(true);
    expect(duplicated?.messagesFullyLoaded).toBe(true);

    // Verify messages have new unique IDs
    expect(duplicated?.message).toHaveLength(2);
    const newMsg1Id = duplicated!.message[0].chatId!;
    const newMsg2Id = duplicated!.message[1].chatId!;
    expect(newMsg1Id).not.toBe("orig-msg-1");
    expect(newMsg2Id).not.toBe("orig-msg-2");
    expect(newMsg1Id).not.toBe(newMsg2Id);

    // Verify bookmarks and bookmarkNames were remapped to the new message IDs
    expect(duplicated?.bookmarks).toEqual([newMsg1Id, newMsg2Id]);
    expect(duplicated?.bookmarkNames).toEqual({
      [newMsg1Id]: "First Encounter",
      [newMsg2Id]: "Climax",
    });

    // Verify original chat remains unchanged in characterStore
    const charInStore = characterStore.characters[0];
    expect(charInStore.chats).toHaveLength(2);
    expect(charInStore.chats[1].id).toBe("chat-original");
    expect(charInStore.chats[1].bookmarks).toEqual(["orig-msg-1", "orig-msg-2"]);

    // Verify chat was unshifted to index 0 and selected
    expect(charInStore.chats[0].id).toBe(duplicated.id);
    expect(charInStore.chatPage).toBe(0);

    // Verify persistence commit occurred
    expect(mockStorage.commits.length).toBeGreaterThanOrEqual(1);
    const lastCommit = mockStorage.commits.at(-1);
    expect(lastCommit?.action).toBe("chat-create-messages");
    expect(lastCommit?.messages.map((m) => m.id)).toEqual([newMsg1Id, newMsg2Id]);
  });

  it("preserves active chatPage when duplicating without selectNew", async () => {
    const testChar: character = {
      chaId: "char-2",
      type: "character",
      name: "Hero 2",
      chatPage: 1,
      chats: [
        { id: "chat-0", name: "Chat 0", message: [] },
        { id: "chat-1", name: "Chat 1", message: [{ chatId: "m-1", role: "user", data: "A" }] },
      ],
    } as any;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    characterStore.characters[0].chatPage = 1;

    const duplicated = await duplicateChat(0, 0, { selectNew: false });

    expect(duplicated).not.toBeNull();
    const charInStore = characterStore.characters[0];
    expect(charInStore.chats).toHaveLength(3);
    expect(charInStore.chatPage).toBe(2);
    expect(charInStore.chats[2].id).toBe("chat-1");
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

  it("ensures unique message IDs when incoming messages have duplicate IDs", async () => {
    const testChar: character = {
      chaId: "char-colliding",
      type: "character",
      name: "CollidingChar",
      chatPage: 0,
      chats: [{ id: "chat-new", name: "New Chat", message: [] }],
    } as any;
    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);

    const collidingMessages: Message[] = [
      { chatId: "same-id", role: "user", data: "first" },
      { chatId: "same-id", role: "char", data: "second" },
    ];

    await messageStore.persistNewChats("char-colliding", [
      { chatId: "chat-new", messages: collidingMessages },
    ]);

    expect(mockStorage.commits.length).toBeGreaterThanOrEqual(1);
    const msgCommit = mockStorage.commits.find((c) => c.action === "chat-create-messages");
    expect(msgCommit).toBeDefined();

    const ids = msgCommit!.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    expect(msgCommit!.messageManifests[0].ids).toEqual(ids);
  });
});
