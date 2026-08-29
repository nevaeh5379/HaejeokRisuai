<script lang="ts">
    import {
        CheckIcon,
        CopyIcon,
        SearchIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { NodePostgresColumnInfo } from 'src/ts/storage/sql/postgres/nodePostgresStorage'

    interface Props {
        tableName: string
        columns: NodePostgresColumnInfo[]
        detailRow: Record<string, unknown> | null
        isMobile: boolean
        onClose: () => void
        onCopyJson: () => void
        onCopyValue: (val: unknown) => void
        onSearchThisValue: (val: unknown) => void
        copiedJson?: boolean
    }

    let {
        tableName,
        columns,
        detailRow,
        isMobile,
        onClose,
        onCopyJson,
        onCopyValue,
        onSearchThisValue,
        copiedJson = false
    }: Props = $props()

    let fieldFilter = $state('')

    const filteredColumns = $derived(
        columns.filter((col) => {
            if (!fieldFilter) return true
            const q = fieldFilter.toLowerCase()
            const valStr = detailRow ? String(detailRow[col.name] ?? '').toLowerCase() : ''
            return col.name.toLowerCase().includes(q) || valStr.includes(q) || col.dataType.toLowerCase().includes(q)
        })
    )

    function formatDetailValue(value: unknown): string {
        if (value === null || value === undefined) {
            return language.postgresDbExplorerNull ?? 'NULL'
        }
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value, null, 2)
            } catch {
                return String(value)
            }
        }
        return String(value)
    }
</script>

{#if detailRow}
    {#if isMobile}
        <!-- Mobile Bottom Sheet Modal -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs md:hidden animate-in fade-in duration-150"
            onclick={onClose}
        >
            <div
                class="flex max-h-[85vh] w-full flex-col rounded-t-2xl border-t border-darkborderc bg-darkbg text-textcolor shadow-2xl overflow-hidden animate-in slide-in-from-bottom duration-200"
                onclick={(e) => e.stopPropagation()}
            >
                <!-- Drag Handle -->
                <div class="flex justify-center pt-2.5 pb-1">
                    <div class="h-1 w-10 rounded-full bg-darkborderc/80"></div>
                </div>

                <!-- Header -->
                <div class="flex items-center justify-between border-b border-darkborderc px-4 py-2.5 shrink-0 bg-darkbg">
                    <div class="min-w-0">
                        <h3 class="font-bold text-sm text-textcolor truncate">
                            {language.postgresDbExplorerRowDetail}
                        </h3>
                        <p class="font-mono text-[11px] text-textcolor2 truncate">{tableName}</p>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <Button size="sm" className="flex items-center gap-1 text-xs py-1 px-2.5" onclick={onCopyJson}>
                            {#if copiedJson}
                                <CheckIcon size={13} class="text-emerald-400" />
                                <span>{language.postgresDbExplorerCopied}</span>
                            {:else}
                                <CopyIcon size={13} />
                                <span>{language.postgresDbExplorerCopyJson}</span>
                            {/if}
                        </Button>
                        <button
                            type="button"
                            class="p-1 text-textcolor2 hover:text-textcolor rounded-lg hover:bg-darkbutton transition-colors"
                            onclick={onClose}
                        >
                            <XIcon size={18} />
                        </button>
                    </div>
                </div>

                <!-- Quick Filter -->
                <div class="border-b border-darkborderc/60 p-2 shrink-0 bg-bgcolor/40">
                    <div class="relative flex items-center">
                        <div class="pointer-events-none absolute left-2 text-textcolor2">
                            <SearchIcon size={13} />
                        </div>
                        <TextInput
                            bind:value={fieldFilter}
                            size="sm"
                            fullwidth={true}
                            placeholder={language.postgresDbExplorerFilterColumns}
                            className="pl-7 pr-6 py-1 text-xs bg-darkbg/90 border-darkborderc/80"
                        />
                        {#if fieldFilter}
                            <button
                                type="button"
                                class="absolute right-1.5 cursor-pointer text-textcolor2 hover:text-textcolor p-0.5 rounded"
                                onclick={() => fieldFilter = ''}
                            >
                                <XIcon size={13} />
                            </button>
                        {/if}
                    </div>
                </div>

                <!-- Field Items List -->
                <div class="flex-1 overflow-y-auto p-3 space-y-3 divide-y divide-darkborderc/30 scrollbar-thin">
                    {#each filteredColumns as column (column.name)}
                        {@const rawVal = detailRow[column.name]}
                        <div class="pt-2.5 first:pt-0 space-y-1">
                            <div class="flex items-center justify-between gap-2">
                                <span class="font-mono text-xs font-semibold text-textcolor truncate">
                                    {column.name}
                                </span>
                                <div class="flex items-center gap-1 shrink-0">
                                    <span class="rounded bg-darkbutton px-1.5 py-0.2 font-mono text-[10px] text-textcolor2">
                                        {column.dataType}
                                    </span>
                                    <button
                                        type="button"
                                        class="p-1 text-textcolor2 hover:text-textcolor rounded hover:bg-darkbutton transition-colors"
                                        title={language.postgresDbExplorerCopyValue}
                                        onclick={() => onCopyValue(rawVal)}
                                    >
                                        <CopyIcon size={12} />
                                    </button>
                                </div>
                            </div>
                            <pre class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bgcolor/70 p-2 font-mono text-xs text-textcolor/90 select-text border border-darkborderc/40 scrollbar-thin">
{formatDetailValue(rawVal)}</pre>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {:else}
        <!-- Desktop Right Slide Drawer Panel -->
        <div class="hidden md:flex flex-col h-full border-l border-darkborderc bg-darkbg/95 w-80 lg:w-96 xl:w-[28rem] z-10 shrink-0 select-none shadow-xl">
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-darkborderc px-3.5 py-2.5 shrink-0 bg-darkbg">
                <div class="min-w-0">
                    <h3 class="font-bold text-xs lg:text-sm text-textcolor truncate">
                        {language.postgresDbExplorerRowDetail}
                    </h3>
                    <p class="font-mono text-[10px] text-textcolor2 truncate">{tableName}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" className="flex items-center gap-1 text-xs py-1 px-2.5" onclick={onCopyJson}>
                        {#if copiedJson}
                            <CheckIcon size={13} class="text-emerald-400" />
                            <span>{language.postgresDbExplorerCopied}</span>
                        {:else}
                            <CopyIcon size={13} />
                            <span>{language.postgresDbExplorerCopyJson}</span>
                        {/if}
                    </Button>
                    <button
                        type="button"
                        class="p-1 text-textcolor2 hover:text-textcolor rounded-lg hover:bg-darkbutton transition-colors"
                        onclick={onClose}
                        title="Close drawer"
                    >
                        <XIcon size={16} />
                    </button>
                </div>
            </div>

            <!-- Quick Filter -->
            <div class="border-b border-darkborderc/60 p-2 shrink-0 bg-bgcolor/30">
                <div class="relative flex items-center">
                    <div class="pointer-events-none absolute left-2 text-textcolor2">
                        <SearchIcon size={13} />
                    </div>
                    <TextInput
                        bind:value={fieldFilter}
                        size="sm"
                        fullwidth={true}
                        placeholder={language.postgresDbExplorerFilterColumns}
                        className="pl-7 pr-6 py-1 text-xs bg-darkbg/90 border-darkborderc/80 rounded-lg focus:border-selected"
                    />
                    {#if fieldFilter}
                        <button
                            type="button"
                            class="absolute right-1.5 cursor-pointer text-textcolor2 hover:text-textcolor p-0.5 rounded"
                            onclick={() => fieldFilter = ''}
                        >
                            <XIcon size={13} />
                        </button>
                    {/if}
                </div>
            </div>

            <!-- Fields List -->
            <div class="flex-1 overflow-y-auto p-3 space-y-3 divide-y divide-darkborderc/30 min-h-0 select-text scrollbar-thin">
                {#each filteredColumns as column (column.name)}
                    {@const rawVal = detailRow[column.name]}
                    <div class="pt-2.5 first:pt-0 space-y-1">
                        <div class="flex items-center justify-between gap-2">
                            <span class="font-mono text-xs font-semibold text-textcolor truncate" title={column.name}>
                                {column.name}
                            </span>
                            <div class="flex items-center gap-1 shrink-0">
                                <span class="rounded bg-darkbutton/80 px-1.5 py-0.2 font-mono text-[10px] text-textcolor2">
                                    {column.dataType}
                                </span>
                                {#if rawVal !== null && rawVal !== undefined}
                                    <button
                                        type="button"
                                        class="p-1 text-textcolor2 hover:text-textcolor rounded hover:bg-darkbutton transition-colors"
                                        title={language.postgresDbExplorerSearchThisValue}
                                        onclick={() => onSearchThisValue(rawVal)}
                                    >
                                        <SearchIcon size={12} />
                                    </button>
                                {/if}
                                <button
                                    type="button"
                                    class="p-1 text-textcolor2 hover:text-textcolor rounded hover:bg-darkbutton transition-colors"
                                    title={language.postgresDbExplorerCopyValue}
                                    onclick={() => onCopyValue(rawVal)}
                                >
                                    <CopyIcon size={12} />
                                </button>
                            </div>
                        </div>
                        <pre class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bgcolor/80 p-2 font-mono text-xs text-textcolor/90 select-text border border-darkborderc/40 scrollbar-thin">
{formatDetailValue(rawVal)}</pre>
                    </div>
                {:else}
                    <div class="py-12 text-center text-xs text-textcolor2">
                        {language.postgresDbExplorerNoTables}
                    </div>
                {/each}
            </div>
        </div>
    {/if}
{/if}
