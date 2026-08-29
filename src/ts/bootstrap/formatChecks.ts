import { v4 as uuidv4 } from "uuid";
import { checkCharOrder } from "../globalApi.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";

/**
 * Checks and updates the database format to the latest version.
 */
export async function checkNewFormat(): Promise<void> {
  // Runtime storage is SQL-only. Legacy aggregate migrations are completed
  // before startup data is installed, so format checks must never reach into
  // domain-owned state through SettingsStore.
  checkCharOrder();
}

/**
 * Assigns unique IDs to characters and chats.
 */
export function assignIds() {
  const characters = characterStore.characters;
  if (!characters) {
    return;
  }
  const assignedIds = new Set<string>();
  for (const cha of characters) {
    if (!cha) {
      continue;
    }
    if (!cha.chaId) {
      cha.chaId = uuidv4();
    }
    if (assignedIds.has(cha.chaId)) {
      console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
      cha.chaId = uuidv4();
    }
    assignedIds.add(cha.chaId);
    // SQL startup may expose character metadata before its chats have
    // been hydrated. IDs are assigned when those rows are loaded/created.
    for (const chat of cha.chats ?? []) {
      if (!chat) {
        continue;
      }
      if (!chat.id) {
        chat.id = uuidv4();
      }
      if (assignedIds.has(chat.id)) {
        console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
        chat.id = uuidv4();
      }
      assignedIds.add(chat.id);
    }
  }
}
