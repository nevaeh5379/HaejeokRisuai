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
        onPurgeLocalFs,
        onCleanOrphans,
        onClose
    }: Props = $props()
</script>

<aside class="flex h-full w-full flex-col bg-darkbg/95 text-textcolor select-none border-r border-darkborderc overflow-hidden">
    <!-- Sidebar Header / Branding -->
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-darkborderc px-4 bg-darkbg">
        <div class="flex items-center gap-2.5 min-w-0">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-darkbutton text-textcolor border border-darkborderc">
                <HardDriveIcon class="h-4.5 w-4.5" />
            </div>
            <div class="min-w-0">
                <h2 class="truncate text-sm font-bold text-textcolor">{language.storageExplorer}</h2>
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
        <!-- ── 1. STORAGE SUMMARY (스토리지 현황 요약) ── -->
        <section class="rounded-xl border border-darkborderc bg-bgcolor/40 p-3 space-y-2.5">
            <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-textcolor">{language.storageOverview}</span>
            </div>

            <!-- Metric Summary -->
            <div class="grid grid-cols-2 gap-2 text-center">
                <div class="rounded-lg bg-darkbg p-2 border border-darkborderc/60">
                    <div class="text-[10px] text-textcolor2 uppercase">{language.storageTotalAssets}</div>
                    <div class="text-xs font-bold text-textcolor font-mono mt-0.5">
                        {(storageSummary?.activeType === 's3' ? storageSummary?.s3?.totalObjects : storageSummary?.activeType === 'azuresql' ? storageSummary?.azuresql?.totalObjects : storageSummary?.localFs?.totalObjects ?? 0)?.toLocaleString()}
                    </div>
                </div>
                <div class="rounded-lg bg-darkbg p-2 border border-darkborderc/60">
                    <div class="text-[10px] text-textcolor2 uppercase">{language.storageTotalSize}</div>
                    <div class="text-xs font-bold text-textcolor font-mono mt-0.5">
                        {formatBytes(storageSummary?.activeType === 's3' ? (storageSummary?.s3?.totalSizeBytes ?? 0) : storageSummary?.activeType === 'azuresql' ? (storageSummary?.azuresql?.totalSizeBytes ?? 0) : (storageSummary?.localFs?.totalSizeBytes ?? 0))}
                    </div>
                </div>
            </div>

            <!-- Breakdown -->
            <div class="space-y-1.5 pt-1 border-t border-darkborderc/40 text-[11px] text-textcolor2">
                <!-- Local FS -->
                <div class="flex items-center justify-between">
                    <span class="flex items-center gap-1.5">
                        <FolderArchiveIcon class="h-3 w-3 text-indigo-400" />
                        <span>{language.storageLocalFs ?? '로컬'}</span>
                        {#if storageSummary?.activeType === 'fs'}
                            <span class="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-1.5 py-0.1 text-[9px] font-semibold text-indigo-300">
                                {language.storageActive}
                            </span>
                        {/if}
                    </span>
                    <div class="flex items-center gap-1.5">
                        <span class="font-mono text-textcolor">{formatBytes(storageSummary?.localFs?.totalSizeBytes ?? 0)}</span>
                        {#if storageSummary?.activeType !== 'fs' && (storageSummary?.localFs?.totalObjects ?? 0) > 0}
                            <button
                                type="button"
                                class="rounded-md bg-rose-500/20 px-1 py-0.2 text-[9px] font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors cursor-pointer"
                                disabled={purgingLocal || busy}
                                onclick={onPurgeLocalFs}
                                title={language.storagePurgeLocalFs}
                            >
                                {purgingLocal ? language.storagePurging : language.storagePurgeLocal}
                            </button>
                        {/if}
                    </div>
                </div>

                <!-- S3 / RustFS -->
                <div class="flex items-center justify-between">
                    <span class="flex items-center gap-1.5">
                        <ServerIcon class="h-3 w-3 text-blue-400" />
                        <span>S3 / RustFS</span>
                        {#if storageSummary?.activeType === 's3'}
                            <span class="rounded-full bg-blue-500/15 border border-blue-500/30 px-1.5 py-0.1 text-[9px] font-semibold text-blue-300">
                                {language.storageActive}
                            </span>
                        {/if}
                    </span>
                    <span class="font-mono text-textcolor">{formatBytes(storageSummary?.s3?.totalSizeBytes ?? 0)}</span>
                </div>

                <!-- Azure SQL -->
                <div class="flex items-center justify-between">
                    <span class="flex items-center gap-1.5">
                        <DatabaseIcon class="h-3 w-3 text-sky-400" />
                        <span>{language.storageAzureSql ?? 'Azure SQL'}</span>
                        {#if storageSummary?.activeType === 'azuresql'}
                            <span class="rounded-full bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.1 text-[9px] font-semibold text-sky-300">
                                {language.storageActive}
                            </span>
                        {/if}
                    </span>
                    <span class="font-mono text-textcolor">{formatBytes(storageSummary?.azuresql?.totalSizeBytes ?? 0)}</span>
                </div>
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
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'bots' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('bots')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <UserIcon class="h-4 w-4 shrink-0 {currentTab === 'bots' ? 'text-textcolor' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabBots}</span>
                    </div>
                    <span class="rounded-full px-2 py-0.2 text-[10px] font-mono shrink-0 {currentTab === 'bots' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc/60' : 'bg-darkbutton text-textcolor2'}">
                        {botCount}
                    </span>
                </button>

                <!-- Tab: Modules -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'modules' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('modules')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <PackageIcon class="h-4 w-4 shrink-0 {currentTab === 'modules' ? 'text-textcolor' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabModules}</span>
                    </div>
                    <span class="rounded-full px-2 py-0.2 text-[10px] font-mono shrink-0 {currentTab === 'modules' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc/60' : 'bg-darkbutton text-textcolor2'}">
                        {moduleCount}
                    </span>
                </button>

                <!-- Tab: All Files -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'files' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('files')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <LayersIcon class="h-4 w-4 shrink-0 {currentTab === 'files' ? 'text-textcolor' : 'text-textcolor2 group-hover:text-textcolor'}" />
                        <span class="truncate">{language.storageTabAllFiles}</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <span class="rounded-md bg-darkbutton px-1.5 py-0.2 text-[9px] uppercase font-semibold text-textcolor2 border border-darkborderc/40">
                            {viewTarget}
                        </span>
                        <span class="rounded-full px-2 py-0.2 text-[10px] font-mono {currentTab === 'files' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc/60' : 'bg-darkbutton text-textcolor2'}">
                            {fileCount}
                        </span>
                    </div>
                </button>

                <!-- Tab: Backend Config -->
                <button
                    type="button"
                    class="group flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all cursor-pointer {currentTab === 'backend' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTab('backend')}
                >
                    <div class="flex items-center gap-2.5 min-w-0">
                        <SettingsIcon class="h-4 w-4 shrink-0 {currentTab === 'backend' ? 'text-textcolor' : 'text-textcolor2 group-hover:text-textcolor'}" />
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
            <div class="flex flex-col gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-200">
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
            <div class="flex items-center gap-1.5 rounded-lg bg-bgcolor/50 border border-darkborderc/60 px-2.5 py-1.5 text-[11px] text-textcolor2">
                <CheckCircle2Icon class="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span class="truncate">연결된 에셋 정상 (고아 에셋 없음)</span>
            </div>
        {/if}
    </div>
</aside>
