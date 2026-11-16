<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { getModuleToggles } from "src/ts/process/modules";
    import { selectedCharID } from "src/ts/stores.svelte";
    import { characterStore, settingsStore } from "src/ts/stores/domain";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import type { character, groupChat } from "../../ts/storage/database/schema";

    import Accordion from '../UI/Accordion.svelte'
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
    import TextInput from "../UI/GUI/TextInput.svelte";
    import CustomSideBar from "./CustomSidebar.svelte";
    import { getGlobalChatVar, isLocallyHandledGlobalChatVar, removeLocallyHandledGlobalChatVar, setGlobalChatVar } from "src/ts/parser/chatVar.svelte";
    import { PinIcon, FolderHeartIcon } from "@lucide/svelte";
    import { alertConfirm, alertSelect } from "src/ts/alert";
    import { pinTogglesToChat, snapshotToggleValues, unpinTogglesFromChat } from "src/ts/chatBindings";
    import { togglePresetsOpenStore } from "src/ts/stores.svelte";
    import Button from "../UI/GUI/Button.svelte";

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
        const template = presetStore.state.promptTemplate
        if (!template) {
            return (presetStore.state.jailbreak ?? '').trim().length > 0
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
            presetStore.state.customPromptTemplateToggle + '\n' +
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

    let currentChat = $derived.by(() => {
        const character = characterStore.characters?.[$selectedCharID]
        return character?.chats?.[character.chatPage]
    })
    let isPinned = $derived(currentChat?.useLocallySetGlobalVariables === true)

    // A pinned chat keeps its own toggle values; edits are stored on the chat.
    async function togglePin() {
        const chat = characterStore.getCurrentChat()
        if (!chat) return
        if (chat.useLocallySetGlobalVariables) {
            if (await alertConfirm(language.togglePinRemove)) unpinTogglesFromChat(chat)
        } else {
            pinTogglesToChat(chat)
        }
    }

    // New chats start pinned to this snapshot; existing chats are not touched.
    async function saveAsDefault() {
        if (settingsStore.state.defaultToggleValues) {
            const sel = parseInt(await alertSelect([
                language.toggleDefaultOverwrite,
                language.toggleDefaultClear,
                language.cancel,
            ]))
            if (sel === 1) {
                settingsStore.state.defaultToggleValues = undefined
                return
            }
            if (sel !== 0) return
        } else if (!(await alertConfirm(language.toggleSetDefaultConfirm))) {
            return
        }
        settingsStore.state.defaultToggleValues = snapshotToggleValues()
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
            <div class="w-full flex gap-2 mt-2 items-center">
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
            <div class="w-full flex gap-2 mt-2 items-center">
                <span>{@render getToggleDisplayName(toggle)}</span>
                <TextInput className="w-32" value={getGlobalChatVarNH(`toggle_${toggle.key}`)} onchange={(e) => {
                    setGlobalChatVar(`toggle_${toggle.key}`, e.currentTarget.value)
                }} />
            </div>
        {:else if toggle.type === 'textarea'}
            <div class="w-full flex gap-2 mt-2 items-start">
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
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center">
                    {#if toggle.value}
                        <span class="shrink-0">{@render getToggleDisplayName(toggle)}</span>
                    {/if}
                    <hr class="border-t border-darkborderc m-0 grow" />
                </div>
            {/if}
        {:else}
            <div class="w-full flex mt-2 items-center">
                <CheckInput check={getGlobalChatVarNH(`toggle_${toggle.key}`) === '1'} reverse={reverse} name={toggle.value} onChange={() => {
                    setGlobalChatVar(`toggle_${toggle.key}`, getGlobalChatVarNH(`toggle_${toggle.key}`) === '1' ? '0' : '1')
                }}>
                    {@render localToggle(toggle)}
                </CheckInput>
            </div>
        {/if}
    {/each}
{/snippet}

{#if currentChat}
    <div class="text-[11px] text-textcolor2 mt-2 px-1">{language.toggleBindingLabel}</div>
    <div class="flex gap-1 items-stretch w-full">
        <Button styled="outlined" size="sm" selected={isPinned}
            className={`flex-1 min-w-0 justify-start gap-2 ${isPinned ? 'text-textcolor' : 'text-textcolor2'}`}
            onclick={togglePin}>
            <PinIcon size={16} class="shrink-0" />
            <span class="truncate">{isPinned ? language.togglePinnedLabel : language.togglePinLabel}</span>
        </Button>
        <Button styled="outlined" size="sm" className="shrink-0" onclick={() => togglePresetsOpenStore.set(true)}>
            <FolderHeartIcon size={16} />
        </Button>
    </div>
{/if}

{#if !noContainer && groupedToggles.length > 4}
    <div class="h-48 border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2 overflow-y-auto">
        <CustomSideBar />

        {#if hasJailbreakPrompt}
            <div class="flex mt-2 items-center w-full">
                <CheckInput bind:check={settingsStore.state.jailbreakToggle} name={language.jailbreakToggle} reverse />
            </div>
        {/if}

        {@render toggles(groupedToggles, true)}
        {#if chara && (settingsStore.state.supaModelType !== 'none' || settingsStore.state.hanuraiEnable || settingsStore.state.hypaV3)}
            <div class="flex mt-2 items-center w-full">
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
        <button class="w-full text-xs text-textcolor2 hover:text-textcolor cursor-pointer py-1 mt-1" onclick={saveAsDefault}>
            {settingsStore.state.defaultToggleValues ? language.toggleDefaultSavedButton : language.toggleSaveAsDefaultButton}
        </button>
    {/if}
{/if}
