import { describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../sql/ISqlStorage";
import {
  exportPortableDatabaseStream,
  PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS,
  PortableDatabaseStreamCollector,
  type PortableDatabaseStreamFragment,
} from "./portableDatabaseStream";

function createStorage(overrides: Record<string, unknown> = {}) {
  let summaryReads = 0;
  const storage = {
    backendKind: "web-sqlite",
    isEnabled: () => true,
    init: vi.fn(async () => true),
    getRevision: () => 7,
    getStorageSyncSummary: vi.fn(async () => {
      summaryReads++;
      return {
        revision: 7,
        initialized: true,
        records: {
          settings: 2,
          characters: 1,
          chats: 1,
          messages: 3,
          total: 7,
        },
      };
    }),
    loadStartupData: vi.fn(async () => ({
      status: "ready",
      revision: 7,
      settings: {},
      characters: [
        {
          chaId: "character-1",
          type: "character",
          name: "Shell",
          image: "assets/shell.png",
          detailsLoaded: false,
          chats: [],
          chatPage: 0,
        },
      ],
    })),
    listSettingKeys: vi.fn(async () => ["personas", "activeBotPresetId"]),
    loadSettingKey: vi.fn(async (key: string) =>
      key === "personas"
        ? [{ name: "User", icon: "assets/user.png", personaPrompt: "" }]
        : "preset-1",
    ),
    loadModules: vi.fn(async () => [{ id: "module-1", name: "Module" }]),
    listBotPresets: vi.fn(async () => [
      {
        id: "preset-1",
        position: 0,
        name: "Preset",
        image: "",
        apiType: "openai",
        aiModel: "model",
        hash: "hash",
      },
    ]),
    loadBotPreset: vi.fn(async () => ({ id: "preset-1", name: "Preset" })),
    listPluginCustomStorageKeys: vi.fn(async () => ["plugin-1"]),
    loadPluginCustomStorageKey: vi.fn(async () => ({ retained: true })),
    listColdStorageItems: vi.fn(async () => ({ items: [] })),
    getColdStorageItem: vi.fn(async () => null),
    loadCharacter: vi.fn(async () => ({
      chaId: "character-1",
      type: "character",
      name: "Character",
      image: "assets/character.png",
      chatPage: 0,
      detailsLoaded: true,
      chats: [{ id: "chat-1", name: "Chat", message: [] }],
    })),
    loadChat: vi.fn(async () => ({
      id: "chat-1",
      name: "Chat",
      note: "",
      message: [{ chatId: "m3", role: "char", data: "three" }],
      messageOffset: 2,
      messageTotal: 3,
      messagesLoaded: true,
      messagesFullyLoaded: false,
      detailsLoaded: true,
    })),
    loadChatBranchGraphPage: vi.fn(async (_chatId: string, offset: number) =>
      offset === 0
        ? {
            branches: [
              {
                id: "root",
                chatId: "chat-1",
                reason: "root",
                headMessageId: "m3",
                createdAt: 1,
              },
            ],
            activeBranchId: "root",
            messages: [
              { chatId: "m1", role: "user", data: "one" },
              { chatId: "m2", role: "char", data: "two" },
            ],
            links: [
              { messageId: "m1", position: 0, originBranchId: "root" },
              {
                messageId: "m2",
                position: 1,
                parentMessageId: "m1",
                originBranchId: "root",
              },
            ],
            offset: 0,
            total: 3,
            hasMore: true,
          }
        : {
            branches: [
              {
                id: "root",
                chatId: "chat-1",
                reason: "root",
                headMessageId: "m3",
                createdAt: 1,
              },
            ],
            activeBranchId: "root",
            messages: [{ chatId: "m3", role: "char", data: "three" }],
            links: [
              {
                messageId: "m3",
                position: 2,
                parentMessageId: "m2",
                originBranchId: "root",
              },
            ],
            offset: 2,
            total: 3,
            hasMore: false,
          },
    ),
    exportDatabaseSnapshot: vi.fn(() => {
      throw new Error("aggregate snapshot must not be called");
    }),
    ...overrides,
  };
  return { storage: storage as unknown as ISqlStorage, summaryReads };
}

describe("portable database streaming backup", () => {
  it("exports and reconstructs bounded records without aggregate snapshot loading", async () => {
    const { storage } = createStorage();
    const fragments: PortableDatabaseStreamFragment[] = [];

    const manifest = await exportPortableDatabaseStream(storage, {
      writeFragment: async (fragment) => {
        fragments.push(structuredClone(fragment));
      },
      writeColdStorage: async () => {},
    });

    expect(storage.exportDatabaseSnapshot).not.toHaveBeenCalled();
    expect(storage.loadChat).toHaveBeenCalledWith("chat-1", {
      messageLimit: 1,
    });
    expect(storage.loadChatBranchGraphPage).toHaveBeenCalledTimes(2);
    expect(manifest.totalFragments).toBe(fragments.length);
    expect(manifest.counts.message).toBe(3);

    const collector = new PortableDatabaseStreamCollector();
    for (const fragment of fragments) collector.addFragment(fragment);
    collector.setManifest(manifest);
    const restored = collector.finish() as any;

    expect(restored.characters).toHaveLength(1);
    expect(restored.characters[0].name).toBe("Character");
    expect(restored.characters[0].chats[0].message).toEqual([]);
    expect(restored.pluginCustomStorage).toEqual({
      "plugin-1": { retained: true },
    });
    expect(restored.haejeokBranchGraphs["chat-1"].messages).toHaveLength(3);
    expect(restored.botPresetsId).toBe(0);
  });

  it("rejects a backup assembled across database revisions", async () => {
    let reads = 0;
    const { storage } = createStorage({
      getStorageSyncSummary: vi.fn(async () => ({
        revision: reads++ < 2 ? 7 : 8,
        initialized: true,
        records: {
          settings: 0,
          characters: 0,
          chats: 0,
          messages: 0,
          total: 0,
        },
      })),
    });

    await expect(
      exportPortableDatabaseStream(storage, {
        writeFragment: async () => {},
        writeColdStorage: async () => {},
      }),
    ).rejects.toThrow("Storage sync source changed from revision 7 to 8");
  });

  it("rejects missing records even when the remaining fragments decode", async () => {
    const { storage } = createStorage();
    const fragments: PortableDatabaseStreamFragment[] = [];
    const manifest = await exportPortableDatabaseStream(storage, {
      writeFragment: async (fragment) => {
        fragments.push(fragment);
      },
      writeColdStorage: async () => {},
    });
    fragments[0].records.splice(2, 1);

    const collector = new PortableDatabaseStreamCollector();
    for (const fragment of fragments) collector.addFragment(fragment);
    collector.setManifest(manifest);
    expect(() => collector.finish()).toThrow("incomplete");
  });

  it("keeps every encoded database fragment bounded", async () => {
    const settingKeys = Array.from(
      { length: 300 },
      (_, index) => `setting-${index}`,
    );
    const { storage } = createStorage({
      listSettingKeys: vi.fn(async () => settingKeys),
      loadSettingKeys: vi.fn(
        async (keys: string[]) => new Map(keys.map((key) => [key, { key }])),
      ),
      listPluginCustomStorageKeys: vi.fn(async () => []),
      loadModules: vi.fn(async () => []),
      listBotPresets: vi.fn(async () => []),
      listColdStorageItems: vi.fn(async () => ({ items: [] })),
      loadStartupData: vi.fn(async () => ({
        status: "ready",
        revision: 7,
        settings: {},
        characters: [],
      })),
    });
    const fragments: PortableDatabaseStreamFragment[] = [];

    const manifest = await exportPortableDatabaseStream(storage, {
      writeFragment: async (fragment) => {
        fragments.push(fragment);
      },
      writeColdStorage: async () => {},
    });

    expect(manifest.totalRecords).toBe(301);
    expect(fragments.length).toBeGreaterThan(3);
    expect(
      fragments.every(
        (fragment) =>
          fragment.records.length <= PORTABLE_DATABASE_STREAM_FRAGMENT_RECORDS,
      ),
    ).toBe(true);
    expect(storage.exportDatabaseSnapshot).not.toHaveBeenCalled();
  });
});
