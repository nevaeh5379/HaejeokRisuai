<script lang="ts">
    import { AlertTriangleIcon, SearchIcon, UserIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import StorageTargetSelector from '../components/StorageTargetSelector.svelte'
    import { formatBytes } from '../utils'
    import type { BotSortType, BotStorageInfo, NodeS3ServerConfig, NodeStorageSummary, ViewTarget } from '../types'

    interface Props {
        bots: BotStorageInfo[]
        viewTarget: ViewTarget
        storageSummary: NodeStorageSummary | null
        config?: NodeS3ServerConfig | null
        busy?: boolean
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onSelectBot: (bot: BotStorageInfo) => void
        onSwitchTarget: (target: ViewTarget) => void
    }

    const {
        bots,
        viewTarget,
        storageSummary,
        config,
        busy = false,
        thumbnailUrls,
        onLoadThumbnail,
        onSelectBot,
        onSwitchTarget
    }: Props = $props()

    let botSearch = $state('')
    let botSort = $state<BotSortType>('size_desc')

    const totalMissing = $derived(bots.reduce((sum, b) => sum + b.missingAssetsCount, 0))
    const botsWithMissingCount = $derived(bots.filter((b) => b.missingAssetsCount > 0).length)

    const filteredBots = $derived.by(() => {
        let list = [...bots]
        if (botSearch.trim()) {
            const query = botSearch.trim().toLowerCase()
            list = list.filter((b) => b.name.toLowerCase().includes(query))
        }
        if (botSort === 'size_desc') {
            list.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
        } else if (botSort === 'size_asc') {
            list.sort((a, b) => a.totalSizeBytes - b.totalSizeBytes)
        } else if (botSort === 'count_desc') {
            list.sort((a, b) => b.totalAssets - a.totalAssets)
        } else if (botSort === 'name_asc') {
            list.sort((a, b) => a.name.localeCompare(b.name))
        } else if (botSort === 'missing_desc') {
            list.sort((a, b) => b.missingAssetsCount - a.missingAssetsCount || b.totalSizeBytes - a.totalSizeBytes)
        }
        return list
    })
</script>

<div class="flex flex-col gap-4">
    <!-- Missing Assets Banner -->
    {#if totalMissing > 0}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
            <div class="flex items-center gap-2 min-w-0">
                <AlertTriangleIcon class="h-4 w-4 shrink-0 text-amber-400" />
                <span class="truncate">{language.storageMissingBotsDetected(botsWithMissingCount)} ({language.storageMissingAssets}: {totalMissing}개)</span>
            </div>
            {#if botSort !== 'missing_desc'}
                <button
                    type="button"
                    class="rounded-md bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 transition-colors cursor-pointer shrink-0"
                    onclick={() => botSort = 'missing_desc'}
                >
                    {language.storageSortMissingDesc}
                </button>
            {/if}
        </div>
    {/if}

    <!-- Controls: Search & Target Selector & Sort -->
    <div class="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
        <div class="relative min-w-[200px] flex-1 max-w-md">
            <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2 pointer-events-none" />
            <input
                type="text"
                bind:value={botSearch}
                placeholder={language.storageSearchBots}
                class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-8 text-xs sm:text-sm text-textcolor placeholder-textcolor2 focus:border-darkborderc/90 focus:outline-hidden"
            />
            {#if botSearch}
                <button
                    type="button"
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor p-0.5"
                    onclick={() => botSearch = ''}
                    aria-label="Clear search"
                >
                    <XIcon class="h-3.5 w-3.5" />
                </button>
            {/if}
        </div>

        <div class="flex flex-wrap items-center gap-2.5 shrink-0">
            <!-- Storage Target Selector Menu -->
            <StorageTargetSelector
                {viewTarget}
                {storageSummary}
                {config}
                disabled={busy}
                {onSwitchTarget}
            />

            <!-- Sort Dropdown -->
            <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-xs text-textcolor2 hidden sm:inline">{language.storageSort}:</span>
                <select
                    bind:value={botSort}
                    class="rounded-lg border border-darkborderc bg-darkbg px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-medium text-textcolor focus:border-darkborderc/90 focus:outline-hidden cursor-pointer"
                >
                    <option value="size_desc">{language.storageSortSizeDesc}</option>
                    <option value="size_asc">{language.storageSortSizeAsc}</option>
                    <option value="count_desc">{language.storageSortCountDesc}</option>
                    <option value="name_asc">{language.storageSortNameAsc}</option>
                    <option value="missing_desc">{language.storageSortMissingDesc}</option>
                </select>
            </div>
        </div>
    </div>

    <!-- Bot Cards Grid -->
    {#if filteredBots.length === 0}
        <div class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-darkborderc py-16 text-textcolor2">
            <UserIcon class="h-12 w-12 opacity-30" />
            <p class="mt-2 text-sm">{language.storageNoBotsFound}</p>
        </div>
    {:else}
        <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {#each filteredBots as bot (bot.id)}
                <button
                    type="button"
                    class="group relative flex flex-col justify-between rounded-xl border p-3.5 sm:p-4 text-left transition-all hover:bg-darkbg hover:shadow-md cursor-pointer w-full active:scale-[0.99] {bot.missingAssetsCount > 0 ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/70' : 'border-darkborderc bg-darkbg/70 hover:border-darkborderc/90'}"
                    onclick={() => onSelectBot(bot)}
                >
                    <div class="flex items-start gap-3 w-full">
                        <!-- Bot Avatar Thumbnail -->
                        <div class="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-darkborderc bg-darkbutton">
                            {#if bot.avatarKey}
                                {@const _ = onLoadThumbnail(bot.avatarKey)}
                                {#if thumbnailUrls.has(bot.avatarKey)}
                                    <img src={thumbnailUrls.get(bot.avatarKey)} alt={bot.name} class="h-full w-full object-cover" />
                                {:else}
                                    <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">...</div>
                                {/if}
                            {:else}
                                <div class="flex h-full w-full items-center justify-center text-textcolor2">
                                    <UserIcon class="h-6 w-6" />
                                </div>
                            {/if}
                        </div>

                        <!-- Bot Title & Size -->
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center justify-between gap-1">
                                <h4 class="truncate text-sm font-bold text-textcolor">
                                    {bot.name}
                                </h4>
                                {#if bot.missingAssetsCount > 0}
                                    <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-300 flex items-center gap-0.5 shrink-0" title="{bot.missingAssetsCount} missing assets">
                                        <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                                        {bot.missingAssetsCount}
                                    </span>
                                {/if}
                            </div>
                            <div class="mt-1 flex items-center gap-2">
                                <span class="rounded-md bg-darkbutton border border-darkborderc/60 px-2 py-0.5 text-xs font-semibold text-textcolor">
                                    {formatBytes(bot.totalSizeBytes)}
                                </span>
                                <span class="text-xs text-textcolor2">
                                    {bot.totalAssets} {language.storageAssets}
                                </span>
                            </div>
                        </div>
                    </div>

                    <!-- Breakdown Pills -->
                    <div class="mt-3 flex flex-wrap gap-1.5 border-t border-darkborderc/50 pt-2.5 text-[11px] text-textcolor2 w-full">
                        {#if bot.missingAssetsCount > 0}
                            <span class="rounded-md bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 text-amber-300 font-semibold flex items-center gap-1">
                                <AlertTriangleIcon class="h-3 w-3 text-amber-400" />
                                {language.storageMissing}: {bot.missingAssetsCount}
                            </span>
                        {/if}
                        {#if bot.emotionsCount > 0}
                            <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                {language.storageEmotions}: {bot.emotionsCount}
                            </span>
                        {/if}
                        {#if bot.additionalAssetsCount > 0}
                            <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                {language.storageAdditional}: {bot.additionalAssetsCount}
                            </span>
                        {/if}
                        {#if bot.ccAssetsCount > 0}
                            <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                {language.storageCcAssets}: {bot.ccAssetsCount}
                            </span>
                        {/if}
                        {#if bot.audioCount > 0}
                            <span class="rounded-md bg-darkbutton/60 px-2 py-0.5">
                                {language.storageAudio}: {bot.audioCount}
                            </span>
                        {/if}
                    </div>
                </button>
            {/each}
        </div>
    {/if}
</div>
