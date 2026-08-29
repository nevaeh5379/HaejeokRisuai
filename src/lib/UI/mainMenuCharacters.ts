export type MainMenuCharacterEntry<T> = {
  char: T;
  index: number;
  matchScore: number;
};

export function indexMainMenuCharacters<T extends { trashTime?: number | null }>(
  characters: readonly T[],
): MainMenuCharacterEntry<T>[] {
  const entries: MainMenuCharacterEntry<T>[] = [];

  for (let index = 0; index < characters.length; index++) {
    const char = characters[index];
    if (char.trashTime) continue;
    entries.push({ char, index, matchScore: 0 });
  }

  return entries;
}
