<script lang="ts">
    import {
        ArrowLeftRightIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        CodeIcon,
        LayersIcon,
        RefreshCwIcon,
        RotateCcwIcon,
        SearchIcon,
        SplitIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type {
        NodePostgresAuditLogItem,
        NodePostgresRevision,
        NodePostgresRevisionDiff
    } from '../types'
    import DbRevisionRowDiff from './DbRevisionRowDiff.svelte'

    interface Props {
        open: boolean
        baseRevisionId: number | null
        targetRevisionId: number | null
        allRevisions: NodePostgresRevision[]
        onClose: () => void
        onRestore?: (revision: NodePostgresRevision) => void
    }

    const {
        open,
        baseRevisionId,
        targetRevisionId,
        allRevisions,
        onClose,
        onRestore
    }: Props = $props()

    let currentBaseId = $state<number | null>(null)
    let currentTargetId = $state<number | null>(null)
    let busy = $state(false)
    let diffResult = $state<NodePostgresRevisionDiff | null>(null)
    let error = $state('')
    let selectedTable = $state<string>('all')
    let selectedOp = $state<'all' | 'INSERT' | 'UPDATE' | 'DELETE'>('all')
    let searchQuery = $state('')

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function loadDiff() {
        if (!currentBaseId || !currentTargetId) return
        busy = true
        error = ''
        try {
            const storage = getNodeStorage().postgres
            if (typeof storage.getRevisionDiff === 'function') {
                diffResult = await storage.getRevisionDiff(currentBaseId, currentTargetId)
            } else {
                diffResult = null
            }
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    $effect(() => {
        if (open) {
            currentBaseId = baseRevisionId
            currentTargetId = targetRevisionId
            selectedTable = 'all'
            selectedOp = 'all'
            searchQuery = ''
            loadDiff()
        } else {
            diffResult = null
        }
    })

    function swapRevisions() {
        const temp = currentBaseId
        currentBaseId = currentTargetId
        currentTargetId = temp
        loadDiff()
    }

    const allEntries = $derived.by(() => {
        if (!diffResult?.tables) return []
        const list: NodePostgresAuditLogItem[] = []
        for (const table of diffResult.tables) {
            if (selectedTable === 'all' || table.tableName === selectedTable) {
                for (const entry of table.entries) {
                    list.push(entry)
                }
            }
        }
        return list
    })

    const filteredEntries = $derived.by(() => {
        let list = allEntries
        if (selectedOp !== 'all') {
            list = list.filter((e) => e.operation === selectedOp)
        }
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase()
            list = list.filter((e) => {
                if (e.tableName.toLowerCase().includes(q)) return true
                if (e.operation.toLowerCase().includes(q)) return true
                const jsonStr = JSON.stringify(e).toLowerCase()
                return jsonStr.includes(q)
            })
        }
        return list
    })

    const totalInsertCount = $derived(
        diffResult?.tables.reduce((acc, t) => acc + (t.insertCount || 0), 0) ?? 0
    )
    const totalUpdateCount = $derived(
        diffResult?.tables.reduce((acc, t) => acc + (t.updateCount || 0), 0) ?? 0
    )
    const totalDeleteCount = $derived(
        diffResult?.tables.reduce((acc, t) => acc + (t.deleteCount || 0), 0) ?? 0
    )

    function getOpBadge(op: string) {
        switch (op) {
            case 'INSERT':
                return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            case 'UPDATE':
                return 'bg-amber-500/20 text-amber-300 border-amber-500/30'
            case 'DELETE':
                return 'bg-rose-500/20 text-rose-300 border-rose-500/30'
            default:
                return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30'
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-xs p-0 sm:p-4 md:p-6 animate-in fade-in duration-200"
        onclick={onClose}
        role="presentation"
    >
        <!-- Modal Container -->
        <div
            class="flex h-full w-full sm:h-[92vh] sm:max-h-[920px] sm:max-w-5xl md:max-w-6xl flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in zoom-in-95 duration-200"
            onclick={(e) => e.stopPropagation()}
            role="presentation"
        >
            <!-- Header Bar -->
            <div class="flex items-center justify-between border-b border-darkborderc bg-darkbg p-3.5 sm:p-4 shrink-0 select-none">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                        <SplitIcon class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                        <h3 class="text-sm sm:text-base font-bold text-textcolor truncate">
                            {language.dbHistoryDiffModalTitle}
                        </h3>
                        <p class="text-xs text-textcolor2 truncate mt-0.5">
                            Comparing Revision #{currentBaseId} ➔ Revision #{currentTargetId}
                        </p>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    <button
                        type="button"
                        class="p-1.5 rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
                        onclick={onClose}
                    >
                        <XIcon size={18} />
                    </button>
                </div>
            </div>

            <!-- Comparison Selector Bar -->
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-darkborderc/60 bg-darkbg/50 px-4 py-3 text-xs font-mono">
                <div class="flex flex-wrap items-center gap-3 min-w-0">
                    <!-- Base Revision Selector -->
                    <div class="flex items-center gap-1.5">
                        <span class="text-textcolor2 font-sans font-medium">{language.dbHistoryDiffBase}:</span>
                        <select
                            class="rounded-lg border border-darkborderc bg-bgcolor px-2.5 py-1 text-xs text-textcolor font-mono focus:outline-hidden"
                            bind:value={currentBaseId}
                            onchange={loadDiff}
                        >
                            {#each allRevisions as rev}
                                <option value={rev.id}>#{rev.id} ({rev.scope} / {rev.action})</option>
                            {/each}
                        </select>
                    </div>

                    <!-- Swap Button -->
                    <button
                        type="button"
                        class="p-1 rounded-lg border border-darkborderc bg-darkbutton hover:text-textcolor text-textcolor2 transition-colors cursor-pointer"
                        title="Swap base and target"
                        onclick={swapRevisions}
                    >
                        <ArrowLeftRightIcon size={13} />
                    </button>

                    <!-- Target Revision Selector -->
                    <div class="flex items-center gap-1.5">
                        <span class="text-textcolor2 font-sans font-medium">{language.dbHistoryDiffTarget}:</span>
                        <select
                            class="rounded-lg border border-darkborderc bg-bgcolor px-2.5 py-1 text-xs text-textcolor font-mono focus:outline-hidden"
                            bind:value={currentTargetId}
                            onchange={loadDiff}
                        >
                            {#each allRevisions as rev}
                                <option value={rev.id}>#{rev.id} ({rev.scope} / {rev.action})</option>
                            {/each}
                        </select>
                    </div>
                </div>

                <!-- Counts Summary Badge -->
                {#if diffResult}
                    <div class="flex items-center gap-2">
                        <span class="rounded-full bg-darkbutton px-2.5 py-0.5 text-xs text-textcolor font-semibold">
                            {diffResult.totalChanges} total changes
                        </span>
                        <span class="text-emerald-400 font-bold">+{totalInsertCount}</span>
                        <span class="text-amber-400 font-bold">~{totalUpdateCount}</span>
                        <span class="text-rose-400 font-bold">-{totalDeleteCount}</span>
                    </div>
                {/if}
            </div>

            <!-- Body Area -->
            <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 min-h-0 scrollbar-thin">
                {#if busy}
                    <div class="flex h-64 flex-col items-center justify-center gap-3 text-textcolor2 text-sm">
                        <RefreshCwIcon size={24} class="animate-spin text-blue-400" />
                        <span>Computing diff between revisions...</span>
                    </div>
                {:else if error}
                    <div class="rounded-xl border border-draculared/40 bg-draculared/10 p-4 text-xs text-draculared">
                        {error}
                    </div>
                {:else if diffResult}
                    <!-- Changed Tables Selector Chips -->
                    {#if diffResult.tables && diffResult.tables.length > 0}
                        <div class="rounded-xl border border-darkborderc bg-darkbg/60 p-3.5 space-y-2">
                            <span class="text-xs font-semibold text-textcolor block">
                                {language.dbHistoryAuditTableSummary}
                            </span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    type="button"
                                    class="rounded-lg px-2.5 py-1 text-xs font-mono font-medium transition-colors cursor-pointer border {
                                        selectedTable === 'all'
                                            ? 'bg-selected text-textcolor border-darkborderc shadow-xs'
                                            : 'bg-darkbutton/60 text-textcolor2 border-darkborderc/50 hover:text-textcolor'
                                    }"
                                    onclick={() => selectedTable = 'all'}
                                >
                                    All Tables ({diffResult.totalChanges})
                                </button>
                                {#each diffResult.tables as table}
                                    <button
                                        type="button"
                                        class="rounded-lg px-2.5 py-1 text-xs font-mono font-medium transition-colors cursor-pointer border flex items-center gap-1.5 {
                                            selectedTable === table.tableName
                                                ? 'bg-selected text-textcolor border-darkborderc shadow-xs'
                                                : 'bg-darkbutton/60 text-textcolor2 border-darkborderc/50 hover:text-textcolor'
                                        }"
                                        onclick={() => selectedTable = table.tableName}
                                    >
                                        <span>{table.tableName}</span>
                                        <span class="rounded bg-bgcolor/80 px-1 py-0.2 text-[10px]">{table.totalCount}</span>
                                    </button>
                                {/each}
                            </div>
                        </div>
                    {/if}

                    <!-- Filter Bar & Search -->
                    <div class="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                        <div class="flex items-center rounded-lg border border-darkborderc bg-bgcolor/60 p-0.5 text-xs font-mono">
                            <button
                                type="button"
                                class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'all' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:text-textcolor'}"
                                onclick={() => selectedOp = 'all'}
                            >
                                All Ops
                            </button>
                            <button
                                type="button"
                                class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'INSERT' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-textcolor2 hover:text-emerald-400'}"
                                onclick={() => selectedOp = 'INSERT'}
                            >
                                + Inserts ({totalInsertCount})
                            </button>
                            <button
                                type="button"
                                class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'UPDATE' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-textcolor2 hover:text-amber-400'}"
                                onclick={() => selectedOp = 'UPDATE'}
                            >
                                ~ Updates ({totalUpdateCount})
                            </button>
                            <button
                                type="button"
                                class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'DELETE' ? 'bg-rose-500/20 text-rose-300 font-bold' : 'text-textcolor2 hover:text-rose-400'}"
                                onclick={() => selectedOp = 'DELETE'}
                            >
                                - Deletes ({totalDeleteCount})
                            </button>
                        </div>

                        <div class="relative w-48 sm:w-64">
                            <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                                <SearchIcon size={13} />
                            </div>
                            <TextInput
                                bind:value={searchQuery}
                                size="sm"
                                fullwidth={true}
                                placeholder="Search diff entries..."
                                className="pl-7 text-xs"
                            />
                        </div>
                    </div>

                    <!-- Diff Entries List -->
                    {#if filteredEntries.length === 0}
                        <div class="rounded-xl border border-darkborderc bg-bgcolor/30 p-12 text-center text-xs text-textcolor2">
                            {language.dbHistoryDiffNoChanges}
                        </div>
                    {:else}
                        <div class="space-y-3">
                            {#each filteredEntries as entry (entry.sequence)}
                                <div class="rounded-xl border border-darkborderc bg-darkbg/50 p-3.5 shadow-xs transition-all space-y-2.5">
                                    <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <span class="rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider border {getOpBadge(entry.operation)}">
                                                {entry.operation}
                                            </span>
                                            <span class="rounded-md bg-darkbutton px-2 py-0.5 text-xs text-textcolor font-medium">
                                                {entry.tableName}
                                            </span>
                                            {#if entry.revisionId}
                                                <span class="text-[11px] text-textcolor2">
                                                    in Rev #{entry.revisionId}
                                                </span>
                                            {/if}
                                        </div>
                                        <div class="text-[11px] text-textcolor2">
                                            Seq #{entry.sequence}
                                        </div>
                                    </div>

                                    <DbRevisionRowDiff
                                        beforeRow={entry.beforeRow}
                                        afterRow={entry.afterRow}
                                        operation={entry.operation}
                                        tableName={entry.tableName}
                                    />
                                </div>
                            {/each}
                        </div>
                    {/if}
                {/if}
            </div>

            <!-- Footer Bar -->
            <div class="flex items-center justify-between border-t border-darkborderc bg-darkbg p-3.5 sm:p-4 shrink-0 select-none">
                <div class="text-xs text-textcolor2 font-mono">
                    Showing {filteredEntries.length} diff records
                </div>

                <div class="flex items-center gap-2">
                    <Button size="sm" onclick={onClose}>
                        Close
                    </Button>
                </div>
            </div>
        </div>
    </div>
{/if}
