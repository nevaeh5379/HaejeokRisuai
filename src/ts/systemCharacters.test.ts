import { describe, expect, test } from "vitest";
import {
  isHiddenFromCharacterLists,
  isHiddenRecentChatRow,
  isReservedSystemCharacterId,
  isRisuAgentCharacterId,
  PLAYGROUND_CHARACTER_ID,
  RESERVED_SYSTEM_CHARACTER_IDS,
  RISU_AGENT_CHARACTER_ID,
  TEMP_CHARACTER_ID,
} from "./systemCharacters";

describe("reserved system characters", () => {
  test("recognizes every reserved id and nothing else", () => {
    for (const id of RESERVED_SYSTEM_CHARACTER_IDS) {
      expect(isReservedSystemCharacterId(id)).toBe(true);
      expect(isHiddenFromCharacterLists({ chaId: id })).toBe(true);
    }

    expect(isReservedSystemCharacterId("ordinary-character")).toBe(false);
    expect(isReservedSystemCharacterId(undefined)).toBe(false);
    expect(isReservedSystemCharacterId("")).toBe(false);
  });

  test("distinguishes Risu Agent from legacy Playground", () => {
    expect(isRisuAgentCharacterId(RISU_AGENT_CHARACTER_ID)).toBe(true);
    expect(isRisuAgentCharacterId(PLAYGROUND_CHARACTER_ID)).toBe(false);
    expect(isRisuAgentCharacterId(TEMP_CHARACTER_ID)).toBe(false);
    expect(RISU_AGENT_CHARACTER_ID).not.toBe(PLAYGROUND_CHARACTER_ID);
  });

  test("hidden helper covers trashed and reserved characters", () => {
    expect(isHiddenFromCharacterLists({ chaId: "ordinary" })).toBe(false);
    expect(
      isHiddenFromCharacterLists({ chaId: "ordinary", trashTime: 1 }),
    ).toBe(true);
    expect(isHiddenFromCharacterLists({ trashTime: 1 })).toBe(true);
    expect(isHiddenFromCharacterLists(null)).toBe(true);
  });
});

describe("recent chat SQL row visibility", () => {
  test("drops reserved rows even when no character is loaded", () => {
    for (const id of RESERVED_SYSTEM_CHARACTER_IDS) {
      expect(isHiddenRecentChatRow(id, undefined)).toBe(true);
    }
    expect(isHiddenRecentChatRow(RISU_AGENT_CHARACTER_ID, null)).toBe(true);
  });

  test("drops rows whose loaded character is trashed or reserved", () => {
    expect(
      isHiddenRecentChatRow("ordinary", { chaId: "ordinary", trashTime: 1 }),
    ).toBe(true);
    expect(
      isHiddenRecentChatRow("ordinary", { chaId: RISU_AGENT_CHARACTER_ID }),
    ).toBe(true);
  });

  test("keeps ordinary rows, including ones not yet hydrated", () => {
    expect(isHiddenRecentChatRow("ordinary", undefined)).toBe(false);
    expect(isHiddenRecentChatRow("ordinary", null)).toBe(false);
    expect(isHiddenRecentChatRow("ordinary", { chaId: "ordinary" })).toBe(
      false,
    );
  });
});
