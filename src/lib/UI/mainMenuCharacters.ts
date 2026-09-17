import { isHiddenFromCharacterLists } from "src/ts/systemCharacters";

export type MainMenuCharacterEntry<T> = {
  char: T;
  index: number;
  matchScore: number;
};

export function indexMainMenuCharacters<
  T extends { chaId?: string | null; trashTime?: number | null },
>(characters: readonly T[]): MainMenuCharacterEntry<T>[] {
  const entries: MainMenuCharacterEntry<T>[] = [];

  for (let index = 0; index < characters.length; index++) {
    const char = characters[index];
    // Trashed characters and reserved/system characters (Risu Agent, legacy
    // Playground, temp sync) never appear in the ordinary character list.
    if (isHiddenFromCharacterLists(char)) continue;
    entries.push({ char, index, matchScore: 0 });
  }

  return entries;
}
