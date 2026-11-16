<script lang="ts">
    import { ScrollTextIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openPresetList, presetSelectCallback, selectedCharID } from "src/ts/stores.svelte";
    import { characterStore, presetStore } from "src/ts/stores/domain";
    import { changeToPreset } from "src/ts/storage/presets/presetService";
    import { bindButtonClass, bindSetClass, bindUnsetClass } from "./bindButton";

    let currentChat = $derived.by(() => {
        const character = characterStore.characters[$selectedCharID]
        return character?.chats?.[character.chatPage]
    })
    let boundPreset = $derived.by(() => {
        const id = currentChat?.bindedBotPreset
        if (!id) return null
        return presetStore.summaries.find((preset) => preset.id === id) ?? null
    })
    let displayName = $derived(
        boundPreset?.name
            ?? presetStore.summaries.find((preset) => preset.id === presetStore.activeId)?.name
            ?? language.none
    )

    // The picker's top row ("default", index -1) unbinds; any preset binds and
    // becomes the active preset right away.
    function openPicker() {
        presetSelectCallback.set((index) => {
            const chat = characterStore.getCurrentChat()
            if (!chat) return
            if (index < 0) {
                chat.bindedBotPreset = ''
                return
            }
            const preset = presetStore.summaries[index]
            if (!preset) return
            chat.bindedBotPreset = preset.id
            void changeToPreset(index)
        })
        openPresetList.set(true)
    }
</script>

<div class="text-[11px] text-textcolor2 mt-2 px-1">{language.promptBindingLabel}</div>
<button
    type="button"
    class={`${bindButtonClass} w-full justify-start ${boundPreset ? bindSetClass : bindUnsetClass}`}
    onclick={openPicker}
>
    <ScrollTextIcon size={16} />
    <span class="truncate">{boundPreset ? displayName : `${language.bindingInherit} (${displayName})`}</span>
</button>
