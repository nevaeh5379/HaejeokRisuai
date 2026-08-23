import { describe, expect, it } from "vitest";
import type { Database } from "../storage/database.svelte";
import { hydrateLazyDatabaseFromSnapshot } from "./backuplocal";

describe("hydrateLazyDatabaseFromSnapshot", () => {
  it("hydrates unloaded backup data without replacing loaded chat changes", () => {
    const unloadedChat = {
      id: "chat-unloaded",
      message: [],
      messagesLoaded: false,
      detailsLoaded: false,
    };
    const dirtyChat = {
      id: "chat-dirty",
      name: "Locally edited",
      message: [{ role: "user", data: "unsaved edit" }],
      messagesLoaded: true,
      detailsLoaded: true,
      messagesFullyLoaded: true,
    };
    const chats = [unloadedChat, dirtyChat];
    const db = {
      characters: [
        {
          chaId: "char-1",
          name: "Shallow character",
          detailsLoaded: false,
          chats,
        },
      ],
      personas: [{ name: "Current persona" }],
      pluginCustomStorage: {},
      isDomainLoaded: (domain: string) => domain === "personas",
    } as unknown as Database;
    const snapshot = {
      characters: [
        {
          chaId: "char-1",
          name: "Full character",
          description: "Loaded detail",
          chats: [
            {
              id: "chat-unloaded",
              name: "Full chat",
              message: [{ role: "char", data: "from SQL" }],
            },
            {
              id: "chat-dirty",
              name: "Stored name",
              message: [{ role: "char", data: "stale value" }],
            },
          ],
        },
      ],
      personas: [{ name: "Stored persona" }],
      pluginCustomStorage: { plugin: { enabled: true } },
    } as unknown as Database;

    hydrateLazyDatabaseFromSnapshot(db, snapshot);

    expect(db.characters[0].name).toBe("Full character");
    expect(db.characters[0].chats).toBe(chats);
    expect(unloadedChat).toMatchObject({
      name: "Full chat",
      messagesLoaded: true,
      detailsLoaded: true,
      messagesFullyLoaded: true,
      messageOffset: 0,
      messageTotal: 1,
    });
    expect(dirtyChat).toMatchObject({
      name: "Locally edited",
      message: [{ role: "user", data: "unsaved edit" }],
    });
    expect(db.personas).toEqual([{ name: "Current persona" }]);
    expect(db.pluginCustomStorage).toEqual({ plugin: { enabled: true } });
  });

  it("hydrates unloaded modules and personas when not present in db", () => {
    const db = {
      characters: [],
      pluginCustomStorage: {},
    } as unknown as Database;
    const snapshot = {
      personas: [{ name: "Restored persona" }],
      modules: [{ id: "mod-1", name: "Restored module" }],
      pluginCustomStorage: { myPlugin: { key: "value" } },
    } as unknown as Database;

    hydrateLazyDatabaseFromSnapshot(db, snapshot);

    expect((db as any).personas).toEqual([{ name: "Restored persona" }]);
    expect((db as any).modules).toEqual([
      { id: "mod-1", name: "Restored module" },
    ]);
    expect(db.pluginCustomStorage).toEqual({ myPlugin: { key: "value" } });
  });

  it("preserves existing pluginCustomStorage and initializes missing pluginCustomStorage during normalization", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database.svelte");
    const emptyDb = {} as Database;
    normalizeDatabaseDefaults(emptyDb);
    expect(emptyDb.pluginCustomStorage).toEqual({});

    const existingDb = {
      pluginCustomStorage: {
        pm_store: { version: 5 },
      },
    } as unknown as Database;
    normalizeDatabaseDefaults(existingDb);
    expect(existingDb.pluginCustomStorage).toEqual({
      pm_store: { version: 5 },
    });
  });
});
