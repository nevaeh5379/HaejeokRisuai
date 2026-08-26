<script lang="ts">
    import { onMount } from 'svelte'
    import { RefreshCwIcon, TableIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { getSqlStorage } from 'src/ts/storage/sqlStorageFactory'
    import type {
        NodePostgresTableData,
        NodePostgresTableInfo
    } from 'src/ts/storage/nodePostgresStorage'
    import DbTableExplorerTab from './DbExplorer/tabs/DbTableExplorerTab.svelte'

    interface Props {
        close?: () => void
    }

    const { close = () => {} }: Props = $props()
    let tables = $state<NodePostgresTableInfo[]>([])
    let busy = $state(false)
    let error = $state('')

    async function getBrowserStorage() {
        const storage = await getSqlStorage()
        if (storage.backendKind !== 'web-sqlite') {
            throw new Error('Browser SQLite storage is not available')        }
        if (!storage.listDbTables || !storage.getDbTableData) {
            throw new Error('This SQLite backend does not support table exploration')
        }
        if (!storage.isEnabled() && !(await storage.init())) {
            throw new Error('Browser SQLite storage failed to initialize')
        }
        return storage
    }

    async function refreshTables() {
        busy = true
        error = ''
        try {
            const storage = await getBrowserStorage()
            tables = await storage.listDbTables!()
        } catch (err) {
            error = `${err}`
            tables = []
        } finally {
            busy = false
        }
    }

    async function loadTableData(
        table: string,
        options: {
            offset?: number
            limit?: number
            sortColumn?: string
            sortOrder?: 'asc' | 'desc'
            search?: string
            columns?: string[]
        }
    ): Promise<NodePostgresTableData> {
        const storage = await getBrowserStorage()
        return storage.getDbTableData!(table, options)
    }

    onMount(() => {
        refreshTables()
    })
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && close()} />

<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-3 md:p-5 lg:p-6"
    onclick={close}
    role="presentation"
>
    <div
        class="flex h-full w-full sm:h-[94vh] sm:max-h-[980px] sm:max-w-6xl md:max-w-7xl lg:max-w-[110rem] flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl"
        onclick={(event) => event.stopPropagation()}
        role="presentation"
    >
        <div class="flex items-center justify-between gap-2 border-b border-darkborderc p-2.5 sm:p-3 shrink-0 bg-darkbg select-none">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                    <TableIcon class="h-5 w-5" />
                </div>
                <div class="min-w-0">
                    <h2 class="text-sm sm:text-base font-bold truncate text-textcolor">{language.postgresDbExplorer}</h2>
                    <p class="hidden sm:block text-xs text-textcolor2 truncate">Browser SQLite · WASM / OPFS</p>
                </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <span class="rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    SQLite · {tables.length} tables
                </span>
                <Button size="sm" disabled={busy} onclick={refreshTables}>
                    <RefreshCwIcon size={14} class={busy ? 'animate-spin' : ''} />
                    <span class="hidden sm:inline">{language.postgresDbExplorerRefresh}</span>
                </Button>
                <button class="cursor-pointer p-1.5 text-textcolor2 hover:text-green-500 rounded-lg hover:bg-darkbutton transition-colors" onclick={close}>
                    <XIcon size={18} />
                </button>
            </div>
        </div>

        {#if error}
            <div class="m-3 rounded-xl border border-draculared/50 bg-draculared/10 p-3 text-xs text-draculared">
                {error}
            </div>        {/if}

        <main class="flex flex-1 min-h-0 overflow-hidden">
            {#if busy && tables.length === 0}
                <div class="flex flex-1 items-center justify-center text-sm text-textcolor2">
                    <RefreshCwIcon size={20} class="animate-spin mr-2 text-blue-400" />
                    <span>{language.postgresStatusLoading}</span>
                </div>
            {:else}
                <DbTableExplorerTab
                    {tables}
                    configEnabled={true}
                    onRefreshAll={refreshTables}
                    {loadTableData}
                />
            {/if}
        </main>
    </div>
</div>
