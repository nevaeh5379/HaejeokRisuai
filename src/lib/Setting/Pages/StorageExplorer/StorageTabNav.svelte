<script lang="ts">
    import {
        DatabaseIcon,
        LayersIcon,
        PackageIcon,
        UserIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { TabType, ViewTarget } from './types'

    interface Props {
        currentTab: TabType
        viewTarget: ViewTarget
        botCount: number
        moduleCount: number
        fileCount: number
        onSelectTab: (tab: TabType) => void
    }

    const {
        currentTab,
        viewTarget,
        botCount,
        moduleCount,
        fileCount,
        onSelectTab
    }: Props = $props()
</script>

<nav class="flex shrink-0 overflow-x-auto border-b border-darkborderc bg-darkbg px-2 sm:px-4 select-none scrollbar-none">
    <!-- Bots Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'bots' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('bots')}
    >
        <UserIcon class="h-4 w-4 shrink-0" />
        <span>{language.storageTabBots}</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{botCount}</span>
    </button>

    <!-- Modules Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'modules' ? 'border-violet-500 text-violet-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('modules')}
    >
        <PackageIcon class="h-4 w-4 shrink-0" />
        <span>{language.storageTabModules}</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{moduleCount}</span>
    </button>

    <!-- Backend Config Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'backend' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('backend')}
    >
        <DatabaseIcon class="h-4 w-4 shrink-0" />
        <span>{language.storageTabBackend}</span>
    </button>

    <!-- All Files Tab -->
    <button
        type="button"
        class="flex items-center gap-1.5 sm:gap-2 border-b-2 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap cursor-pointer {currentTab === 'files' ? 'border-blue-500 text-blue-400 font-semibold' : 'border-transparent text-textcolor2 hover:text-textcolor'}"
        onclick={() => onSelectTab('files')}
    >
        <LayersIcon class="h-4 w-4 shrink-0" />
        <span>{language.storageTabAllFiles} ({viewTarget.toUpperCase()})</span>
        <span class="rounded-full bg-darkbutton px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{fileCount}</span>
    </button>
</nav>
