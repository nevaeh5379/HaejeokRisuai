<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import {
        CheckIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        FolderIcon,
        LayersIcon,
        RefreshCwIcon,
        SearchIcon,
        TableIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import type {
        NodePostgresColumnInfo,
        NodePostgresTableData,
        NodePostgresTableInfo
    } from 'src/ts/storage/sql/postgres/nodePostgresStorage'
    import DbTableListSidebar from '../components/DbTableListSidebar.svelte'
    import DbTableToolbar from '../components/DbTableToolbar.svelte'
    import DbDataTable from '../components/DbDataTable.svelte'
    import DbDataCardView from '../components/DbDataCardView.svelte'
    import DbRowDetailDrawer from '../components/DbRowDetailDrawer.svelte'
    import DbTableContextMenu from '../components/DbTableContextMenu.svelte'
    import type {
        ParsedTableInfo,
        TableContextMenuData,
        TableDisplayMode,
        TableMobileView
    } from '../types'

    interface Props {
        tables: NodePostgresTableInfo[]
        configEnabled: boolean | null
        onRefreshAll: () => Promise<void>
        onGoToConfig?: () => void
        loadTableData: (
            table: string,
            options: {
                offset?: number
                limit?: number
                sortColumn?: string
                sortOrder?: 'asc' | 'desc'
                search?: string
                columns?: string[]
            }
        ) => Promise<NodePostgresTableData>
    }

    let {
        tables,
        configEnabled,
        onRefreshAll,
        onGoToConfig,
        loadTableData
    }: Props = $props()

    let tableFilter = $state('')
    let selectedSchema = $state<string>('all')
    let selectedTable = $state('')
    let tableData = $state<NodePostgresTableData | null>(null)
    let sortColumn = $state('')
    let sortOrder = $state<'asc' | 'desc'>('asc')
    let page = $state(0)
    let pageSize = $state(50)
    let busy = $state(false)
    let error = $state('')

    let searchInput = $state('')
    let activeSearch = $state('')
    let searchTimer: ReturnType<typeof setTimeout> | null = null
    let visibleColumns = $state<string[] | null>(null)
    let columnsOpen = $state(false)
    let columnFilter = $state('')
    let detailRow = $state<Record<string, unknown> | null>(null)
    let copiedJson = $state(false)

    // Layout & Navigation State
    let mobileView = $state<TableMobileView>('tables')
    let displayMode = $state<TableDisplayMode>('table')
    let isMobile = $state(false)
    let sidebarCollapsed = $state(false)

    let contextMenu = $state<TableContextMenuData>({
        open: false,
        x: 0,
        y: 0,
        type: 'cell'
    })
    let toastMessage = $state('')
    let toastTimer: ReturnType<typeof setTimeout> | null = null

    const SCHEMA_ORDER = ['system', 'character', 'chat', 'cold']

    const parsedTables = $derived<ParsedTableInfo[]>(
        tables.map((table) => {
            const dotIndex = table.name.indexOf('.')
            if (dotIndex !== -1) {
                return {
                    ...table,
                    schema: table.name.slice(0, dotIndex),
                    shortName: table.name.slice(dotIndex + 1)
                }
            }
            return {
                ...table,
                schema: 'public',
                shortName: table.name
            }
        })
    )

    const availableSchemas = $derived.by(() => {
        const set = new Set(parsedTables.map((t) => t.schema))
        const ordered: string[] = []
        for (const s of SCHEMA_ORDER) {
            if (set.has(s)) {
                ordered.push(s)
                set.delete(s)
            }
        }
        const remaining = Array.from(set).sort()
        return [...ordered, ...remaining]
    })

    const schemaStats = $derived.by(() => {
        const stats: Record<string, { count: number; rowCount: number }> = {}
        for (const t of parsedTables) {
            if (!stats[t.schema]) {
                stats[t.schema] = { count: 0, rowCount: 0 }
            }
            stats[t.schema].count++
            stats[t.schema].rowCount += t.rowCount
        }
        return stats
    })

    const allColumns = $derived<NodePostgresColumnInfo[]>(
        tableData ? tableData.allColumns ?? tableData.columns : []
    )

    const filteredAllColumns = $derived<NodePostgresColumnInfo[]>(
        allColumns.filter(
            (col) =>
                col.name.toLowerCase().includes(columnFilter.toLowerCase()) ||
                col.dataType.toLowerCase().includes(columnFilter.toLowerCase())
        )
    )

    const visibleNames = $derived(
        tableData
            ? visibleColumns ?? tableData.columns.map((column) => column.name)
            : []
    )

    const maxPage = $derived(
        tableData ? Math.max(0, Math.ceil(tableData.total / pageSize) - 1) : 0
    )

    const rangeStart = $derived(
        tableData && tableData.total > 0 ? page * pageSize + 1 : 0
    )

    const rangeEnd = $derived(
        tableData ? Math.min((page + 1) * pageSize, tableData.total) : 0
    )

    function updateIsMobile() {
        if (typeof window !== 'undefined') {
            const mobile = window.innerWidth < 768
            isMobile = mobile
            if (mobile && displayMode !== 'card') {
                displayMode = 'card'
            }
        }
    }

    function showToast(msg: string) {
        if (toastTimer) {
            clearTimeout(toastTimer)
        }
        toastMessage = msg
        toastTimer = setTimeout(() => {
            toastMessage = ''
            toastTimer = null
        }, 1500)
    }

    async function selectTable(name: string) {
        if (busy) return
        selectedTable = name
        tableData = null
        sortColumn = ''
        sortOrder = 'asc'
        page = 0
        visibleColumns = null
        columnFilter = ''
        mobileView = 'data'
        clearSearchInput()
        closeContextMenu()
        await loadRows()
    }

    async function loadRows() {
        if (busy || !selectedTable) return
        busy = true
        error = ''
        columnsOpen = false
        closeContextMenu()
        try {
            tableData = await loadTableData(
                selectedTable,
                {
                    offset: page * pageSize,
                    limit: pageSize,
                    sortColumn: sortColumn || undefined,
                    sortOrder,
                    search: activeSearch || undefined,
                    columns: visibleColumns ?? undefined
                }
            )
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    function toggleSort(column: NodePostgresColumnInfo) {
        if (busy) return
        if (sortColumn === column.name) {
            sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'
        } else {
            sortColumn = column.name
            sortOrder = 'asc'
        }
        page = 0
        loadRows()
    }

    function changePage(nextPage: number) {
        if (busy || nextPage < 0 || nextPage > maxPage) return
        page = nextPage
        loadRows()
    }

    function changePageSize(event: Event) {
        pageSize = Number((event.currentTarget as HTMLSelectElement).value)
        page = 0
        loadRows()
    }

    function onSearchInput() {
        if (searchTimer) {
            clearTimeout(searchTimer)
        }
        searchTimer = setTimeout(() => {
            const next = searchInput.trim()
            if (next === activeSearch) return
            activeSearch = next
            page = 0
            loadRows()
        }, 300)
    }

    function clearSearchInput() {
        if (searchTimer) {
            clearTimeout(searchTimer)
            searchTimer = null
        }
        searchInput = ''
        if (activeSearch === '') return
        activeSearch = ''
        page = 0
        loadRows()
    }

    function toggleColumn(name: string) {
        if (busy || !tableData) return
        let next: string[]
        if (visibleNames.includes(name)) {
            next = visibleNames.filter((column) => column !== name)
            if (next.length === 0) return
        } else {
            next = allColumns
                .map((column) => column.name)
                .filter(
                    (column) => column === name || visibleNames.includes(column)
                )
        }
        visibleColumns = next.length === allColumns.length ? null : next
        loadRows()
    }

    function showAllColumns() {
        if (busy || !tableData || visibleColumns === null) return
        visibleColumns = null
        loadRows()
    }

    function deselectAllColumns() {
        if (busy || !tableData || allColumns.length === 0) return
        visibleColumns = [allColumns[0].name]
        loadRows()
    }

    function hideColumn(name: string) {
        if (busy || !tableData || visibleNames.length <= 1) return
        visibleColumns = visibleNames.filter((column) => column !== name)
        closeContextMenu()
        loadRows()
    }

    function showOnlyColumn(name: string) {
        if (busy || !tableData) return
        visibleColumns = [name]
        closeContextMenu()
        loadRows()
    }

    function sortByColumn(name: string, order: 'asc' | 'desc') {
        if (busy) return
        sortColumn = name
        sortOrder = order
        page = 0
        closeContextMenu()
        loadRows()
    }

    function searchThisValue(value: unknown) {
        if (value === null || value === undefined) {
            searchInput = ''
        } else if (typeof value === 'object') {
            searchInput = JSON.stringify(value)
        } else {
            searchInput = String(value)
        }
        activeSearch = searchInput.trim()
        page = 0
        closeContextMenu()
        loadRows()
    }

    function toggleDetail(row: Record<string, unknown>) {
        detailRow = detailRow === row ? null : row
    }

    async function copyToClipboard(
        text: string,
        notice = language.postgresDbExplorerCopied
    ) {
        try {
            await navigator.clipboard.writeText(text)
            showToast(notice)
        } catch (err) {
            error = `${err}`
        }
        closeContextMenu()
    }

    async function copyDetailJson() {
        if (!detailRow) return
        try {
            await navigator.clipboard.writeText(
                JSON.stringify(detailRow, null, 2)
            )
            copiedJson = true
            showToast(language.postgresDbExplorerCopied)
            setTimeout(() => {
                copiedJson = false
            }, 1500)
        } catch (err) {
            error = `${err}`
        }
    }

    function openCellContextMenu(
        e: MouseEvent,
        column: NodePostgresColumnInfo,
        row: Record<string, unknown>,
        value: unknown
    ) {
        e.preventDefault()
        e.stopPropagation()
        const menuWidth = 200
        const menuHeight = 240
        const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12)
        const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12)
        contextMenu = {
            open: true,
            x: Math.max(12, x),
            y: Math.max(12, y),
            type: 'cell',
            columnName: column.name,
            columnInfo: column,
            cellValue: value,
            row
        }
    }

    function openHeaderContextMenu(
        e: MouseEvent,
        column: NodePostgresColumnInfo
    ) {
        e.preventDefault()
        e.stopPropagation()
        const menuWidth = 200
        const menuHeight = 220
        const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12)
        const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12)
        contextMenu = {
            open: true,
            x: Math.max(12, x),
            y: Math.max(12, y),
            type: 'header',
            columnName: column.name,
            columnInfo: column
        }
    }

    function openTableContextMenu(e: MouseEvent, tableName: string) {
        e.preventDefault()
        e.stopPropagation()
        const menuWidth = 190
        const menuHeight = 110
        const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12)
        const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12)
        contextMenu = {
            open: true,
            x: Math.max(12, x),
            y: Math.max(12, y),
            type: 'table',
            tableName
        }
    }

    function closeContextMenu() {
        if (contextMenu.open) {
            contextMenu.open = false
        }
    }

    $effect(() => {
        if (tables.length > 0 && !selectedTable) {
            selectTable(tables[0].name)
        }
    })

    onMount(() => {
        updateIsMobile()
    })
</script>

<svelte:window
    onresize={updateIsMobile}
    onkeydown={(e) => {
        if (e.key === 'Escape') {
            if (contextMenu.open) {
                closeContextMenu()
            } else if (detailRow) {
                detailRow = null
            }
        }
    }}
/>

<div class="flex h-full w-full flex-col min-h-0 overflow-hidden bg-bgcolor">
    {#if error}
        <div class="m-2.5 rounded-lg border border-draculared/50 bg-draculared/10 p-2.5 text-xs text-draculared flex items-center justify-between shrink-0">
            <span>{error}</span>
            <button type="button" class="p-1 text-draculared hover:opacity-80" onclick={() => error = ''}>
                <XIcon size={14} />
            </button>
        </div>
    {/if}

    <!-- Zero-Waste Edge-to-Edge Container -->
    <div class="flex flex-1 min-h-0 w-full overflow-hidden">
        <!-- Left: Table List Sidebar -->
        <div class="{isMobile ? (mobileView === 'tables' ? 'flex w-full h-full' : 'hidden') : 'flex h-full'}">
            <DbTableListSidebar
                tables={parsedTables}
                {availableSchemas}
                {schemaStats}
                {selectedSchema}
                {selectedTable}
                {tableFilter}
                collapsed={sidebarCollapsed}
                onSelectSchema={(s) => selectedSchema = s}
                onSelectTable={selectTable}
                onFilterChange={(f) => tableFilter = f}
                onToggleCollapse={() => sidebarCollapsed = !sidebarCollapsed}
                onTableContextMenu={openTableContextMenu}
            />
        </div>

        <!-- Right: Table Data & Detail Section -->
        <div class="flex flex-1 flex-col min-h-0 min-w-0 h-full overflow-hidden {isMobile ? (mobileView === 'data' ? 'flex w-full h-full' : 'hidden') : 'flex'}">
            {#if selectedTable}
                <!-- Top Slim Toolbar -->
                <DbTableToolbar
                    tableName={selectedTable}
                    totalRows={tableData?.total ?? 0}
                    {activeSearch}
                    bind:searchInput
                    {allColumns}
                    {visibleNames}
                    {columnsOpen}
                    bind:columnFilter
                    {filteredAllColumns}
                    {displayMode}
                    {isMobile}
                    {sidebarCollapsed}
                    {busy}
                    onSearchInput={onSearchInput}
                    onClearSearch={clearSearchInput}
                    onToggleColumnsOpen={() => columnsOpen = !columnsOpen}
                    onColumnFilterChange={(v) => columnFilter = v}
                    onToggleColumn={toggleColumn}
                    onShowAllColumns={showAllColumns}
                    onDeselectAllColumns={deselectAllColumns}
                    onToggleDisplayMode={(m) => displayMode = m}
                    onToggleSidebar={() => sidebarCollapsed = !sidebarCollapsed}
                    onRefresh={loadRows}
                    onBackToTables={() => mobileView = 'tables'}
                />

                <!-- Data & Detail Split View Container -->
                <div class="flex flex-1 min-h-0 w-full overflow-hidden relative">
                    <!-- Main Grid: Card View (Mobile) or Table View -->
                    <div class="flex flex-1 flex-col min-h-0 min-w-0 h-full overflow-hidden">
                        {#if busy && !tableData}
                            <div class="flex flex-1 items-center justify-center text-xs text-textcolor2">
                                <RefreshCwIcon size={18} class="animate-spin mr-2 text-blue-400" />
                                <span>{language.postgresDbExplorerLoading}</span>
                            </div>
                        {:else if tableData}
                            {#if displayMode === 'card'}
                                <DbDataCardView
                                    {tableData}
                                    {detailRow}
                                    onSelectRow={toggleDetail}
                                    onCellContextMenu={openCellContextMenu}
                                />
                            {:else}
                                <DbDataTable
                                    {tableData}
                                    {sortColumn}
                                    {sortOrder}
                                    {detailRow}
                                    onToggleSort={toggleSort}
                                    onSelectRow={toggleDetail}
                                    onCellContextMenu={openCellContextMenu}
                                    onHeaderContextMenu={openHeaderContextMenu}
                                    onCopyValue={(v) => copyToClipboard(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))}
                                />
                            {/if}
                        {:else}
                            <div class="flex flex-1 items-center justify-center text-xs text-textcolor2">
                                {language.postgresDbExplorerSelectTable}
                            </div>
                        {/if}

                        <!-- Slim Pagination Footer -->
                        {#if tableData}
                            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-darkborderc bg-darkbg/90 px-3 py-1.5 shrink-0 select-none text-xs">
                                <span class="text-[11px] text-textcolor2 font-mono">
                                    {rangeStart}–{rangeEnd} / {tableData.total.toLocaleString()}
                                </span>
                                <div class="flex items-center gap-1.5">
                                    <SelectInput
                                        value={pageSize}
                                        size="sm"
                                        className="text-xs py-0.5 px-1 bg-darkbg/80"
                                        onchange={changePageSize}
                                    >
                                        <option value={25}>25</option>
                                        <option value={50}>50</option>
                                        <option value={100}>100</option>
                                    </SelectInput>
                                    <button
                                        type="button"
                                        class="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        disabled={busy || page === 0}
                                        onclick={() => changePage(page - 1)}
                                    >
                                        <ChevronLeftIcon size={14} />
                                        <span class="hidden sm:inline">{language.postgresDbExplorerPrevious}</span>
                                    </button>
                                    <button
                                        type="button"
                                        class="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        disabled={busy || page >= maxPage}
                                        onclick={() => changePage(page + 1)}
                                    >
                                        <span class="hidden sm:inline">{language.postgresDbExplorerNext}</span>
                                        <ChevronRightIcon size={14} />
                                    </button>
                                </div>
                            </div>
                        {/if}
                    </div>

                    <!-- Row Detail Drawer (Desktop Slide Panel / Mobile Bottom Sheet) -->
                    <DbRowDetailDrawer
                        tableName={selectedTable}
                        columns={tableData?.columns ?? []}
                        {detailRow}
                        {isMobile}
                        onClose={() => detailRow = null}
                        onCopyJson={copyDetailJson}
                        onCopyValue={(v) => copyToClipboard(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))}
                        onSearchThisValue={searchThisValue}
                        copiedJson={copiedJson}
                    />
                </div>
            {:else}
                <div class="flex flex-1 items-center justify-center p-6 text-xs sm:text-sm text-textcolor2">
                    {language.postgresDbExplorerSelectTable}
                </div>
            {/if}
        </div>
    </div>
</div>

<!-- Context Menu Popup / Action Sheet -->
<DbTableContextMenu
    {contextMenu}
    {isMobile}
    {visibleNames}
    hasHiddenColumns={visibleColumns !== null}
    onClose={closeContextMenu}
    onCopyValue={(v) => copyToClipboard(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v))}
    onCopyRowJson={(row) => copyToClipboard(JSON.stringify(row, null, 2))}
    onViewDetail={(row) => {
        toggleDetail(row)
        closeContextMenu()
    }}
    onSearchValue={searchThisValue}
    onHideColumn={hideColumn}
    onShowOnlyColumn={showOnlyColumn}
    onShowAllColumns={() => {
        showAllColumns()
        closeContextMenu()
    }}
    onSortColumn={sortByColumn}
    onCopyColumnName={(col) => copyToClipboard(col)}
    onCopyTableName={(tbl) => copyToClipboard(tbl)}
    onRefreshTable={() => {
        loadRows()
        closeContextMenu()
    }}
/>

<!-- Toast Notification -->
{#if toastMessage}
    <div class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-darkborderc bg-darkbg px-3.5 py-2.5 text-xs text-textcolor shadow-2xl animate-in fade-in duration-150">
        <CheckIcon size={14} class="text-emerald-400" />
        <span>{toastMessage}</span>
    </div>
{/if}
