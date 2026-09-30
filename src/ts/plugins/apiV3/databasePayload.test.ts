import { describe, expect, it, vi } from "vitest";
import {
  snapshotDatabaseCharacters,
  restoreDatabaseChatHistory,
  snapshotPluginDatabase,
} from "./databasePayload.svelte";
import type { character } from "../../storage/database/schema";

describe("Plugin v3 database character payload", () => {
  it("preserves the legacy payload for default, all, and characters-only reads", async () => {
    const database = {
      characters: [
        {
          chaId: "char",
          chats: [
            {
              id: "chat",
              message: [{ data: "history" }],
              btwSessions: [{ messages: [{ data: "side" }] }],
              branchState: { timelines: [{ messages: [{ data: "branch" }] }] },
            },
          ],
        },
      ],
      theme: "light",
    };
    const loadPlugins = vi.fn(async () => []);
    const keys = ["characters", "theme", "plugins"];
    for (const includeOnly of [undefined, "all", ["characters"]] as const) {
      const result = await snapshotPluginDatabase(
        database,
        keys,
        loadPlugins,
        includeOnly as string[] | "all" | undefined,
      );
      expect(result.characters).toEqual(database.characters);
      expect(result.characters).not.toBe(database.characters);
      expect(result.characters[0].chats[0].message).not.toBe(
        database.characters[0].chats[0].message,
      );
    }
  });

  it("skips unrequested characters and plugin loading", async () => {
    const database = {
      theme: "light",
      get characters() {
        throw new Error("Unrequested characters accessed");
      },
    };
    const loadPlugins = vi.fn(async () => []);
    expect(
      await snapshotPluginDatabase(
        database,
        ["characters", "theme", "plugins"],
        loadPlugins,
        ["theme"],
      ),
    ).toEqual({ theme: "light" });
    expect(loadPlugins).not.toHaveBeenCalled();
  });

  it("omits history only for the explicit metadata path", async () => {
    const database = {
      characters: [
        {
          chaId: "char",
          chats: [
            {
              id: "chat",
              message: [{ data: "history" }],
              btwSessions: [],
              branchState: {},
            },
          ],
        },
      ],
    };
    const result = await snapshotPluginDatabase(
      database,
      ["characters"],
      async () => [],
      "all",
      true,
    );
    expect(result.characters[0].chats[0]).toEqual({ id: "chat" });
    expect(database.characters[0].chats[0].message).toEqual([
      { data: "history" },
    ]);
  });
  it("never reads message-bearing fields while snapshotting metadata", () => {
    const chat = {
      id: "chat",
      name: "Chat",
      note: "Note",
      localLore: [{ key: "lore" }],
      get message() {
        throw new Error("History must not be traversed");
      },
      get btwSessions() {
        throw new Error("Side conversations must not be traversed");
      },
      get branchState() {
        throw new Error("Legacy branches must not be traversed");
      },
    };
    const characters = [
      { chaId: "character", name: "Character", chats: [chat] },
    ] as unknown as character[];
    const result = snapshotDatabaseCharacters(characters);
    expect(result[0].chats[0]).toEqual({
      id: "chat",
      name: "Chat",
      note: "Note",
      localLore: [{ key: "lore" }],
    });
    result[0].chats[0].localLore[0].key = "changed";
    expect(chat.localLore[0].key).toBe("lore");
    expect(structuredClone(result)).toEqual(result);
  });

  it("preserves live history and pagination when metadata is saved after reordering", () => {
    const current = [
      {
        chaId: "character",
        chats: [
          {
            id: "first",
            message: [{ data: "original" }],
            messagesLoaded: true,
            messagesFullyLoaded: false,
            messageOffset: 12,
            messageTotal: 13,
            btwSessions: [{ id: "side", messages: [{ data: "side history" }] }],
          },
          { id: "second", message: [] },
        ],
      },
    ] as unknown as character[];
    const payload = { characters: snapshotDatabaseCharacters(current) };
    payload.characters[0].chats.reverse();
    payload.characters[0].chats[1].name = "Edited";
    current[0].chats[0].message.push({ data: "new message" } as any);
    const restored = restoreDatabaseChatHistory(payload, current);
    expect(restored.characters[0].chats[1]).toMatchObject({
      name: "Edited",
      messageOffset: 12,
      messageTotal: 13,
    });
    expect(restored.characters[0].chats[1].message).toBe(
      current[0].chats[0].message,
    );
    expect(restored.characters[0].chats[1].btwSessions).toBe(
      current[0].chats[0].btwSessions,
    );
    expect(payload.characters[0].chats[1]).not.toHaveProperty("message");
  });

  it("allows explicit history replacement and rejects unmatched metadata", () => {
    const payload = {
      characters: [{ chaId: "new", chats: [{ id: "new-chat", message: [] }] }],
    };
    expect(restoreDatabaseChatHistory(payload, []).characters).toEqual(
      payload.characters,
    );
    expect(() =>
      restoreDatabaseChatHistory(
        { characters: [{ chaId: "new", chats: [{ id: "missing" }] }] },
        [],
      ),
    ).toThrow("existing chat ID");
    expect(restoreDatabaseChatHistory({ theme: "light" }, [])).toEqual({
      theme: "light",
    });
  });
});
