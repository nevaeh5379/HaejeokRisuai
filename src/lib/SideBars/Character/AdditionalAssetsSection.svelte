<script lang="ts">
    import {
        PlusIcon,
        TrashIcon,
        CopyIcon,
        CheckIcon,
        ImageIcon,
        ImageOffIcon,
        SearchIcon,
        MusicIcon,
        VideoIcon,
        FileTextIcon,
        Maximize2Icon,
        UploadCloudIcon,
        LayersIcon,
        LayoutGridIcon,
        ListIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        EyeIcon
    } from "@lucide/svelte";
    import { selectedCharID, assetManagerModalStore } from "src/ts/stores.svelte";
    import { characterStore, settingsStore } from "src/ts/stores/domain";
    import type { character } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { selectMultipleFile } from "src/ts/util";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { getAssetsBatch } from "src/ts/characterImage";
    import {
        getAssetCategory,
        getDefaultMacroTag,
        copyTextToClipboard,
        processAssetUploads,
        SUPPORTED_ASSET_EXTENSIONS,
        type AssetCategory
    } from "src/ts/assetUtils";

    // View settings
    let sidebarViewMode: "grid2" | "grid3" | "list" = $state("grid2");
    let searchQuery = $state("");
    let selectedCategory: AssetCategory = $state("all");
    let copiedIndex: number | null = $state(null);
    let isDragging = $state(false);

    // Pagination for high performance with thousands of assets
    let currentPage = $state(0);
    const PAGE_SIZE = 24;

    let currentChar = $derived(
        characterStore.characters[$selectedCharID] as character | undefined
    );

    let rawAssets = $derived(currentChar?.additionalAssets ?? []);

    // Filter assets by search query and category
    let filteredAssets = $derived(
        rawAssets
            .map((item, idx) => ({ item, originalIndex: idx }))
            .filter(({ item }) => {
                const name = item[0] || "";
                const ext = item[2] || item[1]?.split(".").pop() || "";
                const cat = getAssetCategory(ext);

                const matchesSearch =
                    !searchQuery ||
                    name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    ext.toLowerCase().includes(searchQuery.toLowerCase());

                const matchesCategory =
                    selectedCategory === "all" || cat === selectedCategory;

                return matchesSearch && matchesCategory;
            })
    );

    let totalPages = $derived(Math.max(1, Math.ceil(filteredAssets.length / PAGE_SIZE)));

    // Reset page if filtered items change
    $effect(() => {
        void searchQuery;
        void selectedCategory;
        if (currentPage >= totalPages) {
            currentPage = 0;
        }
    });

    let paginatedAssets = $derived(
        filteredAssets.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    );

    // Cache resolved file src URLs for visible assets only (efficient!)
    let assetSrcMap = $state<Record<string, string>>({});

    $effect(() => {
        if (!paginatedAssets) return;
        const pathsToLoad = paginatedAssets
            .map(({ item }) => item[1])
            .filter((p): p is string => Boolean(p && !assetSrcMap[p]));

        if (pathsToLoad.length === 0) return;

        getAssetsBatch(pathsToLoad, { size: "full" })
            .then((map) => {
                const updated = { ...assetSrcMap };
                for (const [path, url] of map) {
                    if (url && url !== "/none.webp") {
                        updated[path] = url;
                    }
                }
                assetSrcMap = updated;
            })
            .catch((err) => {
                console.error("Failed to batch load sidebar assets", err);
            });
    });

    async function handleAddFiles() {
        if (currentChar?.type !== "character") return;
        const files = await selectMultipleFile(SUPPORTED_ASSET_EXTENSIONS);
        if (!files || files.length === 0) return;

        const updated = await processAssetUploads(files, currentChar.additionalAssets ?? []);
        currentChar.additionalAssets = updated;
    }

    async function handleCopyTag(e: MouseEvent, name: string, ext: string, idx: number) {
        e.stopPropagation();
        const tag = getDefaultMacroTag(ext, name);
        const success = await copyTextToClipboard(tag);
        if (success) {
            copiedIndex = idx;
            setTimeout(() => {
                if (copiedIndex === idx) copiedIndex = null;
            }, 1500);
        }
    }

    function handleDelete(e: MouseEvent, originalIndex: number) {
        e.stopPropagation();
        if (currentChar?.type !== "character" || !currentChar.additionalAssets) return;
        if (currentChar.chats?.[currentChar.chatPage]) {
            currentChar.chats[currentChar.chatPage].fmIndex = -1;
        }
        const updated = [...currentChar.additionalAssets];
        updated.splice(originalIndex, 1);
        currentChar.additionalAssets = updated;
    }

    function togglePromptExclude(e: MouseEvent, assetId: string) {
        e.stopPropagation();
        if (!currentChar) return;
        currentChar.prebuiltAssetExclude ??= [];
        if (currentChar.prebuiltAssetExclude.includes(assetId)) {
            currentChar.prebuiltAssetExclude = currentChar.prebuiltAssetExclude.filter(
                (id) => id !== assetId
            );
        } else {
            currentChar.prebuiltAssetExclude = [
                ...currentChar.prebuiltAssetExclude,
                assetId
            ];
        }
    }

    function openFloatingModal(initialCategory: AssetCategory = "all", assetIndex: number = -1) {
        assetManagerModalStore.filterType = initialCategory;
        assetManagerModalStore.selectedAssetIndex = assetIndex;
        assetManagerModalStore.open = true;
    }

    async function onDropFiles(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        isDragging = false;
        if (currentChar?.type !== "character") return;

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const fileArray = Array.from(files);
        const updated = await processAssetUploads(fileArray, currentChar.additionalAssets ?? []);
        currentChar.additionalAssets = updated;
    }
</script>

{#if currentChar && currentChar.type === "character"}
    <div class="flex flex-col gap-3 w-full">
        <!-- Header Bar -->
        <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-sm text-textcolor flex items-center gap-1.5 truncate">
                    <LayersIcon size={16} class="text-textcolor2 shrink-0" />
                    <span class="truncate">{language.additionalAssets}</span>
                </span>
                <span class="text-xs px-2 py-0.5 rounded-full bg-selected/20 text-selected font-semibold shrink-0">
                    {rawAssets.length}
                </span>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
                <!-- Open in floating window (Icon only) -->
                <button
                    type="button"
                    class="p-1.5 rounded-md hover:bg-textcolor/10 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer border border-darkborderc"
                    title={language.openFloatingManager}
                    onmouseenter={() => { import("src/lib/Others/AssetManagerModal.svelte"); }}
                    onclick={() => openFloatingModal(selectedCategory)}
                >
                    <Maximize2Icon size={16} />
                </button>

                <!-- Add assets button (Icon only) -->
                <button
                    type="button"
                    class="p-1.5 rounded-md bg-selected hover:bg-selected/90 text-white transition-colors cursor-pointer"
                    title={language.addAsset}
                    onclick={handleAddFiles}
                >
                    <PlusIcon size={16} />
                </button>
            </div>
        </div>

        <!-- Search & View Mode Toolbar -->
        <div class="flex items-center gap-2">
            <div class="relative flex-1">
                <div class="absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none">
                    <SearchIcon size={13} />
                </div>
                <input
                    type="text"
                    bind:value={searchQuery}
                    placeholder={language.searchAssets}
                    class="w-full bg-darkbg border border-darkborderc rounded-md pl-8 pr-3 py-1.5 text-xs text-textcolor placeholder-textcolor2/60 focus:outline-none focus:border-selected transition-colors"
                />
            </div>

            <!-- Grid 2 / Grid 3 / List Mode Switcher -->
            <div class="flex items-center bg-darkbg border border-darkborderc rounded-md p-0.5 shrink-0">
                <button
                    type="button"
                    class="p-1 rounded text-xs transition-colors cursor-pointer {sidebarViewMode === 'grid2' ? 'bg-selected text-white font-bold' : 'text-textcolor2 hover:text-textcolor'}"
                    title="2 Columns (Large Images)"
                    onclick={() => { sidebarViewMode = "grid2"; }}
                >
                    <LayoutGridIcon size={14} />
                </button>
                <button
                    type="button"
                    class="p-1 rounded text-xs transition-colors cursor-pointer {sidebarViewMode === 'grid3' ? 'bg-selected text-white font-bold' : 'text-textcolor2 hover:text-textcolor'}"
                    title="3 Columns (Compact Grid)"
                    onclick={() => { sidebarViewMode = "grid3"; }}
                >
                    <span class="text-[10px] font-bold px-0.5">3×</span>
                </button>
                <button
                    type="button"
                    class="p-1 rounded text-xs transition-colors cursor-pointer {sidebarViewMode === 'list' ? 'bg-selected text-white font-bold' : 'text-textcolor2 hover:text-textcolor'}"
                    title={language.viewList}
                    onclick={() => { sidebarViewMode = "list"; }}
                >
                    <ListIcon size={14} />
                </button>
            </div>
        </div>

        <!-- Category Filter Bar (Full width 5-column grid, no horizontal scroll) -->
        <div class="grid grid-cols-5 gap-1 w-full text-xs">
            {#each [
                { id: "all", label: language.filterAll, fullLabel: language.filterAll, icon: LayersIcon },
                { id: "image", label: language.filterImages, fullLabel: language.filterImages, icon: ImageIcon },
                { id: "audio", label: language.filterAudio, fullLabel: language.filterAudio, icon: MusicIcon },
                { id: "video", label: language.filterVideo, fullLabel: language.filterVideo, icon: VideoIcon },
                { id: "font", label: "기타", fullLabel: language.filterFonts, icon: FileTextIcon }
            ] as cat}
                <button
                    type="button"
                    class="py-1 px-1 rounded-md transition-colors flex items-center justify-center gap-1 cursor-pointer truncate {selectedCategory === cat.id ? 'bg-selected text-white font-semibold shadow-sm' : 'bg-darkbg text-textcolor2 hover:text-textcolor border border-darkborderc/60'}"
                    title={cat.fullLabel}
                    onclick={() => { selectedCategory = cat.id as AssetCategory; currentPage = 0; }}
                >
                    <cat.icon size={12} class="shrink-0" />
                    <span class="text-[11px] truncate">{cat.label}</span>
                </button>
            {/each}
        </div>

        <!-- Assets Gallery Container with Drag & Drop -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="relative flex flex-col border border-darkborderc rounded-xl p-2 min-h-[160px] transition-colors {isDragging ? 'border-dashed border-blue-500 bg-blue-500/10' : 'bg-darkbg/40'}"
            ondragover={(e) => { e.preventDefault(); e.stopPropagation(); isDragging = true; }}
            ondragleave={(e) => { e.preventDefault(); e.stopPropagation(); isDragging = false; }}
            ondrop={onDropFiles}
        >
            {#if isDragging}
                <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-darkbg/95 rounded-xl text-blue-400 gap-2 pointer-events-none">
                    <UploadCloudIcon size={36} class="animate-bounce" />
                    <span class="text-xs font-semibold">{language.dropFilesToUpload}</span>
                </div>
            {/if}

            {#if rawAssets.length === 0}
                <!-- Empty state -->
                <div class="flex flex-col items-center justify-center py-10 text-center text-textcolor2 gap-2">
                    <UploadCloudIcon size={32} class="opacity-40" />
                    <span class="text-xs font-medium">{language.noAssetsFound}</span>
                    <button
                        type="button"
                        class="text-xs text-blue-400 hover:underline cursor-pointer"
                        onclick={handleAddFiles}
                    >
                        {language.addAsset}
                    </button>
                </div>
            {:else if filteredAssets.length === 0}
                <div class="flex flex-col items-center justify-center py-10 text-center text-textcolor2">
                    <span class="text-xs">{language.noAssetsFound}</span>
                </div>
            {:else if sidebarViewMode === "grid2" || sidebarViewMode === "grid3"}
                <!-- Visual Image Grid Gallery -->
                <div class="grid gap-2 {sidebarViewMode === 'grid2' ? 'grid-cols-2' : 'grid-cols-3'}">
                    {#each paginatedAssets as { item: asset, originalIndex }}
                        {@const name = asset[0]}
                        {@const assetId = asset[1]}
                        {@const ext = (asset[2] || asset[1]?.split(".").pop() || "png").toLowerCase()}
                        {@const cat = getAssetCategory(ext)}
                        {@const srcUrl = assetSrcMap[assetId]}
                        {@const isExcluded = currentChar.prebuiltAssetExclude?.includes(assetId)}
                        {@const isCopied = copiedIndex === originalIndex}

                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div
                            class="group relative flex flex-col rounded-lg bg-bgcolor/80 border border-darkborderc hover:border-selected/80 transition-all duration-150 overflow-hidden cursor-pointer shadow-sm"
                            onclick={() => openFloatingModal(selectedCategory, originalIndex)}
                        >
                            <!-- Image Display Container (Large & Clear) -->
                            <div class="relative w-full aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                                {#if cat === "image" && srcUrl}
                                    <img
                                        src={srcUrl}
                                        alt={name}
                                        class="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                                        loading="lazy"
                                    />
                                {:else if cat === "image"}
                                    <ImageIcon size={28} class="text-textcolor2/40" />
                                {:else if cat === "audio"}
                                    <div class="flex flex-col items-center justify-center gap-1 text-purple-400 p-2">
                                        <MusicIcon size={28} />
                                    </div>
                                {:else if cat === "video"}
                                    <div class="flex flex-col items-center justify-center gap-1 text-blue-400 p-2">
                                        <VideoIcon size={28} />
                                    </div>
                                {:else}
                                    <div class="flex flex-col items-center justify-center gap-1 text-yellow-400 p-2">
                                        <FileTextIcon size={28} />
                                    </div>
                                {/if}

                                <!-- Top Extension Badge -->
                                <span class="absolute top-1.5 right-1.5 px-1 py-0.2 text-[8px] uppercase font-bold bg-black/75 backdrop-blur-sm text-white rounded pointer-events-none">
                                    {ext}
                                </span>

                                <!-- Excluded Badge -->
                                {#if isExcluded}
                                    <span class="absolute top-1.5 left-1.5 p-1 bg-red-900/80 text-red-300 rounded pointer-events-none" title={language.promptExcluded}>
                                        <ImageOffIcon size={10} />
                                    </span>
                                {/if}

                                <!-- Hover Actions Overlay -->
                                <div class="absolute inset-x-0 bottom-0 p-1 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <!-- Copy tag button -->
                                    <button
                                        type="button"
                                        class="p-1 rounded bg-white/10 hover:bg-white/25 text-white transition-colors cursor-pointer"
                                        title={language.copyTag}
                                        onclick={(e) => handleCopyTag(e, name, ext, originalIndex)}
                                    >
                                        {#if isCopied}
                                            <CheckIcon size={12} class="text-green-400" />
                                        {:else}
                                            <CopyIcon size={12} />
                                        {/if}
                                    </button>

                                    <!-- Prompt exclude toggle -->
                                    <button
                                        type="button"
                                        class="p-1 rounded bg-white/10 hover:bg-white/25 text-white transition-colors cursor-pointer {isExcluded ? 'text-red-400' : 'text-blue-300'}"
                                        title={isExcluded ? language.promptExcluded : language.promptIncluded}
                                        onclick={(e) => togglePromptExclude(e, assetId)}
                                    >
                                        {#if isExcluded}
                                            <ImageOffIcon size={12} />
                                        {:else}
                                            <ImageIcon size={12} />
                                        {/if}
                                    </button>

                                    <!-- Inspect button -->
                                    <button
                                        type="button"
                                        class="p-1 rounded bg-white/10 hover:bg-white/25 text-white transition-colors cursor-pointer"
                                        title={language.assetDetails}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            openFloatingModal(selectedCategory, originalIndex);
                                        }}
                                    >
                                        <EyeIcon size={12} />
                                    </button>

                                    <!-- Delete button -->
                                    <button
                                        type="button"
                                        class="p-1 rounded bg-white/10 hover:bg-red-500 text-white transition-colors cursor-pointer"
                                        title={language.delete}
                                        onclick={(e) => handleDelete(e, originalIndex)}
                                    >
                                        <TrashIcon size={12} />
                                    </button>
                                </div>
                            </div>

                            <!-- Name Info Footer -->
                            <div class="p-1.5 flex flex-col bg-darkbg border-t border-darkborderc/50">
                                <span class="text-[11px] font-medium text-textcolor truncate" title={name}>
                                    {name}
                                </span>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <!-- List View -->
                <div class="flex flex-col gap-1.5">
                    {#each paginatedAssets as { item: asset, originalIndex }}
                        {@const name = asset[0]}
                        {@const assetId = asset[1]}
                        {@const ext = (asset[2] || asset[1]?.split(".").pop() || "png").toLowerCase()}
                        {@const cat = getAssetCategory(ext)}
                        {@const srcUrl = assetSrcMap[assetId]}
                        {@const isExcluded = currentChar.prebuiltAssetExclude?.includes(assetId)}

                        <div class="flex items-center gap-2 p-1.5 rounded-md bg-darkbg border border-darkborderc/80 hover:border-selected/60 transition-colors group">
                            <!-- Thumbnail Preview -->
                            <button
                                type="button"
                                class="w-12 h-12 shrink-0 rounded bg-bgcolor border border-darkborderc/60 flex items-center justify-center overflow-hidden cursor-pointer"
                                onclick={() => openFloatingModal(selectedCategory, originalIndex)}
                            >
                                {#if cat === "image" && srcUrl}
                                    <img src={srcUrl} alt={name} class="w-full h-full object-cover" />
                                {:else if cat === "image"}
                                    <ImageIcon size={18} class="text-textcolor2/70" />
                                {:else if cat === "audio"}
                                    <MusicIcon size={18} class="text-purple-400" />
                                {:else if cat === "video"}
                                    <VideoIcon size={18} class="text-blue-400" />
                                {:else}
                                    <FileTextIcon size={18} class="text-yellow-400" />
                                {/if}
                            </button>

                            <!-- Name & Tag -->
                            <div class="flex-1 min-w-0 flex flex-col justify-center">
                                <input
                                    type="text"
                                    bind:value={currentChar.additionalAssets[originalIndex][0]}
                                    class="w-full bg-transparent text-xs text-textcolor font-medium truncate focus:bg-bgcolor focus:outline-none rounded px-1 -mx-1 py-0.5 border border-transparent focus:border-selected"
                                    placeholder="..."
                                />
                                <span class="text-[10px] text-textcolor2 truncate font-mono">
                                    {getDefaultMacroTag(ext, name)}
                                </span>
                            </div>

                            <!-- Action Buttons -->
                            <div class="flex items-center gap-1 shrink-0">
                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-textcolor hover:bg-textcolor/10 transition-colors cursor-pointer"
                                    title={language.copyTag}
                                    onclick={(e) => handleCopyTag(e, name, ext, originalIndex)}
                                >
                                    {#if copiedIndex === originalIndex}
                                        <CheckIcon size={14} class="text-green-400" />
                                    {:else}
                                        <CopyIcon size={14} />
                                    {/if}
                                </button>

                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-textcolor hover:bg-textcolor/10 transition-colors cursor-pointer {isExcluded ? 'opacity-40' : 'text-blue-400'}"
                                    title={isExcluded ? language.promptExcluded : language.promptIncluded}
                                    onclick={(e) => togglePromptExclude(e, assetId)}
                                >
                                    {#if isExcluded}
                                        <ImageOffIcon size={14} />
                                    {:else}
                                        <ImageIcon size={14} />
                                    {/if}
                                </button>

                                <button
                                    type="button"
                                    class="p-1 rounded text-textcolor2 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                                    title={language.delete}
                                    onclick={(e) => handleDelete(e, originalIndex)}
                                >
                                    <TrashIcon size={14} />
                                </button>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Pagination Bar (When items > PAGE_SIZE) -->
        {#if totalPages > 1}
            <div class="flex items-center justify-between text-xs text-textcolor2 px-1">
                <span class="text-[11px]">
                    {currentPage * PAGE_SIZE + 1} - {Math.min((currentPage + 1) * PAGE_SIZE, filteredAssets.length)} / {filteredAssets.length}
                </span>

                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        disabled={currentPage === 0}
                        class="p-1 rounded hover:bg-textcolor/10 text-textcolor disabled:opacity-30 cursor-pointer"
                        onclick={() => { currentPage = Math.max(0, currentPage - 1); }}
                    >
                        <ChevronLeftIcon size={15} />
                    </button>
                    <span class="font-medium text-textcolor px-1">
                        {currentPage + 1} / {totalPages}
                    </span>
                    <button
                        type="button"
                        disabled={currentPage >= totalPages - 1}
                        class="p-1 rounded hover:bg-textcolor/10 text-textcolor disabled:opacity-30 cursor-pointer"
                        onclick={() => { currentPage = Math.min(totalPages - 1, currentPage + 1); }}
                    >
                        <ChevronRightIcon size={15} />
                    </button>
                </div>
            </div>
        {/if}

        <!-- Optional Beta Prompt Asset Command Settings -->
        {#if settingsStore.state.newImageHandlingBeta}
            <div class="flex flex-col gap-2 pt-2 border-t border-darkborderc/50 mt-1">
                <CheckInput
                    bind:check={currentChar.prebuiltAssetCommand}
                    name={language.insertAssetPrompt}
                />
                {#if currentChar.prebuiltAssetCommand}
                    <div class="flex flex-col gap-1">
                        <span class="text-xs text-textcolor2">{language.assetStyle}</span>
                        <SelectInput
                            className="mb-1"
                            bind:value={currentChar.prebuiltAssetStyle}
                        >
                            <OptionInput value="">{language.static}</OptionInput>
                            <OptionInput value="dynamic">{language.dynamic}</OptionInput>
                        </SelectInput>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
{/if}
