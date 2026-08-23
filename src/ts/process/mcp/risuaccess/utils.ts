import {
  getCurrentCharacter,
  type character,
  type groupChat,
} from "src/ts/storage/database.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";

export function getCharacter(id: string): character | groupChat {
  return id
    ? characterStore.characters.find((c) => c.chaId === id || c.name === id)
    : getCurrentCharacter();
}
