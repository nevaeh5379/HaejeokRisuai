import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { personaStore } from "../../stores/domain/personaStore.svelte";
import { moduleStore } from "../../stores/domain/moduleStore.svelte";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import { safeStructuredClone } from "../../polyfill";
import type { Database } from "./schema";

/** Builds a detached aggregate only at serialization and external API boundaries. */
export function createDatabaseSnapshot(): Database {
  const settings = settingsStore.getStateRecord();
  const activePersona = personaStore.activePersona;
  const target = {
    ...settings,
    ...(activePersona
      ? {
          username: activePersona.name,
          userIcon: activePersona.icon,
          userNote: activePersona.note ?? "",
          personaPrompt: activePersona.personaPrompt,
        }
      : {}),
    characters: characterStore.characters,
    personas: personaStore.list,
    selectedPersona: personaStore.activeIndex,
    modules: moduleStore.modules,
    enabledModules: moduleStore.enabledModules,
    moduleFolders: moduleStore.moduleFolders,
    activeBotPresetId: presetStore.activeId || undefined,
  };
  try {
    return $state.snapshot(target) as Database;
  } catch {
    return safeStructuredClone(target) as Database;
  }
}
