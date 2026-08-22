<script lang="ts">
    import { language } from "src/lang";
    
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { moduleStore } from 'src/ts/stores/domain/moduleStore.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, UserIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertNormal, alertSelect } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleIndex = $state(-1)
    let moduleSearch = $state('')
    let charConversionMode = $state(false)

    function sortModules(modules:RisuModule[], search:string){
        return modules.filter((v) => {
            if(search === '') return true
            return v.name.toLowerCase().includes(search.toLowerCase())
        
        }).sort((a, b) => {
            let score = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            return score
        })
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.modules}</h2>

    <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

    <div class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto">
        {#if settingsStore.state.modules.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else}
            {#each sortModules(settingsStore.state.modules, moduleSearch) as rmodule, i}
                {#if i !== 0}
                    <div class="border-t-1 border-selected"></div>
                {/if}

                <div class="pl-3 pt-3 text-left flex items-center">
                    {#if rmodule.mcp}
                        <Waypoints size={18} class="mr-2" />
                    {/if}
                    <span class="text-lg">{rmodule.name}</span>
                    <div class="grow flex justify-end">
                        {#if charConversionMode}
                            <button class="cursor-pointer text-violet-500 mr-2" onclick={async (e) => {
                                e.stopPropagation()
                                const module = settingsStore.state.modules.find((v: RisuModule) => v.id === rmodule.id)
                                const char = convertModuleToCharacter(module)
                                characterStore.characters.push(char)
                                alertNormal(language.successfullyConverted)
                                checkCharOrder()
                            }}>
                                <UserIcon size={18}/>
                                
                            </button>
                        {:else}
                            <button class={(settingsStore.state.enabledModules.includes(rmodule.id)) ?
                                    "mr-2 cursor-pointer text-blue-500" :
                                    rmodule.namespace && 
                                    settingsStore.state.moduleIntergration?.split(',').map((s: string) => s.trim()).includes(rmodule.namespace) ?
                                    "text-amber-500 hover:text-green-500 mr-2 cursor-pointer" :
                                    "text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                } use:tooltip={language.enableGlobal} onclick={async (e) => {
                                e.stopPropagation()
                                await moduleStore.toggleModule(rmodule.id)
                                charConversionMode = false
                            }}>
                                <Globe size={18}/>
                            </button>
                            {#if !rmodule.mcp}
                                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.download} onclick={async (e) => {
                                    e.stopPropagation()
                                    const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
                                    if(sel === 0){
                                        exportModule(rmodule)
                                    }
                                    else{
                                        exportModuleLegacy(rmodule)
                                    }
                                    charConversionMode = false
                                }}>
                                    <Share2Icon size={18}/>
                                </button>
                                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.edit} onclick={async (e) => {
                                    e.stopPropagation()
                                    const index = settingsStore.state.modules.findIndex((v: RisuModule) => v.id === rmodule.id)
                                    tempModule = rmodule
                                    editModuleIndex = index
                                    mode = 2
                                }}>
                                    <SquarePen size={18}/>
                                </button>
                            {:else}
                                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                    <Share2Icon size={18}/>
                                </button>
                                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                    <SquarePen size={18}/>
                                </button>
                            {/if}
                            <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.remove} onclick={async (e) => {
                                e.stopPropagation()
                                const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                                if(d){
                                    if(settingsStore.state.enabledModules.includes(rmodule.id)){
                                        settingsStore.state.enabledModules.splice(settingsStore.state.enabledModules.indexOf(rmodule.id), 1)
                                        settingsStore.state.enabledModules = settingsStore.state.enabledModules
                                    }
                                    const index = settingsStore.state.modules.findIndex((v: RisuModule) => v.id === rmodule.id)
                                    settingsStore.state.modules.splice(index, 1)
                                    settingsStore.state.modules = settingsStore.state.modules
                                }
                            }}>
                                <TrashIcon size={18}/>
                            </button>
                        {/if}

                    </div>
                </div>
                <div class="mt-1 mb-3 pl-3">
                    <span class="text-sm text-textcolor2">{rmodule.description || 'No description provided'}</span>
                </div>
            {/each}
        {/if}
    </div>

    <div class="flex mr-2 mt-4">
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            tempModule = {
                name: '',
                description: '',
                id: v4(),
            }
            settingsStore.state.modules.push(tempModule)
            mode = 1
        }}>
            <PlusIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            charConversionMode = !charConversionMode
        }}>
            <UserIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            importMCPModule()
        }}>
            <Waypoints />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            importModule()
        }}>
            <HardDriveUpload  />
        </button>
    </div>
{:else if mode === 1}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.createModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={() => {
        settingsStore.state.modules.push(tempModule)
        mode = 0
    }}>{language.createModule}</Button>
{:else if mode === 2}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={() => {
            settingsStore.state.modules[editModuleIndex] = tempModule
            mode = 0
        }}>{language.editModule}</Button>
    {/if}
{/if}
