import { describe, expect, it } from "vitest";
import type { Database } from "../storage/database.svelte";
import {
  hydrateLazyDatabaseFromSnapshot,
  normalizeLocalBackupAssetPath,
} from "./backuplocal";

describe("normalizeLocalBackupAssetPath", () => {
  it("places Tauri backup file names under the assets directory", () => {
    expect(normalizeLocalBackupAssetPath("image.png")).toBe(
      "assets/image.png",
    );
  });

  it("normalizes browser backup keys and Windows separators", () => {
    expect(normalizeLocalBackupAssetPath("assets/image.png")).toBe(
      "assets/image.png",
    );
    expect(normalizeLocalBackupAssetPath("assets\\nested\\image.png")).toBe(
      "assets/nested/image.png",
    );
  });

  it.each(["", "../image.png", "assets/../image.png", "/image.png"])(
    "rejects unsafe backup asset path %j",
    (name) => {
      expect(() => normalizeLocalBackupAssetPath(name)).toThrow(
        "Invalid backup asset path",
      );
    },
  );
});

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

  it("replaces partially hydrated chats even when legacy loading flags are missing", () => {
    const partialChat = {
      id: "chat-partial",
      name: "Partial",
      message: [{ role: "char", data: "recent only" }],
    };
    const db = {
      characters: [{ chaId: "char-1", chats: [partialChat] }],
      pluginCustomStorage: {},
    } as unknown as Database;
    const snapshot = {
      characters: [{
        chaId: "char-1",
        chats: [{
          id: "chat-partial",
          name: "Full",
          message: [
            { role: "user", data: "old 1" },
            { role: "char", data: "old 2" },
            { role: "char", data: "recent only" },
          ],
        }],
      }],
    } as unknown as Database;

    hydrateLazyDatabaseFromSnapshot(db, snapshot);

    expect(partialChat.message.map((message) => message.data)).toEqual([
      "old 1",
      "old 2",
      "recent only",
    ]);
    expect(partialChat).toMatchObject({
      messagesLoaded: true,
      detailsLoaded: true,
      messagesFullyLoaded: true,
      messageOffset: 0,
      messageTotal: 3,
    });
  });

  it("restores chats and characters that only exist in the full SQL snapshot", () => {
    const loadedChat = {
      id: "chat-loaded",
      name: "Local",
      message: [{ role: "user", data: "local edit" }],
      messagesLoaded: true,
      detailsLoaded: true,
      messagesFullyLoaded: true,
    };
    const db = {
      characters: [{
        chaId: "char-existing",
        chats: [loadedChat],
      }],
      pluginCustomStorage: {},
    } as unknown as Database;
    const snapshot = {
      characters: [
        {
          chaId: "char-existing",
          chats: [
            {
              id: "chat-missing",
              name: "Recovered chat",
              message: [{ role: "char", data: "from SQL" }],
            },
            {
              id: "chat-loaded",
              name: "Stored",
              message: [{ role: "char", data: "stale" }],
            },
          ],
        },
        {
          chaId: "char-missing",
          name: "Recovered character",
          chats: [],
        },
      ],
    } as unknown as Database;

    hydrateLazyDatabaseFromSnapshot(db, snapshot);

    expect(db.characters.map((character) => character.chaId)).toEqual([
      "char-existing",
      "char-missing",
    ]);
    expect(db.characters[0].chats.map((chat) => chat.id)).toEqual([
      "chat-missing",
      "chat-loaded",
    ]);
    expect(db.characters[0].chats[1]).toBe(loadedChat);
    expect(loadedChat.message).toEqual([{ role: "user", data: "local edit" }]);
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

  it("initializes moduleFolders as an empty array during normalization", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database.svelte");
    const emptyDb = {} as Database;
    normalizeDatabaseDefaults(emptyDb);
    expect(emptyDb.moduleFolders).toEqual([]);
  });

  it("preserves existing moduleFolders during normalization", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database.svelte");
    const existingDb = {
      moduleFolders: [{ id: "f1", name: "Folder 1", color: "" }],
    } as unknown as Database;
    normalizeDatabaseDefaults(existingDb);
    expect(existingDb.moduleFolders).toEqual([
      { id: "f1", name: "Folder 1", color: "" },
    ]);
  });
});
