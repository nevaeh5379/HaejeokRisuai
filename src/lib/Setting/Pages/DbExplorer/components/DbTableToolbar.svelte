<script lang="ts">
    import {
        ChevronLeftIcon,
        Columns3Icon,
        LayoutGridIcon,
        PanelLeftOpenIcon,
        RefreshCwIcon,
        SearchIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type { NodePostgresColumnInfo } from 'src/ts/storage/nodePostgresStorage'
    import type { TableDisplayMode } from '../types'

    interface Props {
        tableName: string
        totalRows: number
        activeSearch: string
        searchInput: string
        allColumns: NodePostgresColumnInfo[]
        visibleNames: string[]
        columnsOpen: boolean
        columnFilter: string
        filteredAllColumns: NodePostgresColumnInfo[]
        displayMode: TableDisplayMode
        isMobile: boolean
        sidebarCollapsed?: boolean
        busy?: boolean
        onSearchInput: () => void
        onClearSearch: () => void
        onToggleColumnsOpen: () => void
        onColumnFilterChange: (val: string) => void
        onToggleColumn: (colName: string) => void
        onShowAllColumns: () => void
        onDeselectAllColumns: () => void
        onToggleDisplayMode: (mode: TableDisplayMode) => void
        onToggleSidebar?: () => void
        onRefresh: () => void
        onBackToTables?: () => void
    }

    let {
        tableName,
        totalRows,
        activeSearch,
        searchInput = $bindable(),
        allColumns,
        visibleNames,
        columnsOpen,
        columnFilter = $bindable(),
        filteredAllColumns,
        displayMode,
        isMobile,
        sidebarCollapsed = false,
        busy = false,
        onSearchInput,
        onClearSearch,
        onToggleColumnsOpen,
        onColumnFilterChange,
        onToggleColumn,
        onShowAllColumns,
        onDeselectAllColumns,
        onToggleDisplayMode,
        onToggleSidebar,
        onRefresh,
        onBackToTables
    }: Props = $props()

    const dotIdx = $derived(tableName.indexOf('.'))
    const schema = $derived(dotIdx !== -1 ? tableName.slice(0, dotIdx) : 'public')
    const shortName = $derived(dotIdx !== -1 ? tableName.slice(dotIdx + 1) : tableName)

    let mobileSearchExpanded = $state(false)
</script>

<div class="flex flex-wrap items-center justify-between gap-2 border-b border-darkborderc bg-darkbg/90 px-3 py-2 shrink-0 select-none">
    <!-- Left Section: Back button, Sidebar toggle, Table name, Row count -->
    <div class="flex items-center gap-1.5 min-w-0">
        {#if isMobile && onBackToTables}
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors shrink-0"
                onclick={onBackToTables}
                title={language.postgresDbExplorerBackToTables}
            >
                <ChevronLeftIcon size={18} />
            </button>
        {/if}

        {#if !isMobile && sidebarCollapsed && onToggleSidebar}
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors shrink-0"
                onclick={onToggleSidebar}
                title="Show sidebar"
            >
                <PanelLeftOpenIcon size={16} />
            </button>
        {/if}

        <div class="flex items-center gap-1.5 min-w-0">
            <span class="rounded bg-darkbutton px-1.5 py-0.5 font-mono text-[10px] font-semibold text-textcolor2 shrink-0">
                {schema}
            </span>
            <span class="font-mono text-xs sm:text-sm font-bold text-textcolor truncate" title={tableName}>
                {shortName}
            </span>
            <span class="rounded-full bg-bgcolor/80 px-2 py-0.5 font-mono text-[10px] sm:text-[11px] text-textcolor2 shrink-0">
                {totalRows.toLocaleString()} {language.postgresDbExplorerRows}
                {#if activeSearch}
                    <span class="text-blue-400 font-sans ml-0.5">({language.postgresDbExplorerSearchRowsResult})</span>
                {/if}
            </span>
        </div>
    </div>

    <!-- Right Section: Tools (Search, Columns, View switcher, Refresh) -->
    <div class="flex items-center gap-1.5 shrink-0">
        <!-- Desktop Search Box / Mobile Expanded Search -->
        <div class="relative {isMobile && !mobileSearchExpanded ? 'hidden' : 'flex'} w-40 sm:w-48 md:w-56 items-center">
            <div class="pointer-events-none absolute left-2 text-textcolor2">
                <SearchIcon size={13} />
            </div>
            <TextInput
                bind:value={searchInput}
                size="sm"
                fullwidth={true}
                oninput={onSearchInput}
                placeholder={language.postgresDbExplorerSearchRows}
                className="pl-7 pr-6 py-1 text-xs bg-darkbg/90 border-darkborderc/80 rounded-lg focus:border-selected"
            />
            {#if searchInput}
                <button
                    type="button"
                    class="absolute right-1.5 cursor-pointer text-textcolor2 hover:text-textcolor p-0.5 rounded"
                    title={language.postgresDbExplorerClearSearch}
                    onclick={onClearSearch}
                >
                    <XIcon size={13} />
                </button>
            {/if}
        </div>

        {#if isMobile}
            <!-- Mobile Search Icon Toggle -->
            <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors {mobileSearchExpanded ? 'bg-darkbutton text-textcolor' : ''}"
                onclick={() => mobileSearchExpanded = !mobileSearchExpanded}
                title="Toggle search"
            >
                <SearchIcon size={14} />
            </button>

            <!-- Mobile View Switcher (Card / Table) -->
            <div class="flex items-center rounded-lg border border-darkborderc/80 bg-bgcolor/40 p-0.5 shrink-0">
                <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center rounded transition-colors {displayMode === 'card' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => onToggleDisplayMode('card')}
                    title={language.postgresDbExplorerCardView}
                >
                    <LayoutGridIcon size={13} />
                </button>
                <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center rounded transition-colors {displayMode === 'table' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                    onclick={() => onToggleDisplayMode('table')}
                    title={language.postgresDbExplorerTableView}
                >
                    <TableIcon size={13} />
                </button>
            </div>
        {/if}

        <!-- Column Visibility Dropdown -->
        <div class="relative shrink-0">
            <Button
                size="sm"
                className="flex items-center gap-1 px-2 py-1 text-xs whitespace-nowrap"
                onclick={onToggleColumnsOpen}
            >
                <Columns3Icon size={13} />
                <span class="hidden sm:inline">{language.postgresDbExplorerColumns}</span>
                {#if allColumns.length > 0}
                    <span class="rounded bg-darkbutton/90 px-1 py-0.2 text-[10px] font-mono leading-none">
                        {visibleNames.length}/{allColumns.length}
                    </span>
                {/if}
            </Button>

            {#if columnsOpen}
                <!-- Backdrop -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="fixed inset-0 z-30" onclick={onToggleColumnsOpen}></div>

                <!-- Dropdown Menu -->
                <div class="absolute right-0 top-full z-40 mt-1 max-h-80 w-64 overflow-hidden rounded-xl border border-darkborderc bg-darkbg p-2 shadow-2xl animate-in zoom-in-95 duration-100">
                    <div class="relative mb-2">
                        <TextInput
                            bind:value={columnFilter}
                            size="sm"
                            fullwidth={true}
                            oninput={(e) => onColumnFilterChange((e.currentTarget as HTMLInputElement).value)}
                            placeholder={language.postgresDbExplorerFilterColumns}
                            className="pr-6 text-xs bg-bgcolor/80"
                        />
                        {#if columnFilter}
                            <button
                                type="button"
                                class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-textcolor"
                                onclick={() => onColumnFilterChange('')}
                            >
                                <XIcon size={12} />
                            </button>
                        {/if}
                    </div>

                    <div class="mb-2 flex items-center gap-1.5">
                        <button
                            type="button"
                            class="flex-1 cursor-pointer rounded-lg bg-darkbutton/60 px-2 py-1 text-center text-xs text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor"
                            onclick={onShowAllColumns}
                        >
                            {language.postgresDbExplorerSelectAll}
                        </button>
                        <button
                            type="button"
                            class="flex-1 cursor-pointer rounded-lg bg-darkbutton/60 px-2 py-1 text-center text-xs text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor disabled:opacity-40"
                            disabled={visibleNames.length <= 1}
                            onclick={onDeselectAllColumns}
                        >
                            {language.postgresDbExplorerDeselectAll}
                        </button>
                    </div>

                    <div class="max-h-48 overflow-y-auto border-t border-darkborderc/60 pt-1 space-y-0.5 scrollbar-thin">
                        {#each filteredAllColumns as column (column.name)}
                            <label class="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-darkbutton">
                                <div class="flex items-center gap-2 min-w-0">
                                    <input
                                        type="checkbox"
                                        checked={visibleNames.includes(column.name)}
                                        onchange={() => onToggleColumn(column.name)}
                                        class="rounded accent-selected"
                                    />
                                    <span class="truncate font-mono" title={column.name}>{column.name}</span>
                                </div>
                                <span class="shrink-0 font-mono text-[10px] opacity-50" title={column.dataType}>{column.dataType}</span>
                            </label>
                        {:else}
                            <p class="p-2 text-center text-xs text-textcolor2">{language.postgresDbExplorerNoTables}</p>
                        {/each}
                    </div>
                </div>
            {/if}
        </div>

        <!-- Refresh Button -->
        <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors"
            onclick={onRefresh}
            disabled={busy}
            title={language.postgresDbExplorerRefresh}
        >
            <RefreshCwIcon size={13} class={busy ? 'animate-spin' : ''} />
        </button>
    </div>
</div>
