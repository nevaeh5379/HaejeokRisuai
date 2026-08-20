<script lang="ts">
    import { onMount } from "svelte";
    import DOMPurify from 'dompurify';
    import { XIcon, SearchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { messageSearchOpen, DBState, selectedCharID, ScrollToMessageStore } from "src/ts/stores.svelte";
    import { forageStorage } from "src/ts/globalApi.svelte";
    import { NodeStorage } from "src/ts/storage/nodeStorage";
    import type { NodePostgresMessageSearchResult } from "src/ts/storage/nodePostgresStorage";
    import { changeChar } from "src/ts/characters";
    import { changeChatTo } from "src/ts/globalApi.svelte";
    import { findCharacterIndexbyId } from "src/ts/util";
    import { preLoadChat, coldStorageHeader } from "src/ts/process/coldstorage.svelte";

    let query = $state('');
    let scope = $state<'all'|'active'|'cold'>('all');
    let results = $state<NodePostgresMessageSearchResult[]>([]);
    let searching = $state(false);
    let searched = $state(false);
    let error = $state('');
    let inputEl: HTMLInputElement | undefined = $state();

    const close = () => $messageSearchOpen = false;

    function getNodeStorage(): NodeStorage | null {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            return null;
        }
        return forageStorage.realStorage;
    }

    async function runSearch() {
        const q = query.trim();
        if (!q) {
            results = [];
            searched = false;
            return;
        }
        const storage = getNodeStorage();
        if (!storage || !storage.postgres.isEnabled()) {
            error = language.messageSearchUnavailable;
            searched = true;
            return;
        }
        searching = true;
        error = '';
        try {
            results = await storage.postgres.searchMessages(q, scope, 50);
            searched = true;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            searched = true;
        } finally {
            searching = false;
        }
    }

    async function openResult(result: NodePostgresMessageSearchResult) {
        const characterId = result.characterId;
        if (!characterId) {
            return;
        }
        const charIndex = findCharacterIndexbyId(characterId);
        if (charIndex === -1) {
            return;
        }
        close();
        await changeChar(charIndex, {});

        const char = DBState.db.characters[charIndex];
        if (!char) {
            return;
        }

        let chatIndex = -1;
        if (result.storageState === 'active' && result.chatId) {
            chatIndex = char.chats.findIndex((c) => c.id === result.chatId);
        } else if (result.archiveId) {
            const header = coldStorageHeader + result.archiveId;
            chatIndex = char.chats.findIndex((c) => c.message?.[0]?.data === header);
        }

        if (chatIndex === -1) {
            return;
        }

        changeChatTo(chatIndex);
        await preLoadChat(charIndex, chatIndex, { full: true });
        ScrollToMessageStore.value = result.position;
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            close();
        } else if (e.key === 'Enter') {
            runSearch();
        }
    }

    onMount(() => {
        inputEl?.focus();
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed top-0 left-0 w-full h-full z-40 bg-black/50 flex justify-center items-center"
    onclick={(event) => {
        if (event.target === event.currentTarget) {
            close();
        }
    }}
    onkeydown={onKeydown}
>
    <div class="bg-darkbg p-3 rounded-md flex flex-col max-w-2xl w-full max-h-[90%] overflow-y-auto">
        <div class="flex items-center text-textcolor mb-3">
            <h2 class="text-xl font-bold">{language.messageSearch}</h2>
            <div class="ml-auto flex items-center gap-2">
                <button class="text-textcolor2 hover:text-textcolor" onclick={close}>
                    <XIcon size={24} />
                </button>
            </div>
        </div>

        <div class="flex items-center gap-2 mb-3">
            <div class="flex items-center grow border border-darkborderc rounded-md px-2">
                <SearchIcon size={18} class="text-textcolor2 shrink-0" />
                <input
                    bind:this={inputEl}
                    bind:value={query}
                    placeholder={language.messageSearchPlaceholder}
                    class="peer focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 bg-transparent input-text grow resize-none overflow-hidden"
                />
            </div>
            <button
                class="shrink-0 px-3 py-2 rounded-md bg-textcolor2 text-white hover:bg-blue-500 transition-colors"
                onclick={runSearch}
                disabled={searching}
            >
                {searching ? '...' : language.search}
            </button>
        </div>

        <div class="flex items-center gap-2 mb-3 text-sm">
            <button
                class="px-2 py-1 rounded-md border"
                class:bg-selected={scope === 'all'}
                class:border-darkborderc={scope !== 'all'}
                onclick={() => scope = 'all'}
            >
                {language.messageSearchScopeAll}
            </button>
            <button
                class="px-2 py-1 rounded-md border"
                class:bg-selected={scope === 'active'}
                class:border-darkborderc={scope !== 'active'}
                onclick={() => scope = 'active'}
            >
                {language.messageSearchScopeActive}
            </button>
            <button
                class="px-2 py-1 rounded-md border"
                class:bg-selected={scope === 'cold'}
                class:border-darkborderc={scope !== 'cold'}
                onclick={() => scope = 'cold'}
            >
                {language.messageSearchScopeCold}
            </button>
        </div>

        {#if error}
            <p class="text-red-500 text-sm">{error}</p>
        {:else if searched && results.length === 0}
            <p class="text-textcolor2">{language.messageSearchNoResults}</p>
        {:else}
            <div class="flex flex-col gap-2">
                {#each results as result, index (index)}
                    <button
                        class="text-left border border-darkborderc rounded-lg p-3 hover:bg-selected transition-colors"
                        onclick={() => openResult(result)}
                    >
                        <div class="flex items-center gap-2 text-xs text-textcolor2 mb-1">
                            <span>{result.characterName ?? '?'}</span>
                            {#if result.chatName}
                                <span>· {result.chatName}</span>
                            {/if}
                            <span class="ml-auto">{result.storageState === 'cold' ? language.messageSearchScopeCold : language.messageSearchScopeActive}</span>
                        </div>
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="text-textcolor text-sm">
                            {@html DOMPurify.sanitize(result.snippet)}
                        </div>
                    </button>
                {/each}
            </div>
        {/if}
    </div>
</div>
