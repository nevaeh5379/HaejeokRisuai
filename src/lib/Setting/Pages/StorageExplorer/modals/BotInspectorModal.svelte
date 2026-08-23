<script lang="ts">
    import {
        AlertTriangleIcon,
        CopyIcon,
        MusicIcon,
        UserIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { formatBytes, isImageFile } from '../utils'
    import type { BotAssetItem, BotStorageInfo } from '../types'

    interface Props {
        bot: BotStorageInfo
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onOpenPreview: (key: string) => void
        onClose: () => void
    }

    const {
        bot,
        thumbnailUrls,
        onLoadThumbnail,
        onOpenPreview,
        onClose
    }: Props = $props()

    let assetFilter = $state<string>('all')
    let copiedKey = $state<string | null>(null)

    const filteredAssets = $derived.by(() => {
        if (assetFilter === 'all') return bot.assets
        if (assetFilter === 'missing') return bot.assets.filter((a) => a.missing)
        return bot.assets.filter((a) => a.type === assetFilter)
    })

    const categories = $derived.by(() => {
        const types = new Set(bot.assets.map((a) => a.type))
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
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-xs animate-in fade-in duration-200"
    onclick={onClose}
>
    <div
        class="flex max-h-[90vh] sm:max-h-[85vh] w-full max-w-2xl flex-col rounded-t-2xl sm:rounded-2xl border border-darkborderc bg-darkbg text-textcolor shadow-2xl overflow-hidden"
        onclick={(e) => e.stopPropagation()}
    >
        <!-- Modal Header -->
        <div class="flex items-center justify-between border-b border-darkborderc px-4 sm:px-5 py-3.5">
            <div class="flex items-center gap-3 min-w-0">
                <div class="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton">
                    {#if bot.avatarKey}
                        {@const _ = onLoadThumbnail(bot.avatarKey)}
                        {#if thumbnailUrls.has(bot.avatarKey)}
                            <img src={thumbnailUrls.get(bot.avatarKey)} alt="" class="h-full w-full object-cover" />
                        {:else}
                            <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">...</div>
                        {/if}
                    {:else}
                        <div class="flex h-full w-full items-center justify-center text-textcolor2">
                            <UserIcon class="h-5 w-5" />
                        </div>
                    {/if}
                </div>
                <div class="min-w-0">
                    <h3 class="truncate text-sm sm:text-base font-bold">{bot.name}</h3>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-textcolor2">
                        <span>{bot.totalAssets} {language.storageAssets}</span>
                        <span>·</span>
                        <span class="font-semibold text-textcolor">{formatBytes(bot.totalSizeBytes)}</span>
                        {#if bot.missingAssetsCount > 0}
                            <span>·</span>
                            <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-300 flex items-center gap-1">
                                <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                                {language.storageMissingCount(bot.missingAssetsCount)}
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

        <!-- Filter Chips Bar -->
        {#if categories.length > 1 || bot.missingAssetsCount > 0}
            <div class="flex items-center gap-1.5 border-b border-darkborderc bg-darkbg/50 px-4 py-2 overflow-x-auto select-none scrollbar-none">
                <button
                    type="button"
                    class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap {assetFilter === 'all' ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => assetFilter = 'all'}
                >
                    {language.storageFilterAll ?? 'All'} ({bot.assets.length})
                </button>
                {#if bot.missingAssetsCount > 0}
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1 {assetFilter === 'missing' ? 'bg-amber-500/25 border border-amber-500/50 text-amber-300 font-bold' : 'text-amber-400 hover:text-amber-300'}"
                        onclick={() => assetFilter = 'missing'}
                    >
                        <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                        {language.storageFilterMissing} ({bot.missingAssetsCount})
                    </button>
                {/if}
                {#each categories as cat (cat)}
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer whitespace-nowrap {assetFilter === cat ? 'bg-selected text-textcolor font-medium' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => assetFilter = cat}
                    >
                        {cat} ({bot.assets.filter((a) => a.type === cat).length})
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Modal Body (Assets Grid) -->
        <div class="flex-1 overflow-y-auto p-3 sm:p-5">
            {#if filteredAssets.length === 0}
                <div class="py-12 text-center text-sm text-textcolor2">
                    {language.storageNoAssetsFound}
                </div>
            {:else}
                <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {#each filteredAssets as asset (asset.key)}
                        <div class="flex items-center gap-3 rounded-xl border p-2.5 transition-colors {asset.missing ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/70' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80'}">
                            <!-- Thumbnail / Icon -->
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
                                    class="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton hover:opacity-80 transition-opacity cursor-pointer"
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
                                    {:else if /\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i.test(asset.key)}
                                        <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                            <MusicIcon class="h-5 w-5" />
                                        </div>
                                    {:else}
                                        <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">file</div>
                                    {/if}
                                </button>
                            {/if}

                            <!-- Label & Info -->
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-1">
                                    <span class="rounded-md bg-darkbutton px-1.5 py-0.5 text-[10px] font-medium text-textcolor2">
                                        {asset.type}
                                    </span>
                                    {#if asset.missing}
                                        <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-300">
                                            {language.storageMissing}
                                        </span>
                                    {:else}
                                        <span class="text-xs font-semibold text-textcolor">
                                            {formatBytes(asset.size)}
                                        </span>
                                    {/if}
                                </div>
                                <h5 class="mt-1 truncate text-xs font-medium text-textcolor" title={asset.label}>
                                    {asset.label}
                                </h5>
                                <div class="mt-0.5 flex items-center justify-between gap-1">
                                    <span class="truncate text-[10px] font-mono {asset.missing ? 'text-amber-300/70' : 'text-textcolor2/70'}" title={asset.key}>
                                        {asset.key}
                                    </span>
                                    <button
                                        type="button"
                                        class="shrink-0 p-0.5 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                        onclick={() => copyKey(asset.key)}
                                        title={copiedKey === asset.key ? 'Copied!' : 'Copy Key'}
                                    >
                                        <CopyIcon class="h-3 w-3 {copiedKey === asset.key ? 'text-green-400' : ''}" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Modal Footer -->
        <div class="flex justify-end border-t border-darkborderc px-4 sm:px-5 py-3 bg-darkbg/50">
            <Button onclick={onClose}>{language.storageClose}</Button>
        </div>
    </div>
</div>
