<script lang="ts">
    import { FolderIcon, PlusIcon } from "@lucide/svelte";
    import LoreBookList from "src/lib/SideBars/LoreBook/LoreBookList.svelte";
    import type { RisuPersona, loreBook } from "src/ts/storage/database/schema";
    import { characterStore } from "src/ts/stores/domain";
    import { v4 } from "uuid";

    interface Props {
        persona: RisuPersona;
    }

    let { persona }: Props = $props();
    let expanded = $state(false);
    let selectedCharacterId = $state('');

    let availableBots = $derived(
        characterStore.characters.filter((character) => character.chaId && !character.trashTime)
    );
    let selectedLorebooks = $derived(
        selectedCharacterId ? persona.botLorebooks?.[selectedCharacterId] : undefined
    );

    $effect(() => {
        if (availableBots.some((character) => character.chaId === selectedCharacterId)) return;
        selectedCharacterId = characterStore.currentCharacter?.chaId
            ?? availableBots[0]?.chaId
            ?? '';
    });

    function ensureSelectedLorebooks(): loreBook[] | null {
        if (!selectedCharacterId) return null;
        persona.botLorebooks ??= {};
        persona.botLorebooks[selectedCharacterId] ??= [];
        return persona.botLorebooks[selectedCharacterId];
    }

    function addLorebook() {
        const lorebooks = ensureSelectedLorebooks();
        if (!lorebooks) return;
        lorebooks.push({
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: `New Lore ${lorebooks.length + 1}`,
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        });
    }

    function addFolder() {
        const lorebooks = ensureSelectedLorebooks();
        if (!lorebooks) return;
        lorebooks.push({
            key: `\uf000folder:${v4()}`,
            secondkey: '',
            insertorder: 100,
            comment: 'New Folder',
            content: '',
            mode: 'folder',
            alwaysActive: false,
            selective: false,
        });
    }
</script>

<div class="rounded-lg border border-darkborderc/60 bg-darkbg/30 shrink-0 overflow-hidden">
    <button
        type="button"
        class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-darkbutton/50 transition-colors cursor-pointer"
        onclick={() => { expanded = !expanded; }}
    >
        <div class="min-w-0">
            <div class="text-xs font-semibold text-textcolor">Per-bot Lorebooks</div>
            <div class="text-[10px] text-textcolor2 truncate">Lorebooks used only with this persona and bot combination</div>
        </div>
        <span class="text-xs text-textcolor2">{expanded ? '▲' : '▼'}</span>
    </button>

    {#if expanded}
        <div class="border-t border-darkborderc/50 p-2.5 flex flex-col gap-2 max-h-[42vh] overflow-y-auto">
            {#if availableBots.length === 0}
                <div class="text-xs text-textcolor2">No bots are available.</div>
            {:else}
                <div class="flex flex-wrap items-center gap-1.5">
                    <select
                        bind:value={selectedCharacterId}
                        class="min-w-0 flex-1 h-8 px-2 rounded-md border border-darkborderc bg-darkbutton text-textcolor text-xs"
                    >
                        {#each availableBots as bot}
                            <option value={bot.chaId}>{bot.name || 'Unnamed bot'}</option>
                        {/each}
                    </select>
                    <button
                        type="button"
                        class="h-8 px-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected/20 text-textcolor text-xs flex items-center gap-1 cursor-pointer"
                        onclick={addLorebook}
                    >
                        <PlusIcon size={13} /> Lore
                    </button>
                    <button
                        type="button"
                        class="h-8 px-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected/20 text-textcolor text-xs flex items-center gap-1 cursor-pointer"
                        onclick={addFolder}
                    >
                        <FolderIcon size={13} /> Folder
                    </button>
                </div>

                <div class="text-[10px] text-textcolor2">
                    These entries are added to the normal character, chat, and module lorebooks only when this persona is active for the selected bot.
                </div>

                {#if selectedLorebooks}
                    <LoreBookList externalLoreBooks={selectedLorebooks} />
                {:else}
                    <div class="rounded-md border border-dashed border-darkborderc p-3 text-center text-xs text-textcolor2">
                        No dedicated lorebook for this bot yet.
                    </div>
                {/if}
            {/if}
        </div>
    {/if}
</div>
