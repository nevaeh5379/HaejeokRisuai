<script lang="ts">
    import type { character, groupChat, folder } from "../../ts/storage/schema";
    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { createNewCharacter, createNewGroup, changeChar, getCharImage, removeChar, duplicateCharacter } from "src/ts/characters";
    import { exportChar, importCharacter } from "src/ts/characterCards";
    import { MobileSearch, selectedCharID, MobileGUIStack } from "src/ts/stores.svelte";
    import {
        MessageSquareIcon,
        PlusIcon,
        LayoutGridIcon,
        ListIcon,
        TrashIcon,
        Undo2Icon,
        CopyIcon,
        DownloadIcon,
        UploadIcon,
        MoreVerticalIcon,
        UsersIcon,
        UserIcon,
        XIcon,
        ArrowUpDownIcon,
        GlobeIcon,
        SearchIcon,
        CheckIcon
    } from "@lucide/svelte";
    import { alertConfirm, alertNormal } from "src/ts/alert";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid";
    import { language } from "src/lang";
    import AirisuMascot from "../UI/AirisuMascot.svelte";

    interface Props {
        endGrid?: () => void;
        search?: string;
        hideTrash?: boolean;
    }

    let { endGrid = () => {}, search, hideTrash = false }: Props = $props();

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: 'short' });
    const ITEM_HEIGHT = 76; // Height per character row in px
    const OVERSCAN = 4; // Extra items to render above/below viewport

    // View settings
    let viewMode = $state<'list' | 'grid'>('list');
    let sortMode = $state<'recent' | 'name' | 'chats' | 'newest'>('recent');
    let selectedTag = $state<string>('');
    let selectedFolderId = $state<string>('all'); // 'all', 'none', or folder.id
    let showTrash = $state<boolean>(false);
    let speedDialOpen = $state<boolean>(false);
    let activeActionMenuChar = $state<{ item: character | groupChat; index: number } | null>(null);
    let showSortMenu = $state<boolean>(false);

    let scrollContainer: HTMLDivElement | null = $state(null);
    let scrollTop = $state(0);
    let viewportHeight = $state(600);

    let normalizedSearch = $derived(normalizeSearch(search ?? $MobileSearch));

    function normalizeSearch(value: string) {
        return value.replace(/ /g, "").toLocaleLowerCase();
    }

    function makeAgoText(time: number) {
        if (!time || time === 0) return "Unknown";
        const diff = Date.now() - time;
        if (diff < 60000) return "Just now";
        if (diff < 3600000) {
            const min = Math.floor(diff / 60000);
            return agoFormatter.format(-min, 'minute');
        }
        if (diff < 86400000) {
            const hour = Math.floor(diff / 3600000);
            return agoFormatter.format(-hour, 'hour');
        }
        if (diff < 604800000) {
            const day = Math.floor(diff / 86400000);
            return agoFormatter.format(-day, 'day');
        }
        if (diff < 2592000000) {
            const week = Math.floor(diff / 604800000);
            return agoFormatter.format(-week, 'week');
        }
        if (diff < 31536000000) {
            const month = Math.floor(diff / 2592000000);
            return agoFormatter.format(-month, 'month');
        }
        const year = Math.floor(diff / 31536000000);
        return agoFormatter.format(-year, 'year');
    }

    // Extract all unique tags across non-deleted characters
    let availableTags = $derived.by(() => {
        const tagSet = new Set<string>();
        for (const c of characterStore.characters) {
            if (c.trashTime) continue;
            const tags = (c as any).tags ?? (c as any).category ?? [];
            if (Array.isArray(tags)) {
                for (const t of tags) {
                    if (typeof t === 'string' && t.trim()) tagSet.add(t.trim());
                }
            }
        }
        return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    });

    // Available Folders
    let availableFolders = $derived.by(() => {
        const order = settingsStore.state.characterOrder || [];
        const folders: folder[] = [];
        for (const item of order) {
            if (typeof item === 'object' && item && 'data' in item && 'name' in item) {
                folders.push(item as folder);
            }
        }
        return folders;
    });

    // Count of deleted characters in trash
    let trashCount = $derived.by(() => {
        return characterStore.characters.filter(c => Boolean(c.trashTime)).length;
    });

    // Main sorted & filtered characters list
    let filteredChars = $derived.by(() => {
        const chars = characterStore.characters;
        const result: Array<{
            c: character | groupChat;
            i: number;
            name: string;
            image: string;
            chats: number;
            interaction: number;
            agoText: string;
            tags: string[];
            isGroup: boolean;
            folderId?: string;
        }> = [];

        for (let i = 0; i < chars.length; i++) {
            const c = chars[i];
            const isTrash = Boolean(c.trashTime);

            // Trash filter mode
            if (showTrash) {
                if (!isTrash) continue;
            } else {
                if (isTrash) continue;
            }

            // Tag filter
            const charTags: string[] = (c as any).tags ?? (c as any).category ?? [];
            if (selectedTag && !charTags.some(t => t.toLowerCase() === selectedTag.toLowerCase())) {
                continue;
            }

            // Folder filter
            if (selectedFolderId !== 'all') {
                const folderId = (c as any).folderId;
                if (selectedFolderId === 'none') {
                    if (folderId) continue;
                } else if (folderId !== selectedFolderId) {
                    continue;
                }
            }

            // Search query filter
            const charName = c.name || "Unnamed";
            if (normalizedSearch && !normalizeSearch(charName).includes(normalizedSearch)) {
                continue;
            }

            result.push({
                c,
                i,
                name: charName,
                image: c.image,
                chats: c.chats ? c.chats.length : 0,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
                tags: charTags,
                isGroup: c.type === 'group',
                folderId: (c as any).folderId,
            });
        }

        // Sorting
        result.sort((a, b) => {
            switch (sortMode) {
                case 'name':
                    return a.name.localeCompare(b.name);
                case 'chats':
                    return b.chats - a.chats;
                case 'newest':
                    return ((b.c as any).createdTime || b.i) - ((a.c as any).createdTime || a.i);
                case 'recent':
                default:
                    if (a.interaction === b.interaction) {
                        return a.name.localeCompare(b.name);
                    }
                    return b.interaction - a.interaction;
            }
        });

        return result;
    });

    let totalCount = $derived(filteredChars.length);
    let startIndex = $derived(Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN));
    let endIndex = $derived(Math.min(totalCount, Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + OVERSCAN));

    let columnCount = $derived.by(() => {
        if (typeof window !== 'undefined' && window.innerWidth >= 640) return 3;
        return 2;
    });

    let columns = $derived.by(() => {
        const cols: typeof filteredChars[] = Array.from({ length: columnCount }, () => []);
        for (let i = 0; i < filteredChars.length; i++) {
            cols[i % columnCount].push(filteredChars[i]);
        }
        return cols;
    });

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

    async function handleDuplicateChar(charIndex: number) {
        activeActionMenuChar = null;
        const duplicated = await duplicateCharacter(charIndex);
        if (duplicated) {
            alertNormal("Character duplicated");
        }
    }

    async function handleExportChar(charIndex: number) {
        activeActionMenuChar = null;
        await exportChar(charIndex);
    }

    async function handleDeleteChar(charIndex: number, name: string) {
        activeActionMenuChar = null;
        await removeChar(charIndex, name, 'normal');
    }

    async function handleRestoreChar(charIndex: number) {
        const char = characterStore.characters[charIndex];
        if (char) {
            char.trashTime = undefined;
            checkCharOrder();
            characterStore.markCharacterDirty(char.chaId);
            characterStore.markCharacterOrderDirty();
            alertNormal("Character restored");
        }
    }

    async function handlePermanentDeleteChar(charIndex: number, name: string) {
        await removeChar(charIndex, name, 'permanent');
    }

    async function handleEmptyTrash() {
        if (await alertConfirm("Permanently delete all characters in trash?")) {
            characterStore.characters = characterStore.characters.filter(c => !c.trashTime);
            checkCharOrder();
            characterStore.markCharacterOrderDirty();
            showTrash = false;
        }
    }

    async function handleImportCard() {
        speedDialOpen = false;
        await importCharacter();
        checkCharOrder();
    }

    function handleCreateNewChar() {
        speedDialOpen = false;
        const newIdx = createNewCharacter();
        changeChar(newIdx);
        endGrid();
    }

    function handleCreateGroup() {
        speedDialOpen = false;
        const newIdx = createNewGroup();
        changeChar(newIdx);
        endGrid();
    }

    function handleOpenRealm() {
        speedDialOpen = false;
        MobileGUIStack.set(0);
    }
</script>

<div class="flex flex-col w-full h-full bg-bgcolor text-textcolor overflow-hidden relative select-none">
    <!-- Toolbar: Filter Modes & Views -->
    <div class="w-full px-3 py-2 border-b border-darkborderc/60 bg-darkbg/50 backdrop-blur-sm flex flex-col gap-2 shrink-0 z-10">
        <!-- Top Row: Section Tabs, Count, View Mode Toggle -->
        <div class="flex items-center justify-between gap-1">
            <!-- Left Tabs: All / Trash -->
            <div class="flex items-center gap-1 min-w-0">
                <button
                    onclick={() => { showTrash = false; }}
                    class="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5"
                    class:bg-selected={!showTrash}
                    class:text-white={!showTrash}
                    class:text-textcolor2={showTrash}
                    class:hover:text-textcolor={showTrash}
                >
                    <UserIcon size={14} />
                    <span>All</span>
                    <span class="text-[10px] opacity-80">({characterStore.characters.filter(c => !c.trashTime).length})</span>
                </button>

                {#if trashCount > 0}
                    <button
                        onclick={() => { showTrash = true; }}
                        class="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5"
                        class:bg-draculared={showTrash}
                        class:text-white={showTrash}
                        class:text-textcolor2={!showTrash}
                        class:hover:text-textcolor={!showTrash}
                    >
                        <TrashIcon size={14} />
                        <span>{language.trash}</span>
                        <span class="text-[10px] opacity-80">({trashCount})</span>
                    </button>
                {/if}
            </div>

            <!-- Right Controls: Sort & Layout Toggle -->
            <div class="flex items-center gap-1 shrink-0">
                <!-- Sort Dropdown Trigger -->
                <div class="relative">
                    <button
                        onclick={() => { showSortMenu = !showSortMenu; }}
                        class="p-1.5 rounded-lg border border-darkborderc bg-darkbutton/70 text-textcolor2 hover:text-textcolor transition-colors flex items-center gap-1 text-xs"
                        aria-label="Sort characters"
                    >
                        <ArrowUpDownIcon size={14} />
                        <span class="text-[11px] font-medium hidden xs:inline">
                            {sortMode === 'recent' ? (language.recent || 'Recent') :
                             sortMode === 'name' ? (language.name || 'Name') :
                             sortMode === 'chats' ? (language.Chat || 'Chats') : 'Newest'}
                        </span>
                    </button>

                    {#if showSortMenu}
                        <button
                            type="button"
                            tabindex="-1"
                            class="fixed inset-0 z-30 bg-transparent cursor-default"
                            onclick={() => { showSortMenu = false; }}
                            aria-label="Close sort menu"
                        ></button>
                        <div class="absolute right-0 top-8 z-40 bg-darkbg border border-darkborderc rounded-xl p-1 shadow-xl min-w-[130px] flex flex-col gap-0.5">
                            <button
                                onclick={() => { sortMode = 'recent'; showSortMenu = false; }}
                                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors {sortMode === 'recent' ? 'bg-selected text-white font-semibold' : 'text-textcolor hover:bg-darkbutton'}"
                            >
                                <span>{language.recent || 'Recent'}</span>
                                {#if sortMode === 'recent'}<CheckIcon size={12} />{/if}
                            </button>
                            <button
                                onclick={() => { sortMode = 'name'; showSortMenu = false; }}
                                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors {sortMode === 'name' ? 'bg-selected text-white font-semibold' : 'text-textcolor hover:bg-darkbutton'}"
                            >
                                <span>{language.name || 'Name'}</span>
                                {#if sortMode === 'name'}<CheckIcon size={12} />{/if}
                            </button>
                            <button
                                onclick={() => { sortMode = 'chats'; showSortMenu = false; }}
                                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors {sortMode === 'chats' ? 'bg-selected text-white font-semibold' : 'text-textcolor hover:bg-darkbutton'}"
                            >
                                <span>{language.Chat || 'Chats'}</span>
                                {#if sortMode === 'chats'}<CheckIcon size={12} />{/if}
                            </button>
                            <button
                                onclick={() => { sortMode = 'newest'; showSortMenu = false; }}
                                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors {sortMode === 'newest' ? 'bg-selected text-white font-semibold' : 'text-textcolor hover:bg-darkbutton'}"
                            >
                                <span>Newest</span>
                                {#if sortMode === 'newest'}<CheckIcon size={12} />{/if}
                            </button>
                        </div>
                    {/if}
                </div>

                <!-- View Mode (List / Grid) -->
                <button
                    onclick={() => { viewMode = viewMode === 'list' ? 'grid' : 'list'; }}
                    class="p-1.5 rounded-lg border border-darkborderc bg-darkbutton/70 text-textcolor2 hover:text-textcolor transition-colors"
                    title={viewMode === 'list' ? "Grid view" : "List view"}
                    aria-label="Toggle view layout"
                >
                    {#if viewMode === 'list'}
                        <LayoutGridIcon size={15} />
                    {:else}
                        <ListIcon size={15} />
                    {/if}
                </button>
            </div>
        </div>

        <!-- Tag Chips Scrollbar (if tags exist) -->
        {#if !showTrash && availableTags.length > 0}
            <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                <button
                    onclick={() => { selectedTag = ''; }}
                    class="px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition-colors border"
                    class:bg-selected={selectedTag === ''}
                    class:text-white={selectedTag === ''}
                    class:border-selected={selectedTag === ''}
                    class:border-darkborderc={selectedTag !== ''}
                    class:text-textcolor2={selectedTag !== ''}
                    class:hover:text-textcolor={selectedTag !== ''}
                >
                    # All
                </button>
                {#each availableTags as tag}
                    <button
                        onclick={() => { selectedTag = selectedTag === tag ? '' : tag; }}
                        class="px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition-colors border"
                        class:bg-selected={selectedTag === tag}
                        class:text-white={selectedTag === tag}
                        class:border-selected={selectedTag === tag}
                        class:border-darkborderc={selectedTag !== tag}
                        class:text-textcolor2={selectedTag !== tag}
                        class:hover:text-textcolor={selectedTag !== tag}
                    >
                        #{tag}
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Trash Banner with Empty Button (if in trash mode) -->
        {#if showTrash}
            <div class="flex items-center justify-between bg-draculared/10 border border-draculared/30 rounded-xl px-3 py-1.5 text-xs">
                <span class="text-draculared font-semibold flex items-center gap-1.5">
                    <TrashIcon size={14} />
                    <span>{language.trash}</span>
                </span>
                <button
                    onclick={handleEmptyTrash}
                    class="px-2 py-0.5 rounded-lg bg-draculared text-white font-medium hover:bg-draculared/90 transition-colors text-[11px]"
                >
                    Empty Trash
                </button>
            </div>
        {/if}
    </div>

    <!-- Main Body Content -->
    <div class="flex-1 min-h-0 w-full overflow-hidden relative">
        <!-- EMPTY STATE (0 characters or search no match) -->
        {#if filteredChars.length === 0}
            <div class="w-full h-full flex flex-col items-center justify-center p-6 text-center gap-4">
                {#if showTrash}
                    <div class="w-16 h-16 rounded-full bg-darkbutton/50 border border-darkborderc flex items-center justify-center text-textcolor2">
                        <TrashIcon size={28} />
                    </div>
                    <div class="flex flex-col gap-1">
                        <h3 class="font-bold text-base text-textcolor">Trash is empty</h3>
                        <p class="text-xs text-textcolor2">No deleted characters.</p>
                    </div>
                {:else if normalizedSearch || selectedTag}
                    <div class="w-16 h-16 rounded-full bg-darkbutton/50 border border-darkborderc flex items-center justify-center text-textcolor2">
                        <SearchIcon size={28} />
                    </div>
                    <div class="flex flex-col gap-1">
                        <h3 class="font-bold text-base text-textcolor">No characters found</h3>
                        <p class="text-xs text-textcolor2">No characters matching your filters.</p>
                    </div>
                    <button
                        onclick={() => { normalizedSearch = ''; $MobileSearch = ''; selectedTag = ''; }}
                        class="px-4 py-2 rounded-xl bg-darkbutton border border-darkborderc text-xs font-semibold text-textcolor hover:bg-selected transition-colors"
                    >
                        Clear filters
                    </button>
                {:else}
                    <!-- Brand New App - No Characters Yet -->
                    <div class="relative w-28 h-28 rounded-2xl overflow-hidden border border-darkborderc bg-textcolor/5 flex items-end justify-center p-1 shadow-md">
                        <AirisuMascot variant="welcome" alt="Airisu" className="w-full h-full object-contain" eager />
                    </div>
                    <div class="flex flex-col gap-1 max-w-xs">
                        <h3 class="font-bold text-base text-textcolor">Welcome to RisuAI</h3>
                        <p class="text-xs text-textcolor2">Create your first AI character or import cards to start chatting.</p>
                    </div>
                    <div class="flex flex-col gap-2 w-full max-w-xs pt-2">
                        <button
                            onclick={handleCreateNewChar}
                            class="w-full py-2.5 rounded-xl bg-selected hover:bg-selected/90 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all active:scale-[0.98]"
                        >
                            <PlusIcon size={16} />
                            <span>{language.createfromScratch}</span>
                        </button>
                        <button
                            onclick={handleImportCard}
                            class="w-full py-2.5 rounded-xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor font-semibold text-xs flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
                        >
                            <UploadIcon size={16} />
                            <span>{language.importCharacter}</span>
                        </button>
                        <button
                            onclick={handleOpenRealm}
                            class="w-full py-2.5 rounded-xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor font-semibold text-xs flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
                        >
                            <GlobeIcon size={16} />
                            <span>Explore RisuRealm</span>
                        </button>
                    </div>
                {/if}
            </div>

        <!-- LIST VIEW -->
        {:else if viewMode === 'list'}
            <div
                bind:this={scrollContainer}
                bind:clientHeight={viewportHeight}
                onscroll={handleScroll}
                class="w-full h-full overflow-y-auto divide-y divide-darkborderc/40 pb-20"
            >
                {#if topOffsetY > 0}
                    <div style="height: {topOffsetY}px; flex-shrink: 0; width: 100%;"></div>
                {/if}
                {#each visibleItems as { item: char, index }}
                    <!-- Character Row -->
                    <div
                        role="button"
                        tabindex="0"
                        class="flex items-center px-3 py-2.5 gap-3 w-full hover:bg-darkbutton/40 active:bg-selected/20 transition-colors cursor-pointer"
                        style="height: {ITEM_HEIGHT}px; min-height: {ITEM_HEIGHT}px; box-sizing: border-box;"
                        onclick={() => {
                            if (!showTrash) {
                                changeChar(char.i);
                                endGrid();
                            }
                        }}
                        onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                if (!showTrash) {
                                    changeChar(char.i);
                                    endGrid();
                                }
                            }
                        }}
                    >
                        <!-- Character Avatar -->
                        <div class="relative shrink-0">
                            {#if char.image}
                                <BarIcon additionalStyle={getCharImage(char.image, 'css', { thumbnail: true })}></BarIcon>
                            {:else}
                                <div class="w-12 h-12 rounded-xl bg-darkbg border border-darkborderc flex items-center justify-center text-textcolor2">
                                    {#if char.isGroup}
                                        <UsersIcon size={22} />
                                    {:else}
                                        <UserIcon size={22} />
                                    {/if}
                                </div>
                            {/if}
                            {#if char.isGroup}
                                <span class="absolute -bottom-1 -right-1 p-0.5 rounded-full bg-blue-500 text-white shadow-xs">
                                    <UsersIcon size={10} />
                                </span>
                            {/if}
                        </div>

                        <!-- Character Name & Metadata -->
                        <div class="flex flex-1 flex-col justify-center min-w-0 text-left">
                            <div class="flex items-center gap-1.5">
                                <span class="font-bold text-sm text-textcolor truncate leading-tight">{char.name}</span>
                            </div>
                            <div class="text-[11px] text-textcolor2 flex items-center gap-2 mt-1">
                                <span class="flex items-center gap-1">
                                    <MessageSquareIcon size={12} class="opacity-70" />
                                    <span>{char.chats}</span>
                                </span>
                                <span class="opacity-40">·</span>
                                <span>{char.agoText}</span>
                                {#if char.tags.length > 0}
                                    <span class="opacity-40">·</span>
                                    <span class="truncate opacity-75">#{char.tags[0]}</span>
                                {/if}
                            </div>
                        </div>

                        <!-- Right Action / Menu -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="shrink-0 flex items-center gap-1" onclick={(e) => e.stopPropagation()}>
                            {#if showTrash}
                                <button
                                    onclick={() => handleRestoreChar(char.i)}
                                    class="p-2 rounded-lg text-textcolor2 hover:text-green-400 hover:bg-green-500/10 transition-colors"
                                    title="Restore"
                                    aria-label="Restore character"
                                >
                                    <Undo2Icon size={18} />
                                </button>
                                <button
                                    onclick={() => handlePermanentDeleteChar(char.i, char.name)}
                                    class="p-2 rounded-lg text-textcolor2 hover:text-draculared hover:bg-draculared/10 transition-colors"
                                    title="Delete permanently"
                                    aria-label="Delete character permanently"
                                >
                                    <TrashIcon size={18} />
                                </button>
                            {:else}
                                <button
                                    onclick={() => { activeActionMenuChar = { item: char.c, index: char.i }; }}
                                    class="p-2 rounded-lg text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                                    title="More options"
                                    aria-label="Character options"
                                >
                                    <MoreVerticalIcon size={18} />
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
                {#if bottomOffsetY > 0}
                    <div style="height: {bottomOffsetY}px; flex-shrink: 0; width: 100%;"></div>
                {/if}
            </div>

        <!-- GRID VIEW (Masonry Layout with Natural Automatic Image Ratios) -->
        {:else}
            <div class="w-full h-full overflow-y-auto p-2.5 pb-24 flex gap-2.5 items-start">
                {#each columns as col}
                    <div class="flex-1 flex flex-col gap-2.5 min-w-0">
                        {#each col as char (char.c.chaId || char.i)}
                            <div
                                role="button"
                                tabindex="0"
                                class="group relative w-full overflow-hidden rounded-2xl border border-darkborderc bg-darkbg/60 block transition-all shadow-xs hover:border-textcolor/40 active:scale-[0.98] cursor-pointer"
                                onclick={() => {
                                    if (!showTrash) {
                                        changeChar(char.i);
                                        endGrid();
                                    }
                                }}
                                onkeydown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        if (!showTrash) {
                                            changeChar(char.i);
                                            endGrid();
                                        }
                                    }
                                }}
                            >
                                <!-- Full Artwork Image in Natural Automatic Aspect Ratio -->
                                {#if char.image}
                                    {#await getCharImage(char.image, 'plain')}
                                        <div class="w-full min-h-[140px] aspect-[3/4] bg-darkbg animate-pulse flex items-center justify-center">
                                            <UserIcon size={32} class="text-textcolor2/30" />
                                        </div>
                                    {:then src}
                                        {#if src}
                                            <img
                                                {src}
                                                alt={char.name}
                                                class="w-full h-auto object-cover object-top block transition-transform duration-300 group-hover:scale-105"
                                                loading="lazy"
                                                decoding="async"
                                                draggable="false"
                                            />
                                        {:else}
                                            <div class="w-full aspect-[3/4] flex items-center justify-center text-textcolor2/40 bg-darkbg">
                                                {#if char.isGroup}<UsersIcon size={36} />{:else}<UserIcon size={36} />{/if}
                                            </div>
                                        {/if}
                                    {:catch}
                                        <div class="w-full aspect-[3/4] flex items-center justify-center text-textcolor2/40 bg-darkbg">
                                            <UserIcon size={36} />
                                        </div>
                                    {/await}
                                {:else}
                                    <div class="w-full aspect-square flex items-center justify-center text-textcolor2/40 bg-darkbg">
                                        {#if char.isGroup}<UsersIcon size={36} />{:else}<UserIcon size={36} />{/if}
                                    </div>
                                {/if}

                                <!-- Type badge (Group chat indicator) -->
                                {#if char.isGroup}
                                    <div class="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-blue-600/90 text-white text-[10px] font-bold shadow-xs flex items-center gap-1 backdrop-blur-xs">
                                        <UsersIcon size={11} />
                                        <span>Group</span>
                                    </div>
                                {/if}

                                <!-- More Menu button (Top-Right) -->
                                <button
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        if (showTrash) {
                                            handleRestoreChar(char.i);
                                        } else {
                                            activeActionMenuChar = { item: char.c, index: char.i };
                                        }
                                    }}
                                    class="absolute top-2 right-2 p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white/90 backdrop-blur-md transition-colors shadow-sm cursor-pointer"
                                    aria-label="More options"
                                >
                                    {#if showTrash}
                                        <Undo2Icon size={14} />
                                    {:else}
                                        <MoreVerticalIcon size={14} />
                                    {/if}
                                </button>

                                <!-- Chats count badge (Bottom-Right of image) -->
                                {#if char.chats > 0}
                                    <div class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-medium backdrop-blur-xs flex items-center gap-1 shadow-xs">
                                        <MessageSquareIcon size={10} />
                                        <span>{char.chats}</span>
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/each}
            </div>
        {/if}
    </div>

    <!-- Floating Action Button (FAB) & Speed Dial -->
    {#if !showTrash}
        <!-- Backdrop for Speed Dial -->
        {#if speedDialOpen}
            <button
                type="button"
                tabindex="-1"
                class="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] cursor-default"
                onclick={() => { speedDialOpen = false; }}
                aria-label="Close speed dial"
            ></button>

            <!-- Speed Dial Options Popover -->
            <div class="fixed bottom-33 right-4 z-50 flex flex-col items-end gap-1.5 pb-1">
                <!-- 1. Create from scratch -->
                <button
                    onclick={handleCreateNewChar}
                    class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-darkbg border border-darkborderc shadow-lg text-xs font-semibold text-textcolor hover:bg-darkbutton transition-all active:scale-95 cursor-pointer"
                >
                    <span>{language.createfromScratch}</span>
                    <PlusIcon size={15} class="text-textcolor2" />
                </button>

                <!-- 2. Import Card -->
                <button
                    onclick={handleImportCard}
                    class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-darkbg border border-darkborderc shadow-lg text-xs font-semibold text-textcolor hover:bg-darkbutton transition-all active:scale-95 cursor-pointer"
                >
                    <span>{language.importCharacter}</span>
                    <UploadIcon size={15} class="text-textcolor2" />
                </button>

                <!-- 3. Create Group -->
                <button
                    onclick={handleCreateGroup}
                    class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-darkbg border border-darkborderc shadow-lg text-xs font-semibold text-textcolor hover:bg-darkbutton transition-all active:scale-95 cursor-pointer"
                >
                    <span>Create Group</span>
                    <UsersIcon size={15} class="text-textcolor2" />
                </button>

                <!-- 4. Browse Realm -->
                <button
                    onclick={handleOpenRealm}
                    class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-darkbg border border-darkborderc shadow-lg text-xs font-semibold text-textcolor hover:bg-darkbutton transition-all active:scale-95 cursor-pointer"
                >
                    <span>RisuRealm</span>
                    <GlobeIcon size={15} class="text-textcolor2" />
                </button>
            </div>
        {/if}

        <!-- Main FAB Button -->
        <button
            onclick={() => { speedDialOpen = !speedDialOpen; }}
            class="fixed bottom-18 right-4 z-40 w-13 h-13 rounded-2xl bg-selected text-white shadow-xl flex items-center justify-center transition-transform active:scale-90 {speedDialOpen ? 'rotate-45' : ''}"
            title="Add character"
            aria-label="Add character"
        >
            <PlusIcon size={26} />
        </button>
    {/if}

    <!-- CHARACTER CONTEXT ACTION SHEET / MODAL -->
    {#if activeActionMenuChar}
        <div
            role="dialog"
            aria-modal="true"
            class="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-end justify-center p-0 sm:p-4"
        >
            <!-- Backdrop dismiss button -->
            <button
                type="button"
                tabindex="-1"
                class="fixed inset-0 z-0 bg-transparent cursor-default"
                onclick={() => { activeActionMenuChar = null; }}
                aria-label="Close action menu"
            ></button>

            <!-- Sheet Content -->
            <div
                class="relative z-10 w-full max-w-md bg-darkbg border border-darkborderc rounded-t-3xl sm:rounded-3xl p-4 flex flex-col gap-3 shadow-2xl pb-[max(env(safe-area-inset-bottom),20px)]"
            >
                <!-- Header: Avatar + Character Name -->
                <div class="flex items-center gap-3 border-b border-darkborderc/60 pb-3">
                    <div class="w-12 h-12 rounded-xl overflow-hidden bg-bgcolor border border-darkborderc shrink-0 flex items-center justify-center">
                        {#if activeActionMenuChar.item.image}
                            {#await getCharImage(activeActionMenuChar.item.image, 'css', { thumbnail: true })}
                                <div class="w-full h-full bg-darkbg animate-pulse"></div>
                            {:then im}
                                <div class="w-full h-full bg-cover bg-center" style={im}></div>
                            {/await}
                        {:else}
                            <UserIcon size={24} class="text-textcolor2" />
                        {/if}
                    </div>
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="font-bold text-base text-textcolor truncate">{activeActionMenuChar.item.name || "Character"}</span>
                        <span class="text-xs text-textcolor2">{activeActionMenuChar.item.chats.length} {language.Chat}</span>
                    </div>
                    <button
                        onclick={() => { activeActionMenuChar = null; }}
                        class="p-1 text-textcolor2 hover:text-textcolor rounded-lg"
                    >
                        <XIcon size={20} />
                    </button>
                </div>

                <!-- Action Buttons List -->
                <div class="flex flex-col gap-1">
                    <!-- 1. Open Chat -->
                    <button
                        onclick={() => {
                            if (activeActionMenuChar) {
                                changeChar(activeActionMenuChar.index);
                                activeActionMenuChar = null;
                                endGrid();
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-sm font-medium transition-colors"
                    >
                        <MessageSquareIcon size={18} class="text-selected" />
                        <span>Start Chat</span>
                    </button>

                    <!-- 2. Duplicate Character -->
                    <button
                        onclick={() => {
                            if (activeActionMenuChar) {
                                void handleDuplicateChar(activeActionMenuChar.index);
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-sm font-medium transition-colors"
                    >
                        <CopyIcon size={18} class="text-blue-400" />
                        <span>Duplicate</span>
                    </button>

                    <!-- 3. Export Character Card -->
                    <button
                        onclick={() => {
                            if (activeActionMenuChar) {
                                void handleExportChar(activeActionMenuChar.index);
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-sm font-medium transition-colors"
                    >
                        <DownloadIcon size={18} class="text-emerald-400" />
                        <span>{language.exportCharacter}</span>
                    </button>

                    <!-- 4. Delete Character (Move to Trash) -->
                    <button
                        onclick={() => {
                            if (activeActionMenuChar) {
                                void handleDeleteChar(activeActionMenuChar.index, activeActionMenuChar.item.name || 'Character');
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-draculared/10 text-draculared text-sm font-medium transition-colors"
                    >
                        <TrashIcon size={18} />
                        <span>{language.delete}</span>
                    </button>
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    .no-scrollbar::-webkit-scrollbar {
        display: none;
    }
    .no-scrollbar {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
</style>
