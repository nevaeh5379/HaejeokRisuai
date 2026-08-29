import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../polyfill";
import type { Database } from "./schema";

/** Builds a detached aggregate only at serialization and external API boundaries. */
export function createDatabaseSnapshot(): Database {
  const state = settingsStore.getStateRecord();
  const activePersona = state.personas?.[state.selectedPersona];
  const target = {
    ...state,
    ...(activePersona
      ? {
          username: activePersona.name,
          userIcon: activePersona.icon,
          userNote: activePersona.note ?? "",
          personaPrompt: activePersona.personaPrompt,
        }
      : {}),
    characters: characterStore.characters,
  };
  try {
    return $state.snapshot(target) as Database;
  } catch {
    return safeStructuredClone(target) as Database;
  }
}
