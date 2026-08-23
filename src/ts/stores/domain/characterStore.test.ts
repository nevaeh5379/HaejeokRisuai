// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { characterStore } from "./characterStore.svelte";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import type { SqlCommit } from "../../storage/sqlCommit";
import type { character, Chat, groupChat } from "../../storage/database.svelte";

function makeChat(name: string): Chat {
  return {
    message: [],
    note: "",
    name,
    localLore: [],
  } as Chat;
}

function makeChar(name: string, chatCount = 1): character {
  return {
    type: "character",
    name,
    firstMessage: "",
    chats: Array.from({ length: chatCount }, (_, i) =>
      makeChat(`chat ${i + 1}`),
    ),
    chatPage: 0,
    chaId: `char-${name}-${Math.random().toString(36).slice(2)}`,
  } as unknown as character;
}

describe("CharacterStore active-tracking persistence", () => {
  let committed: SqlCommit[];
  let mockStorage: ISqlStorage;

  beforeEach(() => {
    committed = [];
    mockStorage = {
      getRevision: vi.fn(() => committed.length),
      loadCharacter: vi.fn(async () => null),
      loadChat: vi.fn(async () => null),
      loadChatMessagePage: vi.fn(async () => ({
        messages: [],
        offset: 0,
        total: 0,
        hasMore: false,
      })),
      commit: vi.fn(async (commit: SqlCommit) => {
        committed.push(structuredClone(commit));
        return { revision: committed.length };
      }),
    } as unknown as ISqlStorage;
  });

  it("does not commit on init or selection", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);

    await new Promise((r) => setTimeout(r, 30));
    expect(mockStorage.commit).not.toHaveBeenCalled();

    characterStore.select(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("commits a mutation of the active character", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Active char mutation
    characterStore.characters[0].name = "renamed";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters).toHaveLength(1);
    expect(committed[0].characters![0].id).toBe(chars[0].chaId);
    const data = committed[0].characters![0].data as any;
    expect(data.name).toBe("renamed");
    // sqlCharacterData must not leak chats into the row payload
    expect(data.chats).toBeUndefined();
  });

  it("ignores mutations of inactive characters", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Mutate the INACTIVE character
    characterStore.characters[1].name = "should-not-persist";
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();
    expect(committed.length).toBe(0);

    // Explicit mark still persists it
    characterStore.markCharacterDirty(characterStore.characters[1].chaId!);
    await characterStore.flush();
    expect(committed.length).toBe(1);
    expect(committed[0].characters![0].id).toBe(
      characterStore.characters[1].chaId,
    );
  });

  it("persists metadata of newly added chats without spurious commits on switch", async () => {
    const chars = [makeChar("a", 2)];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));
    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Add a new chat to the active character
    characterStore.characters[0].chats.push(makeChat("brand new"));
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    // The store assigned an id to the new chat and persisted its metadata
    const freshId = characterStore.characters[0].chats[2].id;
    expect(freshId).toBeTruthy();
    expect(committed[0].chats!.map((c) => c.id)).toContain(freshId);
    expect(committed[0].chatManifests!).toHaveLength(1);
    expect(committed[0].chatManifests![0].ids).toContain(freshId);

    committed.length = 0;

    // Switching between existing chats persists ONLY the character row
    // (chatPage lives inside sqlCharacterData) — never chat rows.
    characterStore.characters[0].chatPage = 1;
    await new Promise((r) => setTimeout(r, 40));
    await characterStore.flush();
    expect(committed.length).toBe(1);
    expect(committed[0].characters!.map((c) => c.id)).toContain(
      characterStore.characters[0].chaId,
    );
    expect(committed[0].characters![0].data).toHaveProperty("chatPage", 1);
    expect(committed[0].chats).toHaveLength(0);

    // ...but editing the newly-active chat does commit its own row
    characterStore.characters[0].chats[1].note = "edited note";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();
    expect(committed.length).toBe(2);
    expect(committed[1].chats![0].data).toHaveProperty("note", "edited note");
  });

  it("tracks character order changes and direct additions when selectedId is -1", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    // selectedId is -1 (default)
    expect(characterStore.selectedId).toBe(-1);

    // Push a new character directly (e.g. card import)
    const imported = makeChar("imported");
    characterStore.characters.push(imported);
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters).toHaveLength(1);
    expect(committed[0].characters![0].id).toBe(imported.chaId);
    expect(committed[0].characterIds).toHaveLength(3);

    committed.length = 0;

    // Reorder characters
    characterStore.characters.reverse();
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].action).toBe("order");
    expect(committed[0].characterIds).toEqual(
      characterStore.characters.map((c) => c.chaId),
    );
  });

  it("persists characters added via add() and handles remove()", async () => {
    const chars = [makeChar("a")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    const newChar = makeChar("added-via-method");
    const idx = characterStore.add(newChar);
    expect(idx).toBe(1);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characters![0].id).toBe(newChar.chaId);
    expect(committed[0].characterIds).toContain(newChar.chaId);

    committed.length = 0;

    characterStore.remove(0);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect(committed[0].characterIds).toEqual([newChar.chaId]);
  });

  it("handles whole-object replacements via setCurrentCharacter and setCharacterByIndex", async () => {
    const chars = [makeChar("a"), makeChar("b")];
    characterStore.init(chars, mockStorage);
    await new Promise((r) => setTimeout(r, 30));

    characterStore.select(0);
    await new Promise((r) => setTimeout(r, 30));

    // Replace active character object
    const replacedActive = makeChar("a-replaced");
    replacedActive.chaId = chars[0].chaId;
    characterStore.setCurrentCharacter(replacedActive);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe("a-replaced");

    // Subsequent mutations to the new object are tracked
    committed.length = 0;
    characterStore.characters[0].name = "a-replaced-and-mutated";
    await new Promise((r) => setTimeout(r, 30));
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe(
      "a-replaced-and-mutated",
    );

    // Replace inactive character object
    committed.length = 0;
    const replacedInactive = makeChar("b-replaced");
    replacedInactive.chaId = chars[1].chaId;
    characterStore.setCharacterByIndex(1, replacedInactive);
    await characterStore.flush();

    expect(committed.length).toBe(1);
    expect((committed[0].characters![0].data as any).name).toBe("b-replaced");
  });
});
