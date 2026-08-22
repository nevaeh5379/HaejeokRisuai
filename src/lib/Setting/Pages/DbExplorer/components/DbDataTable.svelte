<script lang="ts">
    import {
        ArrowDownIcon,
        ArrowUpIcon,
        BracesIcon,
        CopyIcon,
        FileCode2Icon,
        HashIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type {
        NodePostgresColumnInfo,
        NodePostgresTableData
    } from 'src/ts/storage/nodePostgresStorage'

    interface Props {
        tableData: NodePostgresTableData
        sortColumn: string
        sortOrder: 'asc' | 'desc'
        detailRow: Record<string, unknown> | null
        onToggleSort: (column: NodePostgresColumnInfo) => void
        onSelectRow: (row: Record<string, unknown>) => void
        onCellContextMenu: (
            e: MouseEvent,
            column: NodePostgresColumnInfo,
            row: Record<string, unknown>,
            value: unknown
        ) => void
        onHeaderContextMenu: (
            e: MouseEvent,
            column: NodePostgresColumnInfo
        ) => void
        onCopyValue?: (value: unknown) => void
    }

    let {
        tableData,
        sortColumn,
        sortOrder,
        detailRow,
        onToggleSort,
        onSelectRow,
        onCellContextMenu,
        onHeaderContextMenu,
        onCopyValue
    }: Props = $props()

    function isUUID(str: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
    }

    function isDateString(str: string): boolean {
        return !isNaN(Date.parse(str)) && /^\d{4}-\d{2}-\d{2}/.test(str)
    }

    function getCellRawText(value: unknown): string {
        if (value === null || value === undefined) return 'NULL'
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
    }
</script>

<div class="flex-1 overflow-auto min-h-0 bg-bgcolor/40 select-text scrollbar-thin">
    <table class="w-full border-collapse text-left font-mono text-xs">
        <!-- Table Header -->
        <thead class="sticky top-0 z-20 bg-darkbg border-b border-darkborderc select-none shadow-xs">
            <tr>
                <!-- Row Number Column -->
                <th class="sticky left-0 top-0 z-30 w-12 min-w-12 max-w-12 bg-darkbg px-2.5 py-2 text-center text-[11px] font-semibold text-textcolor2/70 border-r border-darkborderc/60">
                    #
                </th>

                {#each tableData.columns as column, colIndex (column.name)}
                    <th
                        class="sticky top-0 z-20 px-3 py-2 text-xs font-semibold text-textcolor2 transition-colors hover:text-textcolor hover:bg-darkbutton/40 cursor-pointer whitespace-nowrap min-w-[7.5rem] max-w-[20rem] {colIndex === 0 ? 'sticky left-12 z-30 bg-darkbg border-r border-darkborderc/60' : ''}"
                        title={`${column.name} (${column.dataType})`}
                        onclick={() => onToggleSort(column)}
                        oncontextmenu={(e) => onHeaderContextMenu(e, column)}
                    >
                        <div class="flex items-center justify-between gap-1.5 min-w-0">
                            <span class="truncate text-textcolor/90 font-medium">
                                {column.name}
                            </span>
                            <div class="flex items-center gap-1 shrink-0 text-textcolor2">
                                <span class="text-[9px] font-normal opacity-50 px-1 py-0.2 rounded bg-bgcolor/60">
                                    {column.dataType}
                                </span>
                                {#if sortColumn === column.name}
                                    {#if sortOrder === 'asc'}
                                        <ArrowUpIcon size={12} class="text-blue-400" />
                                    {:else}
                                        <ArrowDownIcon size={12} class="text-blue-400" />
                                    {/if}
                                {/if}
                            </div>
                        </div>
                    </th>
                {/each}
            </tr>
        </thead>

        <!-- Table Body -->
        <tbody class="divide-y divide-darkborderc/30">
            {#each tableData.rows as row, index (tableData.offset + index)}
                {@const isSelected = detailRow === row}
                <tr
                    class="group transition-colors hover:bg-darkbutton/40 cursor-pointer {isSelected ? 'bg-selected/10 hover:bg-selected/15' : ''}"
                    onclick={() => onSelectRow(row)}
                >
                    <!-- Row Index -->
                    <td class="sticky left-0 z-10 w-12 min-w-12 max-w-12 bg-darkbg/95 group-hover:bg-darkbutton px-2 py-1.5 text-center text-[10px] text-textcolor2/60 border-r border-darkborderc/50 font-sans {isSelected ? '!bg-selected/20 text-textcolor font-medium' : ''}">
                        {tableData.offset + index + 1}
                    </td>

                    <!-- Columns -->
                    {#each tableData.columns as column, colIndex (column.name)}
                        {@const value = row[column.name]}
                        <td
                            class="px-3 py-1.5 truncate whitespace-nowrap min-w-[7.5rem] max-w-[20rem] text-xs transition-colors {colIndex === 0 ? `sticky left-12 z-10 bg-darkbg/95 group-hover:bg-darkbutton border-r border-darkborderc/50 ${isSelected ? '!bg-selected/20' : ''}` : ''}"
                            title={getCellRawText(value)}
                            oncontextmenu={(e) => onCellContextMenu(e, column, row, value)}
                        >
                            {#if value === null || value === undefined}
                                <span class="italic text-[10px] text-textcolor2/40 select-none">NULL</span>
                            {:else if typeof value === 'boolean'}
                                <span class="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-semibold {value ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'}">
                                    {value ? 'true' : 'false'}
                                </span>
                            {:else if Array.isArray(value)}
                                <span class="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] bg-violet-500/15 text-violet-300 border border-violet-500/30 font-medium">
                                    <BracesIcon size={10} />
                                    <span>Array({value.length})</span>
                                </span>
                            {:else if typeof value === 'object'}
                                <span class="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] bg-sky-500/15 text-sky-300 border border-sky-500/30 font-medium">
                                    <FileCode2Icon size={10} />
                                    <span>{'{'} {Object.keys(value as object).length} keys {'}'}</span>
                                </span>
                            {:else if typeof value === 'number'}
                                <span class="text-amber-300/90 font-medium">
                                    {value.toLocaleString()}
                                </span>
                            {:else if typeof value === 'string' && isUUID(value)}
                                <span class="text-cyan-300/80 font-mono text-[11px]" title={value}>
                                    {value.slice(0, 8)}...{value.slice(-4)}
                                </span>
                            {:else if typeof value === 'string' && isDateString(value)}
                                <span class="text-emerald-300/90 text-[11px]">
                                    {value}
                                </span>
                            {:else}
                                <span class="text-textcolor/90">
                                    {String(value)}
                                </span>
                            {/if}
                        </td>
                    {/each}
                </tr>
            {:else}
                <tr>
                    <td
                        class="px-4 py-16 text-center text-xs text-textcolor2"
                        colspan={tableData.columns.length + 1}
                    >
                        {language.postgresDbExplorerEmptyTable}
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
</div>
