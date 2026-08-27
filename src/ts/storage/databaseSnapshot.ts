import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import type { Database } from "./schema";

/** Builds a detached aggregate only at serialization and external API boundaries. */
export function createDatabaseSnapshot(): Database {
  return $state.snapshot({
    ...settingsStore.getStateRecord(),
    characters: characterStore.characters,
  }) as Database;
}
