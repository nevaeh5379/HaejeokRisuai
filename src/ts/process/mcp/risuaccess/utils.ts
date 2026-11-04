import type { groupChat } from "@risuai/protocol/domain/database.ts";
import type { character } from "@risuai/protocol/domain/legacy/character.ts";

import { characterStore } from "src/ts/stores/domain/characterStore.svelte";

export function getCharacter(id: string): character | groupChat {
  return id
    ? characterStore.characters.find((c) => c.chaId === id || c.name === id)
    : characterStore.currentCharacter;
}
