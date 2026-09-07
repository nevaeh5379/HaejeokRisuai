<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
  import { language } from "src/lang";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { moduleStore, type ModuleRootItem } from 'src/ts/stores/domain/moduleStore.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule, type ModuleFolder } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, UserIcon, FolderPlus, FolderIcon, ChevronDown, ChevronRight, FolderInput, FolderOutput, ArrowUp, ArrowDown, GripVertical } from "@lucide/svelte";
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
    let hoverFolderId: string | null = null
    let hoverFolderTimer: any = null
    let scrollPos = 0

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
        if (folders.length === 0) {
            alertNormal(language.noFolder)
            return
        }
        const isInsideFolder = module.folderId !== undefined
        const options = isInsideFolder
            ? [language.removeFromFolder || language.noFolder, ...folders.map((f) => f.name)]
            : folders.map((f) => f.name)
        const sel = parseInt(await alertSelect(options))
        if (Number.isNaN(sel)) return
        if (isInsideFolder) {
            if (sel === 0) {
                await moduleStore.moveModule(module.id, undefined)
            } else {
                const folder = folders[sel - 1]
                if (folder) {
                    await moduleStore.moveModule(module.id, folder.id)
                }
            }
        } else {
            const folder = folders[sel]
            if (folder) {
                await moduleStore.moveModule(module.id, folder.id)
            }
        }
    }

    let isDragging = false
    let autoScrollRaf: number | null = null
    let autoScrollSpeed = 0
    let scrollTargetEl: HTMLElement | null = null
    let lastTouchX = 0
    let lastTouchY = 0

    function findScrollParent(el: HTMLElement | null): HTMLElement | null {
        let node = el?.parentElement ?? null
        while (node && node !== document.body && node !== document.documentElement) {
            const style = window.getComputedStyle(node)
            const overflowY = style.overflowY
            if (
                (overflowY === 'auto' || overflowY === 'scroll') &&
                node.scrollHeight > node.clientHeight
            ) {
                return node
            }
            node = node.parentElement
        }
        return (document.scrollingElement as HTMLElement) || document.documentElement
    }

    function autoScrollTick() {
        if (!isDragging || autoScrollSpeed === 0) {
            autoScrollRaf = null
            return
        }

        let scrolled = false
        if (rootEle && rootEle.scrollHeight > rootEle.clientHeight + 4) {
            if (autoScrollSpeed > 0 && rootEle.scrollTop + rootEle.clientHeight < rootEle.scrollHeight - 2) {
                rootEle.scrollTop += autoScrollSpeed
                scrolled = true
            } else if (autoScrollSpeed < 0 && rootEle.scrollTop > 2) {
                rootEle.scrollTop += autoScrollSpeed
                scrolled = true
            }
        }

        if (!scrolled) {
            if (!scrollTargetEl || !scrollTargetEl.isConnected) {
                scrollTargetEl = findScrollParent(rootEle)
            }
            if (scrollTargetEl) {
                scrollTargetEl.scrollTop += autoScrollSpeed
            }
        }

        try {
            const target = document.elementFromPoint(lastTouchX, lastTouchY)
            if (target) {
                target.dispatchEvent(new PointerEvent('pointermove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: lastTouchX,
                    clientY: lastTouchY,
                }))
            }
        } catch {}

        autoScrollRaf = requestAnimationFrame(autoScrollTick)
    }

    function handlePointerMoveForScroll(e: PointerEvent | TouchEvent) {
        if (!isDragging) {
            stopAutoScroll()
            return
        }

        const touch = 'touches' in e && e.touches.length > 0 ? e.touches[0] : (e as PointerEvent)
        if (!touch || touch.clientY === undefined) return

        lastTouchX = touch.clientX
        lastTouchY = touch.clientY

        const clientY = touch.clientY
        const vh = window.innerHeight
        const threshold = 120

        let speed = 0

        // 1. Check relative to rootEle if rootEle has internal scroll
        if (rootEle && rootEle.scrollHeight > rootEle.clientHeight + 4) {
            const rect = rootEle.getBoundingClientRect()
            if (clientY > rect.bottom - 80 && clientY < rect.bottom + 60) {
                const ratio = Math.min(1, Math.max(0, (clientY - (rect.bottom - 80)) / 80))
                speed = Math.round(4 + ratio * 20)
            } else if (clientY < rect.top + 80 && clientY > rect.top - 60) {
                const ratio = Math.min(1, Math.max(0, (rect.top + 80 - clientY) / 80))
                speed = -Math.round(4 + ratio * 20)
            }
        }

        // 2. If not scrolling rootEle or rootEle is near edge, check viewport edges (for outer container)
        if (speed === 0) {
            if (clientY > vh - threshold) {
                const ratio = Math.min(1, Math.max(0, (clientY - (vh - threshold)) / threshold))
                speed = Math.round(4 + ratio * 20)
            } else if (clientY < threshold) {
                const ratio = Math.min(1, Math.max(0, (threshold - clientY) / threshold))
                speed = -Math.round(4 + ratio * 20)
            }
        }

        autoScrollSpeed = speed

        if (autoScrollSpeed !== 0 && !autoScrollRaf) {
            autoScrollRaf = requestAnimationFrame(autoScrollTick)
        }
    }

    function startAutoScroll() {
        stopAutoScroll()
        scrollTargetEl = findScrollParent(rootEle)
        window.addEventListener('pointermove', handlePointerMoveForScroll, { passive: true })
        window.addEventListener('touchmove', handlePointerMoveForScroll, { passive: true })
    }

    function stopAutoScroll() {
        if (autoScrollRaf) {
            cancelAnimationFrame(autoScrollRaf)
            autoScrollRaf = null
        }
        autoScrollSpeed = 0
        window.removeEventListener('pointermove', handlePointerMoveForScroll)
        window.removeEventListener('touchmove', handlePointerMoveForScroll)
    }

    const sortableMergedOptions = {
        ...sortableOptions,
        delay: 0,
        delayOnTouchOnly: false,
        touchStartThreshold: 3,
        scroll: true,
        scrollSensitivity: 100,
        scrollSpeed: 20,
        bubbleScroll: true,
        forceAutoScrollFallback: true,
    }

    function destroyRootSortable() {
        if (isDragging) return
        if (rootStb) {
            try { rootStb.destroy() } catch {}
            rootStb = null
        }
    }

    function destroySortable() {
        if (hoverFolderTimer) {
            clearTimeout(hoverFolderTimer)
            hoverFolderTimer = null
        }
        hoverFolderId = null
        if (isDragging) return
        destroyRootSortable()
        for (const stb of folderStbMap.values()) {
            try { stb.destroy() } catch {}
        }
        folderStbMap.clear()
    }

    const checkFolderHover = (event: any) => {
        if (event.related?.className?.indexOf?.('no-sort') !== -1) return false
        const folderEl = event.related?.closest?.('[data-folder-id]')
        if (folderEl) {
            const fId = folderEl.getAttribute('data-folder-id')
            if (fId && !openFolders.has(fId)) {
                if (hoverFolderId !== fId) {
                    if (hoverFolderTimer) clearTimeout(hoverFolderTimer)
                    hoverFolderId = fId
                    hoverFolderTimer = setTimeout(() => {
                        if (hoverFolderId === fId) {
                            const next = new Set(openFolders)
                            next.add(fId)
                            openFolders = next
                        }
                    }, 500)
                }
            }
        } else {
            if (hoverFolderTimer) {
                clearTimeout(hoverFolderTimer)
                hoverFolderTimer = null
            }
            hoverFolderId = null
        }
        return true
    }

    const handleSortEnd = async (evt: any) => {
        isDragging = false
        stopAutoScroll()
        if (hoverFolderTimer) {
            clearTimeout(hoverFolderTimer)
            hoverFolderTimer = null
        }
        hoverFolderId = null

        const fromEl: HTMLElement = evt.from
        const toEl: HTMLElement = evt.to
        const itemEl: HTMLElement = evt.item
        const oldIndex: number | undefined = evt.oldIndex
        const newIndex: number | undefined = evt.newIndex

        if (oldIndex === undefined || newIndex === undefined) return
        if (fromEl === toEl && oldIndex === newIndex) return

        scrollPos = rootEle?.scrollTop ?? 0

        if (fromEl === toEl) {
            if (fromEl === rootEle) {
                await moduleStore.moveRootItem(oldIndex, newIndex)
            } else {
                const folderId = fromEl.getAttribute('data-folder-container-id')
                if (folderId) {
                    const fModules = moduleStore.modulesInFolder(folderId)
                    const copy = fModules.map((m) => m.id)
                    const [moved] = copy.splice(oldIndex, 1)
                    copy.splice(newIndex, 0, moved)
                    await moduleStore.reorderFolderModules(folderId, copy)
                }
            }
        } else {
            const moduleId = itemEl.getAttribute('data-module-id')
            if (itemEl.parentNode) {
                itemEl.remove()
            }
            if (!moduleId) return

            if (toEl === rootEle) {
                await moduleStore.moveModule(moduleId, undefined, newIndex)
            } else {
                const targetFolderId = toEl.getAttribute('data-folder-container-id')
                if (targetFolderId) {
                    await moduleStore.moveModule(moduleId, targetFolderId, newIndex)
                }
            }
        }
        sorted += 1
    }

    function folderSortable(node: HTMLElement, folderId: string) {
        let stb: any = null
        let cancelled = false

        import('sortablejs/modular/sortable.core.esm.js').then(({ default: Sortable }) => {
            if (cancelled || !node) return
            stb = Sortable.create(node, {
                handle: '.module-drag-handle',
                draggable: '.sortable-item',
                animation: 150,
                group: {
                    name: 'modules-group',
                    pull: true,
                    put: (to: any, from: any, dragEl: HTMLElement) => {
                        return dragEl.getAttribute('data-item-type') !== 'folder'
                    },
                },
                onStart: () => {
                    isDragging = true
                    startAutoScroll()
                },
                onMove: checkFolderHover,
                onEnd: handleSortEnd,
                ...sortableMergedOptions,
            })
            folderStbMap.set(folderId, stb)
        })

        return {
            destroy() {
                cancelled = true
                if (stb) {
                    try { stb.destroy() } catch {}
                }
                folderStbMap.delete(folderId)
            }
        }
    }

    $effect(() => {
        const _search = moduleSearch
        const _sorted = sorted
        const _ele = rootEle

        if (!_ele || _search !== '') {
            if (!isDragging) destroySortable()
            return
        }

        let cancelled = false
        tick().then(async () => {
            if (cancelled || !_ele || moduleSearch !== '' || isDragging) return
            destroyRootSortable()
            const { default: Sortable } = await import('sortablejs/modular/sortable.core.esm.js')
            if (cancelled || !_ele || moduleSearch !== '' || isDragging) return

            if (scrollPos > 0) {
                _ele.scrollTop = scrollPos
            }

            rootStb = Sortable.create(_ele, {
                handle: '.root-drag-handle',
                draggable: '.sortable-item',
                animation: 150,
                group: {
                    name: 'modules-group',
                    pull: (to: any, from: any, dragEl: HTMLElement) => {
                        if (dragEl.getAttribute('data-item-type') === 'folder') {
                            return to.el === _ele
                        }
                        return true
                    },
                    put: (to: any, from: any, dragEl: HTMLElement) => {
                        return true
                    },
                },
                onStart: () => {
                    isDragging = true
                    startAutoScroll()
                },
                onMove: checkFolderHover,
                onEnd: handleSortEnd,
                ...sortableMergedOptions,
            })
        })

        return () => {
            cancelled = true
            if (!isDragging) destroyRootSortable()
        }
    })

    onDestroy(() => {
        stopAutoScroll()
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
                {#if item.type === 'folder'}
                    <div
                        class="root-sort-item sortable-item flex flex-col {i !== 0 ? 'border-t-1 border-selected' : ''}"
                        data-item-type="folder"
                        data-folder-id={item.folder.id}
                    >
                        <div class="w-full flex items-center pl-3 pr-3 py-1.5 text-left">
                            {#if moduleSearch === ''}
                                <div
                                    class="root-drag-handle w-10 h-10 -ml-2 mr-1 flex items-center justify-center cursor-grab active:cursor-grabbing text-textcolor2 hover:text-textcolor shrink-0 touch-none select-none rounded hover:bg-textcolor/5 active:bg-textcolor/10"
                                    title="Drag to reorder"
                                >
                                    <GripVertical size={18} />
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
                            <div
                                data-folder-container-id={item.folder.id}
                                use:folderSortable={item.folder.id}
                                class="flex flex-col pl-4 border-t-1 border-selected/50 bg-textcolor/2 min-h-[44px]"
                            >
                                {#if item.modules.length === 0}
                                    <div class="empty-placeholder text-textcolor2/60 text-xs py-3 text-center italic pointer-events-none">
                                        {language.noModules}
                                    </div>
                                {/if}
                                {#each item.modules as fmodule, mIdx (fmodule.id)}
                                    <div
                                        class="folder-module-item sortable-item flex flex-col"
                                        data-item-type="module"
                                        data-module-id={fmodule.id}
                                    >
                                        {@render moduleRow(fmodule, false, mIdx, item.modules.length, mIdx !== 0)}
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {:else}
                    <div
                        class="root-sort-item sortable-item flex flex-col {i !== 0 ? 'border-t-1 border-selected' : ''}"
                        data-item-type="module"
                        data-module-id={item.module.id}
                    >
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

    <div class="pl-3 pt-2.5 pr-3 text-left flex items-center">
        {#if moduleSearch === ''}
            <div
                class="{isRoot ? 'root-drag-handle' : 'module-drag-handle'} w-10 h-10 -ml-2 mr-1 flex items-center justify-center cursor-grab active:cursor-grabbing text-textcolor2 hover:text-textcolor shrink-0 touch-none select-none rounded hover:bg-textcolor/5 active:bg-textcolor/10"
                title="Drag to reorder"
            >
                <GripVertical size={18} />
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
                {#if !isRoot}
                    <button
                        class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
                        use:tooltip={language.removeFromFolder}
                        onclick={async (e) => {
                            e.stopPropagation()
                            await moduleStore.moveModule(rmodule.id, undefined)
                        }}
                    >
                        <FolderOutput size={18}/>
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
