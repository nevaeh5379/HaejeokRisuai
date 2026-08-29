import { describe, expect, it } from "vitest";
import { indexMainMenuCharacters } from "src/lib/UI/mainMenuCharacters";

describe("MainMenu deleted character filtering", () => {
  it("excludes trashed characters without changing surviving store indexes", () => {
    const characters = [
      { id: "active-before" },
      { id: "trashed", trashTime: 123456789 },
      { id: "active-after" },
    ];

    const entries = indexMainMenuCharacters(characters);

    expect(entries.map(({ char, index }) => [char.id, index])).toEqual([
      ["active-before", 0],
      ["active-after", 2],
    ]);
  });
});
