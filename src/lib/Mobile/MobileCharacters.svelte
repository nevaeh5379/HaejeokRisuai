<script lang="ts">
    import { type character, type groupChat } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage } from "src/ts/characters";
    import { MobileSearch } from "src/ts/stores.svelte";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";

    interface Props {
        endGrid?: () => void;
        search?: string;
        hideTrash?: boolean;
    }

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: 'short' });
    const ITEM_HEIGHT = 73; // Height per character row in px
    const OVERSCAN = 4; // Extra items to render above/below viewport

    let {endGrid = () => {}, search, hideTrash = false}: Props = $props();
    let normalizedSearch = $derived(normalizeSearch(search ?? $MobileSearch));

    let scrollContainer: HTMLDivElement | null = $state(null);
    let scrollTop = $state(0);
    let viewportHeight = $state(600);

    function normalizeSearch(value:string){
        return value.replace(/ /g,"").toLocaleLowerCase();
    }

    function makeAgoText(time:number){
        if(time === 0){
            return "Unknown";
        }
        const diff = Date.now() - time;
        if(diff < 3600000){
            const min = Math.floor(diff / 60000);
            return agoFormatter.format(-min, 'minute');
        }
        if(diff < 86400000){
            const hour = Math.floor(diff / 3600000);
            return agoFormatter.format(-hour, 'hour');
        }
        if(diff < 604800000){
            const day = Math.floor(diff / 86400000);
            return agoFormatter.format(-day, 'day');
        }
        if(diff < 2592000000){
            const week = Math.floor(diff / 604800000);
            return agoFormatter.format(-week, 'week');
        }
        if(diff < 31536000000){
            const month = Math.floor(diff / 2592000000);
            return agoFormatter.format(-month, 'month');
        }
        const year = Math.floor(diff / 31536000000);
        return agoFormatter.format(-year, 'year');
    }

    function sortChar(char: (character|groupChat)[]) {
        return char.map((c, i) => ({ c, i })).filter(({ c }) => {
            return !hideTrash || !c.trashTime;
        }).map(({ c, i }) => {
            return {
                name: c.name || "Unnamed",
                image: c.image,
                chats: c.chats.length,
                i: i,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
            }
        }).sort((a, b) => {
            if (a.interaction === b.interaction) {
                return a.name.localeCompare(b.name);
            }
            return b.interaction - a.interaction;
        });
    }

    let filteredChars = $derived(
        sortChar(DBState.db.characters).filter(char =>
            normalizeSearch(char.name).includes(normalizedSearch)
        )
    );

    let totalCount = $derived(filteredChars.length);
    let startIndex = $derived(Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN));
    let endIndex = $derived(Math.min(totalCount, Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + OVERSCAN));

    let visibleItems = $derived(
        filteredChars.slice(startIndex, endIndex).map((item, relIndex) => ({
            item,
            index: startIndex + relIndex
        }))
    );

    let topOffsetY = $derived(startIndex * ITEM_HEIGHT);
    let bottomOffsetY = $derived(Math.max(0, (totalCount - endIndex) * ITEM_HEIGHT));

    function handleScroll(e: Event) {
        const target = e.currentTarget as HTMLDivElement;
        scrollTop = target.scrollTop;
    }
</script>

<div
    bind:this={scrollContainer}
    bind:clientHeight={viewportHeight}
    onscroll={handleScroll}
    class="flex flex-col items-center w-full overflow-y-auto h-full"
>
    {#if topOffsetY > 0}
        <div style="height: {topOffsetY}px; flex-shrink: 0; width: 100%;"></div>
    {/if}
    {#each visibleItems as { item: char, index }}
        <button
            class="flex p-2 border-t-darkborderc gap-2 w-full"
            class:border-t={index !== 0}
            style="height: {ITEM_HEIGHT}px; min-height: {ITEM_HEIGHT}px; max-height: {ITEM_HEIGHT}px; box-sizing: border-box;"
            onclick={() => {
                changeChar(char.i)
                endGrid()
            }}
        >
            <BarIcon additionalStyle={getCharImage(char.image, 'css', { thumbnail: true })}></BarIcon>
            <div class="flex flex-1 w-full flex-col justify-start items-start text-start overflow-hidden">
                <span class="truncate w-full">{char.name}</span>
                <div class="text-sm text-textcolor2 flex items-center w-full flex-wrap">
                    <span class="mr-1">{char.chats}</span>
                    <MessageSquareIcon size={14} />
                    <span class="mr-1 ml-1">|</span>
                    <span>{char.agoText}</span>
                </div>
            </div>
        </button>
    {/each}
    {#if bottomOffsetY > 0}
        <div style="height: {bottomOffsetY}px; flex-shrink: 0; width: 100%;"></div>
    {/if}
</div>

<button class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc" onclick={() => {
    addCharacter()
}}>
    <PlusIcon size={24} />
</button>
