<script lang="ts">
    import {
        AlertCircleIcon,
        CheckCircle2Icon,
        InfoIcon,
        LayersIcon,
        RefreshCwIcon,
        RotateCcwIcon,
        ShieldCheckIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type {
        NodePostgresRestorePreview,
        NodePostgresRevision
    } from '../types'

    interface Props {
        open: boolean
        revision: NodePostgresRevision | null
        onClose: () => void
        onSuccess?: () => void
    }

    const {
        open,
        revision,
        onClose,
        onSuccess
    }: Props = $props()

    let busy = $state(false)
    let restoring = $state(false)
    let preview = $state<NodePostgresRestorePreview | null>(null)
    let error = $state('')

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function loadPreview() {
        if (!revision) return
        busy = true
        error = ''
        try {
            const storage = getNodeStorage().postgres
            if (typeof storage.previewRestoreRevision === 'function') {
                preview = await storage.previewRestoreRevision(revision.id)
            } else {
                preview = null
            }
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    $effect(() => {
        if (open && revision) {
            loadPreview()
        } else {
            preview = null
        }
    })

    async function handleRestore() {
        if (!revision || restoring) return
        restoring = true
        try {
            await getNodeStorage().postgres.restoreRevision(revision.id)
            alertNormal(language.postgresRestoreSuccess)
            onSuccess?.()
            setTimeout(() => location.reload(), 300)
        } catch (err) {
            alertError(err)
            restoring = false
        }
    }
</script>

{#if open && revision}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-xs p-3 sm:p-5 animate-in fade-in duration-200"
        onclick={onClose}
        role="presentation"
    >
        <!-- Modal Dialog -->
        <div
            class="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in zoom-in-95 duration-200"
            onclick={(e) => e.stopPropagation()}
            role="presentation"
        >
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-darkborderc bg-darkbg p-4 select-none shrink-0">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        <RotateCcwIcon class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                        <h3 class="text-base font-bold text-textcolor">
                            {language.dbHistoryRestoreModalTitle} <span class="font-mono text-amber-400">#{revision.id}</span>
                        </h3>
                        <p class="text-xs text-textcolor2 truncate mt-0.5">
                            {language.dbHistoryRestoreModalDesc}
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    class="p-1.5 rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors cursor-pointer"
                    onclick={onClose}
                >
                    <XIcon size={18} />
                </button>
            </div>

            <!-- Body -->
            <div class="p-4 sm:p-5 space-y-4 max-h-[75vh] overflow-y-auto scrollbar-thin">
                <!-- Safety Notice Alert Banner -->
                <div class="flex items-start gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-3.5 text-xs text-blue-300">
                    <ShieldCheckIcon class="h-5 w-5 shrink-0 text-blue-400 mt-0.5" />
                    <p class="leading-relaxed">
                        {language.dbHistoryRestoreSafeNotice}
                    </p>
                </div>

                <!-- Simulation & Impact Analysis Section -->
                {#if busy}
                    <div class="flex h-40 flex-col items-center justify-center gap-2 text-textcolor2 text-xs">
                        <RefreshCwIcon size={20} class="animate-spin text-blue-400" />
                        <span>{language.dbHistoryRestoreSimulating}</span>
                    </div>
                {:else if error}
                    <div class="rounded-xl border border-draculared/40 bg-draculared/10 p-3 text-xs text-draculared">
                        {error}
                    </div>
                {:else if preview}
                    <div class="space-y-3">
                        <h4 class="text-xs font-bold text-textcolor uppercase tracking-wider font-mono flex items-center gap-1.5">
                            <LayersIcon size={14} class="text-textcolor2" />
                            {language.dbHistoryRestoreImpactTitle}
                        </h4>

                        <!-- KPI Summary Grid -->
                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                            <div class="rounded-lg border border-darkborderc bg-darkbg p-2.5">
                                <span class="text-[11px] text-textcolor2 block">{language.dbHistoryRestoreRevertCount}</span>
                                <span class="font-bold text-textcolor block mt-0.5">{preview.revisionsToRevert} revs</span>
                            </div>
                            <div class="rounded-lg border border-darkborderc bg-darkbg p-2.5">
                                <span class="text-[11px] text-emerald-400 block">{language.dbHistoryRestoreInserts}</span>
                                <span class="font-bold text-emerald-400 block mt-0.5">+{preview.restoreInsertCount}</span>
                            </div>
                            <div class="rounded-lg border border-darkborderc bg-darkbg p-2.5">
                                <span class="text-[11px] text-amber-400 block">{language.dbHistoryRestoreUpdates}</span>
                                <span class="font-bold text-amber-400 block mt-0.5">~{preview.restoreUpdateCount}</span>
                            </div>
                            <div class="rounded-lg border border-darkborderc bg-darkbg p-2.5">
                                <span class="text-[11px] text-rose-400 block">{language.dbHistoryRestoreDeletes}</span>
                                <span class="font-bold text-rose-400 block mt-0.5">-{preview.restoreDeleteCount}</span>
                            </div>
                        </div>

                        <!-- Affected Tables List -->
                        {#if preview.affectedTables && preview.affectedTables.length > 0}
                            <div class="rounded-xl border border-darkborderc bg-darkbg/50 p-3 space-y-2">
                                <span class="text-xs font-semibold text-textcolor block">
                                    {language.dbHistoryRestoreAffectedTables} ({preview.affectedTables.length})
                                </span>
                                <div class="divide-y divide-darkborderc/40 text-xs font-mono max-h-48 overflow-y-auto scrollbar-thin">
                                    {#each preview.affectedTables as table}
                                        <div class="py-1.5 flex items-center justify-between gap-2">
                                            <span class="text-textcolor font-medium">{table.tableName}</span>
                                            <div class="flex items-center gap-2 text-[11px]">
                                                {#if table.revertedDeletes > 0}
                                                    <span class="text-emerald-400">+{table.revertedDeletes} ins</span>
                                                {/if}
                                                {#if table.revertedUpdates > 0}
                                                    <span class="text-amber-400">~{table.revertedUpdates} upd</span>
                                                {/if}
                                                {#if table.revertedInserts > 0}
                                                    <span class="text-rose-400">-{table.revertedInserts} del</span>
                                                {/if}
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>

            <!-- Footer Actions -->
            <div class="flex items-center justify-between border-t border-darkborderc bg-darkbg p-4 shrink-0 select-none">
                <Button size="sm" disabled={restoring} onclick={onClose}>
                    Cancel
                </Button>

                <Button
                    size="sm"
                    disabled={busy || restoring}
                    className="bg-amber-500 hover:bg-amber-600 text-black font-semibold px-4"
                    onclick={handleRestore}
                >
                    {#if restoring}
                        <RefreshCwIcon size={14} class="animate-spin mr-1.5 inline" />
                        Restoring...
                    {:else}
                        <RotateCcwIcon size={14} class="mr-1.5 inline" />
                        {language.dbHistoryRestoreConfirmBtn}
                    {/if}
                </Button>
            </div>
        </div>
    </div>
{/if}
