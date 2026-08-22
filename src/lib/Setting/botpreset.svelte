<script lang="ts">
    import { alertCardExport, alertConfirm, alertError } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToPreset, copyPreset, downloadPreset, importPreset } from "../../ts/storage/database.svelte";
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { CopyIcon, Share2Icon, PencilIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon, GitCompare } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import { ShowRealmFrameStore } from "src/ts/stores.svelte";
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

    let showDiffModal = $state(false)
    let selectedDiffPreset = $state<number | null>(null)
    let firstPresetId = $state<number | null>(null);
    let secondPresetId = $state<number | null>(null);

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

    function handlePresetDrop(targetIndex: number, e: DragEvent) {
        if (!isPresetDrag(e)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const sourceIndex = parseInt(e.dataTransfer?.getData(RISU_PRESET_DRAG_TYPE) || '0');
        movePreset(sourceIndex, targetIndex);
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

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.presets}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#each presetStore.summaries as preset, i}
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
                    handlePresetDrop(i, e)
                    dragOverIndex = -1
                }}>
            </div>
            
            <button onclick={() => {
                if(!editMode){
                    void changeToPreset(i)
                    close()
                }
            }} 
            class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" 
            class:bg-selected={preset.id === presetStore.activeId}
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
                handlePresetDrop(dragOverIndex, e)
                dragOverIndex = -1
            }}>
                {#if editMode}
                    <TextInput bind:value={preset.name} placeholder="string" padding={false} onchange={async () => {
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
                            await changeToPreset(presetStore.activeIndex, false)
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
            <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
                <PencilIcon size={18}/>
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
