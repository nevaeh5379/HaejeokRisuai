<script lang="ts">
    import {
        BarChart3Icon,
        HistoryIcon,
        SettingsIcon,
        TableIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { DbExplorerTabType } from './types'

    interface Props {
        currentTab: DbExplorerTabType
        tableCount: number
        revisionCount: number
        botCount: number
        onSelectTab: (tab: DbExplorerTabType) => void
    }

    const {
        currentTab,
        tableCount,
        revisionCount,
        botCount,
        onSelectTab
    }: Props = $props()
</script>

<nav class="flex shrink-0 overflow-x-auto border-b border-darkborderc bg-darkbg px-2 sm:px-4 select-none scrollbar-none">
    <!-- Tables Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'tables' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('tables')}
    >
        <TableIcon class="h-4 w-4 shrink-0" />
        <span>{language.dbExplorerTabTables}</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{tableCount}</span>
    </button>

    <!-- Config Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'config' ? 'border-sky-500 text-sky-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('config')}
    >
        <SettingsIcon class="h-4 w-4 shrink-0" />
        <span>{language.dbExplorerTabConfig}</span>
    </button>

    <!-- Stats Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'stats' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('stats')}
    >
        <BarChart3Icon class="h-4 w-4 shrink-0" />
        <span>{language.dbExplorerTabStats}</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{botCount}</span>
    </button>

    <!-- History Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'history' ? 'border-violet-500 text-violet-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('history')}
    >
        <HistoryIcon class="h-4 w-4 shrink-0" />
        <span>{language.dbExplorerTabHistory}</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{revisionCount}</span>
    </button>
</nav>
