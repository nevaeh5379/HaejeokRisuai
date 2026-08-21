<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import {
        ArrowDownIcon,
        ArrowUpIcon,
        CheckIcon,
        ChevronDownIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        Columns3Icon,
        CopyIcon,
        EyeIcon,
        EyeOffIcon,
        FileTextIcon,
        FolderIcon,
        FolderOpenIcon,
        LayoutGridIcon,
        RefreshCwIcon,
        SearchIcon,
        SettingsIcon,
        TableIcon,
        XIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import { DBState } from 'src/ts/stores.svelte'
    import { getMimeType } from 'src/ts/media'
    import DbExplorerTabNav from './DbExplorer/DbExplorerTabNav.svelte'
    import DbConfigTab from './DbExplorer/tabs/DbConfigTab.svelte'
    import DbStatsTab from './DbExplorer/tabs/DbStatsTab.svelte'
    import DbHistoryTab from './DbExplorer/tabs/DbHistoryTab.svelte'
    import type {
        BotChatStats,
        DbExplorerTabType,
        DbOverallStats
    } from './DbExplorer/types'
    import type {
        NodePostgresColumnInfo,
        NodePostgresRevision,
        NodePostgresTableData,
        NodePostgresTableInfo,
        NodePostgresTokenUsage,
    } from 'src/ts/storage/nodePostgresStorage'

    interface Props {
        close?: () => void
    }

    interface ContextMenuData {
        open: boolean
        x: number
        y: number
        type: 'cell' | 'header' | 'table'
        columnName?: string
        columnInfo?: NodePostgresColumnInfo
        cellValue?: unknown
        row?: Record<string, unknown>
        tableName?: string
    }

    interface ParsedTableInfo extends NodePostgresTableInfo {
        schema: string
        shortName: string
    }

    let { close = () => {} }: Props = $props()

    let currentTab = $state<DbExplorerTabType>('tables')

    let configEnabled = $state<boolean | null>(null)
    let tables = $state<NodePostgresTableInfo[]>([])
    let revisions = $state<NodePostgresRevision[]>([])
    let tokenUsage = $state<NodePostgresTokenUsage[]>([])

    let tableFilter = $state('')
    let selectedSchema = $state<string>('all')
    let collapsedSchemas = $state<Record<string, boolean>>({})
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
    let copied = $state(false)

    // Mobile specific navigation & display mode
    let mobileView = $state<'tables' | 'data'>('tables')
    let mobileDisplayMode = $state<'card' | 'table'>('card')
    let isMobile = $state(false)

    let contextMenu = $state<ContextMenuData>({
        open: false,
        x: 0,
        y: 0,
        type: 'cell'
    })
    let toastMessage = $state('')
    let toastTimer: ReturnType<typeof setTimeout> | null = null

    // Thumbnail cache for Bot avatars in Stats tab
    let thumbnailUrls = $state<Map<string, string>>(new Map())

    const SCHEMA_ORDER = ['system', 'character', 'chat', 'cold']

    const parsedTables = $derived<ParsedTableInfo[]>(
        tables.map((table) => {
            const dotIndex = table.name.indexOf('.')
            if (dotIndex !== -1) {
                return {
                    ...table,
                    schema: table.name.slice(0, dotIndex),
                    shortName: table.name.slice(dotIndex + 1),
                }
            }
            return {
                ...table,
                schema: 'public',
                shortName: table.name,
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

    const filteredTables = $derived<ParsedTableInfo[]>(
        parsedTables.filter((table) => {
            if (selectedSchema !== 'all' && table.schema !== selectedSchema) {
                return false
            }
            if (!tableFilter) {
                return true
            }
            const query = tableFilter.toLowerCase()
            return table.name.toLowerCase().includes(query) || table.shortName.toLowerCase().includes(query)
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
        const schemasToIterate = selectedSchema === 'all' ? availableSchemas : [selectedSchema]
        for (const s of schemasToIterate) {
            const tbls = schemaMap.get(s)
            if (tbls && tbls.length > 0) {
                groups.push({ schema: s, tables: tbls })
            }
        }
        return groups
    })

    function toggleSchemaCollapse(schema: string) {
        collapsedSchemas[schema] = !collapsedSchemas[schema]
    }
    const allColumns = $derived<NodePostgresColumnInfo[]>(
        tableData ? (tableData.allColumns ?? tableData.columns) : []
    )
    const filteredAllColumns = $derived<NodePostgresColumnInfo[]>(
        allColumns.filter(
            (col) =>
                col.name.toLowerCase().includes(columnFilter.toLowerCase()) ||
                col.dataType.toLowerCase().includes(columnFilter.toLowerCase())
        )
    )
    const visibleNames = $derived(
        tableData ? (visibleColumns ?? tableData.columns.map((column) => column.name)) : []
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

    // ── 봇별 및 전체 통계 계산 ──
    const botStats = $derived.by<BotChatStats[]>(() => {
        const chars = DBState.db.characters || []
        return chars.map((char: any) => {
            const isGroup = char.type === 'group'
            const chats = Array.isArray(char.chats) ? char.chats : []
            let totalMessages = 0
            let userMessages = 0
            let botMessages = 0
            let longestSessionMessages = 0

            for (const chat of chats) {
                const msgs = Array.isArray(chat.message) ? chat.message : []
                const msgCount = msgs.length
                totalMessages += msgCount
                if (msgCount > longestSessionMessages) {
                    longestSessionMessages = msgCount
                }
                for (const m of msgs) {
                    if (m?.role === 'user' || m?.saying === 'user') {
                        userMessages++
                    } else {
                        botMessages++
                    }
                }
            }

            return {
                id: char.chaId || char.name,
                name: char.name || (isGroup ? 'Group' : 'Character'),
                avatarKey: char.image,
                image: char.image,
                isGroup,
                totalSessions: chats.length,
                totalMessages,
                userMessages,
                botMessages,
                longestSessionMessages,
                lastActiveDate: null
            }
        })
    })

    const overallStats = $derived.by<DbOverallStats>(() => {
        let totalSessions = 0
        let totalMessages = 0
        for (const b of botStats) {
            totalSessions += b.totalSessions
            totalMessages += b.totalMessages
        }
        let totalInputTokens = 0
        let totalOutputTokens = 0
        for (const t of tokenUsage) {
            totalInputTokens += t.totalInputTokens || 0
            totalOutputTokens += t.totalOutputTokens || 0
        }
        let totalRows = 0
        for (const t of tables) {
            totalRows += t.rowCount || 0
        }

        return {
            totalCharacters: botStats.length,
            totalSessions,
            totalMessages,
            totalInputTokens,
            totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            totalModules: (DBState.db.modules?.length ?? 0),
            totalLorebooks: (DBState.db.loreBook?.length ?? 0),
            totalTables: tables.length,
            totalRows
        }
    })

    function updateIsMobile() {
        if (typeof window !== 'undefined') {
            isMobile = window.innerWidth < 768
        }
    }

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
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

    function formatCell(value: unknown): string {
        if (value === null || value === undefined) {
            return language.postgresDbExplorerNull
        }
        if (typeof value === 'object') {
            return JSON.stringify(value)
        }
        return `${value}`
    }

    function formatDetail(value: unknown): string {
        if (value === null || value === undefined) {
            return language.postgresDbExplorerNull
        }
        if (typeof value === 'object') {
            return JSON.stringify(value, null, 2)
        }
        return `${value}`
    }

    async function loadThumbnail(key: string) {
        if (!key || thumbnailUrls.has(key)) return
        try {
            const storage = getNodeStorage()
            const data = await storage.getItem(key)
            if (data && data.length > 0) {
                const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(key) })
                const url = URL.createObjectURL(blob)
                thumbnailUrls.set(key, url)
                thumbnailUrls = new Map(thumbnailUrls)
            }
        } catch {}
    }

    function clearThumbnailCache() {
        for (const url of thumbnailUrls.values()) {
            URL.revokeObjectURL(url)
        }
        thumbnailUrls = new Map()
    }

    async function refreshTables() {
        busy = true
        error = ''
        closeContextMenu()
        try {
            const storage = getNodeStorage().postgres
            const config = await storage.getServerConfig()
            configEnabled = config.enabled
            tables = config.enabled ? await storage.listDbTables() : []
            revisions = config.enabled ? await storage.listRevisions(30) : []
            tokenUsage = config.enabled ? await storage.getTokenUsage() : []

            if (config.enabled) {
                if (tables.length === 0) {
                    selectedTable = ''
                    tableData = null
                    mobileView = 'tables'
                } else if (!tables.some((table) => table.name === selectedTable)) {
                    selectTable(tables[0].name)
                } else {
                    await loadRows()
                }
            }
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    async function selectTable(name: string) {
        if (busy) {
            return
        }
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
        if (busy || !selectedTable) {
            return
        }
        busy = true
        error = ''
        detailRow = null
        columnsOpen = false
        closeContextMenu()
        try {
            tableData = await getNodeStorage().postgres.getDbTableData(selectedTable, {
                offset: page * pageSize,
                limit: pageSize,
                sortColumn: sortColumn || undefined,
                sortOrder,
                search: activeSearch || undefined,
                columns: visibleColumns ?? undefined,
            })
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    function toggleSort(column: NodePostgresColumnInfo) {
        if (busy) {
            return
        }
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
        if (busy || nextPage < 0 || nextPage > maxPage) {
            return
        }
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
            if (next === activeSearch) {
                return
            }
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
        if (activeSearch === '') {
            return
        }
        activeSearch = ''
        page = 0
        loadRows()
    }

    function toggleColumn(name: string) {
        if (busy || !tableData) {
            return
        }
        let next: string[]
        if (visibleNames.includes(name)) {
            next = visibleNames.filter((column) => column !== name)
            if (next.length === 0) {
                return
            }
        } else {
            next = allColumns.map((column) => column.name).filter((column) => column === name || visibleNames.includes(column))
        }
        visibleColumns = next.length === allColumns.length ? null : next
        loadRows()
    }

    function showAllColumns() {
        if (busy || !tableData || visibleColumns === null) {
            return
        }
        visibleColumns = null
        loadRows()
    }

    function deselectAllColumns() {
        if (busy || !tableData || allColumns.length === 0) {
            return
        }
        visibleColumns = [allColumns[0].name]
        loadRows()
    }

    function hideColumn(name: string) {
        if (busy || !tableData || visibleNames.length <= 1) {
            return
        }
        visibleColumns = visibleNames.filter((column) => column !== name)
        closeContextMenu()
        loadRows()
    }

    function showOnlyColumn(name: string) {
        if (busy || !tableData) {
            return
        }
        visibleColumns = [name]
        closeContextMenu()
        loadRows()
    }

    function sortByColumn(name: string, order: 'asc' | 'desc') {
        if (busy) {
            return
        }
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

    async function copyToClipboard(text: string, notice = language.postgresDbExplorerCopied) {
        try {
            await navigator.clipboard.writeText(text)
            showToast(notice)
        } catch (err) {
            error = `${err}`
        }
        closeContextMenu()
    }

    async function copyDetailJson() {
        if (!detailRow) {
            return
        }
        try {
            await navigator.clipboard.writeText(JSON.stringify(detailRow, null, 2))
            copied = true
            showToast(language.postgresDbExplorerCopied)
            setTimeout(() => {
                copied = false
            }, 1500)
        } catch (err) {
            error = `${err}`
        }
    }

    function openCellContextMenu(e: MouseEvent, column: NodePostgresColumnInfo, row: Record<string, unknown>, value: unknown) {
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
            row,
        }
    }

    function openHeaderContextMenu(e: MouseEvent, column: NodePostgresColumnInfo) {
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
            columnInfo: column,
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
            tableName,
        }
    }

    function closeContextMenu() {
        if (contextMenu.open) {
            contextMenu.open = false
        }
    }

    onMount(() => {
        updateIsMobile()
        refreshTables()
    })

    onDestroy(() => {
        clearThumbnailCache()
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
            } else {
                close()
            }
        }
    }}
/>

<!-- Backdrop Overlay -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4 md:p-6 lg:p-8 animate-in fade-in duration-200"
    onclick={() => { closeContextMenu(); close(); }}
    role="presentation"
>
    <!-- Modal Container -->
    <div
        class="flex h-full w-full sm:h-[92vh] sm:max-h-[960px] sm:max-w-6xl md:max-w-7xl lg:max-w-[105rem] flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in zoom-in-95 duration-200"
        onclick={(e) => { e.stopPropagation(); closeContextMenu(); }}
        role="presentation"
    >
        <!-- Modal Header Bar -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-darkborderc p-3 sm:p-4 shrink-0 bg-darkbg">
            <div class="flex items-center gap-2 min-w-0">
                {#if currentTab === 'tables' && mobileView === 'data' && selectedTable}
                    <button
                        class="flex items-center gap-1 rounded-md p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor md:hidden shrink-0"
                        onclick={() => mobileView = 'tables'}
                        title={language.postgresDbExplorerBackToTables}
                    >
                        <ChevronLeftIcon size={20} />
                    </button>
                {/if}
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                        <TableIcon class="h-4 w-4 sm:h-5 sm:w-5" />
                    </div>
                    <div class="min-w-0">
                        <h2 class="text-sm sm:text-lg font-bold truncate text-textcolor">{language.postgresDbExplorer}</h2>
                        <p class="hidden sm:block text-xs text-textcolor2 truncate">{language.postgresDbExplorerDescription}</p>
                    </div>
                </div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
                {#if configEnabled !== null}
                    <span class="rounded-full px-2.5 py-1 text-xs font-medium {configEnabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-darkbutton text-textcolor2'}">
                        {configEnabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
                    </span>
                {/if}
                <Button size="sm" disabled={busy} onclick={refreshTables}>
                    <span class="hidden sm:inline">{language.postgresDbExplorerRefresh}</span>
                    <RefreshCwIcon size={14} class="sm:hidden" />
                </Button>
                <button class="cursor-pointer p-1.5 text-textcolor2 hover:text-green-500 rounded-lg hover:bg-darkbutton transition-colors" onclick={close}>
                    <XIcon size={20} />
                </button>
            </div>
        </div>

        <!-- 4-Tab Navigation Bar -->
        <DbExplorerTabNav
            {currentTab}
            tableCount={tables.length}
            revisionCount={revisions.length}
            botCount={botStats.length}
            onSelectTab={(tab) => {
                currentTab = tab
            }}
        />

        <!-- Main Content Area -->
        <main class="flex-1 overflow-y-auto p-3 sm:p-5 min-h-0">
            {#if error}
                <div class="mb-4 rounded-xl border border-draculared/50 bg-draculared/10 p-3.5 text-sm text-draculared">
                    {error}
                </div>
            {/if}

            <!-- TAB 1: TABLES (테이블 탐색기) -->
            {#if currentTab === 'tables'}
                {#if configEnabled === null}
                    <div class="flex h-64 items-center justify-center text-sm text-textcolor2">
                        {language.postgresStatusLoading}
                    </div>
                {:else if !configEnabled}
                    <!-- 데이터베이스 비활성화 시 설정 탭 유도 배너 -->
                    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 sm:p-8 text-center max-w-2xl mx-auto my-8">
                        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-300 mb-4">
                            <SettingsIcon size={28} />
                        </div>
                        <h3 class="text-base sm:text-lg font-bold text-textcolor">{language.dbExplorerDisabledBanner}</h3>
                        <p class="mt-1.5 text-xs sm:text-sm text-textcolor2">{language.dbExplorerDisabledDesc}</p>
                        <div class="mt-6 flex justify-center">
                            <Button className="bg-selected hover:opacity-90 font-medium px-5 py-2" onclick={() => currentTab = 'config'}>
                                {language.dbExplorerGoToConfig}
                            </Button>
                        </div>
                    </div>
                {:else}
                    <div class="grid h-[calc(100vh-16rem)] sm:h-[calc(92vh-13rem)] min-h-[400px] gap-2 sm:gap-3 md:grid-cols-[minmax(14rem,1fr)_2.5fr]">
                        <!-- Left Column: Tables List -->
                        <div class="flex min-h-0 flex-col rounded-xl border border-darkborderc bg-darkbg/50 {mobileView === 'data' ? 'hidden md:flex' : 'flex'}">
                            <!-- Schema Filter Tabs -->
                            {#if availableSchemas.length > 1}
                                <div class="flex items-center gap-1 border-b border-darkborderc p-1.5 overflow-x-auto no-scrollbar shrink-0">
                                    <button
                                        type="button"
                                        class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors {selectedSchema === 'all' ? 'bg-selected text-textcolor font-medium shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                                        onclick={() => selectedSchema = 'all'}
                                    >
                                        <span>{language.postgresDbExplorerAllSchemas ?? 'All'}</span>
                                        <span class="rounded-full bg-darkbutton/80 px-1.5 py-0.2 text-[10px] opacity-80">{parsedTables.length}</span>
                                    </button>
                                    {#each availableSchemas as schema (schema)}
                                        {@const stats = schemaStats[schema]}
                                        <button
                                            type="button"
                                            class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap font-mono transition-colors {selectedSchema === schema ? 'bg-selected text-textcolor font-medium shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                                            onclick={() => selectedSchema = schema}
                                        >
                                            <span>{schema}</span>
                                            <span class="rounded-full bg-darkbutton/80 px-1.5 py-0.2 text-[10px] opacity-80 font-sans">{stats?.count ?? 0}</span>
                                        </button>
                                    {/each}
                                </div>
                            {/if}

                            <div class="border-b border-darkborderc p-2 shrink-0">
                                <TextInput
                                    bind:value={tableFilter}
                                    size="sm"
                                    fullwidth={true}
                                    placeholder={language.postgresDbExplorerFilterTables}
                                />
                            </div>

                            <div class="flex-1 overflow-y-auto p-1 divide-y divide-darkborderc/30">
                                {#if selectedSchema === 'all'}
                                    {#each groupedTables as group (group.schema)}
                                        {@const isCollapsed = collapsedSchemas[group.schema]}
                                        <div class="py-1">
                                            <!-- Schema Group Header -->
                                            <button
                                                type="button"
                                                class="flex w-full items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-textcolor2 hover:bg-darkbutton hover:text-textcolor transition-colors"
                                                onclick={() => toggleSchemaCollapse(group.schema)}
                                            >
                                                <div class="flex items-center gap-1.5 min-w-0">
                                                    {#if isCollapsed}
                                                        <ChevronRightIcon size={14} class="shrink-0 text-textcolor2" />
                                                        <FolderIcon size={14} class="shrink-0 text-textcolor2" />
                                                    {:else}
                                                        <ChevronDownIcon size={14} class="shrink-0 text-textcolor2" />
                                                        <FolderOpenIcon size={14} class="shrink-0 text-textcolor2" />
                                                    {/if}
                                                    <span class="font-mono text-xs text-textcolor uppercase tracking-wider">{group.schema}</span>
                                                </div>
                                                <span class="shrink-0 rounded-full bg-darkbutton/80 px-1.5 py-0.5 font-mono text-[10px] text-textcolor2">
                                                    {group.tables.length}
                                                </span>
                                            </button>

                                            {#if !isCollapsed}
                                                <div class="mt-0.5 space-y-0.5 pl-2">
                                                    {#each group.tables as table (table.name)}
                                                        <button
                                                            type="button"
                                                            class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs sm:text-sm transition-colors {selectedTable === table.name ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-darkbutton'}"
                                                            onclick={() => selectTable(table.name)}
                                                            oncontextmenu={(e) => openTableContextMenu(e, table.name)}
                                                        >
                                                            <div class="flex items-center gap-1.5 min-w-0">
                                                                <TableIcon size={13} class="shrink-0 opacity-60" />
                                                                <span class="truncate font-mono text-xs sm:text-sm" title={table.name}>{table.shortName}</span>
                                                            </div>
                                                            <span class="shrink-0 rounded-full bg-darkbutton/60 px-1.5 py-0.5 font-mono text-[10px] sm:text-[11px] opacity-80">
                                                                {table.rowCount.toLocaleString()}
                                                            </span>
                                                        </button>
                                                    {/each}
                                                </div>
                                            {/if}
                                        </div>
                                    {:else}
                                        <p class="p-4 text-center text-xs text-textcolor2">{language.postgresDbExplorerNoTables}</p>
                                    {/each}
                                {:else}
                                    <!-- Single Schema View -->
                                    <div class="space-y-0.5 p-0.5">
                                        {#each filteredTables as table (table.name)}
                                            <button
                                                type="button"
                                                class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors {selectedTable === table.name ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-darkbutton'}"
                                                onclick={() => selectTable(table.name)}
                                                oncontextmenu={(e) => openTableContextMenu(e, table.name)}
                                            >
                                                <div class="flex items-center gap-1.5 min-w-0">
                                                    <TableIcon size={14} class="shrink-0 opacity-60" />
                                                    <span class="truncate font-mono text-xs sm:text-sm" title={table.name}>{table.shortName}</span>
                                                </div>
                                                <span class="shrink-0 rounded-full bg-darkbutton/60 px-2 py-0.5 font-mono text-[11px] opacity-80">
                                                    {table.rowCount.toLocaleString()}
                                                </span>
                                            </button>
                                        {:else}
                                            <p class="p-4 text-center text-xs text-textcolor2">{language.postgresDbExplorerNoTables}</p>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        </div>

                        <!-- Right Column: Table Rows / Data Viewer -->
                        <div class="flex min-h-0 flex-col rounded-xl border border-darkborderc bg-darkbg/50 {mobileView === 'tables' ? 'hidden md:flex' : 'flex'}">
                            {#if tableData}
                                {@const dotIdx = tableData.table.indexOf('.')}
                                <!-- Table Toolbar -->
                                <div class="flex flex-wrap items-center gap-2 border-b border-darkborderc p-2.5 shrink-0 bg-darkbg">
                                    <div class="flex items-center gap-1.5 min-w-0">
                                        {#if dotIdx !== -1}
                                            <span class="font-mono text-xs px-1.5 py-0.5 rounded-md bg-darkbutton text-textcolor2 font-medium shrink-0">
                                                {tableData.table.slice(0, dotIdx)}
                                            </span>
                                            <span class="font-mono text-xs sm:text-sm font-semibold truncate" title={tableData.table}>
                                                {tableData.table.slice(dotIdx + 1)}
                                            </span>
                                        {:else}
                                            <span class="font-mono text-xs sm:text-sm font-semibold truncate" title={tableData.table}>{tableData.table}</span>
                                        {/if}
                                        <span class="text-[11px] sm:text-xs text-textcolor2 shrink-0">
                                            {tableData.total.toLocaleString()} {language.postgresDbExplorerRows}
                                            {#if activeSearch}
                                                <span class="opacity-70">({language.postgresDbExplorerSearchRowsResult})</span>
                                            {/if}
                                        </span>
                                    </div>

                                    <div class="grow"></div>

                                    <!-- Mobile Mode Switcher: Card / Table -->
                                    <div class="flex items-center rounded-lg border border-darkborderc bg-bgcolor/40 p-0.5 md:hidden shrink-0">
                                        <button
                                            type="button"
                                            class="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors {mobileDisplayMode === 'card' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                                            onclick={() => mobileDisplayMode = 'card'}
                                            title={language.postgresDbExplorerCardView}
                                        >
                                            <LayoutGridIcon size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            class="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors {mobileDisplayMode === 'table' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                                            onclick={() => mobileDisplayMode = 'table'}
                                            title={language.postgresDbExplorerTableView}
                                        >
                                            <TableIcon size={14} />
                                        </button>
                                    </div>

                                    <!-- Search Box -->
                                    <div class="relative w-full sm:w-48 md:w-56 shrink-0 order-last sm:order-none">
                                        <div class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-textcolor2">
                                            <SearchIcon size={14} />
                                        </div>
                                        <TextInput
                                            bind:value={searchInput}
                                            size="sm"
                                            oninput={onSearchInput}
                                            fullwidth={true}
                                            placeholder={language.postgresDbExplorerSearchRows}
                                            className="pl-7 pr-7 text-xs"
                                        />
                                        {#if searchInput}
                                            <button
                                                type="button"
                                                class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-green-500"
                                                title={language.postgresDbExplorerClearSearch}
                                                onclick={clearSearchInput}
                                            >
                                                <XIcon size={14} />
                                            </button>
                                        {/if}
                                    </div>

                                    <!-- Column Selector Dropdown -->
                                    <div class="relative shrink-0">
                                        <Button
                                            size="sm"
                                            className="flex items-center gap-1.5 whitespace-nowrap"
                                            onclick={() => columnsOpen = !columnsOpen}
                                        >
                                            <Columns3Icon size={14} />
                                            <span>{language.postgresDbExplorerColumns}</span>
                                            {#if visibleColumns !== null && allColumns.length > 0}
                                                <span class="rounded bg-selected/80 px-1 py-0.2 text-[10px] font-mono leading-none">
                                                    {visibleNames.length}/{allColumns.length}
                                                </span>
                                            {/if}
                                        </Button>
                                        {#if columnsOpen}
                                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                                            <div class="fixed inset-0 z-20" onclick={() => columnsOpen = false}></div>
                                            <div class="absolute right-0 top-full z-30 mt-1 max-h-80 w-64 overflow-hidden rounded-xl border border-darkborderc bg-darkbg p-2.5 shadow-xl">
                                                <div class="relative mb-2">
                                                    <TextInput
                                                        bind:value={columnFilter}
                                                        size="sm"
                                                        fullwidth={true}
                                                        placeholder={language.postgresDbExplorerFilterColumns}
                                                        className="pr-6 text-xs"
                                                    />
                                                    {#if columnFilter}
                                                        <button
                                                            type="button"
                                                            class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-green-500"
                                                            onclick={() => columnFilter = ''}
                                                        >
                                                            <XIcon size={12} />
                                                        </button>
                                                    {/if}
                                                </div>
                                                <div class="mb-2 flex items-center gap-1.5">
                                                    <button
                                                        type="button"
                                                        class="flex-1 cursor-pointer rounded-lg bg-darkbutton/60 px-2 py-1 text-center text-xs text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor"
                                                        disabled={visibleColumns === null}
                                                        class:opacity-50={visibleColumns === null}
                                                        onclick={showAllColumns}
                                                    >
                                                        {language.postgresDbExplorerSelectAll}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="flex-1 cursor-pointer rounded-lg bg-darkbutton/60 px-2 py-1 text-center text-xs text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor"
                                                        disabled={visibleNames.length <= 1}
                                                        class:opacity-50={visibleNames.length <= 1}
                                                        onclick={deselectAllColumns}
                                                    >
                                                        {language.postgresDbExplorerDeselectAll}
                                                    </button>
                                                </div>
                                                <div class="max-h-48 overflow-y-auto border-t border-darkborderc pt-1 space-y-0.5">
                                                    {#each filteredAllColumns as column (column.name)}
                                                        <label class="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-xs transition-colors hover:bg-darkbutton">
                                                            <div class="flex items-center gap-2 min-w-0">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={visibleNames.includes(column.name)}
                                                                    onchange={() => toggleColumn(column.name)}
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
                                </div>

                                <!-- Mobile Card View Mode -->
                                {#if mobileDisplayMode === 'card'}
                                    <div class="flex-1 overflow-y-auto p-2 space-y-2 md:hidden">
                                        {#each tableData.rows as row, index (tableData.offset + index)}
                                            <div
                                                class="rounded-xl border border-darkborderc bg-darkbg/70 p-3 shadow-xs transition-all active:scale-[0.99] {detailRow === row ? 'border-selected ring-1 ring-selected' : ''}"
                                                onclick={() => toggleDetail(row)}
                                                role="button"
                                                tabindex="0"
                                                onkeydown={(e) => { if (e.key === 'Enter') toggleDetail(row) }}
                                            >
                                                <div class="flex items-center justify-between gap-2 border-b border-darkborderc/40 pb-1.5 mb-1.5">
                                                    <span class="font-mono text-xs font-semibold text-textcolor truncate">
                                                        #{tableData.offset + index + 1}
                                                        {#if tableData.columns.length > 0}
                                                            <span class="ml-1 text-textcolor2 font-normal font-mono">({tableData.columns[0].name}: {formatCell(row[tableData.columns[0].name])})</span>
                                                        {/if}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        class="cursor-pointer p-1 text-textcolor2 hover:text-textcolor rounded hover:bg-darkbutton"
                                                        onclick={(e) => {
                                                            e.stopPropagation()
                                                            openCellContextMenu(e, tableData!.columns[0], row, row[tableData!.columns[0].name])
                                                        }}
                                                        title={language.postgresDbExplorerActions}
                                                    >
                                                        <FileTextIcon size={14} />
                                                    </button>
                                                </div>
                                                <div class="grid grid-cols-1 gap-1 text-xs">
                                                    {#each tableData.columns.slice(1, 5) as column (column.name)}
                                                        <div class="flex items-baseline justify-between gap-2">
                                                            <span class="font-mono text-[11px] text-textcolor2 shrink-0">{column.name}</span>
                                                            <span
                                                                class="font-mono text-[11px] truncate text-right text-textcolor"
                                                                class:italic={row[column.name] === null}
                                                                class:text-textcolor2={row[column.name] === null}
                                                            >
                                                                {formatCell(row[column.name])}
                                                            </span>
                                                        </div>
                                                    {/each}
                                                    {#if tableData.columns.length > 5}
                                                        <div class="mt-0.5 text-right font-mono text-[10px] text-textcolor2 opacity-60">
                                                            +{tableData.columns.length - 5} more columns
                                                        </div>
                                                    {/if}
                                                </div>
                                            </div>
                                        {:else}
                                            <div class="py-12 text-center text-xs text-textcolor2">
                                                {language.postgresDbExplorerEmptyTable}
                                            </div>
                                        {/each}
                                    </div>
                                {/if}

                                <!-- Table Scroll Container (Table View) -->
                                <div class="flex-1 overflow-auto min-h-0 {mobileDisplayMode === 'card' ? 'hidden md:block' : 'block'}">
                                    <table class="w-full border-collapse text-sm">
                                        <thead>
                                            <tr>
                                                {#each tableData.columns as column, colIndex (column.name)}
                                                    <th
                                                        class="cursor-pointer select-none whitespace-nowrap border-b border-darkborderc px-2.5 py-1.5 text-left font-semibold text-textcolor2 transition-colors hover:text-textcolor {colIndex === 0 ? 'sticky top-0 left-0 z-30 min-w-[7rem] sm:min-w-[8rem] max-w-[18rem] bg-darkbg shadow-[4px_0_8px_-4px_rgba(0,0,0,0.5)]' : 'sticky top-0 z-20 min-w-[7rem] sm:min-w-[8rem] max-w-[18rem] bg-darkbg'}"
                                                        title={column.dataType}
                                                        onclick={() => toggleSort(column)}
                                                        oncontextmenu={(e) => openHeaderContextMenu(e, column)}
                                                    >
                                                        {column.name}
                                                        {#if sortColumn === column.name}
                                                            <span class="ml-1">{sortOrder === 'asc' ? '▲' : '▼'}</span>
                                                        {/if}
                                                    </th>
                                                {/each}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {#each tableData.rows as row, index (tableData.offset + index)}
                                                <tr
                                                    class="group cursor-pointer border-b border-darkborderc/50 transition-colors hover:bg-darkbutton/40 {detailRow === row ? 'bg-darkbutton/60' : ''}"
                                                    onclick={() => toggleDetail(row)}
                                                >
                                                    {#each tableData.columns as column, colIndex (column.name)}
                                                        {@const value = row[column.name]}
                                                        <td
                                                            class="truncate whitespace-nowrap px-2.5 py-1.5 {colIndex === 0 ? `sticky left-0 z-10 min-w-[7rem] sm:min-w-[8rem] max-w-[18rem] shadow-[4px_0_8px_-4px_rgba(0,0,0,0.5)] ${detailRow === row ? 'bg-darkbutton/60' : 'bg-bgcolor group-hover:bg-darkbutton/40'}` : 'min-w-[7rem] sm:min-w-[8rem] max-w-[18rem]'}"
                                                            class:italic={value === null}
                                                            class:text-textcolor2={value === null}
                                                            title={formatCell(value)}
                                                            oncontextmenu={(e) => openCellContextMenu(e, column, row, value)}
                                                        >
                                                            {formatCell(value)}
                                                        </td>
                                                    {/each}
                                                </tr>
                                            {:else}
                                                <tr>
                                                    <td
                                                        class="px-2 py-8 text-center text-textcolor2"
                                                        colspan={tableData.columns.length}
                                                    >
                                                        {language.postgresDbExplorerEmptyTable}
                                                    </td>
                                                </tr>
                                            {/each}
                                        </tbody>
                                    </table>
                                </div>

                                <!-- Desktop Inline Detail Panel -->
                                {#if detailRow}
                                    <div class="hidden md:block max-h-56 overflow-y-auto border-t border-darkborderc bg-darkbg/60 p-3 shrink-0">
                                        <div class="mb-2 flex items-center gap-2">
                                            <span class="text-sm font-semibold text-textcolor">{language.postgresDbExplorerRowDetail}</span>
                                            <div class="grow"></div>
                                            <Button size="sm" className="flex items-center gap-1 whitespace-nowrap" onclick={copyDetailJson}>
                                                {#if copied}
                                                    <CheckIcon size={14} />
                                                    {language.postgresDbExplorerCopied}
                                                {:else}
                                                    <CopyIcon size={14} />
                                                    {language.postgresDbExplorerCopyJson}
                                                {/if}
                                            </Button>
                                            <button
                                                type="button"
                                                class="cursor-pointer text-textcolor2 hover:text-green-500 p-1 rounded"
                                                onclick={() => detailRow = null}
                                            >
                                                <XIcon size={16} />
                                            </button>
                                        </div>
                                        {#each tableData.columns as column (column.name)}
                                            <div class="mb-2">
                                                <p class="font-mono text-xs font-semibold text-textcolor2">{column.name} <span class="opacity-60">({column.dataType})</span></p>
                                                <pre class="mt-0.5 whitespace-pre-wrap break-words rounded bg-darkbg/60 p-2 font-mono text-xs text-textcolor">
{formatDetail(detailRow[column.name])}</pre>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}

                                <!-- Pagination Footer -->
                                <div class="flex flex-wrap items-center justify-between gap-2 border-t border-darkborderc p-2.5 shrink-0 bg-darkbg">
                                    <span class="text-xs text-textcolor2 font-mono">
                                        {rangeStart}–{rangeEnd} / {tableData.total.toLocaleString()}
                                    </span>
                                    <div class="flex items-center gap-1.5 sm:gap-2">
                                        <SelectInput
                                            value={pageSize}
                                            size="sm"
                                            className="text-xs py-0.5"
                                            onchange={changePageSize}
                                        >
                                            <option value={25}>25</option>
                                            <option value={50}>50</option>
                                            <option value={100}>100</option>
                                        </SelectInput>
                                        <Button size="sm" disabled={busy || page === 0} onclick={() => changePage(page - 1)}>
                                            {language.postgresDbExplorerPrevious}
                                        </Button>
                                        <Button size="sm" disabled={busy || page >= maxPage} onclick={() => changePage(page + 1)}>
                                            {language.postgresDbExplorerNext}
                                        </Button>
                                    </div>
                                </div>
                            {:else}
                                <div class="flex flex-1 items-center justify-center p-6 text-sm text-textcolor2">
                                    {selectedTable ? language.postgresDbExplorerLoading : language.postgresDbExplorerSelectTable}
                                </div>
                            {/if}
                        </div>
                    </div>
                {/if}
            {/if}

            <!-- TAB 2: CONFIG (데이터베이스 설정) -->
            {#if currentTab === 'config'}
                <DbConfigTab onConfigChanged={refreshTables} />
            {/if}

            <!-- TAB 3: STATS (통계 대시보드) -->
            {#if currentTab === 'stats'}
                <DbStatsTab
                    {botStats}
                    {tokenUsage}
                    {overallStats}
                    {thumbnailUrls}
                    onLoadThumbnail={loadThumbnail}
                />
            {/if}

            <!-- TAB 4: HISTORY (리비전 히스토리) -->
            {#if currentTab === 'history'}
                <DbHistoryTab
                    {revisions}
                    onRevisionRestored={refreshTables}
                />
            {/if}
        </main>
    </div>
</div>

<!-- Mobile Row Detail Bottom Sheet Modal -->
{#if detailRow && tableData}
    <div
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs md:hidden"
        onclick={() => detailRow = null}
        role="presentation"
    >
        <div
            class="flex max-h-[85vh] w-full flex-col rounded-t-2xl border-t border-darkborderc bg-darkbg text-textcolor shadow-2xl overflow-hidden animate-slide-up"
            onclick={(e) => e.stopPropagation()}
            role="presentation"
        >
            <!-- Drag handle -->
            <div class="flex justify-center pt-2 pb-1">
                <div class="h-1 w-10 rounded-full bg-darkborderc"></div>
            </div>

            <!-- Header -->
            <div class="flex items-center justify-between border-b border-darkborderc px-4 py-2.5">
                <div>
                    <h3 class="font-bold text-sm text-textcolor">{language.postgresDbExplorerRowDetail}</h3>
                    <p class="font-mono text-xs text-textcolor2">{tableData.table}</p>
                </div>
                <div class="flex items-center gap-2">
                    <Button size="sm" className="flex items-center gap-1 text-xs" onclick={copyDetailJson}>
                        {#if copied}
                            <CheckIcon size={13} />
                            {language.postgresDbExplorerCopied}
                        {:else}
                            <CopyIcon size={13} />
                            {language.postgresDbExplorerCopyJson}
                        {/if}
                    </Button>
                    <button type="button" class="p-1 text-textcolor2 hover:text-green-500 rounded" onclick={() => detailRow = null}>
                        <XIcon size={18} />
                    </button>
                </div>
            </div>

            <!-- Fields list -->
            <div class="flex-1 overflow-y-auto p-3 space-y-2.5 divide-y divide-darkborderc/30">
                {#each tableData.columns as column (column.name)}
                    <div class="pt-2 first:pt-0">
                        <div class="flex items-center justify-between mb-1">
                            <span class="font-mono text-xs font-semibold text-textcolor">{column.name}</span>
                            <div class="flex items-center gap-1.5">
                                <span class="rounded bg-darkbutton px-1.5 py-0.5 font-mono text-[10px] text-textcolor2">{column.dataType}</span>
                                <button
                                    type="button"
                                    class="p-1 text-textcolor2 hover:text-textcolor rounded hover:bg-darkbutton"
                                    title={language.postgresDbExplorerCopyValue}
                                    onclick={() => copyToClipboard(detailRow![column.name] === null ? '' : typeof detailRow![column.name] === 'object' ? JSON.stringify(detailRow![column.name], null, 2) : String(detailRow![column.name]))}
                                >
                                    <CopyIcon size={12} />
                                </button>
                            </div>
                        </div>
                        <pre class="whitespace-pre-wrap break-words rounded bg-bgcolor/60 p-2 font-mono text-xs text-textcolor2">
{formatDetail(detailRow[column.name])}</pre>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{/if}

<!-- Context Menu / Mobile Action Sheet -->
{#if contextMenu.open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-50 bg-black/40 md:bg-transparent"
        onclick={closeContextMenu}
        oncontextmenu={(e) => { e.preventDefault(); closeContextMenu() }}
    ></div>

    <!-- Desktop floating popup vs Mobile bottom sheet -->
    <div
        class="fixed z-50 overflow-hidden border border-darkborderc bg-darkbg text-xs shadow-2xl backdrop-blur-md animate-fade-in
               w-full md:w-auto md:min-w-[12rem] inset-x-0 bottom-0 md:inset-x-auto md:bottom-auto rounded-t-2xl md:rounded-xl p-2 md:p-1"
        style={!isMobile ? `left: ${contextMenu.x}px; top: ${contextMenu.y}px;` : ''}
    >
        {#if isMobile}
            <div class="flex justify-center pt-1 pb-2">
                <div class="h-1 w-10 rounded-full bg-darkborderc"></div>
            </div>
        {/if}

        {#if contextMenu.type === 'cell'}
            <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                onclick={() => copyToClipboard(contextMenu.cellValue === null || contextMenu.cellValue === undefined ? '' : typeof contextMenu.cellValue === 'object' ? JSON.stringify(contextMenu.cellValue, null, 2) : String(contextMenu.cellValue))}
            >
                <CopyIcon size={16} class="text-textcolor2 shrink-0" />
                <span>{language.postgresDbExplorerCopyValue}</span>
            </button>
            {#if contextMenu.row}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => copyToClipboard(JSON.stringify(contextMenu.row, null, 2))}
                >
                    <CopyIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyRowJson}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => {
                        if (contextMenu.row) {
                            toggleDetail(contextMenu.row)
                        }
                        closeContextMenu()
                    }}
                >
                    <FileTextIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerViewDetail}</span>
                </button>
            {/if}
            {#if contextMenu.cellValue !== null && contextMenu.cellValue !== undefined}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => searchThisValue(contextMenu.cellValue)}
                >
                    <SearchIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSearchThisValue}</span>
                </button>
            {/if}
            <div class="my-1 border-t border-darkborderc/60"></div>
            {#if contextMenu.columnName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={visibleNames.length <= 1}
                    onclick={() => hideColumn(contextMenu.columnName!)}
                >
                    <EyeOffIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerHideColumn}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => showOnlyColumn(contextMenu.columnName!)}
                >
                    <EyeIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerShowOnlyColumn}</span>
                </button>
            {/if}
        {:else if contextMenu.type === 'header'}
            {#if contextMenu.columnName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => sortByColumn(contextMenu.columnName!, 'asc')}
                >
                    <ArrowUpIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSortAsc}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => sortByColumn(contextMenu.columnName!, 'desc')}
                >
                    <ArrowDownIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSortDesc}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => copyToClipboard(contextMenu.columnName!)}
                >
                    <CopyIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyColumnName}</span>
                </button>
                <div class="my-1 border-t border-darkborderc/60"></div>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={visibleNames.length <= 1}
                    onclick={() => hideColumn(contextMenu.columnName!)}
                >
                    <EyeOffIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerHideColumn}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => showOnlyColumn(contextMenu.columnName!)}
                >
                    <EyeIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerShowOnlyColumn}</span>
                </button>
                {#if visibleColumns !== null}
                    <button
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                        onclick={() => { showAllColumns(); closeContextMenu(); }}
                    >
                        <Columns3Icon size={16} class="text-textcolor2 shrink-0" />
                        <span>{language.postgresDbExplorerAllColumns}</span>
                    </button>
                {/if}
            {/if}
        {:else if contextMenu.type === 'table'}
            {#if contextMenu.tableName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => copyToClipboard(contextMenu.tableName!)}
                >
                    <CopyIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyTableName}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 md:gap-2 rounded-lg md:rounded px-3 py-2.5 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => { refreshTables(); closeContextMenu(); }}
                >
                    <RefreshCwIcon size={16} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerRefresh}</span>
                </button>
            {/if}
        {/if}
    </div>
{/if}

<!-- Copy Feedback Toast -->
{#if toastMessage}
    <div class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-darkborderc bg-darkbg px-3.5 py-2.5 text-xs text-textcolor shadow-2xl animate-in fade-in duration-150">
        <CheckIcon size={14} class="text-emerald-400" />
        <span>{toastMessage}</span>
    </div>
{/if}
