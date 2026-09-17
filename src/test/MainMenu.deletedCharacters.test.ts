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

  it("excludes reserved/system characters while preserving store indexes", () => {
    const characters = [
      { chaId: "ordinary", name: "Ordinary" },
      { chaId: "§risu-agent", name: "Risu Agent" },
      { chaId: "§playground", name: "Playground" },
      { chaId: "§temp", name: "Temp" },
      { chaId: "ordinary-2", name: "Ordinary 2" },
    ];

    const entries = indexMainMenuCharacters(characters);

    expect(entries.map(({ char, index }) => [char.chaId, index])).toEqual([
      ["ordinary", 0],
      ["ordinary-2", 4],
    ]);
  });
});
