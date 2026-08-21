<script lang="ts">
    import {
        ChevronDownIcon,
        ChevronUpIcon,
        DatabaseIcon,
        FolderArchiveIcon,
        ServerIcon,
        Trash2Icon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { formatBytes } from './utils'
    import type { NodeS3ServerConfig, NodeStorageSummary, ViewTarget } from './types'

    interface Props {
        storageSummary: NodeStorageSummary | null
        config: NodeS3ServerConfig | null
        viewTarget: ViewTarget
        botCount: number
        moduleCount: number
        orphanCount: number
        orphanSizeBytes: number
        purgingLocal: boolean
        cleaningOrphans: boolean
        busy: boolean
        onPurgeLocalFs: () => void
        onCleanOrphans: () => void
    }

    const {
        storageSummary,
        config,
        viewTarget,
        botCount,
        moduleCount,
        orphanCount,
        orphanSizeBytes,
        purgingLocal,
        cleaningOrphans,
        busy,
        onPurgeLocalFs,
        onCleanOrphans
    }: Props = $props()

    let mobileExpanded = $state(false)

    // Current active storage stats helper
    const activeStats = $derived.by(() => {
        if (!storageSummary) return { name: 'Local FS', size: 0, count: 0 }
        if (storageSummary.activeType === 's3' && storageSummary.s3) {
            return { name: 'S3', size: storageSummary.s3.totalSizeBytes, count: storageSummary.s3.totalObjects }
        }
        if (storageSummary.activeType === 'azuresql' && storageSummary.azuresql) {
            return { name: 'Azure SQL', size: storageSummary.azuresql.totalSizeBytes, count: storageSummary.azuresql.totalObjects }
        }
        return { name: 'Local FS', size: storageSummary.localFs.totalSizeBytes, count: storageSummary.localFs.totalObjects }
    })
</script>

<div class="border-b border-darkborderc bg-darkbg/60 px-3 sm:px-4 py-2.5 sm:py-3 select-none">
    <!-- Mobile Compact Bar (< sm) -->
    <div class="flex items-center justify-between sm:hidden">
        <div class="flex items-center gap-2 text-xs">
            <span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] font-bold text-blue-300">
                {activeStats.name}
            </span>
            <span class="font-bold text-textcolor">
                {formatBytes(activeStats.size)}
            </span>
            <span class="text-textcolor2 text-[11px]">
                ({activeStats.count.toLocaleString()} {language.storageAssets})
            </span>
            {#if orphanCount > 0}
                <span class="rounded-full bg-rose-500/20 px-1.5 py-0.2 text-[10px] text-rose-300 font-semibold">
                    {orphanCount} orphan
                </span>
            {/if}
        </div>

        <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors cursor-pointer"
            onclick={() => mobileExpanded = !mobileExpanded}
        >
            <span>{mobileExpanded ? (language.storageClose ?? 'Close') : (language.storageOverview ?? 'Overview')}</span>
            {#if mobileExpanded}
                <ChevronUpIcon class="h-3.5 w-3.5" />
            {:else}
                <ChevronDownIcon class="h-3.5 w-3.5" />
            {/if}
        </button>
    </div>

    <!-- Cards Container: Hidden on mobile when collapsed, visible on sm+ -->
    <div class="{mobileExpanded ? 'mt-2.5 grid grid-cols-1 gap-2 sm:mt-0' : 'hidden sm:grid'} sm:grid-cols-2 lg:grid-cols-5 sm:gap-3">
        <!-- S3 Object Storage Card -->
        <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                    <ServerIcon class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <span class="truncate">{language.storageTargetS3}</span>
                </div>
                {#if config?.enabled && config.storageType === 's3'}
                    <span class="rounded-full bg-blue-500/20 px-2 py-0.2 text-[10px] font-bold text-blue-300">
                        {storageSummary?.activeType === 's3' ? language.storageMainActive : language.storageActive}
                    </span>
                {:else}
                    <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">{language.storageInactive}</span>
                {/if}
            </div>
            <div class="mt-1.5 text-base font-bold text-textcolor sm:text-lg lg:text-xl">
                {formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}
                <span class="text-xs font-normal text-textcolor2">({(storageSummary?.s3?.totalObjects ?? 0).toLocaleString()})</span>
            </div>
        </div>

        <!-- Azure SQL Storage Card -->
        <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                    <DatabaseIcon class="h-3.5 w-3.5 text-sky-400 shrink-0" />
                    <span class="truncate">{language.storageAzureSql}</span>
                </div>
                {#if config?.enabled && config.storageType === 'azuresql'}
                    <span class="rounded-full bg-sky-500/20 px-2 py-0.2 text-[10px] font-bold text-sky-300">
                        {storageSummary?.activeType === 'azuresql' ? language.storageMainActive : language.storageActive}
                    </span>
                {:else}
                    <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">{language.storageInactive}</span>
                {/if}
            </div>
            <div class="mt-1.5 text-base font-bold text-textcolor sm:text-lg lg:text-xl">
                {formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}
                <span class="text-xs font-normal text-textcolor2">({(storageSummary?.azuresql?.totalObjects ?? 0).toLocaleString()})</span>
            </div>
        </div>

        <!-- Local FS Storage Card (with Purge action if S3/Azure active) -->
        <div class="relative flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-1 text-[11px] font-medium text-textcolor2 sm:text-xs">
                    <FolderArchiveIcon class="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                    <span class="truncate">{language.storageLocalFsStorage}</span>
                </div>
                <div class="flex items-center gap-1">
                    {#if storageSummary?.activeType === 'fs'}
                        <span class="rounded-full bg-green-500/20 px-2 py-0.2 text-[10px] font-bold text-green-300">{language.storageMainActive}</span>
                    {:else}
                        <span class="rounded-full bg-darkbutton px-2 py-0.2 text-[10px] text-textcolor2">{language.storageStandbyBadge}</span>
                        {#if (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                            <button
                                type="button"
                                class="rounded-md bg-rose-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                                disabled={purgingLocal || busy}
                                onclick={onPurgeLocalFs}
                                title={language.storagePurgeLocalFs}
                            >
                                {purgingLocal ? language.storagePurging : language.storagePurgeLocal}
                            </button>
                        {/if}
                    {/if}
                </div>
            </div>
            <div class="mt-1.5 text-base font-bold text-textcolor sm:text-lg lg:text-xl">
                {formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}
                <span class="text-xs font-normal text-textcolor2">({(storageSummary?.localFs?.totalObjects ?? 0).toLocaleString()})</span>
            </div>
        </div>

        <!-- Managed content count -->
        <div class="flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
            <div class="text-[11px] font-medium text-textcolor2 sm:text-xs truncate">{language.storageManagedContent}</div>
            <div class="mt-1.5 text-base font-bold text-textcolor sm:text-lg lg:text-xl">
                {botCount} <span class="text-xs font-normal text-textcolor2">{language.storageCharacters}</span>
                <span class="text-xs font-normal text-textcolor2">·</span>
                {moduleCount} <span class="text-xs font-normal text-textcolor2">{language.storageModules}</span>
            </div>
        </div>

        <!-- Orphan Assets & Cleaner for current target -->
        <div class="flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-3 shadow-xs">
            <div class="flex items-center justify-between">
                <div class="text-[11px] font-medium text-textcolor2 sm:text-xs truncate">
                    {language.storageOrphanAssets} ({viewTarget.toUpperCase()})
                </div>
                {#if orphanCount > 0}
                    <button
                        type="button"
                        class="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                        disabled={cleaningOrphans || busy}
                        onclick={onCleanOrphans}
                    >
                        {cleaningOrphans ? language.storagePurging : language.storageCleanOrphan}
                    </button>
                {/if}
            </div>
            <div class="mt-1.5 text-base font-bold text-textcolor sm:text-lg lg:text-xl">
                {orphanCount} <span class="text-xs font-normal text-textcolor2">({formatBytes(orphanSizeBytes)})</span>
            </div>
        </div>
    </div>
</div>
