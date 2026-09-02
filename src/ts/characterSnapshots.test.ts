// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { character, Chat } from "./storage/database/schema";
import {
  applyCharacterSnapshot,
  collectCharacterSnapshotAssetReferences,
  createCharacterSnapshot,
  syncCharacterSnapshotAssetReferences,
} from "./characterSnapshots";

function makeChat(name: string): Chat {
  return {
    id: `chat-${name}`,
    message: [],
    note: `${name} note`,
    name,
    localLore: [],
  } as Chat;
}

function makeCharacter(): character {
  return {
    type: "character",
    chaId: "char-1",
    name: "Current",
    firstMessage: "hello",
    desc: "current description",
    chats: [makeChat("current")],
    chatFolders: [],
    chatPage: 0,
    globalLore: [{ key: "now", content: "current lore" } as any],
    customscript: [{ comment: "", in: "a", out: "b", type: "editinput" }],
    triggerscript: [{ type: "lua", code: "return 1" } as any],
    scriptstate: { counter: 7 },
    lastInteraction: 123,
    realmId: "realm-1",
    creation_date: 111,
    modification_date: 222,
    image: "assets/avatar.png",
    customBackground: "assets/old-bg.png",
    emotionImages: [["happy", "assets/happy.png"]],
    additionalAssets: [["prop", "assets/prop.png", "png"]],
    ccAssets: [{ type: "icon", uri: "assets/card.png", name: "card", ext: "png" }],
    gptSoVitsConfig: { ref_audio_data: { fileName: "voice.wav", assetId: "assets/voice.wav" } },
    snapshots: [],
  } as unknown as character;
}

describe("characterSnapshots", () => {
  it("captures authoring configuration without chat/runtime state", () => {
    const char = makeCharacter();
    const snapshot = createCharacterSnapshot(char, "Before rewrite", 1000);

    expect(snapshot).toMatchObject({
      name: "Before rewrite",
      createdAt: 1000,
      version: 1,
    });
    expect(snapshot.data).toMatchObject({
      desc: "current description",
      globalLore: [{ key: "now", content: "current lore" }],
      triggerscript: [{ type: "lua", code: "return 1" }],
    });

    expect(snapshot.data).not.toHaveProperty("chats");
    expect(snapshot.data).not.toHaveProperty("chatPage");
    expect(snapshot.data).not.toHaveProperty("chaId");
    expect(snapshot.data).not.toHaveProperty("scriptstate");
    expect(snapshot.data).not.toHaveProperty("lastInteraction");
    expect(snapshot.data).not.toHaveProperty("snapshots");
    expect(snapshot.data).not.toHaveProperty("snapshotAssetRefs");

    char.globalLore[0].content = "mutated later";
    expect((snapshot.data.globalLore as any[])[0].content).toBe("current lore");
  });

  it("tracks assets held only by snapshots in a compact cache", () => {
    const char = makeCharacter();
    const snapshot = createCharacterSnapshot(char, "With assets", 1000);
    char.snapshots = [snapshot];

    expect(collectCharacterSnapshotAssetReferences(char.snapshots)).toEqual(
      expect.arrayContaining([
        "assets/avatar.png",
        "assets/old-bg.png",
        "assets/happy.png",
        "assets/prop.png",
        "assets/card.png",
        "assets/voice.wav",
      ]),
    );

    syncCharacterSnapshotAssetReferences(char);
    expect(char.snapshotAssetRefs).toEqual(
      expect.arrayContaining(["assets/avatar.png", "assets/voice.wav"]),
    );
  });

  it("restores config while preserving identity, chats and runtime state", () => {
    const char = makeCharacter();
    const snapshot = createCharacterSnapshot(char, "Old config", 1000);
    char.name = "New name";
    char.desc = "new description";
    char.globalLore = [{ key: "new", content: "new lore" } as any];
    char.scriptstate = { counter: 99 };
    char.lastInteraction = 999;
    char.chats = [makeChat("new-chat")];
    char.snapshots = [snapshot];

    const restored = applyCharacterSnapshot(char, snapshot);

    expect(restored.name).toBe("Current");
    expect(restored.desc).toBe("current description");
    expect(restored.globalLore).toEqual([{ key: "now", content: "current lore" }]);
    expect(restored.chaId).toBe("char-1");
    expect(restored.chats).toBe(char.chats);
    expect(restored.scriptstate).toEqual({ counter: 99 });
    expect(restored.lastInteraction).toBe(999);
    expect(restored.snapshots).toBe(char.snapshots);
  });
});
