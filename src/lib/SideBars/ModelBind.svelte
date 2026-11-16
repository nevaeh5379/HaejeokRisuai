<script lang="ts">
    import { ChevronDownIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import { getModelInfo } from "src/ts/model/modellist";
    import { safeStructuredClone } from "src/ts/polyfill";
    import { CHAT_AUX_MODEL_TASKS, emptyChatModelBinding } from "src/ts/process/request/chatModelBinding";
    import type { ChatAuxModelTask } from "src/ts/storage/database/schema";
    import { selectedCharID } from "src/ts/stores.svelte";
    import { characterStore, presetStore, settingsStore } from "src/ts/stores/domain";
    import { bindButtonClass, bindIconButtonClass, bindSetClass, bindUnsetClass } from "./bindButton";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import ModelList from "../UI/ModelList.svelte";

    let currentChat = $derived.by(() => {
        const character = characterStore.characters[$selectedCharID]
        return character?.chats?.[character.chatPage]
    })
    let auxExpanded = $state(false)

    // An unbound chat is shown as an all-default binding. Each empty slot
    // follows the active preset's model, named in the slot's label.
    let shown = $derived(
        currentChat?.modelBinding
            ?? emptyChatModelBinding(presetStore.state.seperateModelsForAxModels ?? false)
    )

    const modelName = (id: string | undefined) =>
        (id && (getModelInfo(id)?.shortName || id)) || language.none
    const inherit = (id: string | undefined) => `${language.bindingInherit} (${modelName(id)})`
    const slotClass = (value: string | undefined) =>
        `${bindButtonClass} w-full justify-start ${value ? bindSetClass : bindUnsetClass}`

    function ensureBinding() {
        const chat = characterStore.getCurrentChat()
        if (!chat) return null
        chat.modelBinding ??= emptyChatModelBinding(presetStore.state.seperateModelsForAxModels ?? false)
        chat.modelBinding.aux ??= emptyChatModelBinding().aux
        return chat.modelBinding
    }

    function setSlot(slot: 'main' | 'sub', value: string) {
        const binding = ensureBinding()
        if (binding) binding[slot] = value
    }

    function setAuxSlot(task: ChatAuxModelTask, value: string) {
        const binding = ensureBinding()
        if (binding) binding.aux[task] = value
    }

    function setSeparateAux(on: boolean) {
        const binding = ensureBinding()
        if (binding) binding.separateAux = on
    }

    function unbind() {
        const chat = characterStore.getCurrentChat()
        if (chat) chat.modelBinding = undefined
    }

    async function saveAsDefault() {
        if (!currentChat?.modelBinding) return
        if (!(await alertConfirm(language.modelBindingSetDefaultConfirm))) return
        settingsStore.state.defaultModelBinding = safeStructuredClone($state.snapshot(currentChat.modelBinding))
    }

    const auxLabels: Record<ChatAuxModelTask, () => string> = {
        memory: () => language.axModelMemory,
        translate: () => language.axModelTranslate,
        emotion: () => language.axModelEmotion,
        otherAx: () => language.axModelOther,
    }
</script>

<div class="flex flex-col gap-1 mt-2">
    <div class="text-[11px] text-textcolor2 px-1">{language.modelBindingTitle}</div>
    {#key currentChat?.id}
        <ModelList triggerClass={slotClass(shown.main)} blankable value={shown.main} noneText={inherit(presetStore.state.aiModel)} onChange={(v) => setSlot('main', v)} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelList triggerClass={slotClass(shown.sub)} blankable value={shown.sub} noneText={inherit(presetStore.state.subModel)} onChange={(v) => setSlot('sub', v)} />
            </div>
            <button type="button" class={bindIconButtonClass} title={language.seperateModelsForAxModels} onclick={() => { auxExpanded = !auxExpanded }}>
                <ChevronDownIcon size={16} class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </button>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <CheckInput check={shown.separateAux} name={language.seperateModelsForAxModels} onChange={(check) => setSeparateAux(check)} />
                {#if shown.separateAux}
                    {#each CHAT_AUX_MODEL_TASKS as task}
                        <div class="text-[11px] text-textcolor2 px-1">{auxLabels[task]()}</div>
                        <ModelList triggerClass={slotClass(shown.aux[task])} blankable value={shown.aux[task]} noneText={language.submodel} onChange={(v) => setAuxSlot(task, v)} />
                    {/each}
                {/if}
            </div>
        {/if}
    {/key}
    {#if currentChat?.modelBinding}
        <div class="flex gap-1">
            <button class="flex-1 text-xs text-textcolor2 hover:text-textcolor cursor-pointer py-1" onclick={saveAsDefault}>
                {language.modelBindingSaveAsDefault}
            </button>
            <button class="text-xs text-textcolor2 hover:text-draculared cursor-pointer py-1 px-1" onclick={unbind}>
                {language.modelBindingUnbind}
            </button>
        </div>
    {/if}
</div>
