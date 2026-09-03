import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterStore, messageStore } from "./stores/domain";
import { importChat } from "./characters";
import type { character, Chat } from "./storage/database/schema";
import type { ISqlStorage } from "./storage/sql/ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./storage/sql/sqlCommit";
import { setSqlStorageForTesting } from "./storage/sql/sqlStorageFactory";
import { selectedCharID } from "./stores.svelte";
import * as util from "./util";

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

describe("importChat HTML support", () => {
  let mockStorage: MockSqlStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    messageStore.resetPersistenceForTesting();
    mockStorage = new MockSqlStorage();
    setSqlStorageForTesting(mockStorage as unknown as ISqlStorage);

    const testChar = {
      chaId: "char-import-test",
      type: "character",
      name: "Test Character",
      chatPage: 0,
      chats: [
        {
          id: "chat-existing",
          name: "Chat 1",
          note: "",
          localLore: [],
          message: [],
        },
      ],
      chatFolders: [],
    } as unknown as character;

    characterStore.init([testChar], mockStorage as unknown as ISqlStorage);
    selectedCharID.set(0);
  });

  it("imports HTML export, assigns fresh chat ID, sets default fmIndex, and persists messages", async () => {
    const exportedChatData: Chat = {
      id: "old-chat-id",
      name: "Exported Story",
      note: "",
      localLore: [],
      message: [
        { chatId: "m1", role: "user", data: "Hello" },
        { chatId: "m2", role: "char", data: "Greetings!" },
      ],
    };

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="container"><h1>Test</h1></div>
          <div class="idat">${JSON.stringify(exportedChatData)}</div>
        </body>
      </html>
    `;

    vi.spyOn(util, "selectSingleFile").mockResolvedValue({
      name: "chat_export.html",
      data: new TextEncoder().encode(htmlContent),
    });

    await importChat();

    expect(characterStore.characters[0].chats.length).toBe(2);
    const importedChat = characterStore.characters[0].chats[0];

    expect(importedChat.name).toBe("Exported Story");
    expect(importedChat.id).not.toBe("old-chat-id");
    expect(importedChat.id).toBeDefined();
    expect(importedChat.fmIndex).toBe(-1);
    expect(importedChat.message.length).toBe(2);
    expect(characterStore.characters[0].chatPage).toBe(0);

    // Verify messages were persisted to SQL storage
    expect(
      mockStorage.commits.some((c) => c.action === "chat-create-messages"),
    ).toBe(true);
  });

  it("handles HTML file with missing .idat gracefully without throwing", async () => {
    const invalidHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div>Not a RisuAI export</div>
        </body>
      </html>
    `;

    vi.spyOn(util, "selectSingleFile").mockResolvedValue({
      name: "invalid.html",
      data: new TextEncoder().encode(invalidHtml),
    });

    await expect(importChat()).resolves.not.toThrow();
    expect(characterStore.characters[0].chats.length).toBe(1);
  });
});
