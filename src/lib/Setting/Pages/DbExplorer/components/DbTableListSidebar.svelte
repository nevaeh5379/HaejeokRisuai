<script lang="ts">
    import {
        ChevronDownIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        FolderIcon,
        FolderOpenIcon,
        LayersIcon,
        PanelLeftCloseIcon,
        PanelLeftOpenIcon,
        SearchIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { ParsedTableInfo } from '../types'

    interface Props {
        tables: ParsedTableInfo[]
        availableSchemas: string[]
        schemaStats: Record<string, { count: number; rowCount: number }>
        selectedSchema: string
        selectedTable: string
        tableFilter: string
        collapsed?: boolean
        onSelectSchema: (schema: string) => void
        onSelectTable: (tableName: string) => void
        onFilterChange: (filter: string) => void
        onToggleCollapse?: () => void
        onTableContextMenu: (e: MouseEvent, tableName: string) => void
    }

    let {
        tables,
        availableSchemas,
        schemaStats,
        selectedSchema,
        selectedTable,
        tableFilter,
        collapsed = false,
        onSelectSchema,
        onSelectTable,
        onFilterChange,
        onToggleCollapse,
        onTableContextMenu
    }: Props = $props()

    let collapsedSchemas = $state<Record<string, boolean>>({})

    function toggleSchemaCollapse(schema: string) {
        collapsedSchemas[schema] = !collapsedSchemas[schema]
    }

    const filteredTables = $derived<ParsedTableInfo[]>(
        tables.filter((table) => {
            if (selectedSchema !== 'all' && table.schema !== selectedSchema) {
                return false
            }
            if (!tableFilter) {
                return true
            }
            const query = tableFilter.toLowerCase()
            return (
                table.name.toLowerCase().includes(query) ||
                table.shortName.toLowerCase().includes(query)
            )
        })
    )

    const groupedTables = $derived.by(() => {
        const groups: { schema: string; tables: ParsedTableInfo[] }[] = []
        const schemaMap = new Map<string, ParsedTableInfo[]>()
        for (const t of filteredTables) {
            const list = schemaMap.get(t.schema) || []
            list.push(t)
            schemaMap.set(t.schema, list)
        }
        const schemasToIterate =
            selectedSchema === 'all' ? availableSchemas : [selectedSchema]
        for (const s of schemasToIterate) {
            const tbls = schemaMap.get(s)
            if (tbls && tbls.length > 0) {
                groups.push({ schema: s, tables: tbls })
            }
        }
        return groups
    })

    const totalRowsCount = $derived(
        tables.reduce((acc, cur) => acc + (cur.rowCount || 0), 0)
    )
</script>

{#if collapsed}
    <!-- Collapsed Slim Sidebar (Desktop) -->
    <div class="hidden md:flex flex-col items-center border-r border-darkborderc bg-darkbg/80 py-2.5 px-1.5 shrink-0 select-none w-12 transition-all">
        <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors mb-3"
            onclick={onToggleCollapse}
            title="Expand sidebar"
        >
            <PanelLeftOpenIcon size={18} />
        </button>
        <div class="h-px w-6 bg-darkborderc/60 mb-2"></div>
        <div class="flex flex-col gap-1 items-center overflow-y-auto overflow-x-hidden flex-1 w-full scrollbar-none">
            {#each tables.slice(0, 15) as table (table.name)}
                <button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-md text-xs font-mono transition-colors {selectedTable === table.name ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectTable(table.name)}
                    oncontextmenu={(e) => onTableContextMenu(e, table.name)}
                    title={`${table.name} (${table.rowCount.toLocaleString()} rows)`}
                >
                    <TableIcon size={14} />
                </button>
            {/each}
            {#if tables.length > 15}
                <span class="text-[10px] text-textcolor2 opacity-60 font-mono mt-1">+{tables.length - 15}</span>
            {/if}
        </div>
    </div>
{:else}
    <!-- Expanded Standard Sidebar -->
    <div class="flex flex-col h-full border-r border-darkborderc bg-darkbg/60 select-none min-w-0 w-full md:w-64 lg:w-72 shrink-0">
        <!-- Sidebar Top Header -->
        <div class="flex items-center justify-between border-b border-darkborderc/80 px-3 py-2 shrink-0 bg-darkbg/90">
            <div class="flex items-center gap-2 min-w-0">
                <LayersIcon size={15} class="text-textcolor2 shrink-0" />
                <span class="text-xs font-bold text-textcolor uppercase tracking-wider truncate">
                    {language.postgresDbExplorerTables}
                </span>
                <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] font-mono text-textcolor2">
                    {tables.length}
                </span>
            </div>
            <div class="flex items-center gap-1">
                {#if onToggleCollapse}
                    <button
                        type="button"
                        class="hidden md:flex h-7 w-7 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors"
                        onclick={onToggleCollapse}
                        title="Collapse sidebar"
                    >
                        <PanelLeftCloseIcon size={16} />
                    </button>
                {/if}
            </div>
        </div>

        <!-- Schema Filter Chips -->
        {#if availableSchemas.length > 1}
            <div class="flex items-center gap-1 border-b border-darkborderc/60 px-2 py-1.5 overflow-x-auto scrollbar-none shrink-0 bg-bgcolor/30">
                <button
                    type="button"
                    class="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs whitespace-nowrap transition-colors {selectedSchema === 'all' ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                    onclick={() => onSelectSchema('all')}
                >
                    <span>{language.postgresDbExplorerAllSchemas ?? 'All'}</span>
                    <span class="text-[10px] opacity-70 font-mono">({tables.length})</span>
                </button>
                {#each availableSchemas as schema (schema)}
                    {@const stats = schemaStats[schema]}
                    <button
                        type="button"
                        class="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs whitespace-nowrap font-mono transition-colors {selectedSchema === schema ? 'bg-selected text-textcolor font-semibold shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                        onclick={() => onSelectSchema(schema)}
                    >
                        <span>{schema}</span>
                        <span class="text-[10px] opacity-70 font-sans">({stats?.count ?? 0})</span>
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Search Input -->
        <div class="border-b border-darkborderc/60 p-2 shrink-0 bg-darkbg/40">
            <div class="relative flex items-center">
                <div class="pointer-events-none absolute left-2 text-textcolor2">
                    <SearchIcon size={13} />
                </div>
                <TextInput
                    value={tableFilter}
                    size="sm"
                    fullwidth={true}
                    oninput={(e) => onFilterChange((e.currentTarget as HTMLInputElement).value)}
                    placeholder={language.postgresDbExplorerFilterTables}
                    className="pl-7 pr-6 py-1 text-xs bg-darkbg/90 border-darkborderc/80 rounded-lg focus:border-selected"
                />
                {#if tableFilter}
                    <button
                        type="button"
                        class="absolute right-1.5 cursor-pointer text-textcolor2 hover:text-textcolor p-0.5 rounded"
                        onclick={() => onFilterChange('')}
                        title="Clear filter"
                    >
                        <XIcon size={13} />
                    </button>
                {/if}
            </div>
        </div>

        <!-- Table List Items -->
        <div class="flex-1 overflow-y-auto p-1.5 space-y-1 min-h-0 divide-y divide-darkborderc/20 scrollbar-thin">
            {#if selectedSchema === 'all'}
                {#each groupedTables as group (group.schema)}
                    {@const isCollapsed = collapsedSchemas[group.schema]}
                    <div class="pt-1 first:pt-0">
                        <!-- Schema Group Header -->
                        <button
                            type="button"
                            class="flex w-full items-center justify-between gap-1.5 rounded-lg px-2 py-1 text-left text-xs font-semibold text-textcolor2 hover:bg-darkbutton/70 hover:text-textcolor transition-colors"
                            onclick={() => toggleSchemaCollapse(group.schema)}
                        >
                            <div class="flex items-center gap-1.5 min-w-0">
                                {#if isCollapsed}
                                    <ChevronRightIcon size={13} class="shrink-0 text-textcolor2" />
                                    <FolderIcon size={13} class="shrink-0 text-amber-400/80" />
                                {:else}
                                    <ChevronDownIcon size={13} class="shrink-0 text-textcolor2" />
                                    <FolderOpenIcon size={13} class="shrink-0 text-amber-400" />
                                {/if}
                                <span class="font-mono text-xs text-textcolor uppercase tracking-wider truncate">
                                    {group.schema}
                                </span>
                            </div>
                            <span class="shrink-0 rounded bg-darkbutton/90 px-1.5 py-0.2 font-mono text-[10px] text-textcolor2">
                                {group.tables.length}
                            </span>
                        </button>

                        {#if !isCollapsed}
                            <div class="mt-0.5 space-y-0.5 pl-2">
                                {#each group.tables as table (table.name)}
                                    <button
                                        type="button"
                                        class="group flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-all {selectedTable === table.name ? 'bg-selected text-textcolor font-medium shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/70 hover:text-textcolor'}"
                                        onclick={() => onSelectTable(table.name)}
                                        oncontextmenu={(e) => onTableContextMenu(e, table.name)}
                                    >
                                        <div class="flex items-center gap-1.5 min-w-0">
                                            <TableIcon size={13} class="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                                            <span class="truncate font-mono text-xs" title={table.name}>
                                                {table.shortName}
                                            </span>
                                        </div>
                                        <span class="shrink-0 rounded px-1.5 py-0.2 font-mono text-[10px] opacity-75 {selectedTable === table.name ? 'bg-black/20 text-textcolor' : 'bg-darkbutton/60 text-textcolor2'}">
                                            {table.rowCount.toLocaleString()}
                                        </span>
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {:else}
                    <div class="py-8 text-center text-xs text-textcolor2">
                        {language.postgresDbExplorerNoTables}
                    </div>
                {/each}
            {:else}
                <!-- Single Schema Flat View -->
                <div class="space-y-0.5">
                    {#each filteredTables as table (table.name)}
                        <button
                            type="button"
                            class="group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-all {selectedTable === table.name ? 'bg-selected text-textcolor font-medium shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/70 hover:text-textcolor'}"
                            onclick={() => onSelectTable(table.name)}
                            oncontextmenu={(e) => onTableContextMenu(e, table.name)}
                        >
                            <div class="flex items-center gap-1.5 min-w-0">
                                <TableIcon size={13} class="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                                <span class="truncate font-mono text-xs" title={table.name}>
                                    {table.shortName}
                                </span>
                            </div>
                            <span class="shrink-0 rounded px-1.5 py-0.2 font-mono text-[10px] opacity-75 {selectedTable === table.name ? 'bg-black/20 text-textcolor' : 'bg-darkbutton/60 text-textcolor2'}">
                                {table.rowCount.toLocaleString()}
                            </span>
                        </button>
                    {:else}
                        <div class="py-8 text-center text-xs text-textcolor2">
                            {language.postgresDbExplorerNoTables}
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Sidebar Footer Summary -->
        <div class="border-t border-darkborderc/60 px-3 py-1.5 text-[11px] font-mono text-textcolor2/80 bg-darkbg/80 flex items-center justify-between shrink-0">
            <span>{tables.length} tables</span>
            <span>{totalRowsCount.toLocaleString()} total rows</span>
        </div>
    </div>
{/if}
