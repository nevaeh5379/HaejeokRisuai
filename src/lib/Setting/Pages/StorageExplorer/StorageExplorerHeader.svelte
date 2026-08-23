<script lang="ts">
    import {
        MenuIcon,
        RefreshCwIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { TabType, ViewTarget } from './types'

    interface Props {
        currentTab: TabType
        viewTarget: ViewTarget
        loading: boolean
        busy: boolean
        onToggleMobileSidebar?: () => void
        onRefresh: () => void
        onClose: () => void
    }

    const {
        currentTab,
        viewTarget,
        loading,
        busy,
        onToggleMobileSidebar,
        onRefresh,
        onClose
    }: Props = $props()

    const targetLabel = $derived.by(() => {
        if (viewTarget === 's3') return language.storageTargetS3 ?? 'S3 / RustFS'
        if (viewTarget === 'azuresql') return language.storageAzureSql ?? 'Azure SQL'
        return language.storageLocalFs ?? 'Local FS'
    })

    const tabLabel = $derived.by(() => {
        if (currentTab === 'bots') return language.storageTabBots
        if (currentTab === 'modules') return language.storageTabModules
        if (currentTab === 'files') return language.storageTabAllFiles
        if (currentTab === 'backend') return language.storageTabBackend
        return ''
    })
</script>

<header class="flex h-14 shrink-0 items-center justify-between border-b border-darkborderc bg-darkbg px-3 sm:px-5 py-2.5 select-none">
    <!-- Left: Mobile Menu Toggle & Breadcrumbs -->
    <div class="flex items-center gap-2 sm:gap-3 min-w-0">
        {#if onToggleMobileSidebar}
            <button
                type="button"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-darkborderc bg-darkbutton text-textcolor hover:bg-selected transition-colors md:hidden cursor-pointer"
                onclick={onToggleMobileSidebar}
                title="Toggle Sidebar"
                aria-label="Toggle Sidebar"
            >
                <MenuIcon class="h-4.5 w-4.5" />
            </button>
        {/if}

        <!-- Breadcrumbs -->
        <div class="flex items-center gap-2 min-w-0 text-xs sm:text-sm">
            {#if currentTab === 'backend'}
                <h3 class="truncate font-bold text-textcolor">
                    {tabLabel}
                </h3>
            {:else}
                <span class="rounded-md border px-2 py-0.5 font-semibold text-[10px] sm:text-xs shrink-0 {viewTarget === 'fs' ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300' : (viewTarget === 's3' ? 'bg-blue-500/15 border-blue-500/30 text-blue-300' : 'bg-sky-500/15 border-sky-500/30 text-sky-300')}">
                    {targetLabel}
                </span>
                <span class="text-textcolor2">/</span>
                <h3 class="truncate font-bold text-textcolor">
                    {tabLabel}
                </h3>
            {/if}
        </div>
    </div>

    <!-- Right: Actions (Refresh, Close) -->
    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <!-- Refresh button -->
        <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg border border-darkborderc bg-darkbutton px-2.5 sm:px-3 text-xs font-medium text-textcolor hover:bg-selected transition-colors disabled:opacity-50 cursor-pointer"
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
            class="flex h-9 w-9 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
            onclick={onClose}
            title={language.storageClose ?? 'Close'}
            aria-label="Close"
        >
            <XIcon class="h-5 w-5" />
        </button>
    </div>
</header>
