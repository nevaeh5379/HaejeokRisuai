<script lang="ts">
    import {
        ArrowDownIcon,
        ArrowUpDownIcon,
        ArrowUpIcon,
        ChevronFirstIcon,
        ChevronLastIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        DatabaseIcon,
        LayoutGridIcon,
        LayersIcon,
        MusicIcon,
        RefreshCwIcon,
        SearchIcon,
        TableIcon,
        Trash2Icon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { formatBytes, isAudioFile, isImageFile, isThumbnailKey, sortAssetFiles } from '../utils'
    import type { FileFilterType, FileSortType, NodeStorageAssetDetails, NodeStorageAssetItem, ViewTarget } from '../types'

    interface Props {
        assetDetails: NodeStorageAssetDetails | null
        orphanAssets: NodeStorageAssetItem[]
        viewTarget: ViewTarget
        selectedFileKeys: Set<string>
        resyncingCatalog: boolean
        busy: boolean
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onOpenPreview: (key: string) => void
        onToggleSelectFile: (key: string) => void
        onToggleSelectAll: (currentList: NodeStorageAssetItem[]) => void
        onDeleteSingleFile: (key: string) => void
        onDeleteSelectedFiles: () => void
        onResyncCatalog: () => void
    }

    const {
        assetDetails,
        orphanAssets,
        viewTarget,
        selectedFileKeys,
        resyncingCatalog,
        busy,
        thumbnailUrls,
        onLoadThumbnail,
        onOpenPreview,
        onToggleSelectFile,
        onToggleSelectAll,
        onDeleteSingleFile,
        onDeleteSelectedFiles,
        onResyncCatalog
    }: Props = $props()

    let fileSearch = $state('')
    let fileFilter = $state<FileFilterType>('all')
    let fileSort = $state<FileSortType>('size_desc')
    let displayMode = $state<'table' | 'card'>('table')
    let page = $state(1)
    let pageSize = $state(50)

    const filteredAndSortedFiles = $derived.by(() => {
        if (!assetDetails?.assets) return []
        let list = [...assetDetails.assets]

        if (fileSearch.trim()) {
            const query = fileSearch.trim().toLowerCase()
            list = list.filter((f) => f.key.toLowerCase().includes(query))
        }

        if (fileFilter === 'image') {
            list = list.filter((f) => isImageFile(f.key))
        } else if (fileFilter === 'audio') {
            list = list.filter((f) => isAudioFile(f.key))
        } else if (fileFilter === 'orphan') {
            const orphanSet = new Set(orphanAssets.map((o) => o.key))
            list = list.filter((f) => orphanSet.has(f.key))
        }

        return sortAssetFiles(list, fileSort)
    })

    const totalItems = $derived(filteredAndSortedFiles.length)
    const totalPages = $derived(Math.max(1, Math.ceil(totalItems / pageSize)))
    const safeCurrentPage = $derived(Math.min(Math.max(1, page), totalPages))

    const pagedFiles = $derived.by(() => {
        const start = (safeCurrentPage - 1) * pageSize
        return filteredAndSortedFiles.slice(start, start + pageSize)
    })

    const startItemIndex = $derived(totalItems === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1)
    const endItemIndex = $derived(Math.min(safeCurrentPage * pageSize, totalItems))

    const isCurrentPageAllSelected = $derived(
        pagedFiles.length > 0 && pagedFiles.every((f) => selectedFileKeys.has(f.key))
    )

    const isAllFilteredSelected = $derived(
        filteredAndSortedFiles.length > 0 && filteredAndSortedFiles.every((f) => selectedFileKeys.has(f.key))
    )

    function setFilter(filter: FileFilterType) {
        fileFilter = filter
        page = 1
    }

    function setSort(sort: FileSortType) {
        fileSort = sort
        page = 1
    }

    function handlePageSizeChange(e: Event) {
        const target = e.target as HTMLSelectElement
        const newSize = parseInt(target.value, 10)
        if (!isNaN(newSize) && newSize > 0) {
            pageSize = newSize
            page = 1
        }
    }

    function goToPage(p: number) {
        page = Math.min(Math.max(1, p), totalPages)
    }

    function toggleHeaderSort(column: 'key' | 'size') {
        if (column === 'key') {
            fileSort = fileSort === 'name_asc' ? 'name_desc' : 'name_asc'
        } else if (column === 'size') {
            fileSort = fileSort === 'size_desc' ? 'size_asc' : 'size_desc'
        }
        page = 1
    }

    function toggleSelectCurrentPage() {
        if (isCurrentPageAllSelected) {
            for (const file of pagedFiles) {
                if (selectedFileKeys.has(file.key)) {
                    onToggleSelectFile(file.key)
                }
            }
        } else {
            for (const file of pagedFiles) {
                if (!selectedFileKeys.has(file.key)) {
                    onToggleSelectFile(file.key)
                }
            }
        }
    }

    function selectAllFiltered() {
        onToggleSelectAll(filteredAndSortedFiles)
    }

    function deselectAllFiltered() {
        for (const file of filteredAndSortedFiles) {
            if (selectedFileKeys.has(file.key)) {
                onToggleSelectFile(file.key)
            }
        }
    }
</script>

<div class="flex flex-col gap-3 sm:gap-4 relative pb-16 sm:pb-0">
    <!-- Controls: Search & Filter Pills & Sort & View Switcher -->
    <div class="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
        <!-- Search bar -->
        <div class="relative min-w-[200px] flex-1 max-w-md">
            <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2 pointer-events-none" />
            <input
                type="text"
                bind:value={fileSearch}
                oninput={() => page = 1}
                placeholder={language.storageSearchFiles}
                class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-8 text-xs sm:text-sm text-textcolor placeholder-textcolor2 focus:border-blue-500 focus:outline-hidden"
            />
            {#if fileSearch}
                <button
                    type="button"
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor p-0.5 cursor-pointer"
                    onclick={() => { fileSearch = ''; page = 1 }}
                    aria-label="Clear search"
                >
                    <XIcon class="h-3.5 w-3.5" />
                </button>
            {/if}
        </div>

        <!-- Filter pills -->
        <div class="flex items-center gap-1 rounded-lg border border-darkborderc bg-darkbg p-1 text-xs select-none overflow-x-auto scrollbar-none">
            <button
                type="button"
                class="rounded-md px-2.5 py-1 transition-colors whitespace-nowrap cursor-pointer {fileFilter === 'all' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => setFilter('all')}
            >
                {language.storageFilterAll}
            </button>
            <button
                type="button"
                class="rounded-md px-2.5 py-1 transition-colors whitespace-nowrap cursor-pointer {fileFilter === 'image' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => setFilter('image')}
            >
                {language.storageFilterImages}
            </button>
            <button
                type="button"
                class="rounded-md px-2.5 py-1 transition-colors whitespace-nowrap cursor-pointer {fileFilter === 'audio' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => setFilter('audio')}
            >
                {language.storageFilterAudio}
            </button>
            <button
                type="button"
                class="rounded-md px-2.5 py-1 transition-colors whitespace-nowrap cursor-pointer {fileFilter === 'orphan' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => setFilter('orphan')}
            >
                {language.storageFilterOrphan} ({orphanAssets.length})
            </button>
        </div>

        <!-- Sort dropdown & Mode Switcher & Catalog Resync Actions -->
        <div class="flex flex-wrap items-center gap-2">
            <!-- Sort dropdown -->
            <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-xs text-textcolor2 hidden md:inline">{language.storageSort}:</span>
                <select
                    value={fileSort}
                    onchange={(e) => setSort((e.target as HTMLSelectElement).value as FileSortType)}
                    class="rounded-lg border border-darkborderc bg-darkbg px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-medium text-textcolor focus:border-blue-500 focus:outline-hidden cursor-pointer"
                >
                    <option value="size_desc">{language.storageSortSizeDesc}</option>
                    <option value="size_asc">{language.storageSortSizeAsc}</option>
                    <option value="name_asc">{language.storageSortFileNameAsc}</option>
                    <option value="name_desc">{language.storageSortFileNameDesc}</option>
                </select>
            </div>

            <!-- Mobile Display Mode Switcher (Card vs Table) -->
            <div class="flex items-center rounded-lg border border-darkborderc bg-darkbg p-0.5 text-xs sm:hidden">
                <button
                    type="button"
                    class="p-1.5 rounded-md transition-colors {displayMode === 'card' ? 'bg-selected text-textcolor' : 'text-textcolor2'}"
                    onclick={() => displayMode = 'card'}
                    title="Card View"
                >
                    <LayoutGridIcon class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="p-1.5 rounded-md transition-colors {displayMode === 'table' ? 'bg-selected text-textcolor' : 'text-textcolor2'}"
                    onclick={() => displayMode = 'table'}
                    title="Table View"
                >
                    <TableIcon class="h-4 w-4" />
                </button>
            </div>

            {#if viewTarget === 's3' && assetDetails?.listSource === 'catalog'}
                <div class="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">
                    <DatabaseIcon class="h-3.5 w-3.5 shrink-0 hidden sm:inline" />
                    <span class="whitespace-nowrap text-[11px] sm:text-xs">{language.storageListFromCatalog}</span>
                    <button
                        type="button"
                        class="flex items-center gap-1 rounded-md bg-sky-500/20 px-2 py-0.5 font-semibold whitespace-nowrap hover:bg-sky-500/30 transition-colors disabled:opacity-50 cursor-pointer"
                        disabled={resyncingCatalog || busy}
                        onclick={onResyncCatalog}
                        title={language.storageResyncCatalogDescription}
                    >
                        {#if resyncingCatalog}
                            <RefreshCwIcon class="h-3 w-3 animate-spin" />
                            <span>{language.storageResyncingCatalog}</span>
                        {:else}
                            <RefreshCwIcon class="h-3 w-3" />
                            <span>{language.storageResyncCatalog}</span>
                        {/if}
                    </button>
                </div>
            {/if}

            {#if selectedFileKeys.size > 0}
                <button
                    type="button"
                    class="hidden sm:flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-3 py-1.5 sm:py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                    disabled={busy}
                    onclick={onDeleteSelectedFiles}
                >
                    <Trash2Icon class="h-4 w-4" />
                    <span>{language.storageDeleteSelected} ({selectedFileKeys.size})</span>
                </button>
            {/if}
        </div>
    </div>

    <!-- Selection Banner for Multi-Page Files -->
    {#if selectedFileKeys.size > 0 && totalItems > 0}
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3.5 py-2 text-xs text-blue-200 animate-in fade-in duration-150">
            <div class="flex items-center gap-2">
                <span>
                    <strong>{selectedFileKeys.size}</strong> {language.storageFiles ?? 'files'} selected.
                </span>
                {#if isCurrentPageAllSelected && totalItems > pagedFiles.length && !isAllFilteredSelected}
                    <span class="text-blue-300/80">({pagedFiles.length} on this page)</span>
                {/if}
            </div>
            <div class="flex items-center gap-2">
                {#if !isAllFilteredSelected && totalItems > pagedFiles.length}
                    <button
                        type="button"
                        class="font-semibold underline hover:text-white cursor-pointer transition-colors"
                        onclick={selectAllFiltered}
                    >
                        {language.storageSelectAllMatching(totalItems)}
                    </button>
                    <span>·</span>
                {/if}
                <button
                    type="button"
                    class="hover:text-white cursor-pointer transition-colors text-blue-300/90"
                    onclick={deselectAllFiltered}
                >
                    {language.storageDeselectAll}
                </button>
            </div>
        </div>
    {/if}

    <!-- MAIN VIEW: Table or Cards -->
    {#if displayMode === 'table'}
        <!-- Desktop / Tablet Table View -->
        <div class="rounded-xl border border-darkborderc bg-darkbg overflow-hidden flex flex-col">
            <div class="max-h-[600px] overflow-y-auto">
                <table class="w-full text-left text-xs text-textcolor">
                    <thead class="sticky top-0 z-10 border-b border-darkborderc bg-darkbg/95 backdrop-blur-xs font-semibold text-textcolor2">
                        <tr>
                            <th class="w-10 px-3 py-2.5 text-center">
                                <input
                                    type="checkbox"
                                    checked={isCurrentPageAllSelected}
                                    onchange={toggleSelectCurrentPage}
                                    class="rounded-sm border-darkborderc cursor-pointer"
                                    title={language.storageSelectCurrentPage}
                                />
                            </th>
                            <th class="w-14 px-3 py-2.5">{language.storagePreview}</th>
                            <th class="px-3 py-2.5">
                                <button
                                    type="button"
                                    class="group inline-flex items-center gap-1.5 font-semibold text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                    onclick={() => toggleHeaderSort('key')}
                                >
                                    <span>{language.storageAssetKey}</span>
                                    {#if fileSort === 'name_asc'}
                                        <ArrowUpIcon class="h-3.5 w-3.5 text-blue-400" />
                                    {:else if fileSort === 'name_desc'}
                                        <ArrowDownIcon class="h-3.5 w-3.5 text-blue-400" />
                                    {:else}
                                        <ArrowUpDownIcon class="h-3 w-3 text-textcolor2 opacity-40 group-hover:opacity-100 transition-opacity" />
                                    {/if}
                                </button>
                            </th>
                            <th class="w-28 px-3 py-2.5 text-right">
                                <button
                                    type="button"
                                    class="group inline-flex items-center gap-1.5 font-semibold text-textcolor2 hover:text-textcolor transition-colors cursor-pointer ml-auto"
                                    onclick={() => toggleHeaderSort('size')}
                                >
                                    <span>{language.storageSize}</span>
                                    {#if fileSort === 'size_desc'}
                                        <ArrowDownIcon class="h-3.5 w-3.5 text-blue-400" />
                                    {:else if fileSort === 'size_asc'}
                                        <ArrowUpIcon class="h-3.5 w-3.5 text-blue-400" />
                                    {:else}
                                        <ArrowUpDownIcon class="h-3 w-3 text-textcolor2 opacity-40 group-hover:opacity-100 transition-opacity" />
                                    {/if}
                                </button>
                            </th>
                            <th class="w-16 px-3 py-2.5 text-center">{language.storageAction}</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-darkborderc/40">
                        {#if pagedFiles.length === 0}
                            <tr>
                                <td colspan="5" class="py-12 text-center text-textcolor2">
                                    {language.storageNoAssetsFound}
                                </td>
                            </tr>
                        {:else}
                            {#each pagedFiles as file (file.key)}
                                <tr class="hover:bg-darkbutton/30 transition-colors {selectedFileKeys.has(file.key) ? 'bg-blue-500/10' : ''}">
                                    <td class="px-3 py-2 text-center">
                                        <input
                                            type="checkbox"
                                            checked={selectedFileKeys.has(file.key)}
                                            onchange={() => onToggleSelectFile(file.key)}
                                            class="rounded-sm border-darkborderc cursor-pointer"
                                        />
                                    </td>
                                    <td class="px-3 py-2">
                                        <button
                                            type="button"
                                            class="h-8 w-8 overflow-hidden rounded-md border border-darkborderc bg-darkbutton hover:opacity-80 transition-opacity cursor-pointer flex items-center justify-center"
                                            onclick={() => onOpenPreview(file.key)}
                                            title="Preview"
                                        >
                                            {#if isImageFile(file.key)}
                                                {@const _ = onLoadThumbnail(file.key)}
                                                {#if thumbnailUrls.has(file.key)}
                                                    <img loading="lazy" src={thumbnailUrls.get(file.key)} alt="" class="h-full w-full object-cover" />
                                                {:else}
                                                    <div class="text-[9px] text-textcolor2">img</div>
                                                {/if}
                                            {:else if isAudioFile(file.key)}
                                                <MusicIcon class="h-4 w-4 text-textcolor2" />
                                            {:else}
                                                <LayersIcon class="h-4 w-4 text-textcolor2" />
                                            {/if}
                                        </button>
                                    </td>
                                    <td class="px-3 py-2 font-mono text-xs max-w-xs truncate">
                                        <div class="flex items-center gap-1.5 min-w-0">
                                            {#if isThumbnailKey(file.key)}
                                                <span class="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300 shrink-0">
                                                    Thumb
                                                </span>
                                            {/if}
                                            <span class="truncate" title={file.key}>{file.key}</span>
                                        </div>
                                    </td>
                                    <td class="px-3 py-2 text-right font-medium">
                                        {formatBytes(file.size)}
                                    </td>
                                    <td class="px-3 py-2 text-center">
                                        <button
                                            type="button"
                                            class="rounded-md p-1.5 text-textcolor2 hover:bg-rose-500/20 hover:text-rose-300 transition-colors cursor-pointer"
                                            title="Delete"
                                            onclick={() => onDeleteSingleFile(file.key)}
                                        >
                                            <Trash2Icon class="h-3.5 w-3.5" />
                                        </button>
                                    </td>
                                </tr>
                            {/each}
                        {/if}
                    </tbody>
                </table>
            </div>
        </div>
    {:else}
        <!-- Mobile Card / List View -->
        <div class="flex flex-col gap-2">
            <!-- Mobile Select All Bar -->
            {#if pagedFiles.length > 0}
                <div class="flex items-center justify-between px-2.5 py-1.5 bg-darkbg/50 rounded-lg border border-darkborderc text-xs text-textcolor2">
                    <label class="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={isCurrentPageAllSelected}
                            onchange={toggleSelectCurrentPage}
                            class="rounded-sm border-darkborderc"
                        />
                        <span>{isCurrentPageAllSelected ? language.storageDeselectAll : language.storageSelectCurrentPage} ({pagedFiles.length})</span>
                    </label>
                    <span class="font-medium text-textcolor">{selectedFileKeys.size} selected</span>
                </div>
            {/if}

            {#if pagedFiles.length === 0}
                <div class="py-12 text-center text-sm text-textcolor2 rounded-xl border border-dashed border-darkborderc bg-darkbg/40">
                    {language.storageNoAssetsFound}
                </div>
            {:else}
                <div class="flex flex-col gap-2">
                    {#each pagedFiles as file (file.key)}
                        <div class="flex items-center gap-3 rounded-xl border border-darkborderc bg-darkbg p-2.5 transition-colors {selectedFileKeys.has(file.key) ? 'border-blue-500/60 bg-blue-500/10' : ''}">
                            <!-- Select checkbox -->
                            <input
                                type="checkbox"
                                checked={selectedFileKeys.has(file.key)}
                                onchange={() => onToggleSelectFile(file.key)}
                                class="h-4 w-4 rounded-sm border-darkborderc cursor-pointer shrink-0"
                            />

                            <!-- Thumbnail -->
                            <button
                                type="button"
                                class="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton hover:opacity-80 transition-opacity cursor-pointer flex items-center justify-center"
                                onclick={() => onOpenPreview(file.key)}
                            >
                                {#if isImageFile(file.key)}
                                    {@const _ = onLoadThumbnail(file.key)}
                                    {#if thumbnailUrls.has(file.key)}
                                        <img loading="lazy" src={thumbnailUrls.get(file.key)} alt="" class="h-full w-full object-cover" />
                                    {:else}
                                        <div class="text-[10px] text-textcolor2">img</div>
                                    {/if}
                                {:else if isAudioFile(file.key)}
                                    <MusicIcon class="h-5 w-5 text-textcolor2" />
                                {:else}
                                    <LayersIcon class="h-5 w-5 text-textcolor2" />
                                {/if}
                            </button>

                            <!-- Key & Size -->
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-1">
                                    <span class="rounded-md bg-darkbutton px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
                                        {formatBytes(file.size)}
                                    </span>
                                    {#if isThumbnailKey(file.key)}
                                        <span class="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300">
                                            Thumb
                                        </span>
                                    {/if}
                                </div>
                                <p class="mt-1 truncate font-mono text-xs text-textcolor" title={file.key}>
                                    {file.key}
                                </p>
                            </div>

                            <!-- Delete single -->
                            <button
                                type="button"
                                class="p-2 text-textcolor2 hover:text-rose-300 hover:bg-rose-500/20 rounded-lg transition-colors cursor-pointer shrink-0"
                                onclick={() => onDeleteSingleFile(file.key)}
                                title="Delete"
                            >
                                <Trash2Icon class="h-4 w-4" />
                            </button>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Pagination & Range Bar -->
    {#if totalItems > 0}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-darkborderc bg-darkbg p-2.5 sm:p-3 text-xs text-textcolor">
            <!-- Showing info & Page size -->
            <div class="flex flex-wrap items-center gap-3">
                <span class="text-textcolor2 font-medium">
                    {language.storageShowingRange(startItemIndex, endItemIndex, totalItems)}
                </span>

                <div class="flex items-center gap-1.5 text-textcolor2">
                    <span>{language.storageItemsPerPage}:</span>
                    <select
                        value={pageSize}
                        onchange={handlePageSizeChange}
                        class="rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-xs text-textcolor focus:border-blue-500 focus:outline-hidden cursor-pointer"
                    >
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={200}>200</option>
                        <option value={500}>500</option>
                    </select>
                </div>
            </div>

            <!-- Page Navigation Buttons -->
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    class="rounded-md p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                    disabled={safeCurrentPage <= 1}
                    onclick={() => goToPage(1)}
                    title="First Page"
                >
                    <ChevronFirstIcon class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="rounded-md p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                    disabled={safeCurrentPage <= 1}
                    onclick={() => goToPage(safeCurrentPage - 1)}
                    title="Previous Page"
                >
                    <ChevronLeftIcon class="h-4 w-4" />
                </button>

                <div class="flex items-center gap-1 px-1.5 font-medium text-xs">
                    <span class="text-textcolor">{safeCurrentPage}</span>
                    <span class="text-textcolor2">/</span>
                    <span class="text-textcolor2">{totalPages}</span>
                </div>

                <button
                    type="button"
                    class="rounded-md p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                    disabled={safeCurrentPage >= totalPages}
                    onclick={() => goToPage(safeCurrentPage + 1)}
                    title="Next Page"
                >
                    <ChevronRightIcon class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="rounded-md p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                    disabled={safeCurrentPage >= totalPages}
                    onclick={() => goToPage(totalPages)}
                    title="Last Page"
                >
                    <ChevronLastIcon class="h-4 w-4" />
                </button>
            </div>
        </div>
    {/if}

    <!-- Mobile Floating Bottom Action Bar when files are selected -->
    {#if selectedFileKeys.size > 0}
        <div class="fixed bottom-3 left-4 right-4 z-50 flex items-center justify-between rounded-xl border border-darkborderc bg-darkbg/95 p-3 shadow-2xl backdrop-blur-md sm:hidden animate-in slide-in-from-bottom duration-200">
            <span class="text-xs font-semibold text-textcolor">
                {selectedFileKeys.size} {language.storageFiles ?? 'files'} selected
            </span>
            <button
                type="button"
                class="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-bold text-white shadow-md hover:bg-rose-500 transition-colors cursor-pointer"
                disabled={busy}
                onclick={onDeleteSelectedFiles}
            >
                <Trash2Icon class="h-4 w-4" />
                <span>{language.storageDeleteSelected}</span>
            </button>
        </div>
    {/if}
</div>
