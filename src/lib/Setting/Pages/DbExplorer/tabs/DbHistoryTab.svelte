<script lang="ts">
    import {
        ArrowUpDownIcon,
        CheckIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        ClockIcon,
        FileCode2Icon,
        FilterIcon,
        HistoryIcon,
        LayersIcon,
        RefreshCwIcon,
        RotateCcwIcon,
        SearchIcon,
        SparklesIcon,
        SplitIcon,
        TableIcon,
        TrendingUpIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { NodePostgresRevision } from 'src/ts/storage/nodePostgresStorage'
    import type { HistoryScopeFilter } from '../types'
    import DbRevisionCard from '../components/DbRevisionCard.svelte'
    import DbRevisionAuditDrawer from '../components/DbRevisionAuditDrawer.svelte'
    import DbRevisionDiffModal from '../components/DbRevisionDiffModal.svelte'
    import DbRevisionRestoreModal from '../components/DbRevisionRestoreModal.svelte'

    interface Props {
        revisions: NodePostgresRevision[]
        onRevisionRestored?: () => void
    }

    const {
        revisions,
        onRevisionRestored
    }: Props = $props()

    // ── Filtering & Pagination State ──
    let selectedScope = $state<HistoryScopeFilter>('all')
    let selectedAction = $state<string>('all')
    let actionSearch = $state('')
    let pageSize = $state<number | 'all'>('all')
    let displayedCount = $state<number>(100)
    let expandedRevisionId = $state<number | null>(null)

    // ── Comparison Mode State ──
    let compareMode = $state(false)
    let selectedCompareIds = $state<number[]>([])

    // ── Drawers & Modals State ──
    let auditDrawerOpen = $state(false)
    let auditDrawerRevision = $state<NodePostgresRevision | null>(null)

    let diffModalOpen = $state(false)
    let diffBaseId = $state<number | null>(null)
    let diffTargetId = $state<number | null>(null)

    let restoreModalOpen = $state(false)
    let restoreModalRevision = $state<NodePostgresRevision | null>(null)

    // ── Derived Statistics ──
    const activeRevisionId = $derived(
        revisions[0]?.id ?? null
    )

    const totalRestores = $derived(
        revisions.filter((r) => r.scope === 'restore').length
    )

    const totalChanges = $derived(
        revisions.reduce((acc, r) => acc + (r.change_count || 0), 0)
    )

    const avgChangesPerRev = $derived(
        revisions.length > 0 ? (totalChanges / revisions.length).toFixed(1) : '0'
    )

    // Available unique actions for filter chips
    const uniqueActions = $derived.by<string[]>(() => {
        const set = new Set<string>()
        for (const r of revisions) {
            if (r.action) set.add(r.action)
        }
        return Array.from(set).sort()
    })

    // Filtered list based on Scope, Action, and Search Query
    const filteredRevisions = $derived.by(() => {
        let list = [...revisions]
        if (selectedScope !== 'all') {
            list = list.filter((r) => r.scope === selectedScope)
        }
        if (selectedAction !== 'all') {
            list = list.filter((r) => r.action === selectedAction)
        }
        if (actionSearch.trim()) {
            const q = actionSearch.trim().toLowerCase()
            list = list.filter((r) => {
                if (r.action.toLowerCase().includes(q)) return true
                if (r.scope.toLowerCase().includes(q)) return true
                if (String(r.id).includes(q)) return true
                if (r.restored_from_revision && String(r.restored_from_revision).includes(q)) return true
                return false
            })
        }
        return list
    })

    // Paginated / View-limited slice
    const visibleRevisions = $derived.by(() => {
        if (pageSize === 'all') {
            return filteredRevisions
        }
        return filteredRevisions.slice(0, typeof pageSize === 'number' ? pageSize : displayedCount)
    })

    // ── Jump to Revision & Highlight ──
    function jumpToRevision(id: number) {
        // If target revision is outside currently filtered view, reset filters
        if (!filteredRevisions.some((r) => r.id === id)) {
            selectedScope = 'all'
            selectedAction = 'all'
            actionSearch = ''
        }

        setTimeout(() => {
            const el = document.getElementById(`revision-card-${id}`)
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                el.classList.add('ring-2', 'ring-amber-400', 'bg-amber-500/20')
                setTimeout(() => {
                    el.classList.remove('ring-2', 'ring-amber-400', 'bg-amber-500/20')
                }, 1500)
            }
        }, 100)
    }

    // ── Comparison Selection Toggle ──
    function toggleCompareSelection(id: number) {
        if (selectedCompareIds.includes(id)) {
            selectedCompareIds = selectedCompareIds.filter((x) => x !== id)
        } else {
            if (selectedCompareIds.length >= 2) {
                // Shift first item out and add new item
                selectedCompareIds = [selectedCompareIds[1], id]
            } else {
                selectedCompareIds = [...selectedCompareIds, id]
            }
        }
    }

    function openCompareModal() {
        if (selectedCompareIds.length === 2) {
            diffBaseId = Math.min(selectedCompareIds[0], selectedCompareIds[1])
            diffTargetId = Math.max(selectedCompareIds[0], selectedCompareIds[1])
            diffModalOpen = true
        }
    }

    function openCompareWithPrev(rev: NodePostgresRevision) {
        // Find previous revision in list
        const idx = revisions.findIndex((r) => r.id === rev.id)
        if (idx >= 0 && idx + 1 < revisions.length) {
            const prevRev = revisions[idx + 1]
            diffBaseId = prevRev.id
            diffTargetId = rev.id
        } else {
            diffBaseId = Math.max(1, rev.id - 1)
            diffTargetId = rev.id
        }
        diffModalOpen = true
    }

    function openInspectDrawer(rev: NodePostgresRevision) {
        auditDrawerRevision = rev
        auditDrawerOpen = true
    }

    function openRestoreModal(rev: NodePostgresRevision) {
        restoreModalRevision = rev
        restoreModalOpen = true
    }
</script>

<div class="space-y-6">
    <!-- ── 1. 상단 KPI 요약 카드 ── -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4">
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

        <!-- 총 저장된 리비전 (무제한) -->
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

        <!-- 리비전당 평균 변경 항목 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs col-span-2 sm:col-span-1">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/10 text-teal-400 border border-teal-500/20">
                <TrendingUpIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbHistoryAvgChanges}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {avgChangesPerRev}
                </p>
            </div>
        </div>
    </div>

    <!-- ── 2. 비교 모드 활성화 시 플로팅 배너 ── -->
    {#if compareMode}
        <div class="rounded-xl border border-violet-500/40 bg-violet-500/10 p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3 shadow-md animate-in fade-in duration-150">
            <div class="flex items-center gap-2.5">
                <SplitIcon class="h-5 w-5 text-violet-400" />
                <div>
                    <span class="text-sm font-bold text-textcolor">
                        {language.dbHistoryCompareMode}:
                    </span>
                    <span class="text-xs text-textcolor2 ml-1">
                        {#if selectedCompareIds.length === 0}
                            {language.dbHistoryCompareSelectPrompt} (0/2)
                        {:else if selectedCompareIds.length === 1}
                            Selected #{selectedCompareIds[0]} (1/2) - Select one more revision
                        {:else}
                            Comparing #{selectedCompareIds[0]} vs #{selectedCompareIds[1]} (2/2 ready)
                        {/if}
                    </span>
                </div>
            </div>

            <div class="flex items-center gap-2">
                <Button
                    size="sm"
                    disabled={selectedCompareIds.length !== 2}
                    className="bg-violet-600 hover:bg-violet-500 text-white font-medium px-4"
                    onclick={openCompareModal}
                >
                    <SplitIcon size={14} class="mr-1.5 inline" />
                    {language.dbHistoryCompareBtn(selectedCompareIds.length)}
                </Button>
                <Button
                    size="sm"
                    className="bg-darkbutton hover:bg-darkbutton/80 text-textcolor"
                    onclick={() => {
                        compareMode = false
                        selectedCompareIds = []
                    }}
                >
                    Cancel
                </Button>
            </div>
        </div>
    {/if}

    <!-- ── 3. 타임라인 목록 및 필터 툴바 ── -->
    <div class="rounded-xl border border-darkborderc bg-darkbg p-4 sm:p-6 shadow-xs space-y-4">
        <!-- Title & Main Controls Bar -->
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
                <h3 class="text-base sm:text-lg font-semibold text-textcolor">{language.dbHistoryTimeline}</h3>
                <p class="mt-0.5 text-xs text-textcolor2">{language.dbHistoryTimelineDesc}</p>
            </div>

            <!-- Scope Tabs + Search + Compare Mode Toggle -->
            <div class="flex flex-wrap items-center gap-2">
                <!-- Scope Filter Buttons -->
                <div class="flex items-center rounded-lg border border-darkborderc bg-bgcolor/40 p-0.5 text-xs">
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer {selectedScope === 'all' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'all'}
                    >
                        {language.dbHistoryScopeAll}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer {selectedScope === 'database' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'database'}
                    >
                        {language.dbHistoryScopeDatabase}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer {selectedScope === 'cold-storage' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'cold-storage'}
                    >
                        {language.dbHistoryScopeCold}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer {selectedScope === 'restore' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => selectedScope = 'restore'}
                    >
                        {language.dbHistoryScopeRestore}
                    </button>
                </div>

                <!-- Action Search Input -->
                <div class="relative w-36 sm:w-48">
                    <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                        <SearchIcon size={13} />
                    </div>
                    <TextInput
                        bind:value={actionSearch}
                        size="sm"
                        fullwidth={true}
                        placeholder={language.dbHistorySearchPlaceholder}
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

                <!-- Page Size Selector -->
                <div class="flex items-center gap-1 text-xs font-mono">
                    <span class="text-textcolor2 hidden sm:inline">{language.dbHistoryPageSize}:</span>
                    <select
                        class="rounded-lg border border-darkborderc bg-bgcolor px-2 py-1 text-xs text-textcolor focus:outline-hidden"
                        bind:value={pageSize}
                    >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={200}>200</option>
                        <option value="all">{language.dbHistoryPageSizeAll} ({revisions.length})</option>
                    </select>
                </div>

                <!-- Compare Mode Toggle Button -->
                <Button
                    size="sm"
                    className="{compareMode ? 'bg-violet-600 text-white' : 'bg-darkbutton text-textcolor'} text-xs"
                    onclick={() => {
                        compareMode = !compareMode
                        if (!compareMode) selectedCompareIds = []
                    }}
                >
                    <SplitIcon size={13} class="mr-1 inline text-violet-400" />
                    <span>{language.dbHistoryCompareMode}</span>
                </Button>
            </div>
        </div>

        <!-- Action Quick Filter Chips -->
        {#if uniqueActions.length > 0}
            <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-darkborderc/40 text-xs">
                <span class="text-textcolor2 font-medium mr-1">{language.dbHistoryFilterAction}:</span>
                <button
                    type="button"
                    class="rounded-md px-2 py-0.5 font-mono text-[11px] font-medium transition-colors cursor-pointer border {
                        selectedAction === 'all'
                            ? 'bg-selected text-textcolor border-darkborderc shadow-xs'
                            : 'bg-darkbutton/60 text-textcolor2 border-darkborderc/50 hover:text-textcolor'
                    }"
                    onclick={() => selectedAction = 'all'}
                >
                    All ({revisions.length})
                </button>
                {#each uniqueActions as action}
                    {@const count = revisions.filter((r) => r.action === action).length}
                    <button
                        type="button"
                        class="rounded-md px-2 py-0.5 font-mono text-[11px] font-medium transition-colors cursor-pointer border flex items-center gap-1 {
                            selectedAction === action
                                ? 'bg-selected text-textcolor border-darkborderc shadow-xs'
                                : 'bg-darkbutton/60 text-textcolor2 border-darkborderc/50 hover:text-textcolor'
                        }"
                        onclick={() => selectedAction = action}
                    >
                        <span>{action}</span>
                        <span class="rounded bg-bgcolor/80 px-1 py-0.2 text-[9px]">{count}</span>
                    </button>
                {/each}
            </div>
        {/if}

        <!-- ── Revision Cards List with Connected Timeline View ── -->
        {#if visibleRevisions.length === 0}
            <div class="rounded-xl border border-darkborderc bg-bgcolor/20 p-12 text-center text-xs text-textcolor2">
                {language.postgresHistoryEmpty}
            </div>
        {:else}
            <div class="relative space-y-3 pt-2">
                {#each visibleRevisions as revision, index (revision.id)}
                    {@const isLatest = revision.id === activeRevisionId}
                    {@const isExpanded = expandedRevisionId === revision.id}
                    {@const isSelectedForCompare = selectedCompareIds.includes(revision.id)}

                    <DbRevisionCard
                        {revision}
                        {isLatest}
                        {isExpanded}
                        {compareMode}
                        {isSelectedForCompare}
                        onToggleExpand={() => expandedRevisionId = isExpanded ? null : revision.id}
                        onInspectAudit={() => openInspectDrawer(revision)}
                        onCompareWithPrev={() => openCompareWithPrev(revision)}
                        onToggleSelectCompare={() => toggleCompareSelection(revision.id)}
                        onRestore={() => openRestoreModal(revision)}
                        onJumpToRevision={jumpToRevision}
                    />
                {/each}
            </div>

            <!-- "Show More" Button if limited view is active -->
            {#if pageSize !== 'all' && typeof pageSize === 'number' && filteredRevisions.length > pageSize}
                <div class="pt-3 flex justify-center">
                    <Button
                        size="sm"
                        className="bg-darkbutton hover:bg-darkbutton/80 text-textcolor font-medium px-6 py-2"
                        onclick={() => pageSize = 'all'}
                    >
                        Show All {filteredRevisions.length} Revisions
                    </Button>
                </div>
            {/if}
        {/if}
    </div>
</div>

<!-- ── Audit Log Inspector Drawer ── -->
<DbRevisionAuditDrawer
    open={auditDrawerOpen}
    revision={auditDrawerRevision}
    isLatest={auditDrawerRevision?.id === activeRevisionId}
    onClose={() => auditDrawerOpen = false}
    onRestore={(rev) => openRestoreModal(rev)}
    onCompareWithPrev={(rev) => openCompareWithPrev(rev)}
/>

<!-- ── Revision Diff Comparison Modal ── -->
<DbRevisionDiffModal
    open={diffModalOpen}
    baseRevisionId={diffBaseId}
    targetRevisionId={diffTargetId}
    allRevisions={revisions}
    onClose={() => diffModalOpen = false}
    onRestore={(rev) => openRestoreModal(rev)}
/>

<!-- ── Safe Restore Impact Modal ── -->
<DbRevisionRestoreModal
    open={restoreModalOpen}
    revision={restoreModalRevision}
    onClose={() => restoreModalOpen = false}
    onSuccess={() => onRevisionRestored?.()}
/>
