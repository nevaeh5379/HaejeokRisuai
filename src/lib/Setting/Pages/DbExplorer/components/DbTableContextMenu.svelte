<script lang="ts">
    import {
        ArrowDownIcon,
        ArrowUpIcon,
        Columns3Icon,
        CopyIcon,
        EyeIcon,
        EyeOffIcon,
        FileTextIcon,
        RefreshCwIcon,
        SearchIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { TableContextMenuData } from '../types'

    interface Props {
        contextMenu: TableContextMenuData
        isMobile: boolean
        visibleNames: string[]
        hasHiddenColumns?: boolean
        onClose: () => void
        onCopyValue: (val: unknown) => void
        onCopyRowJson: (row: Record<string, unknown>) => void
        onViewDetail: (row: Record<string, unknown>) => void
        onSearchValue: (val: unknown) => void
        onHideColumn: (colName: string) => void
        onShowOnlyColumn: (colName: string) => void
        onShowAllColumns: () => void
        onSortColumn: (colName: string, order: 'asc' | 'desc') => void
        onCopyColumnName: (colName: string) => void
        onCopyTableName: (tableName: string) => void
        onRefreshTable: () => void
    }

    let {
        contextMenu,
        isMobile,
        visibleNames,
        hasHiddenColumns = false,
        onClose,
        onCopyValue,
        onCopyRowJson,
        onViewDetail,
        onSearchValue,
        onHideColumn,
        onShowOnlyColumn,
        onShowAllColumns,
        onSortColumn,
        onCopyColumnName,
        onCopyTableName,
        onRefreshTable
    }: Props = $props()
</script>

{#if contextMenu.open}
    <!-- Backdrop Overlay -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-50 bg-black/40 md:bg-transparent"
        onclick={onClose}
        oncontextmenu={(e) => {
            e.preventDefault()
            onClose()
        }}
    ></div>

    <!-- Menu Container: Floating Popup on Desktop, Bottom Sheet on Mobile -->
    <div
        class="fixed z-50 overflow-hidden border border-darkborderc bg-darkbg text-xs shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150
               w-full md:w-auto md:min-w-[13rem] inset-x-0 bottom-0 md:inset-x-auto md:bottom-auto rounded-t-2xl md:rounded-xl p-2 md:p-1"
        style={!isMobile
            ? `left: ${contextMenu.x}px; top: ${contextMenu.y}px;`
            : ''}
    >
        {#if isMobile}
            <div class="flex justify-center pt-1 pb-2">
                <div class="h-1 w-10 rounded-full bg-darkborderc"></div>
            </div>
        {/if}

        {#if contextMenu.type === 'cell'}
            <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                onclick={() => onCopyValue(contextMenu.cellValue)}
            >
                <CopyIcon size={14} class="text-textcolor2 shrink-0" />
                <span>{language.postgresDbExplorerCopyValue}</span>
            </button>
            {#if contextMenu.row}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onCopyRowJson(contextMenu.row!)}
                >
                    <CopyIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyRowJson}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onViewDetail(contextMenu.row!)}
                >
                    <FileTextIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerViewDetail}</span>
                </button>
            {/if}
            {#if contextMenu.cellValue !== null && contextMenu.cellValue !== undefined}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onSearchValue(contextMenu.cellValue)}
                >
                    <SearchIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSearchThisValue}</span>
                </button>
            {/if}
            <div class="my-1 border-t border-darkborderc/60"></div>
            {#if contextMenu.columnName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={visibleNames.length <= 1}
                    onclick={() => onHideColumn(contextMenu.columnName!)}
                >
                    <EyeOffIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerHideColumn}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onShowOnlyColumn(contextMenu.columnName!)}
                >
                    <EyeIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerShowOnlyColumn}</span>
                </button>
            {/if}
        {:else if contextMenu.type === 'header'}
            {#if contextMenu.columnName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onSortColumn(contextMenu.columnName!, 'asc')}
                >
                    <ArrowUpIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSortAsc}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onSortColumn(contextMenu.columnName!, 'desc')}
                >
                    <ArrowDownIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerSortDesc}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onCopyColumnName(contextMenu.columnName!)}
                >
                    <CopyIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyColumnName}</span>
                </button>
                <div class="my-1 border-t border-darkborderc/60"></div>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={visibleNames.length <= 1}
                    onclick={() => onHideColumn(contextMenu.columnName!)}
                >
                    <EyeOffIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerHideColumn}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onShowOnlyColumn(contextMenu.columnName!)}
                >
                    <EyeIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerShowOnlyColumn}</span>
                </button>
                {#if hasHiddenColumns}
                    <button
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                        onclick={onShowAllColumns}
                    >
                        <Columns3Icon size={14} class="text-textcolor2 shrink-0" />
                        <span>{language.postgresDbExplorerAllColumns}</span>
                    </button>
                {/if}
            {/if}
        {:else if contextMenu.type === 'table'}
            {#if contextMenu.tableName}
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={() => onCopyTableName(contextMenu.tableName!)}
                >
                    <CopyIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerCopyTableName}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg md:rounded-md px-3 py-2 md:py-1.5 text-left text-sm md:text-xs text-textcolor transition-colors hover:bg-darkbutton active:bg-darkbutton"
                    onclick={onRefreshTable}
                >
                    <RefreshCwIcon size={14} class="text-textcolor2 shrink-0" />
                    <span>{language.postgresDbExplorerRefresh}</span>
                </button>
            {/if}
        {/if}
    </div>
{/if}
