## 2024-05-19 - Unkeyed blocks in Mobile UI Lists
**Learning:** `src/lib/Mobile/MobileCharacters.svelte` and `src/lib/Mobile/MobileChatList.svelte` have unkeyed each blocks `{#each visibleItems as { item: char, index }}` and `{#each (selectedFolderFilter === "all" && folders.length > 0 ? unassignedChats : filteredChats) as { chat, index }}`. Since these lists are virtualized or sortable, unkeyed each blocks cause unnecessary re-renders.
**Action:** Let's fix this in MobileCharacters.svelte, MobileChatList.svelte, and SideChatList.svelte to add keys like `(index)` or `(chat.id)`.
