<script lang="ts">
    import { PlusIcon, XIcon } from '@lucide/svelte';
    import { MobileGUI, selectedCharID } from 'src/ts/stores.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { activeGenerationChatIds } from 'src/ts/process/chatRuntimeState';
    import {
        chatTabsStore,
        navigateToChatTab,
        type ChatTab,
    } from 'src/ts/chatTabs.svelte';

    let selectedCharacter = $derived(characterStore.characters[$selectedCharID]);
    let selectedChat = $derived(
        selectedCharacter?.chats?.[selectedCharacter.chatPage ?? 0],
    );

    $effect(() => {
        const characterId = selectedCharacter?.chaId;
        const chatId = selectedChat?.id;
        if (characterId && chatId) {
            chatTabsStore.syncActiveTarget(characterId, chatId);
        }
    });

    function getTabLabel(tab: ChatTab) {
        const character = characterStore.characters.find((item) => item.chaId === tab.characterId);
        const chat = character?.chats?.find((item) => item.id === tab.chatId);
        return {
            characterName: character?.name || 'RisuAI',
            chatName: chat?.name || 'Chat',
        };
    }

    function addTab() {
        chatTabsStore.addFromCurrent();
    }

    async function closeTab(event: Event, tab: ChatTab) {
        event.stopPropagation();
        const result = chatTabsStore.close(tab.id);
        if (result.activeChanged && result.activeTab) {
            await navigateToChatTab(result.activeTab.id);
        }
    }
</script>

<div
    class="shrink-0 h-10 flex items-end gap-1 pr-2 pt-1 overflow-x-auto bg-darkbg/70 border-b border-darkborderc backdrop-blur-sm"
    class:pl-14={!$MobileGUI}
    class:pl-2={$MobileGUI}
>
    {#each chatTabsStore.tabs as tab (tab.id)}
        {@const label = getTabLabel(tab)}
        {@const active = chatTabsStore.activeTabId === tab.id}
        {@const generating = $activeGenerationChatIds.has(tab.chatId)}
        <button
            class="group h-9 min-w-32 max-w-56 px-2 rounded-t-md flex items-center gap-2 border border-b-0 border-darkborderc transition-colors"
            class:bg-selected={active}
            class:bg-bgcolor={!active}
            class:text-textcolor={active}
            class:text-textcolor2={!active}
            title={`${label.characterName} · ${label.chatName}`}
            onclick={() => void navigateToChatTab(tab.id)}
        >
            {#if generating}
                <span class="w-3 h-3 shrink-0 rounded-full border-2 border-current border-r-transparent animate-spin"></span>
            {:else if tab.unread}
                <span class="w-2 h-2 shrink-0 rounded-full bg-green-500"></span>
            {/if}
            <span class="min-w-0 flex-1 text-left leading-tight">
                <span class="block truncate text-xs font-medium">{label.characterName}</span>
                <span class="block truncate text-[10px] opacity-70">{label.chatName}</span>
            </span>
            {#if chatTabsStore.tabs.length > 1}
                <span
                    role="button"
                    tabindex="0"
                    class="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 hover:bg-black/20"
                    onclick={(event) => void closeTab(event, tab)}
                    onkeydown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            void closeTab(event, tab);
                        }
                    }}
                    aria-label="Close chat tab"
                >
                    <XIcon size={14} />
                </span>
            {/if}
        </button>
    {/each}
    <button
        class="h-8 w-8 mb-0.5 shrink-0 flex items-center justify-center rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors"
        title="New chat tab"
        aria-label="New chat tab"
        onclick={addTab}
    >
        <PlusIcon size={17} />
    </button>
</div>
