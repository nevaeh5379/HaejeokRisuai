import { describe, expect, it } from "vitest";
import { applySqliteCommit } from "./sqliteCommit";
import {
  buildSqlReplaceCommit,
  createEmptySqlCommit,
  hasSqlCommitChanges,
} from "./sqlCommit";
import type { Database } from "./schema";

describe("SQL row commits", () => {
  it("keeps character, chat, and message rows separate during explicit import", () => {
    const database = {
      username: "Legacy User",
      userIcon: "legacy-user.png",
      userNote: "legacy note",
      personaPrompt: "legacy prompt",
      personas: [
        {
          name: "Canonical User",
          icon: "persona.png",
          note: "canonical note",
          personaPrompt: "canonical prompt",
          largePortrait: false,
        },
      ],
      selectedPersona: 0,
      characters: [
        {
          chaId: "character-1",
          type: "character",
          name: "Character",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              messagesLoaded: true,
              messageOffset: 0,
              messageTotal: 1,
              messagesFullyLoaded: true,
              branchState: {
                baseMessageIndex: 0,
                activeBranchId: "branch-root",
                branches: [{
                  id: "branch-root",
                  branchMessageIndex: 0,
                  reason: "root",
                  createdAt: 1,
                  messages: [{ chatId: "branch-message", role: "char", data: "saved branch" }],
                  scriptstate: { "$lb-xnai-stack": "root-state" },
                  GLGlobalVariables: { lightboard: "root" },
                  useLocallySetGlobalVariables: true,
                }],
              },
              message: [{ chatId: "message-1", role: "user", data: "hello" }],
            },
          ],
        },
      ],
    } as any;

    const commit = buildSqlReplaceCommit(database, 7);

    expect(commit.baseRevision).toBe(7);
    expect(commit.replaceAll).toBe(true);
    expect(commit.root.upserts).toEqual([
      { key: "personas", value: database.personas },
      { key: "selectedPersona", value: 0 },
      { key: "pluginCustomStorage", value: {} },
    ]);
    const rootKeys = commit.root.upserts.map(({ key }) => key);
    for (const key of ["username", "userIcon", "userNote", "personaPrompt"]) {
      expect(rootKeys).not.toContain(key);
    }
    expect(commit.characters).toHaveLength(1);
    expect(commit.characters[0].data).not.toHaveProperty("chats");
    expect(commit.chats).toHaveLength(1);
    expect(commit.chats[0].data).not.toHaveProperty("message");
    expect(commit.chats[0].data).toHaveProperty("branchState");
    expect((commit.chats[0].data as any).branchState.branches[0]).toMatchObject({
      scriptstate: { "$lb-xnai-stack": "root-state" },
      GLGlobalVariables: { lightboard: "root" },
      useLocallySetGlobalVariables: true,
    });
    expect(commit.chats[0].data).not.toHaveProperty("messageOffset");
    expect(commit.chats[0].data).not.toHaveProperty("messageTotal");
    expect(commit.chats[0].data).not.toHaveProperty("messagesFullyLoaded");
    expect(commit.messages).toEqual([
      {
        id: "message-1",
        chatId: "chat-1",
        position: 0,
        data: { role: "user", data: "hello" },
      },
    ]);
  });

  it("preserves legacy messages whose IDs collide during explicit import", () => {
    const database = {
      characters: [{
        chaId: "character-1",
        name: "Character",
        chats: [{
          id: "chat-1",
          name: "Chat",
          message: [
            { chatId: "duplicate-message", role: "user", data: "first" },
            { chatId: "duplicate-message", role: "char", data: "second" },
            { role: "user", data: "missing id" },
          ],
        }],
      }],
    } as unknown as Database;

    const commit = buildSqlReplaceCommit(database, 0);
    const ids = commit.messages.map((message) => message.id);

    expect(commit.messages.map((message) => message.data)).toEqual([
      { role: "user", data: "first" },
      { role: "char", data: "second" },
      { role: "user", data: "missing id" },
    ]);
    expect(ids[0]).toBe("duplicate-message");
    expect(new Set(ids).size).toBe(3);
    expect(commit.messageManifests[0].ids).toEqual(ids);
  });

  it("recognizes an empty commit without serializing a Database and tracks action", () => {
    const commit = createEmptySqlCommit(3, "message");
    expect(hasSqlCommitChanges(commit)).toBe(false);
    expect(commit.action).toBe("message");
  });

  it("executes only rows included in a bounded commit", async () => {
    const commit = createEmptySqlCommit(2);
    commit.root.upserts.push({ key: "temperature", value: 80 });
    commit.messages.push({
      id: "message-1",
      chatId: "chat-1",
      position: 4,
      data: { role: "char", data: "answer" },
    });
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements.some(({ sql }) => sql.includes("system_settings"))).toBe(
      true,
    );
    expect(
      statements.some(({ sql }) => sql.includes("setting_extension_nodes")),
    ).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("messages"))).toBe(true);
    expect(
      statements.some(({ sql }) => sql.includes("message_extension_nodes")),
    ).toBe(true);
    expect(
      statements.every(({ sql }) => !/\b(?:data|value)\b[^)]*JSON/i.test(sql)),
    ).toBe(true);
    expect(
      statements.every(({ sql }) => !sql.includes("DELETE FROM characters")),
    ).toBe(true);
  });

  it("syncs pluginCustomStorage upserts and deletions to plugin_custom_storage table", async () => {
    const commit = createEmptySqlCommit(1);
    commit.pluginStorage = {
      upserts: [{ key: "my-plugin", value: { setting1: "val1" } }],
      deletes: [],
    };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const pluginStorageStmt = statements.find((s) =>
      s.sql.includes("INSERT INTO plugin_custom_storage"),
    );
    expect(pluginStorageStmt).toBeDefined();
    expect(pluginStorageStmt?.bind[0]).toBe("my-plugin");
    expect(pluginStorageStmt?.bind[1]).toBe(
      JSON.stringify({ setting1: "val1" }),
    );
  });

  it("executes targeted plugin_custom_storage deletion when key is removed", async () => {
    const commit = createEmptySqlCommit(2);
    commit.pluginStorage = {
      upserts: [],
      deletes: ["plugin-a"],
    };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const deleteStmt = statements.find((s) =>
      s.sql.includes("DELETE FROM plugin_custom_storage WHERE key = ?"),
    );
    expect(deleteStmt).toBeDefined();
    expect(deleteStmt?.bind).toEqual(["plugin-a"]);
  });

  it("clears plugin_custom_storage table when clear is true", async () => {
    const commit = createEmptySqlCommit(3);
    commit.pluginStorage = {
      upserts: [],
      deletes: [],
      clear: true,
    };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const clearStmt = statements.find(
      (s) => s.sql === "DELETE FROM plugin_custom_storage",
    );
    expect(clearStmt).toBeDefined();
  });

  it("executes targeted message deletions with messageDeletes", async () => {
    const commit = createEmptySqlCommit(5, "message-delete");
    commit.messageDeletes = [
      {
        chatId: "chat-1",
        ids: ["msg-1", "msg-2"],
      },
    ];
    expect(hasSqlCommitChanges(commit)).toBe(true);

    const statements: { sql: string; bind: unknown[] }[] = [];
    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe(
      "DELETE FROM messages WHERE chat_id = ? AND id IN (?,?)",
    );
    expect(statements[0].bind).toEqual(["chat-1", "msg-1", "msg-2"]);
  });

  it("deletes only explicitly named characters", async () => {
    const commit = createEmptySqlCommit(5, "character-delete");
    commit.characterIds = ["character-kept"];
    commit.characterDeletes = ["character-removed"];
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toEqual([
      {
        sql: "DELETE FROM characters WHERE id = ?",
        bind: ["character-removed"],
      },
    ]);
    expect(
      statements.some(({ sql }) => sql.includes("NOT IN")),
    ).toBe(false);
  });

  it("treats chat and message manifests as non-destructive", async () => {
    const commit = createEmptySqlCommit(6, "entity-delete");
    commit.chatManifests = [{ characterId: "character-1", ids: [] }];
    commit.messageManifests = [{ chatId: "chat-1", ids: [] }];
    commit.chatDeletes = ["chat-removed"];
    commit.messageDeletes = [{ chatId: "chat-1", ids: ["message-removed"] }];
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toEqual([
      { sql: "DELETE FROM chats WHERE id = ?", bind: ["chat-removed"] },
      {
        sql: "DELETE FROM messages WHERE chat_id = ? AND id IN (?)",
        bind: ["chat-1", "message-removed"],
      },
    ]);
    expect(statements.some(({ sql }) => sql.includes("NOT IN"))).toBe(false);
  });

  it("ensures pluginCustomStorage is always included in buildSqlReplaceCommit root upserts", () => {
    const minimalDb = {
      apiType: "gemini-3-flash-preview",
      characters: [],
    } as unknown as Database;

    const commit = buildSqlReplaceCommit(minimalDb, 0);
    expect(commit.replaceAll).toBe(true);
    const pluginStorageUpsert = commit.root.upserts.find(
      (u) => u.key === "pluginCustomStorage",
    );
    expect(pluginStorageUpsert).toBeDefined();
    expect(pluginStorageUpsert?.value).toEqual({});
  });

  it("migrates the live module integration value into the active preset", () => {
    const database = {
      characters: [],
      moduleIntergration: "live-module, second-module",
      botPresetsId: 1,
      botPresets: [
        { name: "Other", moduleIntergration: "other-module" },
        { name: "Active" },
      ],
    } as unknown as Database;

    const commit = buildSqlReplaceCommit(database, 0);

    expect(commit.presets?.upserts[0].data.moduleIntergration).toBe(
      "other-module",
    );
    expect(commit.presets?.upserts[1].data.moduleIntergration).toBe(
      "live-module, second-module",
    );
    expect((database as any).botPresets[1]).not.toHaveProperty(
      "moduleIntergration",
    );
  });

  it.each([
    ["character details", { detailsLoaded: false, chats: [] }],
    [
      "chat messages",
      {
        chats: [
          {
            id: "chat-partial",
            message: [],
            messagesLoaded: false,
          },
        ],
      },
    ],
    [
      "paged chat history",
      {
        chats: [
          {
            id: "chat-paged",
            message: [{ chatId: "newest", role: "char", data: "tail" }],
            messagesLoaded: true,
            messagesFullyLoaded: false,
          },
        ],
      },
    ],
  ])("rejects replace-all from partially loaded %s", (_label, partial) => {
    const database = {
      characters: [
        {
          chaId: "character-partial",
          type: "character",
          name: "Partial",
          ...partial,
        },
      ],
    } as unknown as Database;

    expect(() => buildSqlReplaceCommit(database, 0)).toThrow(
      /partially loaded/,
    );
  });
});
