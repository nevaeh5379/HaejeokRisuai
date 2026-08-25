<script lang="ts">
    import { SearchIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import {
        searchSettings,
        type SettingSearchResult,
    } from "src/ts/setting/searchIndex";

    interface Props {
        onselect: (result: SettingSearchResult) => void;
    }

    let { onselect }: Props = $props();
    let query = $state("");
    let focused = $state(false);
    let results = $derived(searchSettings(query));
    let showResults = $derived(focused && query.trim().length > 0);

    function select(result: SettingSearchResult) {
        query = "";
        focused = false;
        onselect(result);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === "Escape") {
            query = "";
            (event.currentTarget as HTMLInputElement).blur();
        } else if (event.key === "Enter" && results.length > 0) {
            event.preventDefault();
            select(results[0]);
        }
    }
</script>
<div class="relative mb-3 w-full">
    <div class="flex items-center gap-2 rounded-md border border-darkborderc bg-bgcolor px-2 py-1.5 focus-within:border-borderc">
        <SearchIcon size={17} class="shrink-0 text-textcolor2" />
        <input
            class="min-w-0 grow bg-transparent text-sm text-textcolor outline-hidden"
            placeholder={`${language.search} ${language.settings}`}
            bind:value={query}
            onfocus={() => focused = true}
            onblur={() => setTimeout(() => focused = false, 120)}
            onkeydown={handleKeydown}
        />
        {#if query}
            <button
                class="shrink-0 text-textcolor2 hover:text-textcolor"
                aria-label="Clear settings search"
                onclick={() => query = ""}
            >
                <XIcon size={15} />
            </button>
        {/if}
    </div>

    {#if showResults}
        <div class="absolute left-0 right-0 top-full z-50 mt-1 max-h-[55vh] overflow-y-auto rounded-md border border-darkborderc bg-darkbg p-1 shadow-xl">
            {#if results.length === 0}
                <div class="px-2 py-3 text-sm text-textcolor2">
                    No matching settings
                </div>
            {:else}
                {#each results as result (result.key)}
                    <button
                        class="flex w-full flex-col items-start rounded px-2 py-2 text-left hover:bg-selected"
                        onmousedown={(event) => event.preventDefault()}
                        onclick={() => select(result)}
                    >
                        <span class="text-sm text-textcolor">{result.label}</span>
                        {#if result.location}
                            <span class="text-xs text-textcolor2">{result.location}</span>
                        {/if}
                        {#if result.help}
                            <span class="line-clamp-2 text-xs text-textcolor2 opacity-70">
                                {result.help}
                            </span>
                        {/if}
                    </button>
                {/each}
            {/if}
        </div>
    {/if}
</div>
