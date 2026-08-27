<script lang="ts">
    import { getModuleToggles } from "src/ts/process/modules";
    import { MobileGUI, selectedCharID } from "src/ts/stores.svelte";
    import { characterStore, settingsStore } from "src/ts/stores/domain";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import type { character, groupChat } from "../../ts/storage/schema";

    import Accordion from '../UI/Accordion.svelte'
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
    import TextInput from "../UI/GUI/TextInput.svelte";
    import CustomSideBar from "./CustomSidebar.svelte";
    import { getGlobalChatVar, isLocallyHandledGlobalChatVar, removeLocallyHandledGlobalChatVar, setGlobalChatVar } from "src/ts/parser/chatVar.svelte";

    interface Props {
        chara?: character|groupChat
        noContainer?: boolean
    }

    let { chara = $bindable(), noContainer }: Props = $props();

    const jailbreakToggleToken = '{{jbtoggled}}'
    const usesJailbreakToggle = (value?: string) =>
        typeof value === 'string' && value.includes(jailbreakToggleToken)
    const templateUsesJailbreakToggle = (template: PromptItem[]) =>
        template.some(item => {
            if (item.type === 'jailbreak') {
                return true
            }
            if ('text' in item && usesJailbreakToggle(item.text)) {
                // plain, jailbreak, cot
                return true
            }
            if ('innerFormat' in item && usesJailbreakToggle(item.innerFormat)) {
                // persona, description, lorebook, postEverything, memory
                return true
            }
            if ('defaultText' in item && usesJailbreakToggle(item.defaultText)) {
                // author note
                return true
            }
            return false
        })

    let hasJailbreakPrompt = $derived.by(() => {
        const template = settingsStore.state.promptTemplate
        if (!template) {
            return (settingsStore.state.jailbreak ?? '').trim().length > 0
        }
        return templateUsesJailbreakToggle(template)
    })

    let charToggle = $state((characterStore.characters?.[$selectedCharID] as character)?.customModuleToggle)
    $effect(() => {
        const charToggleTemp = (characterStore.characters?.[$selectedCharID] as character)?.customModuleToggle
        if(charToggleTemp !== charToggle) {
            charToggle = charToggleTemp
        }
    })

    let groupedToggles = $derived.by(() => {
        const ungrouped = parseToggleSyntax(
            settingsStore.state.customPromptTemplateToggle + '\n' +
            getModuleToggles() + '\n' +
            charToggle
        )

        let groupOpen = false
        // group toggles together between group ... groupEnd
        return ungrouped.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === 'group') {
                groupOpen = true
                acc.push(toggle)
            } else if (toggle.type === 'groupEnd') {
                groupOpen = false
            } else if (groupOpen) {
                (acc.at(-1) as sidebarToggleGroup).children.push(toggle)
            } else {
                acc.push(toggle)
            }
            return acc
        }, [])
    })

    const getGlobalChatVarNH = (key: string) => {
        const value = getGlobalChatVar(key)
        return value === 'null' ? '' : value
    }
</script>

{#snippet localToggle(toggle: sidebarToggle)}
    {#if isLocallyHandledGlobalChatVar(`toggle_${toggle.key}`)}
        <button
            type="button"
            aria-label={language.localToggles}
            onclick={() => {
                removeLocallyHandledGlobalChatVar(`toggle_${toggle.key}`)
            }}
        >📌</button>
    {/if}
{/snippet}

{#snippet getToggleDisplayName(toggle: sidebarToggle)}
    {toggle.value}{@render localToggle(toggle)}
{/snippet}

{#snippet toggles(items: sidebarToggle[], reverse: boolean = false)}
    {#each items as toggle, index}
        {#if toggle.type === 'group' && toggle.children.length > 0}
            <div class="w-full">
                <Accordion styled name={toggle.value}>
                    {@render toggles((toggle as sidebarToggleGroup).children, reverse)}
                </Accordion>
            </div>
        {:else if toggle.type === 'select'}
            <div class="w-full flex gap-2 mt-2 items-center" class:justify-end={$MobileGUI} >
                <span>{@render getToggleDisplayName(toggle)}</span>
                <SelectInput className="w-32" value={getGlobalChatVarNH(`toggle_${toggle.key}`)} onchange={(e) => {
                    setGlobalChatVar(`toggle_${toggle.key}`, e.currentTarget.value)
                }}>
                    {#each toggle.options as option, i}
                        <OptionInput value={i.toString()}>{option}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
        {:else if toggle.type === 'text'}
            <div class="w-full flex gap-2 mt-2 items-center" class:justify-end={$MobileGUI}>
                <span>{@render getToggleDisplayName(toggle)}</span>
                <TextInput className="w-32" value={getGlobalChatVarNH(`toggle_${toggle.key}`)} onchange={(e) => {
                    setGlobalChatVar(`toggle_${toggle.key}`, e.currentTarget.value)
                }} />
            </div>
        {:else if toggle.type === 'textarea'}
            <div class="w-full flex gap-2 mt-2 items-start" class:justify-end={$MobileGUI}>
                <span class="mt-1.5">{@render getToggleDisplayName(toggle)}</span>
                <TextAreaInput className="w-32" height='20' value={getGlobalChatVarNH(`toggle_${toggle.key}`)} onchange={(e) => {
                    if(e.currentTarget instanceof HTMLDivElement){
                        setGlobalChatVar(`toggle_${toggle.key}`, e.currentTarget.innerText)
                    } else {
                        setGlobalChatVar(`toggle_${toggle.key}`, e.currentTarget.value)
                    }
                }} />
            </div>
        {:else if toggle.type === 'caption'}
            <div class="w-full mt-1 text-xs text-textcolor2">
                {toggle.value}
            </div>
        {:else if toggle.type === 'divider'}
            <!-- Prevent multiple dividers appearing in a row -->
            {#if index === 0 || items[index - 1]?.type !== 'divider' || items[index - 1]?.value !== toggle.value}
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center" class:justify-end={!reverse}>
                    {#if toggle.value}
                        <span class="shrink-0">{@render getToggleDisplayName(toggle)}</span>
                    {/if}
                    <hr class="border-t border-darkborderc m-0 grow" />
                </div>
            {/if}
        {:else}
            <div class="w-full flex mt-2 items-center" class:justify-end={$MobileGUI}>
                <CheckInput check={getGlobalChatVarNH(`toggle_${toggle.key}`) === '1'} reverse={reverse} name={toggle.value} onChange={() => {
                    setGlobalChatVar(`toggle_${toggle.key}`, getGlobalChatVarNH(`toggle_${toggle.key}`) === '1' ? '0' : '1')
                }}>
                    {@render localToggle(toggle)}
                </CheckInput>
            </div>
        {/if}
    {/each}
{/snippet}

{#if !noContainer && groupedToggles.length > 4}
    <div class="h-48 border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2 overflow-y-auto">
        <CustomSideBar />

        {#if hasJailbreakPrompt}
            <div class="flex mt-2 items-center w-full" class:justify-end={$MobileGUI}>
                <CheckInput bind:check={settingsStore.state.jailbreakToggle} name={language.jailbreakToggle} reverse />
            </div>
        {/if}

        {@render toggles(groupedToggles, true)}
        {#if chara && (settingsStore.state.supaModelType !== 'none' || settingsStore.state.hanuraiEnable || settingsStore.state.hypaV3)}
            <div class="flex mt-2 items-center w-full" class:justify-end={$MobileGUI}>
                <CheckInput bind:check={chara.supaMemory} reverse name={settingsStore.state.hypaV3 ? language.ToggleHypaMemory : settingsStore.state.hanuraiEnable ? language.hanuraiMemory : settingsStore.state.hypaMemory ? language.ToggleHypaMemory : language.ToggleSuperMemory}/>
            </div>
        {/if}
    </div>
{:else}
    <CustomSideBar />

    {#if hasJailbreakPrompt}
        <div class="flex mt-2 items-center">
            <CheckInput bind:check={settingsStore.state.jailbreakToggle} name={language.jailbreakToggle}/>
        </div>
    {/if}
    {@render toggles(groupedToggles)}
    {#if chara && (settingsStore.state.supaModelType !== 'none' || settingsStore.state.hanuraiEnable || settingsStore.state.hypaV3)}
        <div class="flex mt-2 items-center">
            <CheckInput bind:check={chara.supaMemory} name={settingsStore.state.hypaV3 ? language.ToggleHypaMemory : settingsStore.state.hanuraiEnable ? language.hanuraiMemory : settingsStore.state.hypaMemory ? language.ToggleHypaMemory : language.ToggleSuperMemory}/>
        </div>
    {/if}
    {#if chara}
        <div class="flex mt-2 items-center w-full" class:justify-end={$MobileGUI}>
            <CheckInput check={characterStore.getCurrentChat()?.useLocallySetGlobalVariables ?? false} name={language.localToggles} onChange={() => {
                const chat = characterStore.getCurrentChat()
                if(chat){
                    chat.useLocallySetGlobalVariables = !chat.useLocallySetGlobalVariables
                }
            }} />
        </div>
    {/if}
{/if}
