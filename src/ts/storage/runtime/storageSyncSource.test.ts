import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeStorageSyncValue } from "@risuai/protocol/storageSyncValueCodec.cjs";
import type { ISqlStorage } from "../sql/ISqlStorage";
import {
  StorageSyncSourceRevisionChangedError,
  iterateStorageSyncSqlChunks,
  iterateStorageSyncSqlRecords,
  measureStorageSyncSqlSource,
} from "./storageSyncSource";

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}
function makeStorage() {
  let revision = 7;
  const pageCalls: number[] = [];
  const storage = {
    getRevision: () => revision,
    getStorageSyncSummary: vi.fn(async () => ({
      revision,
      initialized: true,
      records: { settings: 2, characters: 1, chats: 1, messages: 3, total: 7 },
    })),
    listSettingKeys: vi.fn(async () => ["zeta", "exotic"]),
    loadSettingKeys: vi.fn(async (keys: string[]) =>
      new Map(
        keys.map((key) => [
          key,
          key === "exotic" ? { missing: undefined, nan: Number.NaN } : "last",
        ]),
      ),
    ),
    listPluginCustomStorageKeys: vi.fn(async () => ["plugin-key"]),
    loadPluginCustomStorageKey: vi.fn(async () => ({ enabled: true })),
    loadModules: vi.fn(async () => [{ id: "module-1", name: "Module" }]),
    listBotPresets: vi.fn(async () => [
      { id: "preset-1", position: 0, name: "Preset", image: "", apiType: "", aiModel: "", hash: "h" },
    ]),
    loadBotPreset: vi.fn(async () => ({ id: "preset-1", name: "Preset" })),
    listColdStorageItems: vi.fn(async () => ({ items: ["cold-1"] })),
    getColdStorageItem: vi.fn(async () => ({ archived: true })),
    loadStartupData: vi.fn(async () => ({
      status: "ready" as const,
      revision,
      settings: {},
      characters: [{ chaId: "char-1", name: "Char", type: "character", chats: [] } as any],
    })),
    loadCharacter: vi.fn(async () => ({
      chaId: "char-1",
      name: "Char",
      type: "character",
      detailsLoaded: true,
      chats: [{ id: "chat-1", name: "Chat", message: [] }],
    } as any)),
    loadChat: vi.fn(async () => ({
      id: "chat-1",
      name: "Chat",
      detailsLoaded: true,
      messagesLoaded: true,
      messagesFullyLoaded: false,
      message: [{ chatId: "ignored-active-message", role: "user", data: "not exported here" }],
    } as any)),
    loadChatBranchGraph: vi.fn(async () => {
      throw new Error("whole graph loader must not be used");
    }),
    loadChatBranchGraphPage: vi.fn(async (_chatId: string, offset: number) => {
      pageCalls.push(offset);
      const branches = [
        { id: "root", chatId: "chat-1", reason: "root", createdAt: 0, headMessageId: "m2" },
        { id: "reroll", chatId: "chat-1", parentBranchId: "root", forkMessageId: "m1", reason: "reroll", createdAt: 1, headMessageId: "m-alt" },
      ] as any[];
      if (offset === 0) {
        return {
          branches,
          activeBranchId: "reroll",
          messages: [
            { chatId: "m1", role: "user", data: "one" },
            { chatId: "m2", role: "char", data: "two" },
          ],
          links: [
            { messageId: "m1", position: 0, originBranchId: "root" },
            { messageId: "m2", position: 1, parentMessageId: "m1", originBranchId: "root" },
          ],
          offset: 0,
          total: 3,
          hasMore: true,
        } as any;
      }
      if (offset === 2) {
        return {
          branches,
          activeBranchId: "reroll",
          messages: [{ chatId: "m-alt", role: "char", data: "alternate" }],
          links: [
            { messageId: "m-alt", position: 1, parentMessageId: "m1", originBranchId: "reroll" },
          ],
          offset: 2,
          total: 3,
          hasMore: false,
        } as any;
      }
      throw new Error(`unexpected graph offset ${offset}`);
    }),
  };
  return {
    storage: storage as unknown as ISqlStorage,
    pageCalls,
    setRevision(value: number) {
      revision = value;
    },
  };
}

describe("storage sync SQL source", () => {
  it("streams every SQL domain and pages branch messages", async () => {
    const { storage, pageCalls } = makeStorage();
    const records = await collect(
      iterateStorageSyncSqlRecords(storage, { expectedRevision: 7, pageSize: 2 }),
    );
    expect(pageCalls).toEqual([0, 2]);
    expect((storage.loadChatBranchGraph as any)).not.toHaveBeenCalled();
    expect(records.map((record) => record.type)).toEqual([
      "meta",
      "setting", "setting",
      "plugin-storage",
      "module",
      "preset",
      "cold-storage",
      "character",
      "chat",
      "branch", "branch", "active-branch",
      "message", "message", "message",
    ]);
    const messages = records.filter((record) => record.type === "message");
    expect(messages.map((record) => record.position)).toEqual([0, 1, 1]);
    expect(messages.map((record) => record.id)).toEqual(["m1", "m2", "m-alt"]);
    const chat = records.find((record) => record.type === "chat");
    expect(chat && "data" in chat ? (chat.data as any).message : undefined).toBeUndefined();
  });

  it("produces deterministic bounded chunks matching the measured digest", async () => {
    const measuredStorage = makeStorage().storage;
    const plan = await measureStorageSyncSqlSource(measuredStorage, {
      expectedRevision: 7,
      pageSize: 2,
    });
    const chunks = await collect(
      iterateStorageSyncSqlChunks(makeStorage().storage, {
        expectedRevision: 7,
        pageSize: 2,
        chunkSize: 17,
      }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 17)).toBe(true);
    const bytes = concat(chunks);
    expect(bytes.byteLength).toBe(plan.size);
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(plan.sha256);
    expect(plan.recordCount).toBe(15);

    const records = new TextDecoder()
      .decode(bytes)
      .trimEnd()
      .split("\n")
      .map((line) => decodeStorageSyncValue(JSON.parse(line)) as any);
    const exotic = records.find(
      (record) => record.type === "setting" && record.key === "exotic",
    );
    expect(Object.prototype.hasOwnProperty.call(exotic.value, "missing")).toBe(true);
    expect(exotic.value.missing).toBeUndefined();
    expect(Number.isNaN(exotic.value.nan)).toBe(true);
  });
  it("rejects graph pages that cannot preserve original message positions", async () => {
    const { storage } = makeStorage();
    const original = storage.loadChatBranchGraphPage!.bind(storage);
    (storage as any).loadChatBranchGraphPage = vi.fn(async (...args: any[]) => {
      const page = await original(...args);
      if (page.links[0]) delete page.links[0].position;
      return page;
    });
    await expect(
      measureStorageSyncSqlSource(storage, { expectedRevision: 7, pageSize: 2 }),
    ).rejects.toThrow(/positions required for lossless sync/);
  });

  it("fails instead of mixing revisions when the source changes", async () => {
    const { storage, setRevision } = makeStorage();
    const original = storage.loadCharacter.bind(storage);
    (storage as any).loadCharacter = vi.fn(async (id: string) => {
      const value = await original(id);
      setRevision(8);
      return value;
    });
    await expect(
      measureStorageSyncSqlSource(storage, { expectedRevision: 7, pageSize: 2 }),
    ).rejects.toBeInstanceOf(StorageSyncSourceRevisionChangedError);
  });
});
