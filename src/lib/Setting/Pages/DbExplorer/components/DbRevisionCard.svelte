<script lang="ts">
    import {
        ArrowRightIcon,
        CheckIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        ClockIcon,
        ExternalLinkIcon,
        LayersIcon,
        RotateCcwIcon,
        SplitIcon,
        TableIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import type { NodePostgresRevision } from '../types'

    interface Props {
        revision: NodePostgresRevision
        isLatest: boolean
        isExpanded: boolean
        compareMode: boolean
        isSelectedForCompare: boolean
        onToggleExpand: () => void
        onInspectAudit: () => void
        onCompareWithPrev: () => void
        onToggleSelectCompare: () => void
        onRestore: () => void
        onJumpToRevision?: (targetId: number) => void
    }

    const {
        revision,
        isLatest,
        isExpanded,
        compareMode,
        isSelectedForCompare,
        onToggleExpand,
        onInspectAudit,
        onCompareWithPrev,
        onToggleSelectCompare,
        onRestore,
        onJumpToRevision
    }: Props = $props()

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

    function getActionBadgeClass(action: string): string {
        switch (action) {
            case 'message':
                return 'bg-teal-500/20 text-teal-300 border-teal-500/30'
            case 'character':
                return 'bg-purple-500/20 text-purple-300 border-purple-500/30'
            case 'chat':
                return 'bg-sky-500/20 text-sky-300 border-sky-500/30'
            case 'settings':
            case 'root':
                return 'bg-amber-500/20 text-amber-300 border-amber-500/30'
            case 'order':
                return 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
            case 'replace-all':
            case 'replace_all':
                return 'bg-rose-500/20 text-rose-300 border-rose-500/30'
            case 'restore':
                return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            default:
                return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30'
        }
    }
</script>

<div
    id={`revision-card-${revision.id}`}
    class="relative rounded-xl border transition-all {
        isSelectedForCompare
            ? 'border-violet-500/80 bg-violet-500/10 ring-1 ring-violet-500/50 shadow-md'
            : isLatest
            ? 'border-blue-500/50 bg-blue-500/5 shadow-xs'
            : 'border-darkborderc bg-bgcolor/40 hover:border-darkborderc/80 hover:bg-bgcolor/60'
    } p-3.5 sm:p-4"
>
    <div class="flex flex-wrap items-center justify-between gap-3">
        <!-- Left: Compare Checkbox + ID + Badges + Timestamp -->
        <div class="flex items-center gap-3 min-w-0">
            <!-- Compare Mode Checkbox -->
            {#if compareMode}
                <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer {
                        isSelectedForCompare
                            ? 'border-violet-500 bg-violet-500 text-white'
                            : 'border-darkborderc bg-darkbutton hover:border-textcolor2'
                    }"
                    onclick={onToggleSelectCompare}
                    title="Select for Diff"
                >
                    {#if isSelectedForCompare}
                        <CheckIcon size={14} />
                    {/if}
                </button>
            {/if}

            <!-- ID Badge -->
            <span class="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs sm:text-sm font-bold {
                isLatest ? 'bg-blue-500 text-white' : 'bg-darkbutton text-textcolor'
            }">
                #{revision.id}
            </span>

            <div class="min-w-0">
                <!-- Badges Row -->
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
                    <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider font-mono border {getActionBadgeClass(revision.action)}">
                        {revision.action}
                    </span>

                    {#if isLatest}
                        <span class="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/30">
                            {language.dbHistoryCurrentBadge}
                        </span>
                    {/if}

                    <!-- Restored from link badge -->
                    {#if revision.restored_from_revision}
                        <button
                            type="button"
                            class="flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 transition-colors cursor-pointer"
                            title={language.dbHistoryJumpToOrigin}
                            onclick={() => onJumpToRevision?.(revision.restored_from_revision!)}
                        >
                            <span>{language.dbHistoryRestoredFrom}{revision.restored_from_revision}</span>
                            <ExternalLinkIcon size={10} />
                        </button>
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

        <!-- Right: Changes Count & Interactive Action Buttons -->
        <div class="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <!-- Changes count -->
            <div class="text-right font-mono text-xs text-textcolor2 pr-1">
                <span class="font-semibold text-textcolor">{revision.change_count}</span> {language.dbHistoryChangesCount}
            </div>

            <!-- Inspect Audit Log Button -->
            <Button
                size="sm"
                className="bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-xs"
                onclick={onInspectAudit}
            >
                <TableIcon size={13} class="mr-1 inline text-blue-400" />
                <span class="hidden sm:inline">{language.dbHistoryInspect}</span>
            </Button>

            <!-- Compare with Prev Button -->
            <Button
                size="sm"
                className="bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-xs hidden md:inline-flex"
                onclick={onCompareWithPrev}
            >
                <SplitIcon size={13} class="mr-1 inline text-violet-400" />
                <span>{language.dbHistoryDiff}</span>
            </Button>

            <!-- Restore Button -->
            <Button
                size="sm"
                disabled={isLatest}
                className="bg-selected hover:opacity-90 font-medium text-xs"
                onclick={onRestore}
            >
                <RotateCcwIcon size={12} class="mr-1 inline" />
                <span>{language.postgresRestore}</span>
            </Button>

            <!-- Metadata Expand Toggle Button -->
            <button
                type="button"
                class="p-1.5 rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
                title={language.dbHistoryDetails}
                onclick={onToggleExpand}
            >
                {#if isExpanded}
                    <ChevronDownIcon size={16} />
                {:else}
                    <ChevronRightIcon size={16} />
                {/if}
            </button>
        </div>
    </div>

    <!-- Expanded Metadata Section -->
    {#if isExpanded}
        <div class="mt-3.5 pt-3 border-t border-darkborderc/40 text-xs font-mono text-textcolor2 space-y-2 animate-in fade-in duration-150">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                    <span class="text-textcolor font-medium">{language.dbHistoryStorageRevision}:</span>
                    <span class="ml-1">#{revision.storage_revision ?? '—'}</span>
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
