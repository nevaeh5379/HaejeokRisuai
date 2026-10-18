import { writable } from "svelte/store";

export interface AndroidComposerPrefill {
  id: number;
  text: string;
  characterId?: string;
  chatId?: string;
}

let nextPrefillId = 1;

export const androidComposerPrefill = writable<AndroidComposerPrefill | null>(null);

export function queueAndroidComposerPrefill(
  input: Omit<AndroidComposerPrefill, "id">,
): number {
  const id = nextPrefillId++;
  androidComposerPrefill.set({ id, ...input });
  return id;
}

export function clearAndroidComposerPrefill(id: number): void {
  androidComposerPrefill.update((current) =>
    current?.id === id ? null : current,
  );
}
