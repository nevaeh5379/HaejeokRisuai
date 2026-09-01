<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { ArrowLeft, PlusIcon, TrashIcon, ChevronsUpDown, ChevronDown } from "@lucide/svelte";
    import { language } from "src/lang";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { templateCheck } from "src/ts/process/templates/templateCheck";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { onDestroy, onMount } from "svelte";
    import {defaultAutoSuggestPrompt} from "../../../ts/storage/presets/defaultPrompts";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'

    let sorted = 0
    let warns: string[] = $state([])
    let tokens = $state(0)
    let extokens = $state(0)
    let draggedIndex = $state(-1)
    let dragOverIndex = $state(-1)
    let openedItemIndices = $state(new Set<number>())
    executeTokenize(presetStore.state.promptTemplate)
  interface Props {
    onGoBack?: () => void;
    mode?: 'independent'|'inline';
    subMenu?: number;
  }

  let { onGoBack = () => {}, mode = 'independent', subMenu = $bindable(0) }: Props = $props();

    async function executeTokenize(prest: PromptItem[]){
        tokens = await tokenizePreset(prest, true)
        extokens = await tokenizePreset(prest, false)
    }

    $effect.pre(() => {
    warns = templateCheck(settingsStore.state as any)
  });
  $effect.pre(() => {
    executeTokenize(presetStore.state.promptTemplate)
  });

  function getDisplayTemplate() {
    return presetStore.state.promptTemplate.map((item: any, i: number) => ({
      item,
      originalIndex: i,
      displayIndex: i
    }))
  }

  function getReorderedTemplate() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return getDisplayTemplate()
    }

    const items = getDisplayTemplate()
    const [movedItem] = items.splice(draggedIndex, 1)

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex
    items.splice(adjustedDropIndex, 0, movedItem)

    return items.map((item: any, displayIndex: number) => ({
      ...item,
      displayIndex
    }))
  }

  function handlePromptDrop() {
    if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
      return
    }

    const templates = [...presetStore.state.promptTemplate]
    const [movedItem] = templates.splice(draggedIndex, 1)

    const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex
    templates.splice(adjustedDropIndex, 0, movedItem)

    const newOpenedIndices = new Set<number>()
    openedItemIndices.forEach((index) => {
      if (index === draggedIndex) {
        newOpenedIndices.add(adjustedDropIndex)
      } else if (draggedIndex < adjustedDropIndex) {
        if (index > draggedIndex && index <= adjustedDropIndex) {
          newOpenedIndices.add(index - 1)
        } else {
          newOpenedIndices.add(index)
        }
      } else {
        if (index >= adjustedDropIndex && index < draggedIndex) {
          newOpenedIndices.add(index + 1)
        } else {
          newOpenedIndices.add(index)
        }
      }
    })
    openedItemIndices = newOpenedIndices

    presetStore.state.promptTemplate = templates
    draggedIndex = -1
    dragOverIndex = -1
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === 'o') {
      if (openedItemIndices.size === presetStore.state.promptTemplate.length) {
        openedItemIndices = new Set<number>()
      } else {
        openedItemIndices = new Set(presetStore.state.promptTemplate.map((_: any, i: number) => i))
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

  let addNewPromptOpen = $state(false)

  const promptTypeOptions: { type: string; label: string; defaults: Partial<PromptItem> }[] = [
    { type: 'plain', label: language.formating.plain, defaults: { type: 'plain', text: '', role: 'system', type2: 'normal' } as any },
    { type: 'jailbreak', label: language.formating.jailbreak, defaults: { type: 'jailbreak', text: '', role: 'system', type2: 'normal' } as any },
    { type: 'chat', label: language.Chat, defaults: { type: 'chat', rangeStart: -1000, rangeEnd: 'end' } as any },
    { type: 'persona', label: language.formating.personaPrompt, defaults: { type: 'persona' } as any },
    { type: 'description', label: language.formating.description, defaults: { type: 'description' } as any },
    { type: 'authornote', label: language.formating.authorNote, defaults: { type: 'authornote' } as any },
    { type: 'lorebook', label: language.formating.lorebook, defaults: { type: 'lorebook' } as any },
    { type: 'memory', label: language.formating.memory, defaults: { type: 'memory' } as any },
    { type: 'postEverything', label: language.formating.postEverything, defaults: { type: 'postEverything' } as any },
    { type: 'chatML', label: 'ChatML', defaults: { type: 'chatML', text: '' } as any },
    { type: 'cache', label: language.cachePoint ?? 'Cache', defaults: { type: 'cache', name: '', depth: 1, role: 'all' } as any },
  ]

  function addPromptWithType(defaults: Partial<PromptItem>) {
    let value = presetStore.state.promptTemplate ?? []
    value.push(defaults as PromptItem)
    presetStore.state.promptTemplate = value
    addNewPromptOpen = false
  }

</script>
{#if mode === 'independent'}
    <h2 class="mb-2 text-2xl font-bold mt-2 items-center flex">
        <button class="mr-2 text-textcolor2 hover:text-textcolor" onclick={onGoBack}>
            <ArrowLeft />
        </button>
        {language.promptTemplate}
    </h2>

    <div class="flex w-full rounded-md border border-selected">
        <button onclick={() => {
            subMenu = 0
        }} class="p-2 flex-1" class:bg-selected={subMenu === 0}>
            <span>{language.template}</span>
        </button>
        <button onclick={() => {
            subMenu = 1
        }} class="p-2 flex-1" class:bg-selected={subMenu === 1}>
            <span>{language.settings}</span>
        </button>
    </div>
{/if}
{#if warns.length > 0 && subMenu === 0}
    <div class="text-red-500 flex flex-col items-start p-2 rounded-md border-red-500 border mt-4">
        <h2 class="text-xl font-bold">Warning</h2>
        <div class="border-b border-b-red-500 mt-1 mb-2 w-full"></div>
        {#each warns as warn}
            <span class="ml-4">{warn}</span>
        {/each}
    </div>
{/if}

{#if subMenu === 0}
    <!-- Toolbar -->
    <div class="flex items-center justify-between mt-4 mb-1 px-1">
        <span class="text-xs text-textcolor2">{presetStore.state.promptTemplate.length} items</span>
        <button
            class="text-xs px-2 py-1 rounded border border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors flex items-center gap-1 cursor-pointer"
            onclick={() => {
                if (openedItemIndices.size === presetStore.state.promptTemplate.length) {
                    openedItemIndices = new Set<number>()
                } else {
                    openedItemIndices = new Set(presetStore.state.promptTemplate.map((_: any, i: number) => i))
                }
            }}
        >
            <ChevronsUpDown size={13} />
            {openedItemIndices.size === presetStore.state.promptTemplate.length ? 'Collapse All' : 'Expand All'}
        </button>
    </div>
    <div class="contain w-full max-w-full flex flex-col p-3 rounded-md">
        {#if presetStore.state.promptTemplate.length === 0}
                <div class="text-textcolor2">No Format</div>
        {/if}
        {#key sorted}
            {#each getReorderedTemplate() as { item: prompt, originalIndex, displayIndex }}
                <PromptDataItem
                    bind:promptItem={presetStore.state.promptTemplate[originalIndex]}
                    isDragging={draggedIndex === originalIndex}
                    isOpened={openedItemIndices.has(originalIndex)}
                    bind:draggedIndex
                    bind:dragOverIndex
                    bind:openedItemIndices
                    currentIndex={originalIndex}
                    displayIndex={displayIndex}
                    onDrop={handlePromptDrop}
                    onRemove={() => {
                        let templates = presetStore.state.promptTemplate
                        templates.splice(originalIndex, 1)
                        presetStore.state.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                return
                            } else if (index > originalIndex) {
                                newOpenedIndices.add(index - 1)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices

                        draggedIndex = -1
                        dragOverIndex = -1
                    }}
                    moveDown={() => {
                        if(originalIndex === presetStore.state.promptTemplate.length - 1){
                            return
                        }
                        let templates = presetStore.state.promptTemplate
                        let temp = templates[originalIndex]
                        templates[originalIndex] = templates[originalIndex + 1]
                        templates[originalIndex + 1] = temp
                        presetStore.state.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex + 1)
                            } else if (index === originalIndex + 1) {
                                newOpenedIndices.add(originalIndex)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices
                    }}
                    moveUp={() => {
                        if(originalIndex === 0){
                            return
                        }
                        let templates = presetStore.state.promptTemplate
                        let temp = templates[originalIndex]
                        templates[originalIndex] = templates[originalIndex - 1]
                        templates[originalIndex - 1] = temp
                        presetStore.state.promptTemplate = templates

                        const newOpenedIndices = new Set<number>()
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex - 1)
                            } else if (index === originalIndex - 1) {
                                newOpenedIndices.add(originalIndex)
                            } else {
                                newOpenedIndices.add(index)
                            }
                        })
                        openedItemIndices = newOpenedIndices
                    }} />
            {/each}
        {/key}
    </div>

    <!-- Add prompt dropdown -->
    <div class="relative mt-2">
        <button class="font-medium cursor-pointer hover:text-green-500 flex items-center gap-1 text-sm" onclick={() => {
            addNewPromptOpen = !addNewPromptOpen
        }}>
            <PlusIcon size={18} />
            <ChevronDown size={14} />
        </button>
        {#if addNewPromptOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="fixed inset-0 z-40" onclick={() => { addNewPromptOpen = false }}></div>
            <div class="absolute left-0 bottom-full mb-1 z-50 bg-darkbg border border-darkborderc rounded-lg shadow-lg py-1 min-w-48 max-h-64 overflow-y-auto">
                {#each promptTypeOptions as opt}
                    <button
                        class="w-full text-left px-3 py-1.5 text-sm text-textcolor hover:bg-selected transition-colors cursor-pointer"
                        onclick={() => addPromptWithType(opt.defaults)}
                    >
                        {opt.label}
                    </button>
                {/each}
            </div>
        {/if}
    </div>

    <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
    <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
{:else}
    <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
    <TextInput bind:value={presetStore.state.promptSettings.postEndInnerFormat}/>

    <Check bind:check={presetStore.state.promptSettings.sendChatAsSystem} name={language.sendChatAsSystem} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.sendName} name={language.formatGroupInSingle} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.trimStartNewChat} name={language.trimStartNewChat} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.utilOverride} name={language.utilOverride} className="mt-4"/>
    <Check bind:check={presetStore.state.jsonSchemaEnabled} name={language.enableJsonSchema} className="mt-4"/>
    <Check bind:check={presetStore.state.outputImageModal} name={language.outputImageModal} className="mt-4"/>

    <Check bind:check={presetStore.state.strictJsonSchema} name={language.strictJsonSchema} className="mt-4"/>

    {#if settingsStore.state.showUnrecommended}
        <Check bind:check={presetStore.state.promptSettings.customChainOfThought} name={language.customChainOfThought} className="mt-4">
            <Help unrecommended key='customChainOfThought' />
        </Check>
    {/if}
    <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
    <NumberInput bind:value={presetStore.state.promptSettings.maxThoughtTagDepth}/>
    <span class="text-textcolor mt-4">{language.groupOtherBotRole} <Help key="groupOtherBotRole"/></span>
    <SelectInput bind:value={presetStore.state.groupOtherBotRole}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="system">System</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    <span class="text-textcolor mt-4">{language.customPromptTemplateToggle} <Help key='customPromptTemplateToggle' /></span>
    <TextAreaInput bind:value={presetStore.state.customPromptTemplateToggle}/>
    <span class="text-textcolor mt-4">{language.defaultVariables} <Help key='defaultVariables' /></span>
    <TextAreaInput bind:value={presetStore.state.templateDefaultVariables}/>
    <span class="text-textcolor mt-4">{language.predictedOutput}</span>
    <TextAreaInput bind:value={settingsStore.state.OAIPrediction}/>
    <span class="text-textcolor mt-4">{language.autoSuggest} <Help key='autoSuggest' /></span>
    <TextAreaInput bind:value={presetStore.state.autoSuggestPrompt} placeholder={defaultAutoSuggestPrompt}/>
    <span class="text-textcolor mt-4">{language.groupInnerFormat} <Help key='groupInnerFormat' /></span>
    <TextAreaInput placeholder={`<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`} bind:value={presetStore.state.groupTemplate}/>
    <span class="text-textcolor mt-4">{language.systemContentReplacement} <Help key="systemContentReplacement"/></span>
    <TextAreaInput bind:value={presetStore.state.systemContentReplacement}/>
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement"/></span>
    <SelectInput bind:value={presetStore.state.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    {#if presetStore.state.jsonSchemaEnabled}
        <span class="text-textcolor mt-4">{language.jsonSchema} <Help key='jsonSchema' /></span>
        <TextAreaInput bind:value={presetStore.state.jsonSchema}/>
        <span class="text-textcolor mt-4">{language.extractJson} <Help key='extractJson' /></span>
        <TextInput bind:value={presetStore.state.extractJson}/>
    {/if}

    {#if !settingsStore.state.auxModelUnderModelSettings}
        <AuxModelSelectors />
    {/if}

    {#snippet fallbackModelList(arg:'model'|'memory'|'translate'|'emotion'|'otherAx')}
        {#each presetStore.state.fallbackModels[arg] as model, i}
            <span class="text-textcolor mt-4">
                {language.model} {i + 1}
            </span>
            <ModelList bind:value={presetStore.state.fallbackModels[arg][i]} blankable />
        {/each}
        <div class="flex gap-2">
            <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                let value = presetStore.state.fallbackModels[arg] ?? []
                value.push('')
                presetStore.state.fallbackModels[arg] = value
            }}><PlusIcon /></button>
            <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                let value = presetStore.state.fallbackModels[arg] ?? []
                value.pop()
                presetStore.state.fallbackModels[arg] = value
            }}><TrashIcon /></button>
        </div>
    {/snippet}

    <Accordion name={language.fallbackModel} styled>
        <Check bind:check={presetStore.state.fallbackWhenBlankResponse} name={language.fallbackWhenBlankResponse} className="mt-4"/>
        <Check bind:check={settingsStore.state.doNotChangeFallbackModels} name={language.doNotChangeFallbackModels} className="mt-4"/>

        <Accordion name={language.model} styled>
            {@render fallbackModelList('model')}
        </Accordion>
        <Accordion name={"Memory"} styled>
            {@render fallbackModelList('memory')}
        </Accordion>
        <Accordion name={"Translations"} styled>
            {@render fallbackModelList('translate')}
        </Accordion>
        <Accordion name={"Emotion"} styled>
            {@render fallbackModelList('emotion')}
        </Accordion>
        <Accordion name={"OtherAx"} styled>
            {@render fallbackModelList('otherAx')}
        </Accordion>
    </Accordion>

{/if}