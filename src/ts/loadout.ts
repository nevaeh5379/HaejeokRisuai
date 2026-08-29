import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { changeUserPersona } from "./persona";
import { changeToPreset } from "./storage/presets/presetService";

import { safeStructuredClone } from "./polyfill";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";
import { personaStore } from "./stores/domain/personaStore.svelte";
import { moduleStore } from "./stores/domain/moduleStore.svelte";

export type Loadout = {
  name: string;
  id: string;
  lastUsed: number;
  favorite: boolean;
  characterIds: string[];
  modules: string[];
  globalVariables: { [key: string]: string };
  presetName: string;
  personaId: string;
  icons?: string[];
};

export function makeLoadout(options: { name: string }): Loadout {
  const character = characterStore.currentCharacter;
  const id = crypto.randomUUID();
  const preset = presetStore.activePreset;
  const icons = [];

  if (character?.image) {
    icons.push(character.image);
  }

  return safeStructuredClone({
    name: options.name,
    id: id,
    lastUsed: Date.now(),
    favorite: false,
    characterIds: character ? [character.chaId] : [],
    modules: moduleStore.enabledModules,
    globalVariables: settingsStore.state.globalChatVariables,
    presetName: preset?.name ?? "",
    personaId: personaStore.activePersona?.id,
    icons: icons,
  });
}

type LoadoutApplyOption = "modules" | "globalVariables" | "preset" | "persona";

export function applyLoadout(
  loadout: Loadout,
  apply: LoadoutApplyOption[] = [
    "modules",
    "globalVariables",
    "preset",
    "persona",
  ],
) {
  loadout.lastUsed = Date.now();
  const char = characterStore.currentCharacter;
  if (char) {
    loadout.characterIds.push(char.chaId);
  }
  if (apply.includes("persona")) {
    let personaIndex = personaStore.list.findIndex(
      (p) => p.id === loadout.personaId,
    );
    if (personaIndex !== -1) {
      changeUserPersona(personaIndex);
    }
  }
  if (apply.includes("preset")) {
    let presetIndex = presetStore.list.findIndex(
      (p) => p.name === loadout.presetName,
    );
    if (presetIndex !== -1) {
      changeToPreset(presetIndex);
    }
  }
  if (apply.includes("modules")) {
    moduleStore.enabledModules = loadout.modules;
  }
  if (apply.includes("globalVariables")) {
    settingsStore.state.globalChatVariables = loadout.globalVariables;
  }
  settingsStore.state.lastLoadedLoadoutName = loadout.name;
}

export function saveCurrentLoadout(name: string) {
  const loadout = makeLoadout({ name });
  settingsStore.state.loadouts ??= [];
  settingsStore.state.loadouts.push(loadout);
  return loadout;
}

export function exportLoadout(loadout: Loadout) {
  //TODO
}

export function importLoadout() {
  //TODO
}
