<script lang="ts">
    import {
        AlertTriangleIcon,
        CheckIcon,
        CopyIcon,
        LayersIcon,
        PackageIcon,
        SearchIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { formatBytes, isImageFile } from '../utils'
    import type { ModuleStorageInfo } from '../types'

    interface Props {
        module: ModuleStorageInfo
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onOpenPreview: (key: string) => void
        onClose: () => void
    }

    const {
        module,
        thumbnailUrls,
        onLoadThumbnail,
        onOpenPreview,
        onClose
    }: Props = $props()

    let assetFilter = $state<string>('all')
    let modalSearch = $state<string>('')
    let copiedKey = $state<string | null>(null)
    let copiedName = $state<string | null>(null)

    const filteredAssets = $derived.by(() => {
        let list = module.assets
        if (assetFilter === 'missing') {
            list = list.filter((a) => a.missing)
        } else if (assetFilter !== 'all') {
            list = list.filter((a) => a.type === assetFilter)
        }

        if (modalSearch.trim()) {
            const q = modalSearch.trim().toLowerCase()
            list = list.filter(
                (a) =>
                    a.key.toLowerCase().includes(q) ||
                    (a.originalName && a.originalName.toLowerCase().includes(q)) ||
                    (a.label && a.label.toLowerCase().includes(q))
            )
        }
        return list
    })

    const categories = $derived.by(() => {
        const types = new Set(module.assets.map((a) => a.type))
        return Array.from(types)
    })

    async function copyKey(key: string) {
        try {
            await navigator.clipboard.writeText(key)
            copiedKey = key
            setTimeout(() => {
                if (copiedKey === key) copiedKey = null
            }, 1500)
        } catch {
            // ignore
        }
    }

    async function copyName(name: string) {
        try {
            await navigator.clipboard.writeText(name)
            copiedName = name
            setTimeout(() => {
                if (copiedName === name) copiedName = null
            }, 1500)
        } catch {
            // ignore
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-xs animate-in fade-in duration-200"
    onclick={onClose}
>
    <div
        class="flex max-h-[90vh] sm:max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl sm:rounded-2xl border border-darkborderc bg-darkbg text-textcolor shadow-2xl"
        onclick={(e) => e.stopPropagation()}
    >
        <!-- Modal Header -->
        <div class="flex items-center justify-between border-b border-darkborderc px-4 sm:px-5 py-3.5">
            <div class="flex items-center gap-3 min-w-0">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-darkborderc bg-darkbutton text-violet-400">
                    <PackageIcon class="h-5 w-5" />
                </div>
                <div class="min-w-0">
                    <h3 class="truncate text-sm sm:text-base font-bold">{module.name}</h3>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-textcolor2">
                        <span>{module.totalAssets} {language.storageAssets}</span>
                        <span>·</span>
                        <span class="font-semibold text-textcolor">{formatBytes(module.totalSizeBytes)}</span>
                        {#if module.missingAssetsCount > 0}
                            <span>·</span>
                            <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-300 flex items-center gap-1">
                                <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                                {language.storageMissingCount(module.missingAssetsCount)}
                            </span>
                        {/if}
                    </div>
                </div>
            </div>
            <button
                type="button"
                class="rounded-lg p-1.5 text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor transition-colors cursor-pointer"
                onclick={onClose}
                aria-label="Close"
            >
                <XIcon class="h-5 w-5" />
            </button>
        </div>

        <!-- Filter & Search Bar -->
        <div class="flex flex-col gap-2 border-b border-darkborderc bg-darkbg/50 px-4 py-2.5">
            <!-- Search bar -->
            <div class="relative w-full">
                <SearchIcon class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-textcolor2 pointer-events-none" />
                <input
                    type="text"
                    bind:value={modalSearch}
                    placeholder={language.storageSearchAssetsInModal ?? 'Search asset name or key...'}
                    class="w-full rounded-lg border border-darkborderc bg-darkbg py-1.5 pl-8 pr-7 text-xs text-textcolor placeholder-textcolor2 focus:border-darkborderc/90 focus:outline-hidden"
                />
                {#if modalSearch}
                    <button
                        type="button"
                        class="absolute right-2 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor p-0.5 cursor-pointer"
                        onclick={() => (modalSearch = '')}
                        aria-label="Clear search"
                    >
                        <XIcon class="h-3.5 w-3.5" />
                    </button>
                {/if}
            </div>

            <!-- Filter Chips -->
            {#if categories.length > 1 || module.missingAssetsCount > 0}
                <div class="flex items-center gap-1.5 overflow-x-auto select-none scrollbar-none">
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap {assetFilter === 'all' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => (assetFilter = 'all')}
                    >
                        {language.storageFilterAll ?? 'All'} ({module.assets.length})
                    </button>
                    {#if module.missingAssetsCount > 0}
                        <button
                            type="button"
                            class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1 {assetFilter === 'missing' ? 'bg-amber-500/25 border border-amber-500/50 text-amber-300 font-bold' : 'text-amber-400 hover:text-amber-300'}"
                            onclick={() => (assetFilter = 'missing')}
                        >
                            <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                            {language.storageFilterMissing} ({module.missingAssetsCount})
                        </button>
                    {/if}
                    {#each categories as cat (cat)}
                        <button
                            type="button"
                            class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap {assetFilter === cat ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => (assetFilter = cat)}
                        >
                            {cat === 'moduleIcon' ? language.storageModuleIcon : language.storageModuleAsset} ({module.assets.filter((a) => a.type === cat).length})
                        </button>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Modal Body -->
        <div class="flex-1 overflow-y-auto p-3 sm:p-5">
            {#if filteredAssets.length === 0}
                <div class="py-12 text-center text-sm text-textcolor2">{language.storageNoAssetsFound}</div>
            {:else}
                <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {#each filteredAssets as asset (asset.key)}
                        <div class="flex items-center gap-3 rounded-xl border p-2.5 transition-colors {asset.missing ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/70' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80'}">
                            {#if asset.missing}
                                <div
                                    class="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400"
                                    title={language.storageAssetNotFoundInStorage}
                                >
                                    <AlertTriangleIcon class="h-5 w-5" />
                                    <span class="text-[8px] font-bold uppercase">Missing</span>
                                </div>
                            {:else}
                                <button
                                    type="button"
                                    class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-darkborderc bg-darkbutton transition-opacity hover:opacity-80 cursor-pointer"
                                    onclick={() => onOpenPreview(asset.key)}
                                    title={language.storagePreview}
                                >
                                    {#if isImageFile(asset.key)}
                                        {@const _ = onLoadThumbnail(asset.key)}
                                        {#if thumbnailUrls.has(asset.key)}
                                            <img src={thumbnailUrls.get(asset.key)} alt="" class="h-full w-full object-cover" />
                                        {:else}
                                            <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">img</div>
                                        {/if}
                                    {:else}
                                        <LayersIcon class="h-5 w-5 text-textcolor2" />
                                    {/if}
                                </button>
                            {/if}
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-1">
                                    <div class="flex items-center gap-1 min-w-0">
                                        <span class="rounded-md bg-darkbutton px-1.5 py-0.5 text-[10px] font-medium text-textcolor2 shrink-0">
                                            {asset.type === 'moduleIcon' ? language.storageModuleIcon : language.storageModuleAsset}
                                        </span>
                                        {#if asset.extension}
                                            <span class="rounded bg-darkborderc/60 px-1 py-0.2 text-[9px] font-mono text-textcolor2/90 uppercase shrink-0">
                                                {asset.extension}
                                            </span>
                                        {/if}
                                    </div>
                                    {#if asset.missing}
                                        <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-300 shrink-0">
                                            {language.storageMissing}
                                        </span>
                                    {:else}
                                        <span class="text-xs font-semibold text-textcolor shrink-0">{formatBytes(asset.size)}</span>
                                    {/if}
                                </div>

                                <!-- Original Name (Prominent Display) -->
                                <div class="mt-1 flex items-center justify-between gap-1">
                                    <h5 class="truncate text-xs sm:text-sm font-bold text-textcolor" title={asset.originalName || asset.label}>
                                        {asset.originalName || asset.label}
                                    </h5>
                                    {#if asset.originalName || asset.label}
                                        {@const displayName = asset.originalName || asset.label}
                                        <button
                                            type="button"
                                            class="shrink-0 p-0.5 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                            onclick={() => copyName(displayName)}
                                            title={copiedName === displayName ? 'Copied name!' : (language.storageCopyOriginalName ?? 'Copy Original Name')}
                                        >
                                            {#if copiedName === displayName}
                                                <CheckIcon class="h-3 w-3 text-green-400" />
                                            {:else}
                                                <CopyIcon class="h-3 w-3" />
                                            {/if}
                                        </button>
                                    {/if}
                                </div>

                                <!-- Storage Hex Key (Subtle Secondary) -->
                                <div class="mt-0.5 flex items-center justify-between gap-1">
                                    <span class="truncate font-mono text-[10px] {asset.missing ? 'text-amber-300/70' : 'text-textcolor2/70'}" title={asset.key}>
                                        {asset.key}
                                    </span>
                                    <button
                                        type="button"
                                        class="shrink-0 p-0.5 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                        onclick={() => copyKey(asset.key)}
                                        title={copiedKey === asset.key ? 'Copied key!' : (language.storageCopyKey ?? 'Copy Asset Key')}
                                    >
                                        {#if copiedKey === asset.key}
                                            <CheckIcon class="h-3 w-3 text-green-400" />
                                        {:else}
                                            <CopyIcon class="h-3 w-3 opacity-60 hover:opacity-100" />
                                        {/if}
                                    </button>
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <div class="flex justify-end border-t border-darkborderc bg-darkbg/50 px-4 sm:px-5 py-3">
            <Button onclick={onClose}>{language.storageClose}</Button>
        </div>
    </div>
</div>
