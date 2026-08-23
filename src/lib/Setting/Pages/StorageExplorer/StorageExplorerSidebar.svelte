<script lang="ts">
    import {
        CheckCircle2Icon,
        DatabaseIcon,
        FolderArchiveIcon,
        HardDriveIcon,
        LayersIcon,
        PackageIcon,
        ServerIcon,
        SettingsIcon,
        ShieldCheckIcon,
        Trash2Icon,
        UserIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { formatBytes } from './utils'
    import type { NodeBackupConfig } from 'src/ts/storage/nodePostgresStorage'
    import type { NodeS3ServerConfig, NodeStorageSummary, TabType, ViewTarget } from './types'

    interface Props {
        currentTab: TabType
        viewTarget: ViewTarget
        storageSummary: NodeStorageSummary | null
        config: NodeS3ServerConfig | null
        backupConfig?: NodeBackupConfig | null
        botCount: number
        moduleCount: number
        fileCount: number
        orphanCount: number
        orphanSizeBytes: number
        purgingLocal: boolean
        cleaningOrphans: boolean
        busy: boolean
        onSelectTab: (tab: TabType) => void
        onSwitchTarget: (target: ViewTarget) => void
        onPurgeLocalFs: () => void
        onCleanOrphans: () => void
        onClose?: () => void
    }

    const {
        currentTab,
        viewTarget,
        storageSummary,
        config,
        backupConfig = null,
        botCount,
        moduleCount,
        fileCount,
        orphanCount,
        orphanSizeBytes,
        purgingLocal,
        cleaningOrphans,
        busy,
        onSelectTab,
        onSwitchTarget,
        onPurgeLocalFs,
        onCleanOrphans,
        onClose
    }: Props = $props()

    const activeStorageName = $derived.by(() => {
        if (!storageSummary) return 'Local FS'
        if (storageSummary.activeType === 's3') return 'S3 / RustFS'
        if (storageSummary.activeType === 'azuresql') return 'Azure SQL'
        return 'Local FS'
    })
</script>

<aside class="flex h-full w-full flex-col bg-darkbg/95 text-textcolor select-none border-r border-darkborderc overflow-hidden">
    <!-- Sidebar Header / Branding -->
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-darkborderc px-4 bg-darkbg">
        <div class="flex items-center gap-2.5 min-w-0">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400 border border-blue-500/30">
                <HardDriveIcon class="h-4.5 w-4.5" />
            </div>
            <div class="min-w-0">
                <h2 class="truncate text-sm font-bold text-textcolor">{language.storageExplorer}</h2>
                <div class="flex items-center gap-1.5 text-[10px] text-textcolor2">
                    <span class="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                    <span class="truncate">{activeStorageName} {language.storageActive}</span>
                </div>
            </div>
        </div>

        {#if onClose}
            <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor transition-colors md:hidden cursor-pointer"
                onclick={onClose}
                aria-label="Close Sidebar"
            >
                <XIcon class="h-4.5 w-4.5" />
            </button>
        {/if}
    </div>

    <!-- Scrollable Body for Targets & Navigation -->
    <div class="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-thin">
        <!-- ── 1. STORAGE TARGETS (스토리지 대상) ── -->
        <section class="space-y-1.5">
            <div class="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-textcolor2">
                <span>{language.s3StatsStorageType ?? 'Storage Targets'}</span>
                <span class="text-[10px] lowercase font-normal opacity-70">click to inspect</span>
            </div>

            <div class="space-y-1.5">
                <!-- S3 Object Storage Card -->
                <button
                    type="button"
                    class="group relative flex w-full flex-col gap-1 rounded-xl border p-2.5 text-left transition-all cursor-pointer {viewTarget === 's3' && currentTab !== 'backend' ? 'border-blue-500/80 bg-blue-500/10 shadow-xs ring-1 ring-blue-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => onSwitchTarget('s3')}
                >
                    <div class="flex items-center justify-between gap-1 w-full">
                        <div class="flex items-center gap-2 min-w-0">
                            <ServerIcon class="h-4 w-4 shrink-0 {viewTarget === 's3' && currentTab !== 'backend' ? 'text-blue-400' : 'text-textcolor2 group-hover:text-blue-400'} transition-colors" />
                            <span class="truncate text-xs font-semibold {viewTarget === 's3' && currentTab !== 'backend' ? 'text-blue-300' : 'text-textcolor'}">
                                {language.storageTargetS3}
                            </span>
                        </div>
                        {#if config?.enabled && config.storageType === 's3'}
                            <span class="rounded-full bg-blue-500/20 px-1.5 py-0.2 text-[10px] font-bold text-blue-300 shrink-0">
                                {storageSummary?.activeType === 's3' ? language.storageMainActive : language.storageActive}
                            </span>
                        {:else}
                            <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] text-textcolor2 shrink-0">
                                {language.storageInactive}
                            </span>
                        {/if}
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-textcolor2 pl-6">
                        <span class="font-bold text-textcolor">
                            {formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}
                        </span>
                        <span class="text-[10px] font-mono">
                            {(storageSummary?.s3?.totalObjects ?? 0).toLocaleString()} {language.storageAssets}
                        </span>
                    </div>
                </button>

                <!-- Azure SQL Storage Card -->
                <button
                    type="button"
                    class="group relative flex w-full flex-col gap-1 rounded-xl border p-2.5 text-left transition-all cursor-pointer {viewTarget === 'azuresql' && currentTab !== 'backend' ? 'border-sky-500/80 bg-sky-500/10 shadow-xs ring-1 ring-sky-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => onSwitchTarget('azuresql')}
                >
                    <div class="flex items-center justify-between gap-1 w-full">
                        <div class="flex items-center gap-2 min-w-0">
                            <DatabaseIcon class="h-4 w-4 shrink-0 {viewTarget === 'azuresql' && currentTab !== 'backend' ? 'text-sky-400' : 'text-textcolor2 group-hover:text-sky-400'} transition-colors" />
                            <span class="truncate text-xs font-semibold {viewTarget === 'azuresql' && currentTab !== 'backend' ? 'text-sky-300' : 'text-textcolor'}">
                                {language.storageAzureSql}
                            </span>
                        </div>
                        {#if config?.enabled && config.storageType === 'azuresql'}
                            <span class="rounded-full bg-sky-500/20 px-1.5 py-0.2 text-[10px] font-bold text-sky-300 shrink-0">
                                {storageSummary?.activeType === 'azuresql' ? language.storageMainActive : language.storageActive}
                            </span>
                        {:else}
                            <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] text-textcolor2 shrink-0">
                                {language.storageInactive}
                            </span>
                        {/if}
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-textcolor2 pl-6">
                        <span class="font-bold text-textcolor">
                            {formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}
                        </span>
                        <span class="text-[10px] font-mono">
                            {(storageSummary?.azuresql?.totalObjects ?? 0).toLocaleString()} {language.storageAssets}
                        </span>
                    </div>
                </button>

                <!-- Local FileSystem Card -->
                <div class="group relative flex w-full flex-col gap-1 rounded-xl border p-2.5 text-left transition-all {viewTarget === 'fs' && currentTab !== 'backend' ? 'border-indigo-500/80 bg-indigo-500/10 shadow-xs ring-1 ring-indigo-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}">
                    <button
                        type="button"
                        class="flex items-center justify-between gap-1 w-full text-left cursor-pointer"
                        onclick={() => onSwitchTarget('fs')}
                    >
                        <div class="flex items-center gap-2 min-w-0">
                            <FolderArchiveIcon class="h-4 w-4 shrink-0 {viewTarget === 'fs' && currentTab !== 'backend' ? 'text-indigo-400' : 'text-textcolor2 group-hover:text-indigo-400'} transition-colors" />
                            <span class="truncate text-xs font-semibold {viewTarget === 'fs' && currentTab !== 'backend' ? 'text-indigo-300' : 'text-textcolor'}">
                                {language.storageLocalFsStorage}
                            </span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            {#if storageSummary?.activeType === 'fs'}
                                <span class="rounded-full bg-green-500/20 px-1.5 py-0.2 text-[10px] font-bold text-green-300">
                                    {language.storageMainActive}
                                </span>
                            {:else}
                                <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] text-textcolor2">
                                    {language.storageStandbyBadge}
                                </span>
                            {/if}
                        </div>
                    </button>

                    <div class="flex items-center justify-between text-[11px] text-textcolor2 pl-6">
                        <span class="font-bold text-textcolor">
                            {formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}
                        </span>
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] font-mono">
                                {(storageSummary?.localFs?.totalObjects ?? 0).toLocaleString()} {language.storageAssets}
                            </span>
                            {#if storageSummary?.activeType !== 'fs' && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
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
                        </div>
                    </div>
                </div>

                <!-- Backup Database Card -->
                <button
                    type="button"
                    class="group relative flex w-full flex-col gap-1 rounded-xl border p-2.5 text-left transition-all cursor-pointer {currentTab === 'backend' ? 'border-emerald-500/80 bg-emerald-500/10 shadow-xs ring-1 ring-emerald-500/40' : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-darkbg'}"
                    onclick={() => onSelectTab('backend')}
                >
                    <div class="flex items-center justify-between gap-1 w-full">
                        <div class="flex items-center gap-2 min-w-0">
                            <ShieldCheckIcon class="h-4 w-4 shrink-0 {currentTab === 'backend' ? 'text-emerald-400' : 'text-textcolor2 group-hover:text-emerald-400'} transition-colors" />
                            <span class="truncate text-xs font-semibold {currentTab === 'backend' ? 'text-emerald-300' : 'text-textcolor'}">
                                {language.sqlBackupTitle}
                            </span>
                        </div>
                        {#if backupConfig?.configured}
                            <span class="rounded-full px-1.5 py-0.2 text-[10px] font-bold shrink-0 {backupConfig.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-darkbutton text-textcolor2'}">
                                {backupConfig.enabled ? language.sqlBackupStatusEnabled : language.sqlBackupStatusDisabled}
                            </span>
                        {:else}
                            <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] text-textcolor2 shrink-0">
                                {language.storageInactive}
                            </span>
                        {/if}
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-textcolor2 pl-6">
                        {#if backupConfig?.configured}
                            <span class="font-bold text-textcolor font-mono">
                                #{backupConfig.backupRevision ?? '0'}
                            </span>
                            <span class="text-[10px] font-mono {(backupConfig.lag ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}">
                                {language.sqlBackupLag}: {backupConfig.lag ?? 0}
                            </span>
                        {:else}
                            <span class="text-[10px] text-textcolor2">
                                {language.sqlBackupNotConfigured}
                            </span>
                        {/if}
                    </div>
                </button>
            </div>
        </section>

        <!-- ── 2. NAVIGATION TABS (탐색 및 관리) ── -->
        <section class="space-y-1">
            <div class="px-1 text-[11px] font-semibold uppercase tracking-wider text-textcolor2">
                {language.menuSideBar ?? 'Navigation'}
            </div>

            <div class="space-y-1">
                <!-- Tab: Bots -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'bots' ? 'bg-selected text-textcolor font-semibold shadow-xs border-l-3 border-blue-500 pl-2.5' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('bots')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <UserIcon class="h-4 w-4 shrink-0 {currentTab === 'bots' ? 'text-blue-400' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabBots}</span>
                    </div>
                    <span class="rounded-full px-2 py-0.2 text-[10px] font-mono shrink-0 {currentTab === 'bots' ? 'bg-blue-500/20 text-blue-300 font-bold' : 'bg-darkbutton text-textcolor2'}">
                        {botCount}
                    </span>
                </button>

                <!-- Tab: Modules -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'modules' ? 'bg-selected text-textcolor font-semibold shadow-xs border-l-3 border-violet-500 pl-2.5' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('modules')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <PackageIcon class="h-4 w-4 shrink-0 {currentTab === 'modules' ? 'text-violet-400' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabModules}</span>
                    </div>
                    <span class="rounded-full px-2 py-0.2 text-[10px] font-mono shrink-0 {currentTab === 'modules' ? 'bg-violet-500/20 text-violet-300 font-bold' : 'bg-darkbutton text-textcolor2'}">
                        {moduleCount}
                    </span>
                </button>

                <!-- Tab: All Files -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'files' ? 'bg-selected text-textcolor font-semibold shadow-xs border-l-3 border-blue-500 pl-2.5' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('files')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <LayersIcon class="h-4 w-4 shrink-0 {currentTab === 'files' ? 'text-blue-400' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabAllFiles}</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <span class="rounded-md bg-darkbutton px-1.5 py-0.2 text-[9px] uppercase font-semibold text-textcolor2">
                            {viewTarget}
                        </span>
                        <span class="rounded-full px-2 py-0.2 text-[10px] font-mono {currentTab === 'files' ? 'bg-blue-500/20 text-blue-300 font-bold' : 'bg-darkbutton text-textcolor2'}">
                            {fileCount}
                        </span>
                    </div>
                </button>

                <!-- Tab: Backend Config -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'backend' ? 'bg-selected text-textcolor font-semibold shadow-xs border-l-3 border-blue-500 pl-2.5' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('backend')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <SettingsIcon class="h-4 w-4 shrink-0 {currentTab === 'backend' ? 'text-blue-400' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabBackend}</span>
                    </div>
                    {#if backupConfig?.configured && backupConfig.enabled}
                        <span class="h-2 w-2 rounded-full bg-emerald-400 shrink-0 shadow-xs" title="Backup DB Active"></span>
                    {/if}
                </button>
            </div>
        </section>
    </div>

    <!-- ── 3. BOTTOM MAINTENANCE & HEALTH SUMMARY ── -->
    <div class="shrink-0 border-t border-darkborderc bg-darkbg p-3 space-y-2">
        <!-- Managed Content Summary -->
        <div class="flex items-center justify-between rounded-lg bg-bgcolor/50 px-2.5 py-1.5 text-[11px] text-textcolor2 border border-darkborderc/60">
            <span class="truncate">{language.storageManagedContent}</span>
            <span class="font-semibold text-textcolor font-mono">
                {botCount} {language.storageCharacters} · {moduleCount} {language.storageModules}
            </span>
        </div>

        <!-- Orphan Assets Alert / Action -->
        {#if orphanCount > 0}
            <div class="flex flex-col gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
                <div class="flex items-center justify-between gap-1">
                    <div class="flex items-center gap-1.5 font-semibold text-rose-300 min-w-0">
                        <Trash2Icon class="h-3.5 w-3.5 shrink-0" />
                        <span class="truncate">{language.storageOrphanAssets} ({viewTarget.toUpperCase()})</span>
                    </div>
                    <span class="rounded-full bg-rose-500/20 px-1.5 py-0.2 text-[10px] font-bold text-rose-300">
                        {orphanCount}개
                    </span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-rose-300/80">
                    <span>{formatBytes(orphanSizeBytes)}</span>
                    <button
                        type="button"
                        class="rounded-md bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs hover:bg-rose-500 transition-colors disabled:opacity-50 cursor-pointer"
                        disabled={cleaningOrphans || busy}
                        onclick={onCleanOrphans}
                    >
                        {cleaningOrphans ? language.storagePurging : language.storageCleanOrphan}
                    </button>
                </div>
            </div>
        {:else}
            <div class="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 text-[11px] text-emerald-300">
                <CheckCircle2Icon class="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span class="truncate">연결된 에셋 정상 (고아 에셋 없음)</span>
            </div>
        {/if}
    </div>
</aside>
