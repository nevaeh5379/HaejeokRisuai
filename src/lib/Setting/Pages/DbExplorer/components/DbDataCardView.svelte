<script lang="ts">
    import {
        BracesIcon,
        FileCode2Icon,
        FileTextIcon,
        MoreVerticalIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type {
        NodePostgresColumnInfo,
        NodePostgresTableData
    } from 'src/ts/storage/nodePostgresStorage'

    interface Props {
        tableData: NodePostgresTableData
        detailRow: Record<string, unknown> | null
        onSelectRow: (row: Record<string, unknown>) => void
        onCellContextMenu: (
            e: MouseEvent,
            column: NodePostgresColumnInfo,
            row: Record<string, unknown>,
            value: unknown
        ) => void
    }

    let { tableData, detailRow, onSelectRow, onCellContextMenu }: Props =
        $props()

    function formatCardValue(value: unknown): string {
        if (value === null || value === undefined) return 'NULL'
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
    }
</script>

<div class="flex-1 overflow-y-auto p-2 sm:p-3 space-y-2 min-h-0 bg-bgcolor/40 scrollbar-thin">
    {#each tableData.rows as row, index (tableData.offset + index)}
        {@const isSelected = detailRow === row}
        {@const firstCol = tableData.columns[0]}
        {@const firstColVal = firstCol ? row[firstCol.name] : null}
        
        <div
            class="rounded-xl border border-darkborderc bg-darkbg/90 p-2.5 shadow-xs transition-all active:scale-[0.99] cursor-pointer hover:border-darkborderc/90 hover:bg-darkbg {isSelected ? 'border-selected ring-1 ring-selected' : ''}"
            onclick={() => onSelectRow(row)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') onSelectRow(row) }}
        >
            <!-- Card Top Bar: Row # & Primary identifier & Action button -->
            <div class="flex items-center justify-between gap-2 border-b border-darkborderc/50 pb-1.5 mb-2">
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="rounded bg-darkbutton px-1.5 py-0.2 font-mono text-[10px] text-textcolor2 font-medium shrink-0">
                        #{tableData.offset + index + 1}
                    </span>
                    {#if firstCol}
                        <span class="font-mono text-xs font-bold text-textcolor truncate" title={String(firstColVal)}>
                            {firstCol.name}: <span class="text-blue-400 font-semibold">{formatCardValue(firstColVal)}</span>
                        </span>
                    {/if}
                </div>

                <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center rounded text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors shrink-0"
                    onclick={(e) => {
                        e.stopPropagation()
                        if (firstCol) {
                            onCellContextMenu(e, firstCol, row, firstColVal)
                        }
                    }}
                    title={language.postgresDbExplorerActions}
                >
                    <MoreVerticalIcon size={14} />
                </button>
            </div>

            <!-- Card Body: Key-Value pairs in 2-column or responsive grid -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {#each tableData.columns.slice(1, 7) as column (column.name)}
                    {@const val = row[column.name]}
                    <div class="flex items-center justify-between gap-2 min-w-0 py-0.5">
                        <span class="font-mono text-[11px] text-textcolor2/80 truncate shrink-0">
                            {column.name}:
                        </span>
                        <div class="min-w-0 text-right truncate">
                            {#if val === null || val === undefined}
                                <span class="italic text-[10px] text-textcolor2/40">NULL</span>
                            {:else if typeof val === 'boolean'}
                                <span class="inline-flex px-1 rounded text-[9px] font-semibold {val ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">
                                    {val ? 'true' : 'false'}
                                </span>
                            {:else if Array.isArray(val)}
                                <span class="inline-flex items-center gap-0.5 text-[10px] font-mono text-violet-300">
                                    <BracesIcon size={9} />
                                    <span>[{val.length}]</span>
                                </span>
                            {:else if typeof val === 'object'}
                                <span class="inline-flex items-center gap-0.5 text-[10px] font-mono text-sky-300">
                                    <FileCode2Icon size={9} />
                                    <span>{'{...}'}</span>
                                </span>
                            {:else}
                                <span class="font-mono text-[11px] text-textcolor truncate">
                                    {String(val)}
                                </span>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>

            {#if tableData.columns.length > 7}
                <div class="mt-1.5 pt-1 border-t border-darkborderc/30 flex items-center justify-between text-[10px] font-mono text-textcolor2/70">
                    <span>+{tableData.columns.length - 7} more columns</span>
                    <span class="text-blue-400 hover:underline flex items-center gap-0.5">
                        <FileTextIcon size={10} />
                        {language.postgresDbExplorerViewDetail}
                    </span>
                </div>
            {/if}
        </div>
    {:else}
        <div class="py-16 text-center text-xs text-textcolor2">
            {language.postgresDbExplorerEmptyTable}
        </div>
    {/each}
</div>
