<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeOffIcon } from '@lucide/svelte'

    interface Props {
        beforeRow: Record<string, unknown> | null
        afterRow: Record<string, unknown> | null
        operation: 'INSERT' | 'UPDATE' | 'DELETE'
        tableName?: string
        compact?: boolean
    }

    const {
        beforeRow,
        afterRow,
        operation,
        tableName = '',
        compact = false
    }: Props = $props()

    let showUnchanged = $state(false)
    let expandedKeys = $state<Set<string>>(new Set())

    function toggleKeyExpanded(key: string) {
        const next = new Set(expandedKeys)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        expandedKeys = next
    }

    interface FieldDiff {
        key: string
        status: 'added' | 'removed' | 'modified' | 'unchanged'
        beforeVal: unknown
        afterVal: unknown
        beforeStr: string
        afterStr: string
        isComplex: boolean
    }

    function formatVal(val: unknown): string {
        if (val === null) return 'null'
        if (val === undefined) return 'undefined'
        if (typeof val === 'object') {
            try {
                return JSON.stringify(val, null, 2)
            } catch {
                return String(val)
            }
        }
        return String(val)
    }

    const fieldDiffs = $derived.by<FieldDiff[]>(() => {
        const before = beforeRow || {}
        const after = afterRow || {}
        const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))

        return allKeys.map((key) => {
            const hasBefore = key in before && before[key] !== undefined
            const hasAfter = key in after && after[key] !== undefined
            const beforeVal = before[key]
            const afterVal = after[key]
            const beforeStr = formatVal(beforeVal)
            const afterStr = formatVal(afterVal)

            let status: FieldDiff['status'] = 'unchanged'
            if (operation === 'INSERT' || (!hasBefore && hasAfter)) {
                status = 'added'
            } else if (operation === 'DELETE' || (hasBefore && !hasAfter)) {
                status = 'removed'
            } else if (beforeStr !== afterStr) {
                status = 'modified'
            }

            const isComplex = typeof beforeVal === 'object' || typeof afterVal === 'object' ||
                beforeStr.length > 60 || afterStr.length > 60 || beforeStr.includes('\n') || afterStr.includes('\n')

            return {
                key,
                status,
                beforeVal,
                afterVal,
                beforeStr,
                afterStr,
                isComplex
            }
        }).sort((a, b) => {
            const rank = (s: FieldDiff['status']) => {
                if (s === 'modified') return 0
                if (s === 'added') return 1
                if (s === 'removed') return 2
                return 3
            }
            const rDiff = rank(a.status) - rank(b.status)
            if (rDiff !== 0) return rDiff
            return a.key.localeCompare(b.key)
        })
    })

    const visibleDiffs = $derived(
        showUnchanged ? fieldDiffs : fieldDiffs.filter((f) => f.status !== 'unchanged')
    )

    const unchangedCount = $derived(
        fieldDiffs.filter((f) => f.status === 'unchanged').length
    )
</script>

<div class="rounded-lg border border-darkborderc/60 bg-darkbg/80 text-xs font-mono overflow-hidden">
    <!-- Top toolbar for toggling unchanged fields -->
    {#if unchangedCount > 0}
        <div class="flex items-center justify-between px-3 py-1.5 bg-bgcolor/40 border-b border-darkborderc/40 text-[11px] text-textcolor2">
            <span>{visibleDiffs.length} fields shown ({unchangedCount} unchanged hidden)</span>
            <button
                type="button"
                class="flex items-center gap-1 hover:text-textcolor transition-colors cursor-pointer text-[11px]"
                onclick={() => showUnchanged = !showUnchanged}
            >
                {#if showUnchanged}
                    <EyeOffIcon size={12} /> Hide unchanged
                {:else}
                    <EyeIcon size={12} /> Show all ({unchangedCount} unchanged)
                {/if}
            </button>
        </div>
    {/if}

    <!-- Diff rows -->
    <div class="divide-y divide-darkborderc/30 max-h-96 overflow-y-auto scrollbar-thin">
        {#if visibleDiffs.length === 0}
            <div class="p-3 text-center text-textcolor2 text-xs">
                No visible field changes.
            </div>
        {:else}
            {#each visibleDiffs as diff (diff.key)}
                {@const isExpanded = expandedKeys.has(diff.key)}
                <div class="p-2.5 transition-colors {
                    diff.status === 'added' ? 'bg-emerald-500/5 hover:bg-emerald-500/10' :
                    diff.status === 'removed' ? 'bg-rose-500/5 hover:bg-rose-500/10' :
                    diff.status === 'modified' ? 'bg-amber-500/5 hover:bg-amber-500/10' :
                    'hover:bg-bgcolor/30 opacity-75'
                }">
                    <!-- Field Header -->
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-1.5 min-w-0">
                            {#if diff.isComplex}
                                <button
                                    type="button"
                                    class="p-0.5 rounded text-textcolor2 hover:text-textcolor cursor-pointer"
                                    onclick={() => toggleKeyExpanded(diff.key)}
                                >
                                    {#if isExpanded}
                                        <ChevronDownIcon size={13} />
                                    {:else}
                                        <ChevronRightIcon size={13} />
                                    {/if}
                                </button>
                            {/if}

                            <span class="font-semibold {
                                diff.status === 'added' ? 'text-emerald-400' :
                                diff.status === 'removed' ? 'text-rose-400' :
                                diff.status === 'modified' ? 'text-amber-300' :
                                'text-textcolor2'
                            }">
                                {diff.key}
                            </span>

                            <span class="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded {
                                diff.status === 'added' ? 'bg-emerald-500/20 text-emerald-300' :
                                diff.status === 'removed' ? 'bg-rose-500/20 text-rose-300' :
                                diff.status === 'modified' ? 'bg-amber-500/20 text-amber-300' :
                                'bg-zinc-500/20 text-zinc-400'
                            }">
                                {diff.status}
                            </span>
                        </div>
                    </div>

                    <!-- Field Values -->
                    {#if diff.status === 'modified'}
                        <div class="mt-1.5 space-y-1 text-[11px]">
                            <!-- Before -->
                            <div class="flex items-start gap-2 rounded bg-rose-500/10 p-1.5 text-rose-300 border border-rose-500/20">
                                <span class="font-bold select-none text-rose-400">-</span>
                                <pre class="whitespace-pre-wrap break-all min-w-0 flex-1 {(!isExpanded && diff.isComplex) ? 'line-clamp-2' : ''}">{diff.beforeStr}</pre>
                            </div>
                            <!-- After -->
                            <div class="flex items-start gap-2 rounded bg-emerald-500/10 p-1.5 text-emerald-300 border border-emerald-500/20">
                                <span class="font-bold select-none text-emerald-400">+</span>
                                <pre class="whitespace-pre-wrap break-all min-w-0 flex-1 {(!isExpanded && diff.isComplex) ? 'line-clamp-2' : ''}">{diff.afterStr}</pre>
                            </div>
                        </div>
                    {:else if diff.status === 'added'}
                        <div class="mt-1 flex items-start gap-2 rounded bg-emerald-500/10 p-1.5 text-emerald-300 text-[11px] border border-emerald-500/20">
                            <span class="font-bold select-none text-emerald-400">+</span>
                            <pre class="whitespace-pre-wrap break-all min-w-0 flex-1 {(!isExpanded && diff.isComplex) ? 'line-clamp-2' : ''}">{diff.afterStr}</pre>
                        </div>
                    {:else if diff.status === 'removed'}
                        <div class="mt-1 flex items-start gap-2 rounded bg-rose-500/10 p-1.5 text-rose-300 text-[11px] border border-rose-500/20">
                            <span class="font-bold select-none text-rose-400">-</span>
                            <pre class="whitespace-pre-wrap break-all min-w-0 flex-1 {(!isExpanded && diff.isComplex) ? 'line-clamp-2' : ''}">{diff.beforeStr}</pre>
                        </div>
                    {:else}
                        <div class="mt-1 text-textcolor2/80 text-[11px] px-1.5">
                            <pre class="whitespace-pre-wrap break-all min-w-0 flex-1 {(!isExpanded && diff.isComplex) ? 'line-clamp-1' : ''}">{diff.afterStr}</pre>
                        </div>
                    {/if}
                </div>
            {/each}
        {/if}
    </div>
</div>
