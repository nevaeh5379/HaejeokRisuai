import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../polyfill";
import type { Database } from "./schema";

/** Builds a detached aggregate only at serialization and external API boundaries. */
export function createDatabaseSnapshot(): Database {
  const target = {
    ...settingsStore.getStateRecord(),
    characters: characterStore.characters,
  };
  try {
    return $state.snapshot(target) as Database;
  } catch {
    return safeStructuredClone(target) as Database;
  }
}
