import { describe, expect, test } from "vitest";
import {
  isHiddenFromCharacterLists,
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
