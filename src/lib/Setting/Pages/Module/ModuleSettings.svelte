<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { language } from "src/lang";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { moduleStore } from 'src/ts/stores/domain/moduleStore.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, refreshModules, type RisuModule, type ModuleFolder } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, UserIcon, FolderPlus, FolderIcon, ChevronDown, ChevronRight, FolderInput } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertNormal, alertSelect, alertInput } from "src/ts/alert";
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
    let moduleSearch = $state('')
    let charConversionMode = $state(false)
    let openFolders = $state<Set<string>>(new Set())
    let modules = $derived(moduleStore.list)
    let enabledModules = $derived(moduleStore.enabledModules)
    let moduleFolders = $derived(moduleStore.folders)

    function sortModules(modules:RisuModule[], search:string){
        return modules.filter((v) => {
            if(search === '') return true
            return v.name.toLowerCase().includes(search.toLowerCase())

        }).sort((a, b) => {
            let score = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            return score
        })
    }

    function toggleFolder(id: string) {
        const next = new Set(openFolders)
        if (next.has(id)) {
            next.delete(id)
        } else {
            next.add(id)
        }
        openFolders = next
    }

    async function createFolder() {
        const name = await alertInput(language.folderName)
        if (!name) return
        await moduleStore.addFolder(name)
    }

    async function removeFolder(folder: ModuleFolder) {
        const d = await alertConfirm(language.removeFolderConfirm)
        if (!d) return
        await moduleStore.removeFolder(folder.id)
    }

    async function moveModuleToFolder(module: RisuModule) {
        const folders = moduleFolders
        const options = [
            language.noFolder,
            ...folders.map((f) => f.name),
        ]
        const sel = parseInt(await alertSelect(options))
        if (Number.isNaN(sel)) return
        if (sel === 0) {
            await moduleStore.moveModuleToFolder(module.id, undefined)
        } else {
            const folder = folders[sel - 1]
            if (folder) {
                await moduleStore.moveModuleToFolder(module.id, folder.id)
            }
        }
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.modules}</h2>

    <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

    <div class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto">
        {#if modules.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else}
            {@const folders = moduleFolders}
            {@const ungrouped = sortModules(modules.filter((m) => !m.folderId || !folders.some((f) => f.id === m.folderId)), moduleSearch)}
            {@render moduleRows(ungrouped, true)}
            {#each folders as folder}
                {@const folderModules = sortModules(modules.filter((m) => m.folderId === folder.id), moduleSearch)}
                {#if folderModules.length > 0 || moduleSearch === ''}
                    <div class="border-t-1 border-selected"></div>
                    <div class="w-full flex items-center pl-3 pr-3 py-2 text-left">
                        <button
                            class="grow flex items-center text-left hover:bg-textcolor/5 cursor-pointer -ml-3 pl-3 py-2"
                            onclick={() => toggleFolder(folder.id)}
                        >
                            {#if openFolders.has(folder.id)}
                                <ChevronDown size={18} class="mr-2 text-textcolor2" />
                            {:else}
                                <ChevronRight size={18} class="mr-2 text-textcolor2" />
                            {/if}
                            <FolderIcon size={18} class="mr-2 text-textcolor2" />
                            <span class="text-lg font-semibold">{folder.name}</span>
                            <span class="ml-2 text-sm text-textcolor2">({folderModules.length})</span>
                        </button>
                        <button
                            class="text-textcolor2 hover:text-red-500 ml-2 cursor-pointer"
                            use:tooltip={language.removeFolder}
                            onclick={async (e) => {
                                e.stopPropagation()
                                await removeFolder(folder)
                            }}
                        >
                            <TrashIcon size={16} />
                        </button>
                    </div>
                    {#if openFolders.has(folder.id)}
                        {@render moduleRows(folderModules, false)}
                    {/if}
                {/if}
            {/each}
        {/if}
    </div>

    <div class="flex mr-2 mt-4">
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.createModule} onclick={async () => {
            tempModule = {
                name: '',
                description: '',
                id: v4(),
            }
            mode = 1
        }}>
            <PlusIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.createFolder} onclick={createFolder}>
            <FolderPlus />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" onclick={async () => {
            charConversionMode = !charConversionMode
        }}>
            <UserIcon />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.importModule} onclick={async () => {
            importMCPModule()
        }}>
            <Waypoints />
        </button>
        <button class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer" use:tooltip={language.importModule} onclick={async () => {
            importModule()
        }}>
            <HardDriveUpload  />
        </button>
    </div>
{:else if mode === 1}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.createModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={async () => {
        await moduleStore.installModule(tempModule)
        mode = 0
    }}>{language.createModule}</Button>
{:else if mode === 2}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={async () => {
            await moduleStore.updateModule(tempModule.id, tempModule)
            mode = 0
        }}>{language.editModule}</Button>
    {/if}
{/if}

{#snippet moduleRows(modules: RisuModule[], showHeader: boolean)}
    {#each modules as rmodule, i}
        {#if i !== 0 || showHeader}
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
                        const module = moduleStore.getById(rmodule.id)
                        if (!module) return
                        const char = convertModuleToCharacter(module)
                        characterStore.characters.push(char)
                        alertNormal(language.successfullyConverted)
                        checkCharOrder()
                    }}>
                        <UserIcon size={18}/>

                    </button>
                {:else}
                    <button class={(enabledModules.includes(rmodule.id)) ?
                            "mr-2 cursor-pointer text-blue-500" :
                            rmodule.namespace &&
                            presetStore.state.moduleIntergration?.split(',').map((s: string) => s.trim()).includes(rmodule.namespace) ?
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
                            tempModule = rmodule
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
                    <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.moveToFolder} onclick={async (e) => {
                        e.stopPropagation()
                        await moveModuleToFolder(rmodule)
                    }}>
                        <FolderInput size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer" use:tooltip={language.remove} onclick={async (e) => {
                        e.stopPropagation()
                        const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                        if(d){
                            await moduleStore.removeModule(rmodule.id)
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
{/snippet}
