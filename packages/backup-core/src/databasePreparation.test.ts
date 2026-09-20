import { describe, expect, it } from "vitest";
import {
  buildPortableLocalBackupDatabase,
  normalizePortableBackupSnapshot,
} from "./databasePreparation";

const HEADER = "\uEF01COLDSTORAGE\uEF01";

describe("buildPortableLocalBackupDatabase (native mode)", () => {
  it("filters account and function values with a shallow top-level copy", () => {
    const characters = [{ name: "Alice" }];
    const source = {
      account: { token: "secret" },
      onEvent: () => undefined,
      characters,
      username: "User",
    };
    const result = buildPortableLocalBackupDatabase(source, "native");

    expect(result.account).toBeUndefined();
    expect(result.onEvent).toBeUndefined();
    expect(result.username).toBe("User");
    // Shallow copy: nested values are shared by reference, not copied.
    expect(result.characters).toBe(characters);
  });

  it("keeps moduleFolders in native mode", () => {
    const source = { moduleFolders: [{ id: "f1" }] };
    expect(
      buildPortableLocalBackupDatabase(source, "native").moduleFolders,
    ).toEqual([{ id: "f1" }]);
  });

  it("defaults missing pluginCustomStorage without mutating the source", () => {
    const source: Record<string, any> = { username: "User" };
    const result = buildPortableLocalBackupDatabase(source, "native");
    expect(result.pluginCustomStorage).toEqual({});
    expect(source.pluginCustomStorage).toBeUndefined();
  });

  it("preserves an existing pluginCustomStorage object", () => {
    const pluginCustomStorage = { store: { version: 1 } };
    const result = buildPortableLocalBackupDatabase(
      { pluginCustomStorage },
      "native",
    );
    expect(result.pluginCustomStorage).toBe(pluginCustomStorage);
  });
});

describe("buildPortableLocalBackupDatabase (compatible mode)", () => {
  it("omits moduleFolders and strips legacy character asset folders", () => {
    const source = {
      moduleFolders: [{ id: "f1" }],
      characters: [
        {
          name: "Alice",
          chats: [{ message: [{ data: "hello" }] }],
          additionalAssetFolders: [{ id: "f" }],
          additionalAssetFolderAssignments: { a: "f" },
        },
      ],
    };
    const result = buildPortableLocalBackupDatabase(source, "compatible");

    expect(result.moduleFolders).toBeUndefined();
    expect(result.characters[0].additionalAssetFolders).toBeUndefined();
    expect(
      result.characters[0].additionalAssetFolderAssignments,
    ).toBeUndefined();
  });

  it("does not mutate the source database", () => {
    const source: Record<string, any> = {
      moduleFolders: [{ id: "f1" }],
      characters: [
        {
          name: "Alice",
          chats: [{ message: [{ data: "hello" }] }],
          additionalAssetFolders: [{ id: "f" }],
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(source));
    buildPortableLocalBackupDatabase(source, "compatible");
    expect(source).toEqual(snapshot);
  });

  it("materializes cold storage chats from provided values", () => {
    const source = {
      characters: [
        {
          chaId: "c1",
          name: "Alice",
          coldstorage: "cold-1",
          chats: [{ message: [{ data: `${HEADER}cold-1` }] }],
        },
      ],
    };
    const result = buildPortableLocalBackupDatabase(
      source,
      "compatible",
      new Map([
        ["cold-1", { message: [{ data: "restored message" }] }] as const,
      ]),
    );

    expect(result.characters[0].chats[0].message).toEqual([
      { data: "restored message" },
    ]);
    // The whole character was not restored, so the cold pointer is kept.
    expect(result.characters[0].coldstorage).toBe("cold-1");
  });

  it("restores the whole character when the cold storage value embeds one", () => {
    const source = {
      characters: [
        {
          chaId: "c1",
          name: "Stale Name",
          coldstorage: "cold-1",
          chats: [{ message: [{ data: `${HEADER}cold-1` }] }],
        },
      ],
    };
    const result = buildPortableLocalBackupDatabase(
      source,
      "compatible",
      new Map([
        [
          "cold-1",
          {
            character: {
              chaId: "c1",
              name: "Alice",
              chats: [{ message: [{ data: "full" }] }],
            },
          } as const,
        ],
      ]),
    );

    expect(result.characters[0].name).toBe("Alice");
    expect(result.characters[0].chats).toEqual([
      { message: [{ data: "full" }] },
    ]);
    expect(result.characters[0].coldstorage).toBeUndefined();
  });

  it("expands native branch graphs into standalone legacy chats", () => {
    const source = {
      characters: [
        {
          chaId: "c1",
          name: "Alice",
          chatPage: 0,
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: [{ chatId: "m1", data: "m1" }],
            },
          ],
        },
      ],
      haejeokBranchGraphs: {
        "chat-1": {
          branches: [
            {
              id: "b1",
              chatId: "chat-1",
              reason: "root",
              createdAt: 1,
              headMessageId: "m1",
            },
            {
              id: "b2",
              chatId: "chat-1",
              reason: "manual",
              createdAt: 2,
              headMessageId: "m2",
            },
          ],
          messages: [
            { chatId: "m1", data: "m1" },
            { chatId: "m2", data: "m2" },
          ],
          links: [],
          activeBranchId: "b1",
        },
      },
    };
    const result = buildPortableLocalBackupDatabase(source, "compatible");

    expect(result.haejeokBranchGraphs).toBeUndefined();
    expect(result.characters[0].chats.map((chat: any) => chat.name)).toEqual([
      "Chat",
      "Chat (Branch 1)",
    ]);
    expect(result.characters[0].chats[0].message).toEqual([
      { chatId: expect.any(String), data: "m1" },
    ]);
    expect(result.characters[0].chats[1].message).toEqual([
      { chatId: expect.any(String), data: "m2" },
    ]);
  });

  it("keeps unbranched chats as stripped single chats", () => {
    const source = {
      characters: [
        {
          name: "Alice",
          chats: [
            {
              id: "chat-1",
              branch: "b1",
              branchState: { activeBranchId: "b1" },
              message: [{ data: "hello" }],
            },
          ],
        },
      ],
    };
    const result = buildPortableLocalBackupDatabase(source, "compatible");
    const chat = result.characters[0].chats[0];
    expect(chat.message).toEqual([{ data: "hello" }]);
    expect(chat.branch).toBeUndefined();
    expect(chat.branchState).toBeUndefined();
  });
});

describe("normalizePortableBackupSnapshot", () => {
  it("defaults pluginCustomStorage and returns the same mutated object", () => {
    const db: Record<string, any> = { username: "U", personas: [] };
    const result = normalizePortableBackupSnapshot(db);
    expect(result).toBe(db);
    expect(db.pluginCustomStorage).toEqual({});
  });

  it("builds a fallback persona from legacy mirror fields", () => {
    const db: Record<string, any> = {
      username: "Legacy",
      userIcon: "assets/u.png",
      personaPrompt: "prompt",
      userNote: "note",
      selectedPersona: 0,
    };
    normalizePortableBackupSnapshot(db);

    expect(db.personas).toEqual([
      {
        name: "Legacy",
        icon: "assets/u.png",
        personaPrompt: "prompt",
        note: "note",
        largePortrait: false,
      },
    ]);
    expect(db.username).toBe("Legacy");
    expect(db.userIcon).toBe("assets/u.png");
    expect(db.userNote).toBe("note");
    expect(db.personaPrompt).toBe("prompt");
  });

  it('falls back to the "User" name when no legacy mirrors exist', () => {
    const db: Record<string, any> = {};
    normalizePortableBackupSnapshot(db);
    expect(db.personas).toEqual([
      {
        name: "User",
        icon: "",
        personaPrompt: "",
        note: "",
        largePortrait: false,
      },
    ]);
    expect(db.selectedPersona).toBe(0);
  });

  it("applies largePortrait defaults without dropping null-ish entries", () => {
    const persona: Record<string, any> = {
      name: "P1",
      icon: "",
      personaPrompt: "",
    };
    const db: Record<string, any> = {
      personas: [persona, null],
      selectedPersona: 0,
    };
    normalizePortableBackupSnapshot(db);
    expect(persona.largePortrait).toBe(false);
    expect(db.personas).toEqual([persona, null]);
  });

  it("preserves an existing largePortrait value", () => {
    const persona: Record<string, any> = { name: "P1", largePortrait: true };
    normalizePortableBackupSnapshot({ personas: [persona] } as any);
    expect(persona.largePortrait).toBe(true);
  });

  it.each([
    ["non-number", "0"],
    ["non-integer", 1.5],
    ["out of range", 5],
  ])("falls back to persona 0 for a %s selectedPersona", (_label, value) => {
    const db: Record<string, any> = {
      personas: [{ name: "P0" }, { name: "P1" }],
      selectedPersona: value as any,
    };
    normalizePortableBackupSnapshot(db);
    expect(db.selectedPersona).toBe(0);
    expect(db.username).toBe("P0");
  });

  it("syncs legacy mirrors from the selected persona", () => {
    const db: Record<string, any> = {
      personas: [
        { name: "First", icon: "a.png", personaPrompt: "p1" },
        {
          name: "Second",
          icon: "b.png",
          personaPrompt: "p2",
          note: "n2",
          largePortrait: true,
        },
      ],
      selectedPersona: 1,
      username: "stale",
      userIcon: "stale.png",
      userNote: "stale",
      personaPrompt: "stale",
    };
    normalizePortableBackupSnapshot(db);
    expect(db.username).toBe("Second");
    expect(db.userIcon).toBe("b.png");
    expect(db.userNote).toBe("n2");
    expect(db.personaPrompt).toBe("p2");
  });

  it('defaults a missing persona note to "" when syncing mirrors', () => {
    const db: Record<string, any> = {
      personas: [{ name: "Solo", icon: "", personaPrompt: "" }],
      selectedPersona: 0,
      userNote: "old",
    };
    normalizePortableBackupSnapshot(db);
    expect(db.userNote).toBe("");
  });

  it("applies botPresets defaults", () => {
    const db: Record<string, any> = { personas: [{ name: "P" }] };
    normalizePortableBackupSnapshot(db);
    expect(db.botPresets).toEqual([]);
    expect(db.botPresetsId).toBe(0);
  });

  it("keeps existing botPresets and id", () => {
    const botPresets = [{ name: "Preset" }];
    const db: Record<string, any> = {
      personas: [{ name: "P" }],
      botPresets,
      botPresetsId: 3,
    };
    normalizePortableBackupSnapshot(db);
    expect(db.botPresets).toBe(botPresets);
    expect(db.botPresetsId).toBe(3);
  });
});
