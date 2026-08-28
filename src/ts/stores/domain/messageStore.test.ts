import { vi } from "vitest";
import { describe, expect, it, beforeEach } from "vitest";
import {
  cancelInactiveChatMessageRelease,
  messageStore,
  releaseInactiveChatMessages,
} from "./messageStore.svelte";
import { characterStore } from "./characterStore.svelte";
import { setSqlStorageForTesting } from "../../storage/sqlStorageFactory";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "../../storage/sqlCommit";
import type { character, Message } from "../../storage/schema";

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

describe("messageStore", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);

    const testChar: character = {
      chaId: "char-1",
      type: "character",
      name: "TestChar",
      chatPage: 0,
      chats: [
        {
          id: "chat-1",
          name: "Chat 1",
          message: [
            { chatId: "msg-1", role: "user", data: "hello" },
            { chatId: "msg-2", role: "char", data: "hi there" },
            { chatId: "msg-3", role: "user", data: "how are you?" },
          ],
          messagesFullyLoaded: true,
          messageTotal: 3,
        },
      ],
    } as any;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
  });

  it("defers inactive chat eviction until after character selection can paint", async () => {
    vi.useFakeTimers();
    try {
      const character = characterStore.characters[0];
      character.chats.push({
        id: "chat-2",
        name: "Chat 2",
        message: [{ chatId: "msg-old", role: "char", data: "old" }],
        messagesLoaded: true,
        messagesFullyLoaded: true,
      } as any);

      releaseInactiveChatMessages("chat-1");

      expect(character.chats[1].message).toHaveLength(1);
      await vi.runAllTimersAsync();
      expect(character.chats[1].message).toEqual([]);
      expect(character.chats[1].messagesLoaded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stale idle eviction before the next character starts loading", async () => {
    vi.useFakeTimers();
    try {
      const character = characterStore.characters[0];
      character.chats.push({
        id: "chat-2",
        name: "Chat 2",
        message: [{ chatId: "msg-old", role: "char", data: "old" }],
        messagesLoaded: true,
        messagesFullyLoaded: true,
      } as any);

      releaseInactiveChatMessages("chat-1");
      cancelInactiveChatMessageRelease();

      await vi.runAllTimersAsync();
      expect(character.chats[1].message).toHaveLength(1);
      expect(character.chats[1].messagesLoaded).not.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a single message selectively and commits messageDeletes", async () => {
    await messageStore.deleteMessage("chat-1", "msg-2");

    const chat = characterStore.characters[0].chats[0];
    expect(chat.message).toHaveLength(2);
    expect(chat.message.map((m) => m.chatId)).toEqual(["msg-1", "msg-3"]);
    expect(chat.messageTotal).toBe(2);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.action).toBe("message-delete");
    expect(commit.messageDeletes).toEqual([
      {
        chatId: "chat-1",
        ids: ["msg-2"],
      },
    ]);
    expect(commit.messages).toHaveLength(0);
  });

  it("deletes multiple messages selectively with deleteMessages", async () => {
    await messageStore.deleteMessages("chat-1", ["msg-1", "msg-3"]);

    const chat = characterStore.characters[0].chats[0];
    expect(chat.message).toHaveLength(1);
    expect(chat.message[0].chatId).toBe("msg-2");
    expect(chat.messageTotal).toBe(1);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.action).toBe("message-delete");
    expect(commit.messageDeletes).toEqual([
      {
        chatId: "chat-1",
        ids: ["msg-1", "msg-3"],
      },
    ]);
  });

  it("updates a message and commits to SQL", async () => {
    const updatedMsg = {
      chatId: "msg-2",
      role: "char" as const,
      data: "edited content",
    };
    await messageStore.updateMessage("chat-1", updatedMsg);

    const chat = characterStore.characters[0].chats[0];
    expect(chat.message[1].data).toBe("edited content");

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.action).toBe("message");
    expect(commit.messages).toHaveLength(1);
    expect(commit.messages[0]).toEqual({
      id: "msg-2",
      chatId: "chat-1",
      position: 1,
      data: { role: "char", data: "edited content" },
    });
  });

  it("commits newly appended messages to SQL without messageManifests", async () => {
    const newMsg = {
      chatId: "msg-4",
      role: "char" as const,
      data: "brand new message",
    };
    await messageStore.appendMessage("chat-1", newMsg);

    const chat = characterStore.characters[0].chats[0];
    expect(chat.message).toHaveLength(4);
    expect(chat.message[3].chatId).toBe("msg-4");

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.messages).toHaveLength(1);
    expect(commit.messages[0].id).toBe("msg-4");
    expect(commit.messageManifests).toEqual([]);
  });

  it("persists an already appended user message without duplicating it", async () => {
    const chat = characterStore.characters[0].chats[0];
    const translatedUserMessage: Message = {
      role: "user",
      data: "translated input",
    };
    chat.message.push(translatedUserMessage);

    await messageStore.appendMessage("chat-1", translatedUserMessage);

    expect(chat.message).toHaveLength(4);
    expect(translatedUserMessage.chatId).toBeTruthy();
    expect(mockStorage.commits).toHaveLength(1);
    expect(mockStorage.commits[0].messages).toHaveLength(1);
    expect(mockStorage.commits[0].messages[0]).toMatchObject({
      id: translatedUserMessage.chatId,
      chatId: "chat-1",
      position: 3,
      data: { role: "user", data: "translated input" },
    });
  });

  it("replaces the active branch path and deletes messages from the previous path", async () => {
    const chat = characterStore.characters[0].chats[0];
    const previous = chat.message.map((message) => ({ ...message }));
    const next = [
      previous[0],
      { chatId: "branch-msg", role: "char" as const, data: "branch answer" },
    ];

    await messageStore.replaceMessages("chat-1", next, previous);

    expect(chat.message.map((message) => message.chatId)).toEqual(["msg-1", "branch-msg"]);
    expect(chat.messageTotal).toBe(2);
    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.action).toBe("message-branch-switch");
    expect(commit.messageManifests).toEqual([{ chatId: "chat-1", ids: ["msg-1", "branch-msg"] }]);
    expect(commit.messageDeletes).toEqual([{ chatId: "chat-1", ids: ["msg-2", "msg-3"] }]);
    expect(commit.messages.map((message) => message.position)).toEqual([0, 1]);
  });

  it("omits messageManifests in commitMessages when messages are partially loaded", async () => {
    const chat = characterStore.characters[0].chats[0];
    chat.messagesFullyLoaded = false;
    chat.messageOffset = 10;

    const newMsg = {
      chatId: "msg-5",
      role: "char" as const,
      data: "partial load commit",
    };
    chat.message.push(newMsg);
    await messageStore.commitMessages("chat-1", [newMsg]);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.messages).toHaveLength(1);
    expect(commit.messages[0].position).toBe(13); // offset (10) + index (3)
    expect(commit.messageManifests).toEqual([]);
  });

  it("omits messageManifests for a partial update of a fully loaded chat", async () => {
    const chat = characterStore.characters[0].chats[0];
    chat.messagesFullyLoaded = true;

    const newMsg = {
      chatId: "msg-5",
      role: "char" as const,
      data: "fully loaded partial commit",
    };
    chat.message.push(newMsg);
    await messageStore.commitMessages("chat-1", [newMsg]);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.messages).toHaveLength(1);
    expect(commit.messageManifests).toEqual([]);
  });

  it("includes messageManifests only for a complete fully loaded snapshot", async () => {
    const chat = characterStore.characters[0].chats[0];
    chat.messagesFullyLoaded = true;

    await messageStore.commitMessages("chat-1", chat.message);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.messages).toHaveLength(chat.message.length);
    expect(commit.messageManifests).toHaveLength(1);
    expect(commit.messageManifests[0]).toEqual({
      chatId: "chat-1",
      ids: chat.message.map((message) => message.chatId),
    });
    expect(commit.messageDeletes).toEqual([]);
  });

  it("persists an empty fully-loaded message list", async () => {
    const chat = characterStore.characters[0].chats[0];
    chat.messagesFullyLoaded = true;
    chat.message = [];

    await messageStore.commitMessages("chat-1", [], ["msg-1", "msg-2"]);

    expect(mockStorage.commits).toHaveLength(1);
    const commit = mockStorage.commits[0];
    expect(commit.messages).toEqual([]);
    expect(commit.messageManifests).toEqual([{ chatId: "chat-1", ids: [] }]);
    expect(commit.messageDeletes).toEqual([
      { chatId: "chat-1", ids: ["msg-1", "msg-2"] },
    ]);
  });

  it("persists a new chat row before committing its messages", async () => {
    const character = characterStore.characters[0];
    const newChat = {
      id: "chat-copy",
      name: "Chat 1 (Copy)",
      note: "",
      localLore: [],
      message: [
        { chatId: "copy-msg-1", role: "user", data: "hello" },
        { chatId: "copy-msg-2", role: "char", data: "hi there" },
      ],
      messagesFullyLoaded: true,
    } as any;
    character.chats.unshift(newChat);

    await messageStore.persistNewChat(
      character.chaId,
      newChat.id,
      newChat.message,
    );

    expect(mockStorage.commits).toHaveLength(2);
    expect(mockStorage.commits[0].chats).toEqual([
      expect.objectContaining({
        id: "chat-copy",
        characterId: "char-1",
        position: 0,
      }),
    ]);
    expect(mockStorage.commits[0].chatManifests).toEqual([
      { characterId: "char-1", ids: ["chat-copy", "chat-1"] },
    ]);

    expect(mockStorage.commits[1].action).toBe("chat-create-messages");
    expect(
      mockStorage.commits[1].messages.map(({ chatId, position }) => ({
        chatId,
        position,
      })),
    ).toEqual([
      { chatId: "chat-copy", position: 0 },
      { chatId: "chat-copy", position: 1 },
    ]);
    expect(mockStorage.commits[1].messageManifests).toEqual([
      { chatId: "chat-copy", ids: ["copy-msg-1", "copy-msg-2"] },
    ]);
  });

  it("assigns unique message IDs when persisting a chat with duplicated IDs", async () => {
    const character = characterStore.characters[0];
    const duplicatedChat = {
      id: "chat-clone",
      name: "Chat 1 (Copy)",
      note: "",
      localLore: [],
      message: [
        { chatId: "duplicate-message", role: "user", data: "first" },
        { chatId: "duplicate-message", role: "char", data: "second" },
        { role: "user", data: "missing id" },
      ],
      messagesFullyLoaded: true,
    } as any;
    character.chats.unshift(duplicatedChat);

    await messageStore.persistNewChat(
      character.chaId,
      duplicatedChat.id,
      duplicatedChat.message,
    );

    const commit = mockStorage.commits.at(-1)!;
    const ids = commit.messages.map((message) => message.id);
    expect(commit.messages.map((message) => message.data)).toEqual([
      { role: "user", data: "first" },
      { role: "char", data: "second" },
      { role: "user", data: "missing id" },
    ]);
    expect(ids[0]).toBe("duplicate-message");
    expect(new Set(ids).size).toBe(3);
    expect(duplicatedChat.message.map((m: Message) => m.chatId)).toEqual(ids);
    expect(commit.messageManifests).toEqual([
      { chatId: "chat-clone", ids },
    ]);
  });

  it("retains a message commit after a transient storage failure", async () => {
    const originalCommit = mockStorage.commit.bind(mockStorage);
    vi.spyOn(mockStorage, "commit")
      .mockRejectedValueOnce(new Error("database locked"))
      .mockImplementation(originalCommit);
    const message = {
      chatId: "msg-retry",
      role: "char" as const,
      data: "must survive",
    };

    await messageStore.appendMessage("chat-1", message);
    expect(mockStorage.commits).toHaveLength(0);
    expect(messageStore.hasPendingWrites()).toBe(true);
    await messageStore.flush();

    expect(mockStorage.commits).toHaveLength(1);
    expect(mockStorage.commits[0].messages[0]).toMatchObject({
      id: "msg-retry",
      data: { role: "char", data: "must survive" },
    });
    expect(messageStore.hasPendingWrites()).toBe(false);
  });
});
