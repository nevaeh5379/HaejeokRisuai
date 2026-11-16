<script lang="ts">
    import { alertCardExport, alertConfirm, alertError, alertInput, alertSelect } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToPreset, copyPreset, downloadPreset, importPreset } from "../../ts/storage/presets/presetService";
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { CopyIcon, Share2Icon, PencilIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon, GitCompare, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, FolderIcon, FolderInputIcon, FolderPlusIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { groupByFolder } from "src/ts/folders";
    import type { PromptPresetFolder } from "src/ts/storage/database/schema";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import { ShowRealmFrameStore, presetSelectCallback } from "src/ts/stores.svelte";
    import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
    import { get } from "svelte/store";
    import PromptDiffModal from "../Others/PromptDiffModal.svelte";
    import { RISU_PRESET_DRAG_TYPE } from "src/ts/dragTypes";
    import { safeStructuredClone } from "src/ts/polyfill";
    import { presetStore } from 'src/ts/stores/domain/presetStore.svelte';

    let editMode = $state(false)
    let isDragging = $state(false)
    let dragOverIndex = $state(-1)

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Drop a pending callback when the list unmounts so it cannot fire later.
    $effect(() => {
        return () => {
            presetSelectCallback.set(null)
        }
    })

    // Binding mode (opened from the sidebar): a top "default" row unbinds and
    // the highlighted item is the chat's bound preset.
    const bindingMode = $derived($presetSelectCallback !== null)
    const highlightId = $derived(
        bindingMode
            ? (characterStore.getCurrentChat()?.bindedBotPreset ?? '')
            : presetStore.activeId
    )
    const activePresetName = $derived(
        presetStore.summaries.find((preset) => preset.id === presetStore.activeId)?.name ?? language.none
    )

    function select(index: number) {
        const callback = get(presetSelectCallback)
        if (callback) {
            presetSelectCallback.set(null)
            callback(index)
        } else {
            void changeToPreset(index)
        }
        close()
    }

    let showDiffModal = $state(false)
    let selectedDiffPreset = $state<number | null>(null)
    let firstPresetId = $state<number | null>(null);
    let secondPresetId = $state<number | null>(null);

    const folders = $derived(settingsStore.state.promptPresetFolders ?? [])
    const assignments = $derived(settingsStore.state.promptPresetFolderAssignments ?? {})
    const groups = $derived(groupByFolder(
        presetStore.summaries.map((preset) => assignments[preset.id]),
        folders,
    ))

    // Folders start collapsed and the uncategorized group ('') starts open,
    // so for '' the set records "collapsed" instead of "expanded".
    let toggled = $state<Set<string>>(new Set())

    function isOpen(key: string) {
        return key === '' ? !toggled.has(key) : toggled.has(key)
    }

    function toggleFolder(key: string) {
        const next = new Set(toggled)
        if (next.has(key)) next.delete(key); else next.add(key)
        toggled = next
    }

    function setPresetFolder(presetId: string, folderId: string | undefined) {
        const next = { ...assignments }
        if (folderId) next[presetId] = folderId
        else delete next[presetId]
        settingsStore.state.promptPresetFolderAssignments = next
    }

    async function createFolder() {
        const name = (await alertInput(language.folderName)).trim()
        if (!name) return
        const folder: PromptPresetFolder = { id: v4(), name }
        settingsStore.state.promptPresetFolders = [...folders, folder]
        toggleFolder(folder.id)
    }

    async function renameFolder(folder: PromptPresetFolder) {
        const name = (await alertInput(language.changeFolderName, undefined, folder.name)).trim()
        if (!name) return
        settingsStore.state.promptPresetFolders = folders.map((item) =>
            item.id === folder.id ? { ...item, name } : item)
    }

    async function removeFolder(folder: PromptPresetFolder) {
        if (!(await alertConfirm(language.presetFolderRemoveConfirm))) return
        settingsStore.state.promptPresetFolders = folders.filter((item) => item.id !== folder.id)
        settingsStore.state.promptPresetFolderAssignments = Object.fromEntries(
            Object.entries(assignments).filter(([, folderId]) => folderId !== folder.id))
    }

    function moveFolder(index: number, delta: number) {
        const target = index + delta
        if (target < 0 || target >= folders.length) return
        const next = [...folders]
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        settingsStore.state.promptPresetFolders = next
    }

    async function chooseFolder(presetId: string) {
        const sel = parseInt(await alertSelect([
            language.folderUncategorized,
            ...folders.map((folder) => folder.name),
            language.cancel,
        ]))
        if (Number.isNaN(sel) || sel > folders.length) return
        setPresetFolder(presetId, sel === 0 ? undefined : folders[sel - 1].id)
    }

    async function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= presetStore.summaries.length || toIndex > presetStore.summaries.length) return;

        let botPresets = [...presetStore.summaries];
        const movedItem = botPresets.splice(fromIndex, 1)[0];
        if (!movedItem) return;

        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        botPresets.splice(adjustedToIndex, 0, movedItem);

        await presetStore.reorder(botPresets.map((preset) => preset.id));
    }

    function isPresetDrag(e: DragEvent) {
        return e.dataTransfer?.types.includes(RISU_PRESET_DRAG_TYPE) ?? false;
    }

    function markPresetDrag(e: DragEvent, index: number) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'preset');
        e.dataTransfer.setData(RISU_PRESET_DRAG_TYPE, index.toString());
    }

    // `folderId` is the folder of the drop target; `false` keeps the dragged
    // preset in the folder it already has.
    function handlePresetDrop(targetIndex: number, e: DragEvent, folderId: string | undefined | false = false) {
        if (!isPresetDrag(e)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const sourceIndex = parseInt(e.dataTransfer?.getData(RISU_PRESET_DRAG_TYPE) || '0');
        const source = presetStore.summaries[sourceIndex]
        if (source && folderId !== false) setPresetFolder(source.id, folderId)
        if (targetIndex >= 0) movePreset(sourceIndex, targetIndex);
    }


    async function handleDiffMode(id: number) {
        await presetStore.load(presetStore.summaries[id].id)
        if (selectedDiffPreset === id) {
            selectedDiffPreset = null
            firstPresetId = null
            secondPresetId = null
            return
        }
        
        selectedDiffPreset = id

        if (firstPresetId === null) {
            firstPresetId = id
            secondPresetId = null
            return
        }

        secondPresetId = id
        await presetStore.load(presetStore.summaries[firstPresetId].id)
        selectedDiffPreset = null
        showDiffModal = true
    }

    function closeDiff() {
        showDiffModal = false;
        firstPresetId = null;
        secondPresetId = null;
        selectedDiffPreset = null;
    }

</script>

<div class="absolute w-full h-full z-[70] bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.presets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#if bindingMode}
            <button onclick={() => select(-1)}
                class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 mb-1 cursor-pointer"
                class:bg-selected={!highlightId}>
                <span class="font-medium">{language.bindingInherit}</span>
                <span class="opacity-75 ml-1">({activePresetName})</span>
            </button>
        {/if}
        {#each groups as group, groupIndex (group.folder?.id ?? '')}
        {@const folderKey = group.folder?.id ?? ''}
        {#if folders.length > 0}
            <div class="flex items-center gap-2 w-full rounded-md px-2 py-2 mt-1 text-textcolor cursor-pointer hover:bg-selected/30 select-none"
                role="button" tabindex="0"
                onclick={() => toggleFolder(folderKey)}
                onkeydown={(e) => { if (e.key === 'Enter') toggleFolder(folderKey) }}
                ondragover={(e) => {
                    if (!isPresetDrag(e)) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                }}
                ondrop={(e) => handlePresetDrop(-1, e, group.folder?.id)}>
                {#if isOpen(folderKey)}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                <FolderIcon size={16} class="shrink-0 text-textcolor2"/>
                <span class="grow min-w-0 text-left truncate" class:text-textcolor2={!group.folder}>{group.folder?.name ?? language.folderUncategorized}</span>
                <span class="text-xs text-textcolor2">{group.indexes.length}</span>
                {#if group.folder}
                    {@const folder = group.folder}
                    <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={(e) => { e.stopPropagation(); moveFolder(groupIndex - 1, -1) }}>
                        <ChevronUpIcon size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={(e) => { e.stopPropagation(); moveFolder(groupIndex - 1, 1) }}>
                        <ChevronDownIcon size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={(e) => { e.stopPropagation(); void renameFolder(folder) }}>
                        <PencilIcon size={16}/>
                    </button>
                    <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={(e) => { e.stopPropagation(); void removeFolder(folder) }}>
                        <TrashIcon size={16}/>
                    </button>
                {/if}
            </div>
        {/if}
        {#each isOpen(folderKey) ? group.indexes : [] as i (presetStore.summaries[i].id)}
            {@const preset = presetStore.summaries[i]}
            <div class="w-full transition-all duration-200"
                class:h-0.5={!isDragging || dragOverIndex !== i}
                class:h-1={isDragging && dragOverIndex === i}
                class:bg-blue-500={isDragging && dragOverIndex === i}
                class:shadow-lg={isDragging && dragOverIndex === i}
                class:hover:bg-gray-600={!isDragging}
                role="listitem"
                ondragover={(e) => {
                    if (!isPresetDrag(e)) {
                        return
                    }
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'move'
                    dragOverIndex = i
                }}
                ondragleave={(e) => {
                    dragOverIndex = -1
                }}
                ondrop={(e) => {
                    handlePresetDrop(i, e, group.folder?.id)
                    dragOverIndex = -1
                }}>
            </div>
            
            <button onclick={() => {
                if(!editMode){
                    select(i)
                }
            }} 
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" 
            class:pl-7={folders.length > 0}
            class:bg-selected={preset.id === highlightId}
            class:draggable-preset={!editMode}
            draggable={!editMode ? "true" : "false"}
            ondragstart={(e) => {
                if (editMode) {
                    e.preventDefault()
                    return
                }
                isDragging = true
                markPresetDrag(e, i)

                const dragElement = document.createElement('div')
                dragElement.textContent = preset?.name || 'Unnamed Preset'
                dragElement.className = 'absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-textcolor2 rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none z-50'
                document.body.appendChild(dragElement)
                e.dataTransfer?.setDragImage(dragElement, 10, 10)

                setTimeout(() => {
                    document.body.removeChild(dragElement)
                }, 0)
            }}
            ondragend={(e) => {
                isDragging = false
                dragOverIndex = -1
            }}
            ondragover={(e) => {
                if (!isPresetDrag(e)) {
                    return
                }
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const mouseY = e.clientY
                const elementCenter = rect.top + rect.height / 2

                if (mouseY < elementCenter) {
                    dragOverIndex = i
                } else {
                    dragOverIndex = i + 1
                }
            }}
            ondrop={(e) => {
                handlePresetDrop(dragOverIndex, e, group.folder?.id)
                dragOverIndex = -1
            }}>
                {#if editMode}
                    <TextInput bind:value={presetStore.summaries[i].name} placeholder="string" padding={false} onchange={async () => {
                        const full = await presetStore.load(preset.id); full.name = preset.name; await presetStore.savePreset(full)
                    }}/>
                {:else}
                    {#if i < 9}
                        <span class="w-2 text-center mr-2 text-textcolor2">{i + 1}</span>
                    {/if}
                    {#if preset.image}
                        <img src={preset.image} alt="icon" class="mr-2 min-w-6 min-h-6 w-6 h-6 rounded-md" decoding="async"/>

                    {/if}
                    <span>{preset.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    {#if settingsStore.state.showPromptComparison}
                        <div class="{selectedDiffPreset === i ? 'text-green-500' : 'text-textcolor2 hover:text-green-500'} cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                            e.stopPropagation()
                            handleDiffMode(i)
                        }} onkeydown={(e) => {
                            if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                                e.currentTarget.click()
                            }
                        }}>
                            <GitCompare size={18}/>
                        </div>
                    {/if}
                    {#if folders.length > 0}
                        <div class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2" role="button" tabindex="0" title={language.moveToFolder} onclick={(e) => {
                            e.stopPropagation()
                            void chooseFolder(preset.id)
                        }} onkeydown={(e) => {
                            if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                                e.currentTarget.click()
                            }
                        }}>
                            <FolderInputIcon size={18}/>
                        </div>
                    {/if}
                    <div class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2" role="button" tabindex="0" onclick={(e) => {
                        e.stopPropagation()
                        void copyPreset(i)
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        const data = await alertCardExport('preset')
                        console.log(data.type)
                        if(data.type === ''){
                            downloadPreset(i, 'risupreset')
                        }
                        if(data.type === 'realm'){
                            $ShowRealmFrameStore = `preset:${i}`
                        }
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>

                        <Share2Icon size={18} />
                    </div>
                    <div class="text-textcolor2 hover:text-green-500 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(presetStore.summaries.length === 1){
                            alertError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${preset.name}`)
                        if(d){
                            await presetStore.delete(preset.id)
                            setPresetFolder(preset.id, undefined)
                        }
                    }} onkeydown={(e) => {
                        if(e.key === 'Enter' && e.currentTarget instanceof HTMLElement){
                            e.currentTarget.click()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        {/each}

        <div class="w-full transition-all duration-200"
            class:h-0.5={!isDragging || dragOverIndex !== presetStore.summaries.length}
            class:h-1={isDragging && dragOverIndex === presetStore.summaries.length}
            class:bg-blue-500={isDragging && dragOverIndex === presetStore.summaries.length}
            class:shadow-lg={isDragging && dragOverIndex === presetStore.summaries.length}
            class:hover:bg-gray-600={!isDragging}
            role="listitem"
            ondragover={(e) => {
                if (!isPresetDrag(e)) {
                    return
                }
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                dragOverIndex = presetStore.summaries.length
            }}
            ondragleave={(e) => {
                dragOverIndex = -1
            }}
            ondrop={(e) => {
                handlePresetDrop(presetStore.summaries.length, e)
                dragOverIndex = -1
            }}>
        </div>
        
        <div class="flex mt-2 items-center">
            <button class="text-textcolor2 hover:text-green-500 cursor-pointer mr-1" onclick={async () => {
                let newPreset = safeStructuredClone(prebuiltPresets.OAI2)
                newPreset.name = `New Preset`
                await presetStore.savePreset(newPreset, presetStore.summaries.length)
            }}>
                <PlusIcon/>
            </button>
            <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" onclick={() => {
                importPreset()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
                <PencilIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-green-500 cursor-pointer" title={language.createFolder} onclick={() => void createFolder()}>
                <FolderPlusIcon size={18}/>
            </button>
        </div>
        <span class="text-textcolor2 text-sm">{language.quickPreset}</span>
    </div>
</div>

{#if showDiffModal && firstPresetId !== null && secondPresetId !== null}
  <PromptDiffModal
    firstPresetId={firstPresetId}
    secondPresetId={secondPresetId}
    onClose={closeDiff}
  />
{/if}

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }

    /* Drag and drop styles */
    .draggable-preset:hover {
        cursor: grab;
    }

    .draggable-preset:active {
        cursor: grabbing;
    }

    .h-0\.5 {
        min-height: 2px;
        height: 2px;
    }

    .h-1 {
        min-height: 4px;
        height: 4px;
    }
</style>
