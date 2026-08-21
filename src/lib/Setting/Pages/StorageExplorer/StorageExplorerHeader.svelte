<script lang="ts">
    import {
        ChevronLeftIcon,
        DatabaseIcon,
        FolderArchiveIcon,
        HardDriveIcon,
        RefreshCwIcon,
        ServerIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { formatBytes } from './utils'
    import type { NodeS3ServerConfig, NodeStorageSummary, ViewTarget } from './types'

    interface Props {
        viewTarget: ViewTarget
        config: NodeS3ServerConfig | null
        storageSummary: NodeStorageSummary | null
        loading: boolean
        busy: boolean
        onSwitchTarget: (target: ViewTarget) => void
        onRefresh: () => void
        onClose: () => void
    }

    const {
        viewTarget,
        config,
        storageSummary,
        loading,
        busy,
        onSwitchTarget,
        onRefresh,
        onClose
    }: Props = $props()
</script>

<header class="flex h-14 shrink-0 items-center justify-between border-b border-darkborderc bg-darkbg px-3 sm:px-5 py-2.5 rounded-t-none sm:rounded-t-2xl select-none">
    <!-- Left: Navigation & Title -->
    <div class="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
            type="button"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-darkborderc bg-darkbg hover:bg-selected/40 transition-colors cursor-pointer"
            onclick={onClose}
            title={language.storageClose ?? 'Close'}
            aria-label="Close"
        >
            <ChevronLeftIcon class="h-5 w-5" />
        </button>
        <div class="flex items-center gap-2 min-w-0">
            <HardDriveIcon class="h-5 w-5 text-blue-400 shrink-0 hidden sm:inline" />
            <h2 class="truncate text-sm font-bold sm:text-lg">{language.storageExplorer}</h2>
        </div>
    </div>

    <!-- Right: Backend Switcher Pill & Actions -->
    <div class="flex items-center gap-1.5 sm:gap-2">
        <!-- Target Storage Toggle Pill (S3 / Azure SQL / Local FS) -->
        <div class="flex items-center rounded-lg border border-darkborderc bg-darkbg/90 p-0.5 text-xs">
            {#if config?.enabled && config.storageType !== 'azuresql'}
                <button
                    type="button"
                    class="flex items-center gap-1 sm:gap-1.5 rounded-md px-2 sm:px-2.5 py-1 transition-all cursor-pointer {viewTarget === 's3' ? 'bg-blue-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => onSwitchTarget('s3')}
                    title={language.storageS3Rustfs}
                >
                    <ServerIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="hidden md:inline">{language.storageS3Rustfs}</span>
                    <span class="md:hidden">S3</span>
                    <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px] hidden sm:inline">
                        {formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}
                    </span>
                </button>
            {/if}

            {#if config?.enabled && config.storageType === 'azuresql'}
                <button
                    type="button"
                    class="flex items-center gap-1 sm:gap-1.5 rounded-md px-2 sm:px-2.5 py-1 transition-all cursor-pointer {viewTarget === 'azuresql' ? 'bg-sky-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => onSwitchTarget('azuresql')}
                    title={language.storageAzureSql}
                >
                    <DatabaseIcon class="h-3.5 w-3.5 shrink-0" />
                    <span class="hidden md:inline">{language.storageAzureSql}</span>
                    <span class="md:hidden">Azure</span>
                    <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px] hidden sm:inline">
                        {formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}
                    </span>
                </button>
            {/if}

            <button
                type="button"
                class="flex items-center gap-1 sm:gap-1.5 rounded-md px-2 sm:px-2.5 py-1 transition-all cursor-pointer {viewTarget === 'fs' ? 'bg-indigo-600 text-white font-semibold shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                onclick={() => onSwitchTarget('fs')}
                title={language.storageLocalFs}
            >
                <FolderArchiveIcon class="h-3.5 w-3.5 shrink-0" />
                <span class="hidden md:inline">{language.storageLocalFs}</span>
                <span class="md:hidden">FS</span>
                <span class="rounded-full bg-black/30 px-1.5 py-0.2 text-[10px] hidden sm:inline">
                    {formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}
                </span>
            </button>
        </div>

        <!-- Refresh button -->
        <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg border border-darkborderc bg-darkbg px-2.5 sm:px-3 text-xs font-medium hover:bg-selected/40 transition-colors disabled:opacity-50 cursor-pointer"
            disabled={loading || busy}
            onclick={onRefresh}
            title={language.storageRefresh}
        >
            <RefreshCwIcon class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
            <span class="hidden sm:inline">{language.storageRefresh}</span>
        </button>

        <!-- Close button -->
        <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor transition-colors cursor-pointer"
            onclick={onClose}
            title={language.storageClose ?? 'Close'}
            aria-label="Close"
        >
            <XIcon class="h-5 w-5" />
        </button>
    </div>
</header>
