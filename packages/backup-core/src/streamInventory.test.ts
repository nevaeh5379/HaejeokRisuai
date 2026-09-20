import { describe, expect, it } from "vitest";
import {
  collectStreamingInventoryRecord,
  createStreamingColdStorageInventory,
  type StreamingColdStorageInventory,
} from "./streamInventory";
import type { LegacyBackupSqlRecord } from "./legacyRecords";

const HEADER = "\uEF01COLDSTORAGE\uEF01";

function collect(
  record: LegacyBackupSqlRecord,
  options?: Parameters<typeof collectStreamingInventoryRecord>[2],
): StreamingColdStorageInventory {
  const inventory = createStreamingColdStorageInventory();
  collectStreamingInventoryRecord(inventory, record, options);
  return inventory;
}

function characterRecord(
  data: Record<string, any> | undefined,
  id = "char-1",
): LegacyBackupSqlRecord {
  return { type: "character", position: 0, id, data };
}

describe("streaming cold-storage tracking", () => {
  it("tracks direct character references and filters malformed chat lists", () => {
    const inventory = collect(
      characterRecord({
        name: "Alice",
        coldstorage: "key-main",
        coldStoragedChats: ["key-a", 42, null, "key-b", {}],
      }),
    );

    expect([...inventory.referencedColdStorageKeys]).toEqual([
      "key-main",
      "key-a",
      "key-b",
    ]);
    expect([...inventory.coldStorageCharacters.values()]).toEqual([
      {
        chaId: "char-1",
        name: "Alice",
        coldstorage: "key-main",
        coldStoragedChats: ["key-a", "key-b"],
        chats: [],
      },
    ]);
  });

  it("accepts malformed character payloads without throwing", () => {
    const inventory = collect(characterRecord(undefined, "char-x"));
    expect([...inventory.coldStorageCharacters.values()]).toEqual([
      {
        chaId: "char-x",
        name: "Unknown Character",
        coldstorage: undefined,
        coldStoragedChats: [],
        chats: [],
      },
    ]);
    expect(inventory.chatOwners.size).toBe(0);
  });

  it("does not treat chat records without a cold-storage marker as referenced", () => {
    const inventory = collect({
      type: "chat",
      characterId: "char-1",
      position: 0,
      id: "chat-1",
      data: { message: [] },
    });
    expect(inventory.chatOwners.get("chat-1")).toBe("char-1");
    expect(inventory.referencedColdStorageKeys.size).toBe(0);
  });
});

describe("streaming position-0 marker reconstruction", () => {
  const character = characterRecord({ name: "Alice", coldstorage: "key-a" });
  const chat = {
    type: "chat",
    characterId: "char-1",
    position: 0,
    id: "chat-1",
    data: {},
  } as const;

  function markerRecord(data: string, position = 0): LegacyBackupSqlRecord {
    return {
      type: "message",
      chatId: "chat-1",
      id: "msg-1",
      position,
      originBranchId: "root",
      data: { data },
    };
  }

  it("links a marker message to its owning character when records are in order", () => {
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, character);
    collectStreamingInventoryRecord(inventory, chat);
    collectStreamingInventoryRecord(inventory, markerRecord(`${HEADER}key-b`));

    expect([...inventory.referencedColdStorageKeys]).toEqual([
      "key-a",
      "key-b",
    ]);
    expect(inventory.coldStorageCharacters.get("char-1")?.chats).toEqual([
      { message: [{ data: `${HEADER}key-b` }] },
    ]);
  });

  it("ignores marker messages that arrive before their chat record", () => {
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, character);
    collectStreamingInventoryRecord(inventory, markerRecord(`${HEADER}key-b`));
    collectStreamingInventoryRecord(inventory, chat);

    expect([...inventory.referencedColdStorageKeys]).toEqual([
      "key-a",
      "key-b",
    ]);
    expect(inventory.coldStorageCharacters.get("char-1")?.chats).toEqual([]);
  });

  it("rejects empty marker keys without touching the inventory", () => {
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, character);
    collectStreamingInventoryRecord(inventory, chat);
    collectStreamingInventoryRecord(inventory, markerRecord(HEADER));

    expect([...inventory.referencedColdStorageKeys]).toEqual(["key-a"]);
    expect(inventory.coldStorageCharacters.get("char-1")?.chats).toEqual([]);
  });

  it("ignores non-zero positions and non-marker messages", () => {
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, character);
    collectStreamingInventoryRecord(inventory, chat);
    collectStreamingInventoryRecord(
      inventory,
      markerRecord(`${HEADER}key-b`, 1),
    );
    collectStreamingInventoryRecord(inventory, {
      type: "message",
      chatId: "chat-1",
      id: "msg-2",
      position: 0,
      originBranchId: "root",
      data: { data: "plain message" },
    });

    expect([...inventory.referencedColdStorageKeys]).toEqual(["key-a"]);
    expect(inventory.coldStorageCharacters.get("char-1")?.chats).toEqual([]);
  });

  it("honors a caller-supplied cold-storage header", () => {
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, character);
    collectStreamingInventoryRecord(inventory, markerRecord("ALT-key-c"), {
      coldStorageHeader: "ALT-",
    });
    collectStreamingInventoryRecord(inventory, markerRecord(`${HEADER}key-d`), {
      coldStorageHeader: "ALT-",
    });

    expect([...inventory.referencedColdStorageKeys]).toEqual([
      "key-a",
      "key-c",
    ]);
  });

  it("does not mutate the record payload", () => {
    const record = markerRecord(`${HEADER}key-b`);
    const snapshot = JSON.parse(JSON.stringify(record));
    collect(record);
    expect(record).toEqual(snapshot);
  });
});

describe("streaming asset collection (backup export)", () => {
  it("collects nothing without a scope option", () => {
    const inventory = collect(
      characterRecord({ name: "Alice", image: "assets/a.png" }),
    );
    expect(inventory.referencedColdStorageKeys.size).toBe(0);
    // Cold-storage tracking still ran; asset map is an export-only option.
  });

  it("collects essential-scope assets only", () => {
    const record = {
      type: "character",
      position: 0,
      id: "char-1",
      data: {
        name: "Alice",
        image: "assets/a.png",
        emotionImages: [["smile", "assets/e.png"]],
        additionalAssets: [["extra", "assets/x.png"]],
      },
    } as LegacyBackupSqlRecord;
    const assetMap = new Map();
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(inventory, record, {
      scope: "essential",
      assetMap,
    });

    expect([...assetMap.entries()]).toEqual([
      ["assets/a.png", { charName: "Alice", assetName: "Profile Image" }],
    ]);
  });

  it("collects the full all-scope asset set, skipping group-only assets", () => {
    const base = {
      name: "Alice",
      image: "assets/a.png",
      emotionImages: [["smile", "assets/e.png"]],
      vits: { files: { voice: "assets/v.wav" } },
      ccAssets: [{ uri: "assets/cc.png", name: "Card" }],
      additionalAssets: [["extra", "assets/x.bin"]],
    };
    const assetMap = new Map();
    collectStreamingInventoryRecord(
      createStreamingColdStorageInventory(),
      characterRecord({ ...base, type: "group" }, "char-1"),
      { scope: "all", assetMap },
    );
    expect(Object.keys(Object.fromEntries(assetMap)).sort()).toEqual([
      "assets/a.png",
      "assets/e.png",
    ]);

    const soloMap = new Map();
    collectStreamingInventoryRecord(
      createStreamingColdStorageInventory(),
      characterRecord({ ...base }, "char-1"),
      { scope: "all", assetMap: soloMap },
    );
    expect(Object.keys(Object.fromEntries(soloMap)).sort()).toEqual([
      "assets/a.png",
      "assets/cc.png",
      "assets/e.png",
      "assets/v.wav",
      "assets/x.bin",
    ]);
  });

  it("uses fallback labels for malformed optional asset arrays", () => {
    const data = {
      name: "Alice",
      image: "assets/a.png",
      emotionImages: [[], [undefined, "assets/e.png"]],
      additionalAssets: [[], [null, "assets/x.png"]],
      vits: { files: {} },
      ccAssets: [null, { uri: "assets/c.png" }],
    };
    const assetMap = new Map();
    collectStreamingInventoryRecord(
      createStreamingColdStorageInventory(),
      characterRecord(data, "char-1"),
      { scope: "all", assetMap },
    );

    expect([...assetMap.entries()]).toEqual([
      ["assets/a.png", { charName: "Alice", assetName: "Main Image" }],
      ["assets/e.png", { charName: "Alice", assetName: "Emotion" }],
      ["assets/x.png", { charName: "Alice", assetName: "Asset" }],
      ["assets/c.png", { charName: "Alice", assetName: "Asset" }],
    ]);
  });

  it("collects setting, module, and preset assets with scope differences", () => {
    const assetMap = new Map();
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "setting",
        key: "personas",
        value: [
          { name: "P1", icon: "assets/p1.png" },
          { icon: "assets/p2.png" },
          null,
        ],
      },
      { scope: "essential", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "setting",
        key: "userIcon",
        value: "assets/user.png",
      },
      { scope: "essential", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "setting",
        key: "characterOrder",
        value: [
          { name: "Folder", img: "assets/f.png", imgFile: "assets/ff.png" },
          "not-an-object",
          null,
        ],
      },
      { scope: "all", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "module",
        position: 0,
        id: "mod-1",
        data: {
          name: "Mod",
          icon: "assets/m.png",
          assets: [["a", "assets/ma.png"]],
        },
      },
      { scope: "all", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "preset",
        position: 0,
        id: "preset-1",
        data: { name: "Preset", image: "assets/pr.png" },
      },
      { scope: "all", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "setting",
        key: "customBackground",
        value: "assets/bg.png",
      },
      { scope: "essential", assetMap },
    );

    expect(Object.keys(Object.fromEntries(assetMap)).sort()).toEqual([
      "assets/bg.png",
      "assets/m.png",
      "assets/ma.png",
      "assets/p1.png",
      "assets/p2.png",
      "assets/user.png",
    ]);
  });

  it("ignores empty asset keys and records it cannot classify", () => {
    const assetMap = new Map();
    const inventory = createStreamingColdStorageInventory();
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "setting",
        key: "personas",
        value: [{ name: "Anon", icon: "" }],
      },
      { scope: "essential", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "meta",
        formatVersion: 1,
        revision: 1,
      },
      { scope: "all", assetMap },
    );
    collectStreamingInventoryRecord(
      inventory,
      {
        type: "active-branch",
        chatId: "c",
        branchId: "b",
      },
      { scope: "all", assetMap },
    );

    expect(assetMap.size).toBe(0);
    expect(inventory.referencedColdStorageKeys.size).toBe(0);
  });
});
