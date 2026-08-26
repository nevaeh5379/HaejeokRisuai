<script lang="ts">
    import type { PromptItem, PromptItemChat, PromptRole } from "src/ts/process/prompt";
    import OptionInput from "./GUI/OptionInput.svelte";
    import TextAreaInput from "./GUI/TextAreaInput.svelte";
    import SelectInput from "./GUI/SelectInput.svelte";
    import { language } from "src/lang";
    import NumberInput from "./GUI/NumberInput.svelte";
    import CheckInput from "./GUI/CheckInput.svelte";
    import { ArrowDown, ArrowUp, XIcon, GripVertical } from "@lucide/svelte";
    import TextInput from "./GUI/TextInput.svelte";
    import { settingsStore } from 'src/ts/stores/domain';
    import { RISU_PROMPT_DRAG_TYPE } from "src/ts/dragTypes";
    
    interface Props {
        promptItem: PromptItem;
        onRemove?: () => void;
        moveUp?: () => void;
        moveDown?: () => void;
        onDrop?: () => void;
        isDragging?: boolean;
        isOpened?: boolean;
        draggedIndex?: number;
        dragOverIndex?: number;
        openedItemIndices?: Set<number>;
        currentIndex?: number;
        displayIndex?: number;
    }

    let {
        promptItem = $bindable(),
        onRemove = () => {},
        moveUp = () => {},
        moveDown = () => {},
        onDrop = () => {},
        isDragging = false,
        isOpened = false,
        draggedIndex = $bindable(-1),
        dragOverIndex = $bindable(-1),
        openedItemIndices = $bindable(new Set<number>()),
        currentIndex = -1,
        displayIndex = -1
    }: Props = $props();

    const chatPromptChange = () => {
        const currentprompt = promptItem as PromptItemChat
        if(currentprompt.rangeStart === -1000){
            currentprompt.rangeStart = 0
            currentprompt.rangeEnd = 'end'
        }else{
            currentprompt.rangeStart = -1000
            currentprompt.rangeEnd = 'end'
        }
        promptItem = currentprompt
    }

    const hasPromptBlockRole = (promptItem: PromptItem): promptItem is PromptItem & { role2?: PromptRole } => {
        return promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'
    }

    const isPromptRole = (role: unknown): role is PromptRole => {
        return role === 'user' || role === 'bot' || role === 'system' || role === 'assistant'
    }

    function getName(promptItem:PromptItem){

        if(promptItem.name){
            return promptItem.name
        }

        if(promptItem.type === 'plain'){
            return language.formating.plain
        }
        if(promptItem.type === 'jailbreak'){
            return language.formating.jailbreak
        }
        if(promptItem.type === 'chat'){
            return language.Chat
        }
        if(promptItem.type === 'persona'){
            return language.formating.personaPrompt
        }
        if(promptItem.type === 'description'){
            return language.formating.description
        }
        if(promptItem.type === 'authornote'){
            return language.formating.authorNote
        }
        if(promptItem.type === 'lorebook'){
            return language.formating.lorebook
        }
        if(promptItem.type === 'memory'){
            return language.formating.memory
        }
        if(promptItem.type === 'postEverything'){
            return language.formating.postEverything
        }
        if(promptItem.type === 'cot'){
            return language.cot
        }
        if(promptItem.type === 'chatML'){
            return 'ChatML'
        }
        return ""
    }

    function replacePrompt(prompt:PromptItem){
        if(JSON.stringify(promptItem) === JSON.stringify(prompt)){
            return
        }

        const ind = settingsStore.state.promptTemplate.findIndex((item, index) => {
            return JSON.stringify(item) === JSON.stringify(prompt)
        })

        if(ind !== -1){
            settingsStore.state.promptTemplate.splice(ind, 1)
        }
        const myInd = settingsStore.state.promptTemplate.findIndex((item, index) => {
            return JSON.stringify(item) === JSON.stringify(promptItem)
        })
        settingsStore.state.promptTemplate.splice(myInd, 0, prompt)

    }

    const isPromptDrag = (e:DragEvent) => {
        return e.dataTransfer?.types.includes(RISU_PROMPT_DRAG_TYPE) ?? false
    }

    const markPromptDrag = (e:DragEvent) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', 'prompt')
        e.dataTransfer.setData(RISU_PROMPT_DRAG_TYPE, 'true')
        e.dataTransfer.setData('prompt', JSON.stringify(promptItem))
    }

    function getTypeBadge(item: PromptItem): string {
        if (item.type === 'plain' || item.type === 'jailbreak' || item.type === 'cot') {
            const role = (item as any).role
            if (role === 'user') return language.user
            if (role === 'bot') return language.character
            return language.systemPrompt
        }
        if (item.type === 'chatML') return 'ChatML'
        if (item.type === 'cache') return language.cachePoint ?? 'Cache'
        if (item.type === 'chat') return language.Chat
        return ''
    }

    function getPreviewText(item: PromptItem): string {
        if (item.type === 'plain' || item.type === 'jailbreak' || item.type === 'cot' || item.type === 'chatML') {
            const text = (item as any).text ?? ''
            if (!text) return ''
            return text.replace(/\n/g, ' ').slice(0, 80)
        }
        if (item.type === 'persona' || item.type === 'description' || item.type === 'authornote' || item.type === 'memory') {
            if ((item as any).innerFormat) {
                return (item as any).innerFormat.replace(/\n/g, ' ').slice(0, 80)
            }
        }
        return ''
    }

</script>

<!-- Drop indicator line - visible when dragging over the top half -->
{#if draggedIndex !== -1 && draggedIndex !== currentIndex && dragOverIndex === currentIndex}
    <div class="w-full h-0.5 bg-blue-500 rounded-full my-0.5 transition-all"></div>
{:else}
    <div class="first:mt-0 w-full h-1.5" role="doc-pagebreak"
        ondrop={(e) => {
            if(!isPromptDrag(e)){
                return
            }
            e.preventDefault()
            e.stopPropagation()
            onDrop()
        }}
        ondragover={(e) => {
            if(!isPromptDrag(e)){
                return
            }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
        }}
        draggable="true"
        ondragstart={(e) => {
            markPromptDrag(e)
        }}>
    </div>
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="flex flex-col border border-selected rounded-md bg-darkbg transition-all duration-200"
    class:opacity-50={isDragging}
    class:scale-95={isDragging}
    class:p-4={isOpened}
    class:py-1.5={!isOpened}
    class:px-2={!isOpened}

    ondragover={(e) => {
        if(!isPromptDrag(e)){
            return
        }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if(draggedIndex === -1 || draggedIndex === currentIndex) {
            return
        }

        const rect = e.currentTarget.getBoundingClientRect()
        const mouseY = e.clientY
        const elementCenter = rect.top + rect.height / 2

        if (mouseY < elementCenter) {
            dragOverIndex = currentIndex
        } else {
            dragOverIndex = currentIndex + 1
        }
    }}
    ondrop={(e) => {
        if(!isPromptDrag(e)){
            return
        }
        e.preventDefault()
        e.stopPropagation()
        onDrop()
    }}
>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="flex items-center w-full gap-1"
    >
        <!-- Drag handle -->
        <div
            class="shrink-0 text-textcolor2/40 hover:text-textcolor2 transition-colors cursor-grab active:cursor-grabbing"
            draggable="true"
            ondragstart={(e) => {
                draggedIndex = currentIndex
                markPromptDrag(e)

                const dragElement = document.createElement('div')
                dragElement.textContent = getName(promptItem)
                dragElement.className = 'absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-textcolor2 rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none z-50'
                document.body.appendChild(dragElement)
                e.dataTransfer?.setDragImage(dragElement, 10, 10)

                setTimeout(() => {
                    document.body.removeChild(dragElement)
                }, 0)
            }}
            ondragend={(e) => {
                draggedIndex = -1
                dragOverIndex = -1
            }}
        >
            <GripVertical size={16} />
        </div>
        <!-- Clickable title area -->
        <button
            class="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
            onclick={() => {
                const newIndices = new Set(openedItemIndices)
                if (isOpened) {
                    newIndices.delete(currentIndex)
                } else {
                    newIndices.add(currentIndex)
                }
                openedItemIndices = newIndices
            }}
        >
            <span class="font-medium truncate shrink-0">{getName(promptItem)}</span>
            {#if !isOpened}
                {#if getTypeBadge(promptItem)}
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-selected text-textcolor2 font-medium shrink-0">{getTypeBadge(promptItem)}</span>
                {/if}
                {#if getPreviewText(promptItem)}
                    <span class="text-xs text-textcolor2/50 truncate min-w-0">{getPreviewText(promptItem)}</span>
                {/if}
            {/if}
        </button>
        <!-- Action buttons -->
        <div class="flex shrink-0 items-center gap-0.5">
            <button class="p-1 text-textcolor2 hover:text-red-400 transition-colors" onclick={(e) => {
                e.stopPropagation()
                onRemove()
            }}><XIcon size={15} /></button>
            <button class="p-1 text-textcolor2 hover:text-textcolor transition-colors" onclick={(e) => {
                e.stopPropagation()
                moveDown()
            }}><ArrowDown size={15} /></button>
            <button class="p-1 text-textcolor2 hover:text-textcolor transition-colors" onclick={(e) => {
                e.stopPropagation()
                moveUp()
            }}><ArrowUp size={15} /></button>
        </div>
    </div>
    {#if isOpened}
        <!-- Responsive 2-column layout: desktop = side-by-side, mobile = stacked -->
        <div class="flex flex-col md:flex-row md:gap-4 mt-3">
            <!-- LEFT: Main content area (textarea) - takes priority space -->
            <div class="flex flex-col flex-1 min-w-0 order-2 md:order-1">
                {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'}
                    <TextAreaInput highlight bind:value={promptItem.text} />
                {/if}
                {#if promptItem.type === 'chatML'}
                    <TextAreaInput highlight bind:value={promptItem.text} />
                {/if}
                {#if promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'}
                    {#if !promptItem.innerFormat}
                        <div class="flex items-center justify-center h-24 text-textcolor2/50 text-sm border border-dashed border-darkborderc rounded-md">
                            <CheckInput name={language.customInnerFormat} check={false} onChange={() => {
                                if(promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'){
                                    promptItem.innerFormat = "{{slot}}"
                                }
                            }} />
                        </div>
                    {:else}
                        <span class="text-xs text-textcolor2 mb-1">{language.innerFormat}</span>
                        <TextAreaInput highlight bind:value={promptItem.innerFormat} />
                        <CheckInput name={language.customInnerFormat} check={true} className="mt-1" onChange={() => {
                            if(promptItem.type === 'persona' || promptItem.type === 'description' || promptItem.type === 'authornote' || promptItem.type === 'memory'){
                                promptItem.innerFormat = null
                            }
                        }} />
                    {/if}
                {/if}
                {#if promptItem.type === 'chat'}
                    <div class="flex flex-col gap-2 p-3 border border-darkborderc rounded-md">
                        {#if promptItem.rangeStart !== -1000}
                            <div class="flex gap-2 items-center">
                                <span class="text-xs text-textcolor2 shrink-0">{language.rangeStart}</span>
                                <NumberInput bind:value={promptItem.rangeStart} />
                            </div>
                            <div class="flex gap-2 items-center">
                                <span class="text-xs text-textcolor2 shrink-0">{language.rangeEnd}</span>
                                {#if promptItem.rangeEnd === 'end'}
                                    <NumberInput value={0} marginBottom disabled/>
                                {:else}
                                    <NumberInput bind:value={promptItem.rangeEnd} marginBottom />
                                {/if}
                            </div>
                            <CheckInput name={language.untilChatEnd} check={promptItem.rangeEnd === 'end'} onChange={() => {
                                if(promptItem.type === 'chat'){
                                    promptItem.rangeEnd = promptItem.rangeEnd === 'end' ? 0 : 'end'
                                }
                            }} />
                            {#if settingsStore.state.promptSettings.sendChatAsSystem}
                                <CheckInput name={language.chatAsOriginalOnSystem} bind:check={promptItem.chatAsOriginalOnSystem}/>
                            {/if}
                        {/if}
                        <CheckInput name={language.advanced} check={promptItem.rangeStart !== -1000} onChange={chatPromptChange} />
                    </div>
                {/if}
                {#if promptItem.type === 'cache'}
                    <div class="flex flex-col gap-2 p-3 border border-darkborderc rounded-md">
                        <div class="flex gap-2 items-center">
                            <span class="text-xs text-textcolor2 shrink-0">{language.depth}</span>
                            <NumberInput bind:value={promptItem.depth} />
                        </div>
                    </div>
                {/if}
            </div>

            <!-- RIGHT: Metadata sidebar - compact controls -->
            <!-- Mobile: 2-col grid to save vertical space / Desktop: single-col sidebar -->
            <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 order-1 md:order-2 md:flex md:flex-col md:gap-2 md:w-56 md:shrink-0 mb-2 md:mb-0">
                <!-- Name -->
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-textcolor2">{language.name}</span>
                    <TextInput bind:value={promptItem.name} />
                </div>
                <!-- Type -->
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-textcolor2">{language.type}</span>
                    <SelectInput bind:value={promptItem.type} onchange={() => {
                        if(promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'){
                            promptItem.text = ""
                            promptItem.role = "system"
                        }
                        if(promptItem.type === 'cache'){
                            promptItem.depth = 1
                            promptItem.role = 'all'
                        }
                        if(promptItem.type === 'chat'){
                            promptItem.rangeStart = -1000
                            promptItem.rangeEnd = 'end'
                        }
                        if(hasPromptBlockRole(promptItem) && !isPromptRole(promptItem.role2)){
                            promptItem.role2 = 'system'
                        }
                    }} >
                        <OptionInput value="plain">{language.formating.plain}</OptionInput>
                        <OptionInput value="jailbreak">{language.formating.jailbreak}</OptionInput>
                        <OptionInput value="chat">{language.Chat}</OptionInput>
                        <OptionInput value="persona">{language.formating.personaPrompt}</OptionInput>
                        <OptionInput value="description">{language.formating.description}</OptionInput>
                        <OptionInput value="authornote">{language.formating.authorNote}</OptionInput>
                        <OptionInput value="lorebook">{language.formating.lorebook}</OptionInput>
                        <OptionInput value="memory">{language.formating.memory}</OptionInput>
                        <OptionInput value="postEverything">{language.formating.postEverything}</OptionInput>
                        <OptionInput value="chatML">{"chatML"}</OptionInput>
                        <OptionInput value="cache">{language.cachePoint}</OptionInput>
                        {#if settingsStore.state.promptSettings.customChainOfThought}
                            <OptionInput value="cot">{language.cot}</OptionInput>
                        {/if}
                    </SelectInput>
                </div>
                <!-- Special Type (plain/jailbreak/cot only) -->
                {#if promptItem.type === 'plain' || promptItem.type === 'jailbreak' || promptItem.type === 'cot'}
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs text-textcolor2">{language.specialType}</span>
                        <SelectInput bind:value={promptItem.type2}>
                            <OptionInput value="normal">{language.noSpecialType}</OptionInput>
                            <OptionInput value="main">{language.mainPrompt}</OptionInput>
                            <OptionInput value="globalNote">{language.globalNote}</OptionInput>
                        </SelectInput>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs text-textcolor2">{language.role}</span>
                        <SelectInput bind:value={promptItem.role}>
                            <OptionInput value="user">{language.user}</OptionInput>
                            <OptionInput value="bot">{language.character}</OptionInput>
                            <OptionInput value="system">{language.systemPrompt}</OptionInput>
                        </SelectInput>
                    </div>
                {/if}
                <!-- Role for block types (persona/description/authornote/memory) -->
                {#if hasPromptBlockRole(promptItem)}
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs text-textcolor2">{language.role}</span>
                        <SelectInput value={promptItem.role2 ?? 'system'} onchange={(event) => {
                            if(hasPromptBlockRole(promptItem)){
                                promptItem.role2 = event.currentTarget.value as PromptRole
                            }
                        }}>
                            <OptionInput value="user">{language.user}</OptionInput>
                            <OptionInput value="bot">{language.character}</OptionInput>
                            <OptionInput value="system">{language.systemPrompt}</OptionInput>
                        </SelectInput>
                    </div>
                {/if}
                <!-- Cache role -->
                {#if promptItem.type === 'cache'}
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs text-textcolor2">{language.role}</span>
                        <SelectInput bind:value={promptItem.role}>
                            <OptionInput value="all">{language.all}</OptionInput>
                            <OptionInput value="user">{language.user}</OptionInput>
                            <OptionInput value="assistant">{language.character}</OptionInput>
                            <OptionInput value="system">{language.systemPrompt}</OptionInput>
                        </SelectInput>
                    </div>
                {/if}
                <!-- Author note default text -->
                {#if promptItem.type === 'authornote'}
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs text-textcolor2">{language.defaultPrompt}</span>
                        <TextInput bind:value={promptItem.defaultText} />
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</div>
