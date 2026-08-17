<script lang="ts">
    import { onMount } from 'svelte'
    import { XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type {
        NodePostgresColumnInfo,
        NodePostgresTableData,
        NodePostgresTableInfo,
    } from 'src/ts/storage/nodePostgresStorage'

    let { close = () => {} }: { close?: () => void } = $props()

    let configEnabled = $state<boolean|null>(null)
    let tables = $state<NodePostgresTableInfo[]>([])
    let tableFilter = $state('')
    let selectedTable = $state('')
    let tableData = $state<NodePostgresTableData|null>(null)
    let sortColumn = $state('')
    let sortOrder = $state<'asc'|'desc'>('asc')
    let page = $state(0)
    let pageSize = $state(50)
    let busy = $state(false)
    let error = $state('')

    const filteredTables = $derived(
        tables.filter((table) => table.name.toLowerCase().includes(tableFilter.toLowerCase()))
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

    function getNodeStorage() {
        if(!(forageStorage.realStorage instanceof NodeStorage)){
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    function formatCell(value:unknown):string {
        if(value === null || value === undefined){
            return language.postgresDbExplorerNull
        }
        if(typeof value === 'object'){
            return JSON.stringify(value)
        }
        return `${value}`
    }

    async function refreshTables() {
        busy = true
        error = ''
        try {
            const storage = getNodeStorage().postgres
            const config = await storage.getServerConfig()
            configEnabled = config.enabled
            tables = config.enabled ? await storage.listDbTables() : []
            if(config.enabled){
                if(tables.length === 0){
                    selectedTable = ''
                    tableData = null
                }
                else if(!tables.some((table) => table.name === selectedTable)){
                    selectTable(tables[0].name)
                }
                else {
                    await loadRows()
                }
            }
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    async function selectTable(name:string) {
        if(busy || name === selectedTable){
            return
        }
        selectedTable = name
        tableData = null
        sortColumn = ''
        sortOrder = 'asc'
        page = 0
        await loadRows()
    }

    async function loadRows() {
        if(busy || !selectedTable){
            return
        }
        busy = true
        error = ''
        try {
            tableData = await getNodeStorage().postgres.getDbTableData(selectedTable, {
                offset: page * pageSize,
                limit: pageSize,
                sortColumn: sortColumn || undefined,
                sortOrder,
            })
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    function toggleSort(column:NodePostgresColumnInfo) {
        if(busy){
            return
        }
        if(sortColumn === column.name){
            sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'
        } else {
            sortColumn = column.name
            sortOrder = 'asc'
        }
        page = 0
        loadRows()
    }

    function changePage(nextPage:number) {
        if(busy || nextPage < 0 || nextPage > maxPage){
            return
        }
        page = nextPage
        loadRows()
    }

    function changePageSize(event:Event) {
        pageSize = Number((event.currentTarget as HTMLSelectElement).value)
        page = 0
        loadRows()
    }

    onMount(refreshTables)
</script>

<div class="absolute inset-0 z-40 bg-black/50 flex items-center justify-center p-2 sm:p-4">
    <div class="flex h-full w-full max-w-[110rem] flex-col overflow-hidden rounded-lg border border-darkborderc bg-bgcolor text-textcolor">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-darkborderc p-3">
            <div>
                <h2 class="text-xl font-bold">{language.postgresDbExplorer}</h2>
                <p class="mt-0.5 text-sm text-textcolor2">{language.postgresDbExplorerDescription}</p>
            </div>
            <div class="flex items-center gap-2">
                {#if configEnabled !== null}
                    <span class="rounded-full px-2 py-1 text-xs {configEnabled ? 'bg-selected text-textcolor' : 'bg-darkbutton text-textcolor2'}">
                        {configEnabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
                    </span>
                {/if}
                <Button size="sm" disabled={busy} onclick={refreshTables}>
                    {language.postgresDbExplorerRefresh}
                </Button>
                <button class="cursor-pointer text-textcolor2 hover:text-green-500" onclick={close}>
                    <XIcon size={24} />
                </button>
            </div>
        </div>

        <div class="flex flex-1 min-h-0 flex-col p-3">
            {#if error}
                <p class="rounded-md border border-draculared/50 bg-draculared/10 p-2 text-sm text-draculared">{error}</p>
            {:else if configEnabled === null}
                <p class="text-sm text-textcolor2">{language.postgresStatusLoading}</p>
            {:else if !configEnabled}
                <p class="rounded-md border border-borderc bg-darkbg/40 p-2 text-sm text-textcolor2">
                    {language.postgresDbExplorerDisabled}
                </p>
            {:else}
                <div class="mt-2 grid flex-1 min-h-[28rem] gap-3 md:grid-cols-[minmax(14rem,1fr)_2fr]">
                    <div class="flex min-h-0 flex-col rounded-lg border border-darkborderc bg-darkbg/40">
                        <div class="border-b border-darkborderc p-2">
                            <TextInput
                                bind:value={tableFilter}
                                fullwidth={true}
                                placeholder={language.postgresDbExplorerFilterTables}
                            />
                        </div>
                        <div class="max-h-[20rem] flex-1 overflow-y-auto p-1 md:max-h-none">
                            {#each filteredTables as table (table.name)}
                                <button
                                    class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors {selectedTable === table.name ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-darkbutton'}"
                                    onclick={() => selectTable(table.name)}
                                >
                                    <span class="truncate font-mono" title={table.name}>{table.name}</span>
                                    <span class="shrink-0 opacity-70">{table.rowCount.toLocaleString()}</span>
                                </button>
                            {:else}
                                <p class="p-2 text-xs text-textcolor2">{language.postgresDbExplorerNoTables}</p>
                            {/each}
                        </div>
                    </div>

                    <div class="flex min-h-0 flex-col rounded-lg border border-darkborderc bg-darkbg/40">
                        {#if tableData}
                            <div class="flex flex-wrap items-center gap-2 border-b border-darkborderc p-2">
                                <span class="font-mono text-sm font-semibold">{tableData.table}</span>
                                <span class="text-xs text-textcolor2">
                                    {tableData.total.toLocaleString()} {language.postgresDbExplorerRows}
                                </span>
                            </div>

                            <div class="min-h-[20rem] flex-1 overflow-auto md:min-h-0">
                                <table class="w-full border-collapse text-sm">
                                    <thead class="sticky top-0 z-10 bg-darkbg">
                                        <tr>
                                            {#each tableData.columns as column, colIndex (column.name)}
                                                <th
                                                    class="cursor-pointer select-none whitespace-nowrap border-b border-darkborderc px-2 py-1.5 text-left font-semibold text-textcolor2 transition-colors hover:text-textcolor {colIndex === 0 ? 'sticky left-0 z-20 min-w-[8rem] max-w-[18rem] bg-darkbg shadow-[4px_0_8px_-4px_rgba(0,0,0,0.5)]' : 'min-w-[8rem] max-w-[18rem]'}"
                                                    title={column.dataType}
                                                    onclick={() => toggleSort(column)}
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
                                            <tr class="border-b border-darkborderc/50 transition-colors hover:bg-darkbutton/40">
                                                {#each tableData.columns as column, colIndex (column.name)}
                                                    {@const value = row[column.name]}
                                                    <td
                                                        class="truncate whitespace-nowrap px-2 py-1.5 {colIndex === 0 ? 'sticky left-0 z-10 min-w-[8rem] max-w-[18rem] bg-bgcolor shadow-[4px_0_8px_-4px_rgba(0,0,0,0.5)]' : 'min-w-[8rem] max-w-[18rem]'}"
                                                        class:italic={value === null}
                                                        class:text-textcolor2={value === null}
                                                        title={formatCell(value)}
                                                    >
                                                        {formatCell(value)}
                                                    </td>
                                                {/each}
                                            </tr>
                                        {:else}
                                            <tr>
                                                <td
                                                    class="px-2 py-6 text-center text-textcolor2"
                                                    colspan={tableData.columns.length}
                                                >
                                                    {language.postgresDbExplorerEmptyTable}
                                                </td>
                                            </tr>
                                        {/each}
                                    </tbody>
                                </table>
                            </div>

                            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-darkborderc p-2">
                                <span class="text-xs text-textcolor2">
                                    {rangeStart}–{rangeEnd} / {tableData.total.toLocaleString()}
                                </span>
                                <div class="flex items-center gap-2">
                                    <SelectInput
                                        value={pageSize}
                                        size="sm"
                                        className="text-xs"
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
        </div>
    </div>
</div>
