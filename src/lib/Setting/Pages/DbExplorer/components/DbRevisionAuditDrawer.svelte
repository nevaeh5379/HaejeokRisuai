<script lang="ts">
    import {
        CheckIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        ClockIcon,
        CodeIcon,
        FileCode2Icon,
        FilterIcon,
        LayersIcon,
        RefreshCwIcon,
        RotateCcwIcon,
        SearchIcon,
        SparklesIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/files/nodeStorage'
    import type {
        NodePostgresAuditLogItem,
        NodePostgresRevision,
        NodePostgresRevisionDetails,
        NodePostgresTableSummary
    } from '../types'
    import DbRevisionRowDiff from './DbRevisionRowDiff.svelte'

    interface Props {
        open: boolean
        revision: NodePostgresRevision | null
        isLatest?: boolean
        onClose: () => void
        onRestore?: (revision: NodePostgresRevision) => void
        onCompareWithPrev?: (revision: NodePostgresRevision) => void
    }

    const {
        open,
        revision,
        isLatest = false,
        onClose,
        onRestore,
        onCompareWithPrev
    }: Props = $props()

    let busy = $state(false)
    let details = $state<NodePostgresRevisionDetails | null>(null)
    let error = $state('')
    let selectedTable = $state<string>('all')
    let selectedOp = $state<'all' | 'INSERT' | 'UPDATE' | 'DELETE'>('all')
    let searchQuery = $state('')
    let viewRawJson = $state(false)
    let expandedItemKeys = $state<Set<number>>(new Set())

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function loadDetails() {
        if (!revision) return
        busy = true
        error = ''
        try {
            const storage = getNodeStorage().postgres
            if (typeof storage.getRevisionDetails === 'function') {
                details = await storage.getRevisionDetails(revision.id)
            } else {
                details = null
            }
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    $effect(() => {
        if (open && revision) {
            selectedTable = 'all'
            selectedOp = 'all'
            searchQuery = ''
            expandedItemKeys = new Set()
            loadDetails()
        } else {
            details = null
        }
    })

    function toggleItemExpanded(seq: number) {
        const next = new Set(expandedItemKeys)
        if (next.has(seq)) next.delete(seq)
        else next.add(seq)
        expandedItemKeys = next
    }

    function getEntitySummary(item: NodePostgresAuditLogItem): string {
        const row = item.afterRow || item.beforeRow || {}
        if (item.tableName.includes('character') && row.name) {
            return `Character: ${row.name}`
        }
        if (item.tableName.includes('chat') && row.name) {
            return `Chat: ${row.name}`
        }
        if (item.tableName.includes('message')) {
            const role = row.role ? `[${row.role}] ` : ''
            const text = typeof row.content_text === 'string' ? row.content_text : (row.data as any)?.data || ''
            const snippet = text.slice(0, 50).replace(/\n/g, ' ')
            return `${role}${snippet || row.id || ''}`
        }
        if (item.tableName.includes('setting') && row.key) {
            return `Setting: ${row.key}`
        }
        if (row.id) return `ID: ${row.id}`
        if (row.key) return `Key: ${row.key}`
        return ''
    }

    const filteredAuditLogs = $derived.by(() => {
        if (!details?.auditLogs) return []
        let list = [...details.auditLogs]
        if (selectedTable !== 'all') {
            list = list.filter((a) => a.tableName === selectedTable)
        }
        if (selectedOp !== 'all') {
            list = list.filter((a) => a.operation === selectedOp)
        }
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase()
            list = list.filter((a) => {
                if (a.tableName.toLowerCase().includes(q)) return true
                if (a.operation.toLowerCase().includes(q)) return true
                const summary = getEntitySummary(a).toLowerCase()
                if (summary.includes(q)) return true
                const jsonStr = JSON.stringify(a).toLowerCase()
                return jsonStr.includes(q)
            })
        }
        return list
    })

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
    <!-- Backdrop Overlay -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
        onclick={onClose}
        role="presentation"
    ></div>

    <!-- Slide-over Drawer Panel -->
    <div
        class="fixed inset-y-0 right-0 z-60 flex w-full max-w-2xl sm:max-w-3xl flex-col border-l border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in slide-in-from-right duration-200"
        role="dialog"
        aria-modal="true"
    >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-darkborderc bg-darkbg p-4 select-none shrink-0">
            <div class="flex items-center gap-3 min-w-0">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    <TableIcon class="h-5 w-5" />
                </div>
                <div class="min-w-0">
                    <div class="flex items-center gap-2">
                        <h3 class="text-base font-bold text-textcolor">
                            {language.dbHistoryAuditTitle} <span class="font-mono text-blue-400">#{revision?.id}</span>
                        </h3>
                        {#if isLatest}
                            <span class="rounded-full bg-emerald-500/20 px-2 py-0.2 text-[10px] font-medium text-emerald-300 border border-emerald-500/30">
                                {language.dbHistoryCurrentBadge}
                            </span>
                        {/if}
                    </div>
                    <p class="text-xs text-textcolor2 truncate mt-0.5">
                        {language.dbHistoryAuditSubtitle} #{revision?.id} · {revision?.scope} / {revision?.action}
                    </p>
                </div>
            </div>

            <div class="flex items-center gap-2">
                <button
                    type="button"
                    class="p-2 rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
                    onclick={onClose}
                    title="Close"
                >
                    <XIcon size={18} />
                </button>
            </div>
        </div>

        <!-- Body Content -->
        <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 min-h-0 scrollbar-thin">
            {#if busy}
                <div class="flex h-64 flex-col items-center justify-center gap-3 text-textcolor2 text-sm">
                    <RefreshCwIcon size={24} class="animate-spin text-blue-400" />
                    <span>Loading audit trail...</span>
                </div>
            {:else if error}
                <div class="rounded-xl border border-draculared/40 bg-draculared/10 p-4 text-xs text-draculared">
                    {error}
                </div>
            {:else if details}
                <!-- 1. Metadata summary cards -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
                    <div class="rounded-lg border border-darkborderc bg-darkbg/70 p-2.5">
                        <span class="text-[11px] text-textcolor2 block">Created At</span>
                        <span class="font-semibold text-textcolor truncate block mt-0.5" title={details.created_at}>
                            {new Date(details.created_at).toLocaleTimeString()}
                        </span>
                    </div>
                    <div class="rounded-lg border border-darkborderc bg-darkbg/70 p-2.5">
                        <span class="text-[11px] text-textcolor2 block">Total Changes</span>
                        <span class="font-bold text-textcolor block mt-0.5">{details.change_count} rows</span>
                    </div>
                    <div class="rounded-lg border border-darkborderc bg-darkbg/70 p-2.5">
                        <span class="text-[11px] text-textcolor2 block">Storage Rev</span>
                        <span class="font-semibold text-textcolor block mt-0.5">#{details.storage_revision ?? '—'}</span>
                    </div>
                    <div class="rounded-lg border border-darkborderc bg-darkbg/70 p-2.5">
                        <span class="text-[11px] text-textcolor2 block">Initialized</span>
                        <span class="font-semibold text-textcolor block mt-0.5">{details.database_initialized ? 'Yes' : 'No'}</span>
                    </div>
                </div>

                <!-- 2. Changed Tables Summary Chips -->
                {#if details.tableSummaries && details.tableSummaries.length > 0}
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
                                All Tables ({details.change_count})
                            </button>
                            {#each details.tableSummaries as summary}
                                <button
                                    type="button"
                                    class="rounded-lg px-2.5 py-1 text-xs font-mono font-medium transition-colors cursor-pointer border flex items-center gap-1.5 {
                                        selectedTable === summary.tableName
                                            ? 'bg-selected text-textcolor border-darkborderc shadow-xs'
                                            : 'bg-darkbutton/60 text-textcolor2 border-darkborderc/50 hover:text-textcolor'
                                    }"
                                    onclick={() => selectedTable = summary.tableName}
                                >
                                    <span>{summary.tableName}</span>
                                    <span class="rounded bg-bgcolor/80 px-1 py-0.2 text-[10px]">{summary.totalCount}</span>
                                </button>
                            {/each}
                        </div>
                    </div>
                {/if}

                <!-- 3. Filter Bar & Search -->
                <div class="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                    <!-- Operation Filter -->
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
                            + Inserts
                        </button>
                        <button
                            type="button"
                            class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'UPDATE' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-textcolor2 hover:text-amber-400'}"
                            onclick={() => selectedOp = 'UPDATE'}
                        >
                            ~ Updates
                        </button>
                        <button
                            type="button"
                            class="rounded-md px-2 py-1 transition-colors cursor-pointer {selectedOp === 'DELETE' ? 'bg-rose-500/20 text-rose-300 font-bold' : 'text-textcolor2 hover:text-rose-400'}"
                            onclick={() => selectedOp = 'DELETE'}
                        >
                            - Deletes
                        </button>
                    </div>

                    <!-- Search Input & JSON View Toggle -->
                    <div class="flex items-center gap-2">
                        <div class="relative w-44 sm:w-56">
                            <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                                <SearchIcon size={13} />
                            </div>
                            <TextInput
                                bind:value={searchQuery}
                                size="sm"
                                fullwidth={true}
                                placeholder="Search changes..."
                                className="pl-7 text-xs"
                            />
                        </div>

                        <button
                            type="button"
                            class="p-2 rounded-lg border border-darkborderc bg-darkbutton text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                            title={viewRawJson ? 'Switch to Diff view' : 'Switch to Raw JSON view'}
                            onclick={() => viewRawJson = !viewRawJson}
                        >
                            <CodeIcon size={14} class={viewRawJson ? 'text-blue-400' : ''} />
                        </button>
                    </div>
                </div>

                <!-- 4. Audit Log Items List -->
                {#if filteredAuditLogs.length === 0}
                    <div class="rounded-xl border border-darkborderc bg-bgcolor/30 p-10 text-center text-xs text-textcolor2">
                        {language.dbHistoryAuditNoChanges}
                    </div>
                {:else if viewRawJson}
                    <div class="rounded-xl bg-darkbg p-4 border border-darkborderc overflow-x-auto text-xs font-mono">
                        <pre class="text-textcolor2">{JSON.stringify(filteredAuditLogs, null, 2)}</pre>
                    </div>
                {:else}
                    <div class="space-y-3">
                        {#each filteredAuditLogs as log, idx (log.sequence)}
                            {@const summary = getEntitySummary(log)}
                            {@const isExpanded = !expandedItemKeys.has(log.sequence)}

                            <div class="rounded-xl border border-darkborderc bg-darkbg/50 p-3.5 shadow-xs transition-all space-y-2.5">
                                <!-- Card Header -->
                                <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <!-- Operation Badge -->
                                        <span class="rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider border {getOpBadge(log.operation)}">
                                            {log.operation}
                                        </span>

                                        <!-- Table Name -->
                                        <span class="rounded-md bg-darkbutton px-2 py-0.5 text-xs text-textcolor font-medium">
                                            {log.tableName}
                                        </span>

                                        <!-- Entity Summary if available -->
                                        {#if summary}
                                            <span class="text-xs font-sans text-textcolor2 truncate font-normal">
                                                {summary}
                                            </span>
                                        {/if}
                                    </div>

                                    <div class="flex items-center gap-2 text-[11px] text-textcolor2">
                                        <span>Seq #{log.sequence}</span>
                                        <button
                                            type="button"
                                            class="p-1 rounded text-textcolor2 hover:text-textcolor cursor-pointer"
                                            onclick={() => toggleItemExpanded(log.sequence)}
                                        >
                                            {#if isExpanded}
                                                <ChevronDownIcon size={14} />
                                            {:else}
                                                <ChevronRightIcon size={14} />
                                            {/if}
                                        </button>
                                    </div>
                                </div>

                                <!-- Card Row Diff Body -->
                                {#if isExpanded}
                                    <DbRevisionRowDiff
                                        beforeRow={log.beforeRow}
                                        afterRow={log.afterRow}
                                        operation={log.operation}
                                        tableName={log.tableName}
                                    />
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}
        </div>

        <!-- Footer Actions -->
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-darkborderc bg-darkbg p-4 shrink-0 select-none">
            <div class="text-xs text-textcolor2 font-mono">
                Revision #{revision?.id} ({filteredAuditLogs.length} events)
            </div>

            <div class="flex items-center gap-2">
                {#if onCompareWithPrev && revision}
                    <Button
                        size="sm"
                        className="bg-darkbutton hover:bg-darkbutton/80 text-textcolor"
                        onclick={() => {
                            onCompareWithPrev(revision)
                            onClose()
                        }}
                    >
                        {language.dbHistoryDiffWithPrev}
                    </Button>
                {/if}

                {#if onRestore && revision}
                    <Button
                        size="sm"
                        disabled={isLatest}
                        className="bg-selected hover:opacity-90 font-medium"
                        onclick={() => {
                            onRestore(revision)
                            onClose()
                        }}
                    >
                        <RotateCcwIcon size={13} class="mr-1.5 inline" />
                        {language.dbHistoryRestoreButton}
                    </Button>
                {/if}
            </div>
        </div>
    </div>
{/if}
