<script lang="ts">
    import { PackageIcon, SearchIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import StorageTargetSelector from '../components/StorageTargetSelector.svelte'
    import { formatBytes } from '../utils'
    import type { ModuleSortType, ModuleStorageInfo, NodeS3ServerConfig, NodeStorageSummary, ViewTarget } from '../types'

    interface Props {
        modules: ModuleStorageInfo[]
        viewTarget: ViewTarget
        storageSummary: NodeStorageSummary | null
        config?: NodeS3ServerConfig | null
        busy?: boolean
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onSelectModule: (module: ModuleStorageInfo) => void
        onSwitchTarget: (target: ViewTarget) => void
    }

    const {
        modules,
        viewTarget,
        storageSummary,
        config,
        busy = false,
        thumbnailUrls,
        onLoadThumbnail,
        onSelectModule,
        onSwitchTarget
    }: Props = $props()

    let moduleSearch = $state('')
    let moduleSort = $state<ModuleSortType>('size_desc')

    const filteredModules = $derived.by(() => {
        let list = [...modules]
        if (moduleSearch.trim()) {
            const query = moduleSearch.trim().toLowerCase()
            list = list.filter((m) => m.name.toLowerCase().includes(query))
        }
        if (moduleSort === 'size_desc') {
            list.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
        } else if (moduleSort === 'size_asc') {
            list.sort((a, b) => a.totalSizeBytes - b.totalSizeBytes)
        } else if (moduleSort === 'count_desc') {
            list.sort((a, b) => b.totalAssets - a.totalAssets)
        } else {
            list.sort((a, b) => a.name.localeCompare(b.name))
        }
        return list
    })
</script>

<div class="flex flex-col gap-4">
    <!-- Controls: Search & Target Selector & Sort -->
    <div class="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
        <div class="relative min-w-[200px] flex-1 max-w-md">
            <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2 pointer-events-none" />
            <input
                type="text"
                bind:value={moduleSearch}
                placeholder={language.storageSearchModules}
                class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-8 text-xs sm:text-sm text-textcolor placeholder-textcolor2 focus:border-darkborderc/90 focus:outline-hidden"
            />
            {#if moduleSearch}
                <button
                    type="button"
                    class="absolute right-2.5 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor p-0.5"
                    onclick={() => moduleSearch = ''}
                    aria-label="Clear search"
                >
                    <XIcon class="h-3.5 w-3.5" />
                </button>
            {/if}
        </div>

        <div class="flex flex-wrap items-center gap-2.5 shrink-0">
            <!-- Storage Target Selector Menu -->
            <StorageTargetSelector
                {viewTarget}
                {storageSummary}
                {config}
                disabled={busy}
                {onSwitchTarget}
            />

            <!-- Sort Dropdown -->
            <div class="flex items-center gap-2 shrink-0">
                <span class="text-xs text-textcolor2 hidden sm:inline">{language.storageSort}:</span>
                <select
                    bind:value={moduleSort}
                    class="rounded-lg border border-darkborderc bg-darkbg px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-medium text-textcolor focus:border-darkborderc/90 focus:outline-hidden cursor-pointer"
                >
                    <option value="size_desc">{language.storageSortSizeDesc}</option>
                    <option value="size_asc">{language.storageSortSizeAsc}</option>
                    <option value="count_desc">{language.storageSortCountDesc}</option>
                    <option value="name_asc">{language.storageSortModuleNameAsc}</option>
                </select>
            </div>
        </div>
    </div>

    <!-- Module Cards Grid -->
    {#if filteredModules.length === 0}
        <div class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-darkborderc py-16 text-textcolor2">
            <PackageIcon class="h-12 w-12 opacity-30" />
            <p class="mt-2 text-sm">{language.storageNoModulesFound}</p>
        </div>
    {:else}
        <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {#each filteredModules as module (module.id)}
                <button
                    type="button"
                    class="group relative flex w-full cursor-pointer flex-col justify-between rounded-xl border border-darkborderc bg-darkbg/70 p-3.5 sm:p-4 text-left transition-all hover:border-darkborderc/90 hover:bg-darkbg hover:shadow-md active:scale-[0.99]"
                    onclick={() => onSelectModule(module)}
                >
                    <div class="w-full">
                        <h4 class="truncate text-sm font-bold text-textcolor">
                            {module.name}
                        </h4>
                        <div class="mt-1.5 flex items-center gap-2">
                            <span class="rounded-md bg-darkbutton border border-darkborderc/60 px-2 py-0.5 text-xs font-semibold text-textcolor">
                                {formatBytes(module.totalSizeBytes)}
                            </span>
                            <span class="text-xs text-textcolor2">
                                {module.totalAssets} {language.storageAssets}
                            </span>
                        </div>
                    </div>
                    <div class="mt-3 border-t border-darkborderc/50 pt-2.5 text-[11px] text-textcolor2">
                        {language.storageModuleAssets}: {module.assets.filter((a) => a.type === 'moduleAsset').length}
                    </div>
                </button>
            {/each}
        </div>
    {/if}
</div>
