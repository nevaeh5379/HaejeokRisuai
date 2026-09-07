<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
  import { language } from "src/lang";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { moduleStore, type ModuleRootItem } from 'src/ts/stores/domain/moduleStore.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule, type ModuleFolder } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, UserIcon, FolderPlus, FolderIcon, ChevronDown, ChevronRight, FolderInput, ArrowUp, ArrowDown, GripVertical } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertNormal, alertSelect, alertInput } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy, tick } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { getModelInfo } from "src/ts/model/modellist";
    import { sortableOptions } from "src/ts/util";

    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let moduleSearch = $state('')
    let charConversionMode = $state(false)
    let openFolders = $state<Set<string>>(new Set())
    let modules = $derived(moduleStore.list)
    let enabledModules = $derived(moduleStore.enabledModules)
    let moduleFolders = $derived(moduleStore.folders)
    let rootItems = $derived(moduleStore.getRootItems())

    let rootEle: HTMLDivElement | undefined = $state()
    let sorted = $state(0)
    let rootStb: any = null
    let folderStbMap = new Map<string, any>()

    let displayItems = $derived.by(() => {
        const q = moduleSearch.trim().toLowerCase()
        if (!q) return rootItems
        const result: ModuleRootItem[] = []
        for (const item of rootItems) {
            if (item.type === 'folder') {
                const matchingModules = item.modules.filter((m) =>
                    m.name.toLowerCase().includes(q) ||
                    (m.description && m.description.toLowerCase().includes(q))
                )
                if (matchingModules.length > 0 || item.folder.name.toLowerCase().includes(q)) {
                    result.push({
                        type: 'folder',
                        folder: item.folder,
                        modules: matchingModules,
                    })
                }
            } else {
                if (
                    item.module.name.toLowerCase().includes(q) ||
                    (item.module.description && item.module.description.toLowerCase().includes(q))
                ) {
                    result.push(item)
                }
            }
        }
        return result
    })

    function toggleFolder(id: string) {
        const next = new Set(openFolders)
        if (next.has(id)) {
            next.delete(id)
        } else {
            next.add(id)
        }
        openFolders = next
    }

    async function createFolder() {
        const name = await alertInput(language.folderName)
        if (!name || name.trim() === '') return
        await moduleStore.addFolder(name.trim())
    }

    async function renameFolder(folder: ModuleFolder) {
        const name = await alertInput(language.changeFolderName, undefined, folder.name)
        if (!name || name.trim() === '') return
        await moduleStore.renameFolder(folder.id, name.trim())
    }

    async function removeFolder(folder: ModuleFolder) {
        const d = await alertConfirm(language.removeFolderConfirm)
        if (!d) return
        await moduleStore.removeFolder(folder.id)
    }

    async function moveModuleToFolder(module: RisuModule) {
        const folders = moduleFolders
        const options = [
            language.noFolder,
            ...folders.map((f) => f.name),
        ]
        const sel = parseInt(await alertSelect(options))
        if (Number.isNaN(sel)) return
        if (sel === 0) {
            await moduleStore.moveModuleToFolder(module.id, undefined)
        } else {
            const folder = folders[sel - 1]
            if (folder) {
                await moduleStore.moveModuleToFolder(module.id, folder.id)
            }
        }
    }

    function destroySortable() {
        if (rootStb) {
            try { rootStb.destroy() } catch {}
            rootStb = null
        }
        for (const stb of folderStbMap.values()) {
            try { stb.destroy() } catch {}
        }
        folderStbMap.clear()
    }

    $effect(() => {
        const _search = moduleSearch
        const _items = rootItems
        const _open = openFolders
        const _sorted = sorted
        const _ele = rootEle

        if (!_ele || _search !== '') {
            destroySortable()
            return
        }

        let cancelled = false
        tick().then(async () => {
            if (cancelled || !_ele || moduleSearch !== '') return
            destroySortable()
            const { default: Sortable } = await import('sortablejs/modular/sortable.core.esm.js')
            if (cancelled || !_ele || moduleSearch !== '') return

            rootStb = Sortable.create(_ele, {
                handle: '.root-drag-handle',
                draggable: '.root-sort-item',
                onEnd: async (evt) => {
                    if (evt.oldIndex === undefined || evt.newIndex === undefined || evt.oldIndex === evt.newIndex) return
                    await moduleStore.moveRootItem(evt.oldIndex, evt.newIndex)
                    sorted += 1
                },
                ...sortableOptions,
            })

            const folderContainers = _ele.querySelectorAll<HTMLDivElement>('[data-folder-container-id]')
            folderContainers.forEach((container) => {
                const folderId = container.getAttribute('data-folder-container-id')
                if (!folderId) return
                const stb = Sortable.create(container, {
                    handle: '.module-drag-handle',
                    draggable: '.folder-module-item',
                    onEnd: async (evt) => {
                        if (evt.oldIndex === undefined || evt.newIndex === undefined || evt.oldIndex === evt.newIndex) return
                        const fModules = moduleStore.modulesInFolder(folderId)
                        const copy = fModules.map((m) => m.id)
                        const [moved] = copy.splice(evt.oldIndex, 1)
                        copy.splice(evt.newIndex, 0, moved)
                        await moduleStore.reorderFolderModules(folderId, copy)
                        sorted += 1
                    },
                    ...sortableOptions,
                })
                folderStbMap.set(folderId, stb)
            })
        })

        return () => {
            cancelled = true
            destroySortable()
        }
    })

    onDestroy(() => {
        destroySortable()
        refreshModules()
    })
</script>
{#if mode === 0}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.modules}</h2>

    <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

    <div bind:this={rootEle} class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto">
        {#if modules.length === 0 && moduleFolders.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else if displayItems.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else}
            {#each displayItems as item, i (item.type === 'folder' ? 'folder:' + item.folder.id : item.module.id)}
                {#if i !== 0}
                    <div class="border-t-1 border-selected"></div>
                {/if}
                {#if item.type === 'folder'}
                    <div class="root-sort-item flex flex-col">
                        <div class="w-full flex items-center pl-3 pr-3 py-2 text-left">
                            {#if moduleSearch === ''}
                                <div class="root-drag-handle mr-2 cursor-grab text-textcolor2 hover:text-textcolor shrink-0" title="Drag to reorder">
                                    <GripVertical size={16} />
                                </div>
                            {/if}
                            <button
                                class="grow flex items-center text-left hover:bg-textcolor/5 cursor-pointer pl-1 py-1"
                                onclick={() => toggleFolder(item.folder.id)}
                            >
                                {#if openFolders.has(item.folder.id)}
                                    <ChevronDown size={18} class="mr-2 text-textcolor2 shrink-0" />
                                {:else}
                                    <ChevronRight size={18} class="mr-2 text-textcolor2 shrink-0" />
                                {/if}
                                <FolderIcon size={18} class="mr-2 text-textcolor2 shrink-0" />
                                <span class="text-lg font-semibold truncate">{item.folder.name}</span>
                                <span class="ml-2 text-sm text-textcolor2 shrink-0">({item.modules.length})</span>
                            </button>
                            {#if moduleSearch === ''}
                                <button
                                    class="text-textcolor2 hover:text-textcolor p-1 mr-1 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                                    disabled={i === 0}
                                    onclick={async (e) => {
                                        e.stopPropagation()
                                        await moduleStore.moveFolder(item.folder.id, 'up')
                                    }}
                                >
                                    <ArrowUp size={16} />
                                </button>
                                <button
                                    class="text-textcolor2 hover:text-textcolor p-1 mr-2 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                                    disabled={i === displayItems.length - 1}
                                    onclick={async (e) => {
                                        e.stopPropagation()
                                        await moduleStore.moveFolder(item.folder.id, 'down')
                                    }}
                                >
                                    <ArrowDown size={16} />
                                </button>
                            {/if}
                            <button
                                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                use:tooltip={language.renameFolder}
                                onclick={async (e) => {
                                    e.stopPropagation()
                                    await renameFolder(item.folder)
                                }}
                            >
                                <SquarePen size={16} />
                            </button>
                            <button
                                class="text-textcolor2 hover:text-red-500 ml-1 cursor-pointer"
                                use:tooltip={language.removeFolder}
                                onclick={async (e) => {
                                    e.stopPropagation()
                                    await removeFolder(item.folder)
                                }}
                            >
                                <TrashIcon size={16} />
                            </button>
                        </div>
                        {#if openFolders.has(item.folder.id)}
                            <div data-folder-container-id={item.folder.id} class="flex flex-col pl-4 border-t-1 border-selected/50 bg-textcolor/2">
                                {#each item.modules as fmodule, mIdx (fmodule.id)}
                                    <div class="folder-module-item flex flex-col">
                                        {@render moduleRow(fmodule, false, mIdx, item.modules.length, mIdx !== 0)}
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {:else}
                    <div class="root-sort-item flex flex-col">
                        {@render moduleRow(item.module, true, i, displayItems.length, false)}
                    </div>
                {/if}
            {/each}
        {/if}
    </div>

    <div class="flex mr-2 mt-4">
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.createModule} onclick={async () => {
            tempModule = {
                name: '',
                description: '',
                id: v4(),
            }
            mode = 1
        }}>
            <PlusIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.createFolder} onclick={createFolder}>
            <FolderPlus />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            charConversionMode = !charConversionMode
        }}>
            <UserIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.importModule} onclick={async () => {
            importMCPModule()
        }}>
            <Waypoints />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.importModule} onclick={async () => {
            importModule()
        }}>
            <HardDriveUpload  />
        </button>
    </div>
{:else if mode === 1}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.createModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={async () => {
        await moduleStore.installModule(tempModule)
        mode = 0
    }}>{language.createModule}</Button>
{:else if mode === 2}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={async () => {
            await moduleStore.updateModule(tempModule.id, tempModule)
            mode = 0
        }}>{language.editModule}</Button>
    {/if}
{/if}

{#snippet moduleRow(rmodule: RisuModule, isRoot: boolean, index: number, totalCount: number, showDivider: boolean)}
    {#if showDivider}
        <div class="border-t-1 border-selected/50"></div>
    {/if}

    <div class="pl-3 pt-3 pr-3 text-left flex items-center">
        {#if moduleSearch === ''}
            <div
                class={isRoot ? "root-drag-handle mr-2 cursor-grab text-textcolor2 hover:text-textcolor shrink-0" : "module-drag-handle mr-2 cursor-grab text-textcolor2 hover:text-textcolor shrink-0"}
                title="Drag to reorder"
            >
                <GripVertical size={16} />
            </div>
        {/if}
        {#if rmodule.mcp}
            <Waypoints size={18} class="mr-2 shrink-0" />
        {/if}
        <span class="text-lg truncate">{rmodule.name}</span>
        <div class="grow flex justify-end items-center">
            {#if charConversionMode}
                <button class="cursor-pointer text-violet-500 mr-2" onclick={async (e) => {
                    e.stopPropagation()
                    const module = moduleStore.getById(rmodule.id)
                    if (!module) return
                    const char = convertModuleToCharacter(module)
                    characterStore.characters.push(char)
                    alertNormal(language.successfullyConverted)
                    checkCharOrder()
                }}>
                    <UserIcon size={18}/>
                </button>
            {:else}
                {#if moduleSearch === ''}
                    <button
                        class="text-textcolor2 hover:text-textcolor p-1 mr-1 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                        disabled={index === 0}
                        onclick={async (e) => {
                            e.stopPropagation()
                            if (isRoot) {
                                await moduleStore.moveRootModule(rmodule.id, 'up')
                            } else {
                                await moduleStore.moveFolderModule(rmodule.id, 'up')
                            }
                        }}
                    >
                        <ArrowUp size={16} />
                    </button>
                    <button
                        class="text-textcolor2 hover:text-textcolor p-1 mr-2 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                        disabled={index === totalCount - 1}
                        onclick={async (e) => {
                            e.stopPropagation()
                            if (isRoot) {
                                await moduleStore.moveRootModule(rmodule.id, 'down')
                            } else {
                                await moduleStore.moveFolderModule(rmodule.id, 'down')
                            }
                        }}
                    >
                        <ArrowDown size={16} />
                    </button>
                {/if}
                <button class={(enabledModules.includes(rmodule.id)) ?
                        "mr-2 cursor-pointer text-blue-500" :
                        rmodule.namespace &&
                        presetStore.state.moduleIntergration?.split(',').map((s: string) => s.trim()).includes(rmodule.namespace) ?
                        "text-amber-500 hover:text-green-500 mr-2 cursor-pointer" :
                        "text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                    } use:tooltip={language.enableGlobal} onclick={async (e) => {
                    e.stopPropagation()
                    await moduleStore.toggleModule(rmodule.id)
                    charConversionMode = false
                }}>
                    <Globe size={18}/>
                </button>
                {#if !rmodule.mcp}
                    <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.download} onclick={async (e) => {
                        e.stopPropagation()
                        const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
                        if(sel === 0){
                            exportModule(rmodule)
                        }
                        else{
                            exportModuleLegacy(rmodule)
                        }
                        charConversionMode = false
                    }}>
                        <Share2Icon size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.edit} onclick={async (e) => {
                        e.stopPropagation()
                        tempModule = rmodule
                        mode = 2
                    }}>
                        <SquarePen size={18}/>
                    </button>
                {:else}
                    <button class="text-textcolor2 mr-2 cursor-not-allowed">
                        <Share2Icon size={18}/>
                    </button>
                    <button class="text-textcolor2 mr-2 cursor-not-allowed">
                        <SquarePen size={18}/>
                    </button>
                {/if}
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.moveToFolder} onclick={async (e) => {
                    e.stopPropagation()
                    await moveModuleToFolder(rmodule)
                }}>
                    <FolderInput size={18}/>
                </button>
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.remove} onclick={async (e) => {
                    e.stopPropagation()
                    const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                    if(d){
                        await moduleStore.removeModule(rmodule.id)
                    }
                }}>
                    <TrashIcon size={18}/>
                </button>
            {/if}

        </div>
    </div>
    <div class="mt-1 mb-3 pl-3 pr-3 flex flex-wrap items-center gap-2">
        <span class="text-sm text-textcolor2">{rmodule.description || 'No description provided'}</span>
        {#if settingsStore.state.enableModuleSubModel && rmodule.subModel}
            <span class="text-xs px-2 py-0.5 rounded-md bg-selected/50 text-textcolor border border-darkborderc flex items-center gap-1">
                <span class="text-textcolor2">{language.submodel}:</span>
                {getModelInfo(rmodule.subModel)?.fullName || rmodule.subModel}
            </span>
        {/if}
    </div>
{/snippet}
