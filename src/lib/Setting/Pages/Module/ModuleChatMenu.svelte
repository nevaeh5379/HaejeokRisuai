<script lang="ts">
    import { CircleCheckIcon, Waypoints, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { RisuModule } from "src/ts/process/modules";
    
    import { ReloadGUIPointer, selectedCharID, SettingsMenuIndex, settingsOpen, MobileGUI, MobileSideBar, openMobileSettingsPage } from "src/ts/stores.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
    import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";

    interface Props {
        close?: any;
        alertMode?: boolean;
    }

    let { close = (i:string) => {}, alertMode = false }: Props = $props();
    let moduleSearch = $state('')
    let modules = $derived(moduleStore.list)
    let enabledModules = $derived(settingsStore.state.enabledModules ?? moduleStore.enabledModules ?? [])
    let currentCharacter = $derived(characterStore.characters?.[$selectedCharID])
    let currentChat = $derived(currentCharacter?.chats?.[currentCharacter.chatPage])

    function sortModules(modules:RisuModule[], search:string){
        return modules.filter((v) => {
            if(search === '') return true
            return v.name.toLowerCase().includes(search.toLowerCase())
        
        }).sort((a, b) => {
            let score = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            return score
        })
    }

</script>


<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-full max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor">
            <h2 class="mt-0 mb-0 text-lg">{language.modules}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={() => {
                    close('')
                }}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        <span class="text-sm text-textcolor2">{language.chatModulesInfo}</span>

        <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

        <div class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md">
            {#if modules.length === 0}
                <div class="text-textcolor2 p-3">{language.noModules}</div>
            {:else}
                {#each sortModules(modules, moduleSearch) as rmodule, i}
                    {#if i !== 0}
                        <div class="border-t-1 border-selected"></div>
                    {/if}
                    <div class="pl-3 py-3 text-left flex items-center">
                        {#if rmodule.mcp}
                            <Waypoints size={18} class="mr-2" />
                        {/if}
                        {#if !alertMode && enabledModules.includes(rmodule.id)}
                            <span class="text-textcolor2">{rmodule.name}</span>
                        {:else}
                            <span class="">{rmodule.name}</span>
                        {/if}
                        <div class="grow flex justify-end">

                            {#if alertMode}
                                <button class={"text-textcolor2 mr-2 cursor-pointer hover:text-blue-500 transition-colors"} onclick={async (e) => {
                                    e.stopPropagation()

                                    close(rmodule.id)
                                }}>
                                    <CircleCheckIcon size={18}/>
                                </button>
                            {:else if enabledModules.includes(rmodule.id)}
                                <button class="mr-2 text-textcolor2 cursor-not-allowed"aria-labelledby="disabled">
                                </button>
                            {:else}
                                <button class={(currentChat?.modules?.includes(rmodule.id)) ?
                                        "mr-2 cursor-pointer text-blue-500" :
                                        (currentCharacter?.modules?.includes(rmodule.id)) ?
                                        "mr-2 cursor-pointer text-violet-500" :
                                        "text-textcolor2 hover:text-blue-400 mr-2 cursor-pointer"
                                } onclick={async (e) => {
                                    e.stopPropagation()
                                    if (!currentChat) return
                                    currentChat.modules ??= []
                                    if(currentChat.modules.includes(rmodule.id)){
                                        currentChat.modules.splice(currentChat.modules.indexOf(rmodule.id), 1)

                                    }
                                    else{
                                        currentChat.modules.push(rmodule.id)
                                    }
                                    currentChat.modules = currentChat.modules
                                    $ReloadGUIPointer += 1
                                }}
                                oncontextmenu={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    if (!currentCharacter) return
                                    if(!currentCharacter.modules){
                                        currentCharacter.modules = []
                                    }
                                    if(currentCharacter.modules.includes(rmodule.id)){
                                        currentCharacter.modules.splice(currentCharacter.modules.indexOf(rmodule.id), 1)
                                    }
                                    else{
                                        currentCharacter.modules.push(rmodule.id)
                                    }
                                    $ReloadGUIPointer += 1
                                }}>

                                    <CircleCheckIcon size={18}/>
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
            {/if}
        </div>
        <div>
            <Button className="mt-4 grow-0" size="sm" onclick={() => {
                if ($MobileGUI) {
                    close('')
                    openMobileSettingsPage(14, $selectedCharID, $MobileSideBar);
                } else {
                    $SettingsMenuIndex = 14
                    $settingsOpen = true
                    close('')
                }
            }}>{language.edit}</Button>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
