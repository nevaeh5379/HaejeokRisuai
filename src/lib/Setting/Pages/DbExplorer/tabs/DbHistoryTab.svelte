<script lang="ts">
    import {
        CalendarIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        ClockIcon,
        FileCode2Icon,
        HistoryIcon,
        LayersIcon,
        RotateCcwIcon,
        SearchIcon,
        SparklesIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type { NodePostgresRevision } from 'src/ts/storage/nodePostgresStorage'
    import type { HistoryScopeFilter } from '../types'

    interface Props {
        revisions: NodePostgresRevision[]
        onRevisionRestored?: () => void
    }

    const {
        revisions,
        onRevisionRestored
    }: Props = $props()

    let busy = $state(false)
    let selectedScope = $state<HistoryScopeFilter>('all')
    let actionSearch = $state('')
    let expandedRevisionId = $state<number | null>(null)

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function restoreRevision(revision: NodePostgresRevision) {
        if (busy || !await alertConfirm(language.postgresRestoreConfirm(revision.id))) {
            return
        }
        busy = true
        try {
            await getNodeStorage().postgres.restoreRevision(revision.id)
            alertNormal(language.postgresRestoreSuccess)
            onRevisionRestored?.()
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    function formatRelativeTime(dateString: string): string {
        try {
            const date = new Date(dateString)
            const now = new Date()
            const diffMs = now.getTime() - date.getTime()
            const diffSec = Math.floor(diffMs / 1000)
            const diffMin = Math.floor(diffSec / 60)
            const diffHour = Math.floor(diffMin / 60)
            const diffDay = Math.floor(diffHour / 24)

            if (diffSec < 60) return '방금 전'
            if (diffMin < 60) return `${diffMin}분 전`
            if (diffHour < 24) return `${diffHour}시간 전`
            if (diffDay < 30) return `${diffDay}일 전`
            return date.toLocaleDateString()
        } catch {
            return dateString
        }
    }

    const filteredRevisions = $derived.by(() => {
        let list = [...revisions]
        if (selectedScope !== 'all') {
            list = list.filter((r) => r.scope === selectedScope)
        }
        if (actionSearch.trim()) {
            const q = actionSearch.trim().toLowerCase()
            list = list.filter((r) => r.action.toLowerCase().includes(q))
        }
        return list
    })

    const totalRestores = $derived(
        revisions.filter((r) => r.scope === 'restore').length
    )

    const totalChanges = $derived(
        revisions.reduce((acc, r) => acc + (r.change_count || 0), 0)
    )

    const activeRevisionId = $derived(
        revisions[0]?.id ?? null
    )
</script>

<div class="space-y-6">
    <!-- ── 1. 상단 KPI 요약 카드 ── -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <!-- 현재 활성 리비전 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <SparklesIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbHistoryActiveRevision}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {activeRevisionId ? `#${activeRevisionId}` : '—'}
                </p>
            </div>
        </div>

        <!-- 총 저장된 리비전 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                <HistoryIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbHistoryTotalRevisions}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {revisions.length.toLocaleString()}
                </p>
            </div>
        </div>

        <!-- 복원 횟수 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <RotateCcwIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbHistoryTotalRestores}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {totalRestores.toLocaleString()}
                </p>
            </div>
        </div>

        <!-- 총 누적 변경 항목 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <LayersIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbHistoryTotalChanges}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {totalChanges.toLocaleString()}
                </p>
            </div>
        </div>
    </div>

    <!-- ── 2. 타임라인 목록 및 필터 ── -->
    <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
                <h3 class="text-base sm:text-lg font-semibold text-textcolor">{language.dbHistoryTimeline}</h3>
                <p class="mt-0.5 text-xs text-textcolor2">{language.dbHistoryTimelineDesc}</p>
            </div>

            <!-- Scope Tabs + Search -->
            <div class="flex flex-wrap items-center gap-2">
                <!-- Scope Filter Buttons -->
                <div class="flex items-center rounded-lg border border-darkborderc bg-bgcolor/40 p-0.5">
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors {selectedScope === 'all' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'all'}
                    >
                        {language.dbHistoryScopeAll}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors {selectedScope === 'database' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'database'}
                    >
                        {language.dbHistoryScopeDatabase}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors {selectedScope === 'cold-storage' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'cold-storage'}
                    >
                        {language.dbHistoryScopeCold}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors {selectedScope === 'restore' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'restore'}
                    >
                        {language.dbHistoryScopeRestore}
                    </button>
                </div>

                <!-- Action Search -->
                <div class="relative w-40 sm:w-48">
                    <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                        <SearchIcon size={13} />
                    </div>
                    <TextInput
                        bind:value={actionSearch}
                        size="sm"
                        fullwidth={true}
                        placeholder="Action 검색..."
                        className="pl-7 pr-6 text-xs"
                    />
                    {#if actionSearch}
                        <button
                            class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-green-500"
                            onclick={() => actionSearch = ''}
                        >
                            <XIcon size={12} />
                        </button>
                    {/if}
                </div>
            </div>
        </div>

        <!-- Revision Cards List -->
        {#if filteredRevisions.length === 0}
            <div class="rounded-xl border border-darkborderc bg-bgcolor/20 p-12 text-center text-xs text-textcolor2">
                {language.postgresHistoryEmpty}
            </div>
        {:else}
            <div class="space-y-3">
                {#each filteredRevisions as revision, index (revision.id)}
                    {@const isLatest = revision.id === activeRevisionId}
                    {@const isExpanded = expandedRevisionId === revision.id}

                    <div class="rounded-xl border transition-all {isLatest ? 'border-blue-500/40 bg-blue-500/5' : 'border-darkborderc bg-bgcolor/30 hover:border-darkborderc/80'} p-4 shadow-xs">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <!-- Left: ID + Scope + Action + Timestamp -->
                            <div class="flex items-center gap-3 min-w-0">
                                <!-- ID Badge -->
                                <span class="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs sm:text-sm font-bold {isLatest ? 'bg-blue-500 text-white' : 'bg-darkbutton text-textcolor'}">
                                    #{revision.id}
                                </span>

                                <div class="min-w-0">
                                    <div class="flex flex-wrap items-center gap-1.5">
                                        <!-- Scope Badge -->
                                        <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider font-mono {
                                            revision.scope === 'restore' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                                            revision.scope === 'cold-storage' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' :
                                            'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                        }">
                                            {revision.scope}
                                        </span>

                                        <!-- Action Tag -->
                                        <span class="font-mono text-xs font-semibold text-textcolor truncate">
                                            {revision.action}
                                        </span>

                                        {#if isLatest}
                                            <span class="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30">
                                                {language.dbHistoryCurrentBadge}
                                            </span>
                                        {/if}
                                    </div>

                                    <!-- Date & Relative Time -->
                                    <div class="mt-1 flex items-center gap-2 text-xs text-textcolor2 font-mono">
                                        <span class="flex items-center gap-1">
                                            <ClockIcon size={12} /> {formatRelativeTime(revision.created_at)}
                                        </span>
                                        <span>·</span>
                                        <span class="text-[11px] opacity-70">
                                            {new Date(revision.created_at).toLocaleString()}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <!-- Right: Change Count & Restore Action Button -->
                            <div class="flex items-center gap-3 shrink-0">
                                <div class="text-right font-mono text-xs text-textcolor2">
                                    <span class="font-semibold text-textcolor">{revision.change_count}</span> {language.dbHistoryChangesCount}
                                    {#if revision.restored_from_revision}
                                        <div class="text-[10px] text-amber-400">
                                            {language.dbHistoryRestoredFrom}{revision.restored_from_revision}
                                        </div>
                                    {/if}
                                </div>

                                <!-- Metadata Toggle Button -->
                                <button
                                    type="button"
                                    class="p-1.5 rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
                                    title={language.dbHistoryDetails}
                                    onclick={() => expandedRevisionId = isExpanded ? null : revision.id}
                                >
                                    {#if isExpanded}
                                        <ChevronDownIcon size={16} />
                                    {:else}
                                        <ChevronRightIcon size={16} />
                                    {/if}
                                </button>

                                <!-- Restore Button -->
                                <Button
                                    size="sm"
                                    disabled={busy || isLatest}
                                    onclick={() => restoreRevision(revision)}
                                >
                                    {language.postgresRestore}
                                </Button>
                            </div>
                        </div>

                        <!-- Expanded Metadata Section -->
                        {#if isExpanded}
                            <div class="mt-3.5 pt-3 border-t border-darkborderc/40 text-xs font-mono text-textcolor2 space-y-1.5 animate-in fade-in duration-150">
                                <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    <div>
                                        <span class="text-textcolor font-medium">{language.dbHistoryStorageRevision}:</span>
                                        <span class="ml-1">{revision.storage_revision ?? '—'}</span>
                                    </div>
                                    <div>
                                        <span class="text-textcolor font-medium">{language.dbHistoryDbInitialized}:</span>
                                        <span class="ml-1">{revision.database_initialized ? 'Yes' : 'No'}</span>
                                    </div>
                                    <div>
                                        <span class="text-textcolor font-medium">Restored From:</span>
                                        <span class="ml-1">{revision.restored_from_revision ? `#${revision.restored_from_revision}` : '—'}</span>
                                    </div>
                                </div>
                                <div class="mt-2 rounded-lg bg-darkbg/70 p-2.5 border border-darkborderc/60 overflow-x-auto text-[11px]">
                                    <pre class="text-textcolor2">{JSON.stringify(revision, null, 2)}</pre>
                                </div>
                            </div>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</div>
