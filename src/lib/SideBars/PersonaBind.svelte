<script lang="ts">
    import { ContactIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { language } from "src/lang";
    import { openPersonaList, personaSelectCallback, selectedCharID } from "src/ts/stores.svelte";
    import { characterStore, personaStore } from "src/ts/stores/domain";
    import Button from "../UI/GUI/Button.svelte";

    let currentChat = $derived.by(() => {
        const character = characterStore.characters[$selectedCharID]
        return character?.chats?.[character.chatPage]
    })
    let boundPersona = $derived.by(() => {
        const id = currentChat?.bindedPersona
        if (!id) return null
        return personaStore.list.find((persona) => persona.id === id) ?? null
    })
    let displayPersona = $derived(boundPersona ?? personaStore.activePersona)

    // The picker's top row ("default", index -1) unbinds; any persona binds.
    function openPicker() {
        personaSelectCallback.set((index) => {
            const chat = characterStore.getCurrentChat()
            if (!chat) return
            if (index < 0) {
                chat.bindedPersona = ''
                return
            }
            const persona = personaStore.list[index]
            if (!persona) return
            if (!persona.id) persona.id = v4()
            chat.bindedPersona = persona.id
        })
        openPersonaList.set(true)
    }
</script>

<div class="text-[11px] text-textcolor2 mt-2 px-1">{language.personaBindingLabel}</div>
<Button
    styled="outlined"
    size="sm"
    className={`w-full min-w-0 justify-start gap-2 ${boundPersona ? 'border-selected text-textcolor' : 'text-textcolor2'}`}
    onclick={openPicker}
>
    <ContactIcon size={16} class="shrink-0" />
    <span class="truncate">{boundPersona ? (displayPersona?.name ?? 'User') : `${language.bindingInherit} (${displayPersona?.name ?? 'User'})`}</span>
    {#if displayPersona?.note}
        <span class="truncate text-xs opacity-60">({displayPersona.note})</span>
    {/if}
</Button>
