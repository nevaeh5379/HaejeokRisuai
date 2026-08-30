<script lang="ts">
    import { 
        FolderIcon, 
        FolderOpenIcon,
        PlusIcon, 
        SearchIcon, 
        XIcon, 
        DownloadIcon, 
        UploadIcon, 
        SunIcon, 
        LinkIcon, 
        CopyIcon, 
        Trash2Icon, 
        ChevronDownIcon, 
        ChevronUpIcon, 
        BookOpenIcon,
        BotIcon,
        SparklesIcon,
        FilterIcon
    } from "@lucide/svelte";
    import type { RisuPersona, loreBook } from "src/ts/storage/database/schema";
    import { characterStore } from "src/ts/stores/domain";
    import { v4 } from "uuid";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { convertExternalLorebook } from "src/ts/process/lorebook.svelte";
    import { alertConfirm, alertNormal, alertError } from "src/ts/alert";
    import { language } from "src/lang";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";

    interface Props {
        persona: RisuPersona;
    }

    let { persona }: Props = $props();

    let selectedCharacterId = $state('');
    let botSearchQuery = $state('');
    let loreSearchQuery = $state('');
    let filterConfiguredOnly = $state(false);
    let selectedFolderFilter = $state<string | null>(null);

    // Track open state of lore items using IDs
    let openLoreIds = $state<Set<string>>(new Set());

    // Token count cache by item ID
    let tokenCounts = $state<Record<string, number>>({});

    let availableBots = $derived(
        characterStore.characters.filter((character) => character.chaId && !character.trashTime)
    );

    let configuredBotIds = $derived.by(() => {
        if (!persona.botLorebooks) return new Set<string>();
        const ids = new Set<string>();
        for (const [botId, loreList] of Object.entries(persona.botLorebooks)) {
            if (Array.isArray(loreList) && loreList.length > 0) {
                ids.add(botId);
            }
        }
        return ids;
    });

    let configuredBots = $derived(
        availableBots.filter((bot) => configuredBotIds.has(bot.chaId))
    );

    let filteredBots = $derived.by(() => {
        let list = availableBots;
        if (filterConfiguredOnly) {
            list = list.filter((bot) => configuredBotIds.has(bot.chaId));
        }
        const q = botSearchQuery.trim().toLowerCase();
        if (q) {
            list = list.filter((bot) => (bot.name || '').toLowerCase().includes(q));
        }
        return list;
    });

    let selectedBot = $derived(
        availableBots.find((bot) => bot.chaId === selectedCharacterId)
    );

    let selectedLorebooks = $derived.by(() => {
        if (!selectedCharacterId || !persona.botLorebooks) return [];
        return persona.botLorebooks[selectedCharacterId] ?? [];
    });

    let activeLoreCount = $derived(
        selectedLorebooks.filter((item) => item.alwaysActive && item.mode !== 'folder').length
    );

    let folders = $derived(
        selectedLorebooks.filter((item) => item.mode === 'folder')
    );

    let filteredLorebooks = $derived.by(() => {
        let list = selectedLorebooks;
        if (selectedFolderFilter !== null) {
            list = list.filter((item) => {
                if (selectedFolderFilter === '') {
                    return !item.folder;
                }
                return item.folder === selectedFolderFilter || item.key === selectedFolderFilter;
            });
        }
        const q = loreSearchQuery.trim().toLowerCase();
        if (q) {
            list = list.filter((item) => {
                const comment = (item.comment || '').toLowerCase();
                const key = (item.key || '').toLowerCase();
                const content = (item.content || '').toLowerCase();
                return comment.includes(q) || key.includes(q) || content.includes(q);
            });
        }
        return list;
    });

    // Auto-select current bot or first available
    $effect(() => {
        if (availableBots.some((character) => character.chaId === selectedCharacterId)) return;
        selectedCharacterId = characterStore.currentCharacter?.chaId
            ?? availableBots[0]?.chaId
            ?? '';
    });

    function ensureSelectedLorebooks(): loreBook[] {
        if (!selectedCharacterId) return [];
        persona.botLorebooks ??= {};
        persona.botLorebooks[selectedCharacterId] ??= [];
        return persona.botLorebooks[selectedCharacterId];
    }

    function getItemId(item: loreBook): string {
        if (!item.id) {
            item.id = v4();
        }
        return item.id;
    }

    function toggleLoreOpen(item: loreBook) {
        const id = getItemId(item);
        const next = new Set(openLoreIds);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
            if (item.content && tokenCounts[id] === undefined) {
                void updateItemTokens(id, item.content);
            }
        }
        openLoreIds = next;
    }

    function expandAll() {
        const next = new Set<string>();
        for (const item of selectedLorebooks) {
            next.add(getItemId(item));
        }
        openLoreIds = next;
    }

    function collapseAll() {
        openLoreIds = new Set();
    }

    async function updateItemTokens(id: string, text: string) {
        if (!text) {
            tokenCounts[id] = 0;
            return;
        }
        try {
            const count = await tokenizeAccurate(text);
            tokenCounts[id] = count;
        } catch {
            tokenCounts[id] = Math.ceil(text.length / 4);
        }
    }

    function addLorebook(folderKey?: string) {
        const lorebooks = ensureSelectedLorebooks();
        const newItem: loreBook = {
            id: v4(),
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: `New Lore ${lorebooks.length + 1}`,
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
            folder: folderKey || undefined,
        };
        lorebooks.push(newItem);
        const next = new Set(openLoreIds);
        next.add(newItem.id);
        openLoreIds = next;
    }

    function addFolder() {
        const lorebooks = ensureSelectedLorebooks();
        const folderKey = `\uf000folder:${v4()}`;
        const newFolder: loreBook = {
            id: v4(),
            key: folderKey,
            secondkey: '',
            insertorder: 100,
            comment: 'New Folder',
            content: '',
            mode: 'folder',
            alwaysActive: false,
            selective: false,
        };
        lorebooks.push(newFolder);
        const next = new Set(openLoreIds);
        next.add(newFolder.id);
        openLoreIds = next;
    }

    function duplicateLore(item: loreBook) {
        const lorebooks = ensureSelectedLorebooks();
        const newItem: loreBook = {
            ...item,
            id: v4(),
            comment: `${item.comment || 'Lore'} (Copy)`,
            key: item.mode === 'folder' ? `\uf000folder:${v4()}` : item.key,
        };
        lorebooks.push(newItem);
        const next = new Set(openLoreIds);
        next.add(newItem.id);
        openLoreIds = next;
        alertNormal('Lorebook entry duplicated');
    }

    async function removeLore(item: loreBook) {
        const lorebooks = ensureSelectedLorebooks();
        const name = item.comment || (item.mode === 'folder' ? 'Folder' : 'Lore');
        const confirm = await alertConfirm(`${language.removeConfirm}${name}`);
        if (!confirm) return;

        const itemId = item.id;
        if (item.mode === 'folder') {
            const remaining = lorebooks.filter(
                (entry) => entry !== item && entry.folder !== item.key
            );
            lorebooks.splice(0, lorebooks.length, ...remaining);
        } else {
            const index = lorebooks.indexOf(item);
            if (index !== -1) {
                lorebooks.splice(index, 1);
            }
        }
        if (itemId) {
            const next = new Set(openLoreIds);
            next.delete(itemId);
            openLoreIds = next;
        }
    }

    function toggleAlwaysActive(item: loreBook) {
        if (item.mode === 'folder') {
            const nextVal = !item.alwaysActive;
            item.alwaysActive = nextVal;
            const lorebooks = ensureSelectedLorebooks();
            for (const entry of lorebooks) {
                if (entry.folder === item.key) {
                    entry.alwaysActive = nextVal;
                }
            }
        } else {
            item.alwaysActive = !item.alwaysActive;
        }
    }

    function toggleAllAlwaysActive() {
        const lorebooks = ensureSelectedLorebooks();
        if (lorebooks.length === 0) return;
        const allActive = lorebooks.every((b) => b.alwaysActive);
        for (const item of lorebooks) {
            item.alwaysActive = !allActive;
        }
    }

    async function clearAllBotLorebooks() {
        const lorebooks = ensureSelectedLorebooks();
        if (lorebooks.length === 0) return;
        const botName = selectedBot?.name || 'this bot';
        const confirm = await alertConfirm(`Are you sure you want to clear all lorebooks for "${botName}"?`);
        if (!confirm) return;
        lorebooks.splice(0, lorebooks.length);
        openLoreIds = new Set();
        alertNormal('All lorebooks cleared for this bot');
    }

    async function exportLorebooks() {
        try {
            const lorebooks = ensureSelectedLorebooks();
            if (lorebooks.length === 0) {
                alertNormal('No lorebooks to export');
                return;
            }
            const dataStr = Buffer.from(
                JSON.stringify({
                    type: 'risu',
                    ver: 1,
                    data: lorebooks,
                }, null, 2),
                'utf-8'
            );
            const botName = (selectedBot?.name || 'bot').replace(/[^\w\s-]/g, '_');
            const personaName = (persona.name || 'persona').replace(/[^\w\s-]/g, '_');
            await downloadFile(`lorebook_${personaName}_${botName}.json`, dataStr);
            alertNormal(language.successExport || 'Exported successfully');
        } catch (error) {
            alertError(error);
        }
    }

    async function importLorebooks() {
        try {
            const file = await selectSingleFile(['json', 'lorebook']);
            if (!file?.data) return;
            const content = JSON.parse(Buffer.from(file.data).toString('utf-8'));
            const lorebooks = ensureSelectedLorebooks();
            let importedCount = 0;

            if (content.type === 'risu' && Array.isArray(content.data)) {
                for (const item of content.data) {
                    lorebooks.push({
                        ...item,
                        id: v4(),
                    });
                    importedCount++;
                }
            } else if (content.entries) {
                const converted = convertExternalLorebook(content.entries);
                for (const item of converted) {
                    lorebooks.push({
                        ...item,
                        id: v4(),
                    });
                    importedCount++;
                }
            } else if (Array.isArray(content)) {
                for (const item of content) {
                    lorebooks.push({
                        ...item,
                        id: v4(),
                    });
                    importedCount++;
                }
            }

            if (importedCount > 0) {
                alertNormal(`${importedCount} lorebook item(s) imported successfully`);
            } else {
                alertError('Could not find valid lorebook entries in the selected file');
            }
        } catch (error) {
            alertError(error);
        }
    }
</script>

<!-- Flat, Clean, Single-Level Container -->
<div class="flex flex-col gap-2.5 w-full flex-1 min-h-0 overflow-hidden">
    {#if availableBots.length === 0}
        <div class="py-12 text-center text-xs text-textcolor2 flex flex-col items-center gap-2">
            <BotIcon size={24} class="opacity-40" />
            <span>No bots available. Create or import a character first.</span>
        </div>
    {:else}
        <!-- Top Toolbar: Bot Selector & Action Buttons in Single Clean Row -->
        <div class="flex flex-col gap-1.5 shrink-0">
            <div class="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                <!-- Bot Selector Dropdown -->
                <div class="relative flex-1 min-w-[180px]">
                    <select
                        bind:value={selectedCharacterId}
                        class="w-full h-8 pl-2.5 pr-7 rounded-lg border border-darkborderc bg-darkbutton text-textcolor text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-selected/50 cursor-pointer transition-all"
                    >
                        {#each filteredBots as bot}
                            {@const count = persona.botLorebooks?.[bot.chaId]?.length ?? 0}
                            <option value={bot.chaId}>
                                {bot.name || 'Unnamed bot'} {count > 0 ? `(${count})` : ''}
                            </option>
                        {/each}
                    </select>
                </div>

                {#if characterStore.currentCharacter?.chaId && characterStore.currentCharacter.chaId !== selectedCharacterId}
                    <button
                        type="button"
                        class="h-8 px-2 rounded-lg bg-selected/15 hover:bg-selected/25 text-selected border border-selected/30 text-xs font-medium transition-colors cursor-pointer shrink-0 flex items-center gap-1"
                        onclick={() => {
                            if (characterStore.currentCharacter?.chaId) {
                                selectedCharacterId = characterStore.currentCharacter.chaId;
                            }
                        }}
                        title="Select current chat bot"
                    >
                        <SparklesIcon size={12} />
                        <span class="hidden sm:inline">Current</span>
                    </button>
                {/if}

                <!-- Filter Toggle -->
                <button
                    type="button"
                    class="h-8 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer shrink-0 flex items-center gap-1 {filterConfiguredOnly ? 'bg-selected text-white border-selected' : 'bg-darkbutton/70 hover:bg-darkbutton text-textcolor2 hover:text-textcolor border-darkborderc'}"
                    onclick={() => { filterConfiguredOnly = !filterConfiguredOnly; }}
                    title="Filter bots with lorebooks"
                >
                    <FilterIcon size={12} />
                    <span>({configuredBotIds.size})</span>
                </button>

                <!-- Add Lore / Folder Buttons -->
                <button
                    type="button"
                    class="h-8 px-2.5 rounded-lg bg-selected text-white hover:bg-selected/90 text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors shrink-0 shadow-xs"
                    onclick={() => addLorebook()}
                >
                    <PlusIcon size={13} />
                    <span>Lore</span>
                </button>

                <button
                    type="button"
                    class="h-8 px-2 rounded-lg bg-darkbutton hover:bg-darkbutton/80 text-textcolor border border-darkborderc text-xs font-medium flex items-center gap-1 cursor-pointer transition-colors shrink-0"
                    onclick={addFolder}
                    title="Add Folder"
                >
                    <FolderIcon size={13} />
                    <span class="hidden sm:inline">Folder</span>
                </button>

                <!-- Tools: Import / Export / Expand / Sun -->
                <div class="flex items-center gap-1 shrink-0 ml-auto sm:ml-0">
                    <button
                        type="button"
                        class="h-8 w-8 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor border border-darkborderc text-xs flex items-center justify-center cursor-pointer transition-colors"
                        onclick={importLorebooks}
                        title="Import lorebooks from JSON"
                    >
                        <UploadIcon size={13} />
                    </button>

                    {#if selectedLorebooks.length > 0}
                        <button
                            type="button"
                            class="h-8 w-8 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor border border-darkborderc text-xs flex items-center justify-center cursor-pointer transition-colors"
                            onclick={exportLorebooks}
                            title="Export lorebooks to JSON"
                        >
                            <DownloadIcon size={13} />
                        </button>

                        <button
                            type="button"
                            class="h-8 w-8 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor2 hover:text-textcolor border border-darkborderc text-xs flex items-center justify-center cursor-pointer transition-colors"
                            onclick={() => {
                                if (openLoreIds.size > 0) {
                                    collapseAll();
                                } else {
                                    expandAll();
                                }
                            }}
                            title={openLoreIds.size > 0 ? "Collapse all" : "Expand all"}
                        >
                            {#if openLoreIds.size > 0}
                                <ChevronUpIcon size={14} />
                            {:else}
                                <ChevronDownIcon size={14} />
                            {/if}
                        </button>

                        <button
                            type="button"
                            class="h-8 w-8 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor2 hover:text-textcolor border border-darkborderc text-xs flex items-center justify-center cursor-pointer transition-colors"
                            onclick={toggleAllAlwaysActive}
                            title="Toggle always active for all items"
                        >
                            <SunIcon size={13} class={activeLoreCount > 0 ? "text-selected" : ""} />
                        </button>

                        <button
                            type="button"
                            class="h-8 w-8 rounded-lg hover:bg-draculared/20 text-textcolor2 hover:text-draculared border border-darkborderc text-xs flex items-center justify-center cursor-pointer transition-colors"
                            onclick={clearAllBotLorebooks}
                            title="Clear all lorebooks for this bot"
                        >
                            <Trash2Icon size={13} />
                        </button>
                    {/if}
                </div>
            </div>

            <!-- Quick Jump Chips (Only if multiple configured bots exist) -->
            {#if configuredBots.length > 1}
                <div class="flex items-center gap-1 overflow-x-auto py-0.5 scrollbar-none">
                    {#each configuredBots as bot}
                        {@const isSelected = bot.chaId === selectedCharacterId}
                        {@const count = persona.botLorebooks?.[bot.chaId]?.length ?? 0}
                        <button
                            type="button"
                            class="h-5.5 px-2 rounded-full text-[10px] font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 {isSelected ? 'bg-selected text-white font-bold' : 'bg-darkbutton text-textcolor2 hover:text-textcolor border border-darkborderc/50'}"
                            onclick={() => { selectedCharacterId = bot.chaId; }}
                        >
                            <span class="truncate max-w-[100px]">{bot.name || 'Bot'}</span>
                            <span class="opacity-75">{count}</span>
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- Search & Folder Filter (When entries exist) -->
            {#if selectedLorebooks.length > 2 || folders.length > 0}
                <div class="flex items-center gap-1.5 pt-0.5">
                    <div class="relative flex-1">
                        <div class="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-textcolor2">
                            <SearchIcon size={12} />
                        </div>
                        <input
                            type="text"
                            bind:value={loreSearchQuery}
                            placeholder="Search lore entries..."
                            class="w-full h-7 pl-7 pr-6 rounded-md border border-darkborderc bg-darkbutton/50 text-textcolor placeholder-textcolor2/50 text-xs focus:outline-none focus:ring-1 focus:ring-selected/50"
                        />
                        {#if loreSearchQuery}
                            <button
                                class="absolute inset-y-0 right-2 flex items-center text-textcolor2 hover:text-textcolor"
                                onclick={() => { loreSearchQuery = ''; }}
                            >
                                <XIcon size={11} />
                            </button>
                        {/if}
                    </div>

                    {#if folders.length > 0}
                        <select
                            bind:value={selectedFolderFilter}
                            class="h-7 px-2 rounded-md border border-darkborderc bg-darkbutton/50 text-textcolor text-xs"
                        >
                            <option value={null}>All Folders</option>
                            <option value="">Root Only</option>
                            {#each folders as folder}
                                <option value={folder.key}>{folder.comment || 'Folder'}</option>
                            {/each}
                        </select>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- Lorebook List (Single-level scroll area) -->
        <div class="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto pr-0.5">
            {#if selectedLorebooks.length === 0}
                <div class="py-10 text-center text-xs text-textcolor2 flex flex-col items-center gap-2">
                    <BookOpenIcon size={22} class="opacity-30" />
                    <span>No dedicated lorebook for "{selectedBot?.name || 'this bot'}".</span>
                    <button
                        type="button"
                        class="px-2.5 py-1 rounded-md bg-selected/20 hover:bg-selected/30 text-selected text-xs font-semibold transition-colors cursor-pointer mt-1"
                        onclick={() => addLorebook()}
                    >
                        + Add First Lore
                    </button>
                </div>
            {:else if filteredLorebooks.length === 0}
                <div class="py-8 text-center text-xs text-textcolor2">
                    No entries match "{loreSearchQuery}"
                </div>
            {:else}
                {#each filteredLorebooks as item (getItemId(item))}
                    {@const isOpen = openLoreIds.has(getItemId(item))}
                    {@const isFolder = item.mode === 'folder'}
                    {@const id = getItemId(item)}

                    <div class="rounded-lg border transition-all {isOpen ? 'border-selected/70 bg-selected/5' : 'border-darkborderc/60 bg-darkbg/30 hover:border-textcolor/30'}">
                        <!-- Header Row -->
                        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 min-h-[34px]">
                            <!-- Click Title to Toggle -->
                            <button
                                type="button"
                                class="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                                onclick={() => toggleLoreOpen(item)}
                            >
                                <div class="shrink-0 {isFolder ? 'text-yellow-500' : item.alwaysActive ? 'text-selected' : 'text-textcolor2'}">
                                    {#if isFolder}
                                        {#if isOpen}
                                            <FolderOpenIcon size={15} />
                                        {:else}
                                            <FolderIcon size={15} />
                                        {/if}
                                    {:else}
                                        <BookOpenIcon size={15} />
                                    {/if}
                                </div>

                                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                                    <span class="text-xs font-semibold text-textcolor truncate">
                                        {item.comment || (isFolder ? 'Unnamed Folder' : item.key ? item.key : 'Unnamed Lore')}
                                    </span>

                                    {#if !isFolder && item.key && !item.alwaysActive}
                                        <span class="px-1.5 py-0.2 rounded text-[9px] bg-darkbutton text-textcolor2 truncate max-w-[120px] shrink-0 border border-darkborderc/40">
                                            🔑 {item.key}
                                        </span>
                                    {/if}

                                    {#if item.alwaysActive}
                                        <span class="px-1.5 py-0.2 rounded-full text-[9px] bg-selected/20 text-selected font-bold shrink-0">
                                            Always
                                        </span>
                                    {/if}
                                </div>
                            </button>

                            <!-- Item Actions -->
                            <div class="flex items-center gap-0.5 shrink-0">
                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-textcolor transition-colors cursor-pointer {item.alwaysActive ? 'text-selected' : ''}"
                                    onclick={() => toggleAlwaysActive(item)}
                                    title="Toggle Always Active"
                                >
                                    {#if item.alwaysActive}
                                        <SunIcon size={14} />
                                    {:else}
                                        <LinkIcon size={14} />
                                    {/if}
                                </button>

                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                    onclick={() => duplicateLore(item)}
                                    title="Duplicate"
                                >
                                    <CopyIcon size={13} />
                                </button>

                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-draculared transition-colors cursor-pointer"
                                    onclick={() => removeLore(item)}
                                    title="Delete"
                                >
                                    <Trash2Icon size={13} />
                                </button>

                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                    onclick={() => toggleLoreOpen(item)}
                                >
                                    {#if isOpen}
                                        <ChevronUpIcon size={13} />
                                    {:else}
                                        <ChevronDownIcon size={13} />
                                    {/if}
                                </button>
                            </div>
                        </div>

                        <!-- Editor Form (When Open) -->
                        {#if isOpen}
                            <div class="border-t border-darkborderc/40 p-2.5 flex flex-col gap-2.5">
                                {#if isFolder}
                                    <div class="flex flex-col gap-1">
                                        <span class="text-[10px] font-semibold text-textcolor2">{language.folderName || "Folder Name"}</span>
                                        <TextInput size="sm" bind:value={item.comment} placeholder="Folder Name" fullwidth />
                                    </div>
                                    <div class="flex items-center justify-end pt-0.5">
                                        <button
                                            type="button"
                                            class="px-2 py-0.5 rounded bg-selected/20 hover:bg-selected/30 text-selected text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                                            onclick={() => addLorebook(item.key)}
                                        >
                                            <PlusIcon size={11} />
                                            <span>Add Lore to Folder</span>
                                        </button>
                                    </div>
                                {:else}
                                    <!-- Top Grid: Name + Activation Keys in 2 Columns -->
                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <div class="flex flex-col gap-0.5">
                                            <span class="text-[10px] font-semibold text-textcolor2">{language.name || "Name / Identifier"}</span>
                                            <TextInput size="sm" bind:value={item.comment} placeholder="Identifier / Name" fullwidth />
                                        </div>

                                        {#if !item.alwaysActive}
                                            <div class="flex flex-col gap-0.5">
                                                <span class="text-[10px] font-semibold text-textcolor2">{language.activationKeys || "Activation Keys"}</span>
                                                <TextInput size="sm" bind:value={item.key} placeholder="sword, excalibur, weapon" fullwidth />
                                            </div>
                                        {:else}
                                            <div class="flex flex-col justify-end pb-1.5 text-[11px] text-selected font-semibold">
                                                <span>✓ Always Active (Injected into context unconditionally)</span>
                                            </div>
                                        {/if}
                                    </div>

                                    <!-- Secondary Keys (If Selective) -->
                                    {#if !item.alwaysActive && item.selective}
                                        <div class="flex flex-col gap-0.5 pl-2 border-l-2 border-selected/50">
                                            <span class="text-[10px] font-semibold text-textcolor2">{language.SecondaryKeys || "Secondary Keys (AND Condition)"}</span>
                                            <TextInput size="sm" bind:value={item.secondkey} placeholder="holy, knight" fullwidth />
                                        </div>
                                    {/if}

                                    <!-- Prompt Content Area -->
                                    <div class="flex flex-col gap-1">
                                        <div class="flex items-center justify-between">
                                            <span class="text-[10px] font-semibold text-textcolor2">{language.prompt || "Prompt Content"}</span>
                                            <span class="text-[10px] text-textcolor2 font-medium">
                                                {tokenCounts[id] !== undefined ? `${tokenCounts[id]} tokens` : ''}
                                            </span>
                                        </div>
                                        <div class="h-28 w-full">
                                            <TextAreaInput
                                                autocomplete="off"
                                                height="full"
                                                bind:value={item.content}
                                                placeholder="Information injected into context when keys trigger..."
                                                fullwidth
                                            />
                                        </div>
                                    </div>

                                    <!-- Bottom Meta Controls & Checkboxes (Compact 1-Row Layout) -->
                                    <div class="flex flex-wrap items-center justify-between gap-2.5 pt-1.5 border-t border-darkborderc/30 text-xs">
                                        <!-- Checkboxes -->
                                        <div class="flex items-center gap-3">
                                            <Check bind:check={item.alwaysActive} name={language.alwaysActive || "Always Active"} />

                                            {#if !item.alwaysActive}
                                                <Check bind:check={item.selective} name={language.selective || "Selective (AND)"} />
                                                <Check bind:check={item.useRegex} name={language.useRegexLorebook || "Regex"} />
                                            {/if}
                                        </div>

                                        <!-- Compact Order, Probability & Folder Settings -->
                                        <div class="flex items-center gap-2 flex-wrap">
                                            <div class="flex items-center gap-1">
                                                <span class="text-[10px] font-semibold text-textcolor2">{language.insertOrder || "Order"}:</span>
                                                <div class="w-16">
                                                    <NumberInput size="sm" bind:value={item.insertorder} min={0} max={1000} />
                                                </div>
                                            </div>

                                            {#if !(item.activationPercent === undefined || item.activationPercent === null)}
                                                <div class="flex items-center gap-1">
                                                    <span class="text-[10px] font-semibold text-textcolor2">%:</span>
                                                    <div class="w-14">
                                                        <NumberInput size="sm" bind:value={item.activationPercent} min={0} max={100} />
                                                    </div>
                                                </div>
                                            {/if}

                                            {#if folders.length > 0}
                                                <div class="flex items-center gap-1 text-[11px] text-textcolor2">
                                                    <span>Folder:</span>
                                                    <select
                                                        bind:value={item.folder}
                                                        class="h-6 px-1.5 rounded border border-darkborderc bg-darkbutton text-textcolor text-[11px]"
                                                    >
                                                        <option value={undefined}>(Root)</option>
                                                        {#each folders as folder}
                                                            {#if folder.key !== item.key}
                                                                <option value={folder.key}>{folder.comment || 'Folder'}</option>
                                                            {/if}
                                                        {/each}
                                                    </select>
                                                </div>
                                            {/if}
                                        </div>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
            {/if}
        </div>
    {/if}
</div>


