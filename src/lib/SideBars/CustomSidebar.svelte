<script lang="ts">
    import { Cog, PinIcon } from '@lucide/svelte'
    import { loadoutModalStore, openPersonaList, openPresetList, selectedCharID, settingsOpen, SettingsMenuIndex, MobileGUI, MobileSideBar, openMobileSettingsPage } from 'src/ts/stores.svelte';
    import { characterStore, settingsStore, personaStore, presetStore } from 'src/ts/stores/domain';
    import Button from '../UI/GUI/Button.svelte';
    import type { CustomSideBarItem } from '../../ts/storage/database/schema';
    import { language } from 'src/lang';
    import TextInput from '../UI/GUI/TextInput.svelte';
    import { getFullSettingsData } from 'src/ts/setting/utils';
    import { getModelInfo } from 'src/ts/model/modellist';
    import { get } from 'svelte/store';
    import SettingRenderer from '../Setting/SettingRenderer.svelte';
    import { checkPersonaBinded, getPersonaForTarget } from 'src/ts/util';
    import { v4 } from 'uuid';
    let configPage:'list'|'add'|'addSettingsSubmenu' = $state('list')
    let search = $state('')

    let bindedPersona = $derived.by(() => {
        characterStore.characters[$selectedCharID].chatPage
        return checkPersonaBinded()
    })

    let fixedPersona = $derived.by(() => {
        const chara = characterStore.characters[$selectedCharID]
        if (!chara || chara.type === 'group' || !chara.fixedPersonaId) return null
        return personaStore.list.find((persona) => persona.id === chara.fixedPersonaId) ?? null
    })

    let displayedPersona = $derived.by(() => getPersonaForTarget())
    let personaName = $derived(displayedPersona?.name ?? 'User')
</script>


<div class="rounded-sm flex flex-col w-full gap-2">

    {#each settingsStore.state.customSidebarItems as item}
        {#if item.type === 'model'}
            <Button onclick={() => {
                if ($MobileGUI) {
                    openMobileSettingsPage(1, $selectedCharID, $MobileSideBar);
                } else {
                    $SettingsMenuIndex = 1;
                    settingsOpen.set(true);
                }
            }}>{
                getModelInfo(settingsStore.state.aiModel)?.fullName || settingsStore.state.aiModel || language.none
            }</Button>
        {:else if item.type === 'preset'}
            <Button onclick={() => {
                openPresetList.set(!get(openPresetList))
            }}>{
                presetStore.activePreset?.name
                ||
                language.presets
            }</Button>
        {:else if item.type === 'loadout'}
            <Button onclick={() => {
                loadoutModalStore.open = !loadoutModalStore.open
            }}>{settingsStore.state.lastLoadedLoadoutName || language.loadouts}</Button>
        {:else if item.type === 'persona'}
            <Button className="flex" onclick={() => {
                if(bindedPersona || fixedPersona){
                    return
                }
                openPersonaList.set(!get(openPersonaList))
            }}>
                <div class="flex-1 flex-col flex text-left">
                    <span>{personaName}</span>
                    {#if displayedPersona?.note}
                        <span class="text-xs text-textcolor2">{displayedPersona.note}</span>
                    {/if}
                </div>

                <button class={{
                    "ml-2": true,
                    "text-textcolor2": !bindedPersona,
                    "text-textcolor": bindedPersona
                }} onclick={(e) => {
                    e.stopPropagation()
                    const chatIndex = characterStore.characters[$selectedCharID].chatPage
                    const currentPersona = personaStore.activePersona
                    if(!currentPersona) return
                    if(!currentPersona.id){
                        currentPersona.id = v4()
                    }
                    if(checkPersonaBinded()) {
                        characterStore.characters[$selectedCharID].chats[chatIndex].bindedPersona = ''
                    }
                    else{
                        characterStore.characters[$selectedCharID].chats[chatIndex].bindedPersona = currentPersona.id
                    }
                }}>
                    <PinIcon size={20} />
                </button>
            </Button>
        {:else if item.type === 'setting'}
            <SettingRenderer items={
                [getFullSettingsData().find(s => s.id === item.subType)]
            } />
        {/if}
    {/each}
</div>
