import { get } from "svelte/store";
import { chatTabsStore } from "../chatTabs.svelte";
import { activeGenerationChatIds } from "../process/chatRuntimeState";

/**
 * Chats whose live in-memory state must survive background compaction.
 * Visible split panes and both local/remote generations are always protected.
 */
export function getProtectedChatIds(
  additionalChatIds: Iterable<string | undefined> = [],
): Set<string> {
  const protectedIds = new Set(get(activeGenerationChatIds));

  for (const group of chatTabsStore.groups) {
    const chatId = chatTabsStore.activeTabForGroup(group.id)?.chatId;
    if (chatId) protectedIds.add(chatId);
  }

  for (const chatId of additionalChatIds) {
    if (chatId) protectedIds.add(chatId);
  }

  return protectedIds;
}
