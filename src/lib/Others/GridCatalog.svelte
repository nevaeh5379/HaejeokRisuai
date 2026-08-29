<script lang="ts">
    import { changeChar, getCharImage, removeChar } from "../../ts/characters";
    import type { Database, character, groupChat } from "../../ts/storage/database/schema";
    import { characterStore } from 'src/ts/stores/domain';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, User, Users, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { parseMultilangString } from "src/ts/util";
    import { checkCharOrder, forageStorage } from "src/ts/globalApi.svelte";
    import { NodeStorage } from "src/ts/storage/files/nodeStorage";
    import type { NodePostgresCharacterSearchResult } from "src/ts/storage/sql/postgres/nodePostgresStorage";
    import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    interface Props {
        endGrid?: any;
    }

    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let tagSearch = $state('')
    let tagResults = $state<NodePostgresCharacterSearchResult[]>([])
    let tagSearching = $state(false)
    let selected = $state(3)

    function getNodeStorage(): NodeStorage | null {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            return null;
        }
        return forageStorage.realStorage;
    }

    async function runTagSearch() {
        const tag = tagSearch.trim();
        if (!tag) {
            tagResults = [];
            return;
        }
        const storage = getNodeStorage();
        if (storage && storage.postgres.isEnabled()) {
            tagSearching = true;
            try {
                tagResults = await storage.postgres.searchCharactersByTag(tag, 100);
            } catch {
                tagResults = [];
            } finally {
                tagSearching = false;
            }
            return;
        }
        // In-memory fallback
        const lower = tag.toLowerCase();
        tagResults = characterStore.characters
            .filter((c) => !c.trashTime && ((c as any).tags ?? []).some((t: string) => t.toLowerCase().includes(lower)))
            .map((c) => ({ id: c.chaId, name: c.name, image: c.image ?? null, kind: c.type === 'group' ? 'group' : 'character' }));
    }

    function formatChars(search:string, chars: (character|groupChat)[] = characterStore.characters, trash = false){
        let charas:{
            image:string
            index:number
            type:string,
            name:string
            desc:string
            chaId:string
        }[] = []

        for(let i=0;i<chars.length;i++){
            const c = chars[i]
            if(c.trashTime && !trash){
                continue
            }
            if(!c.trashTime && trash){
                continue
            }
            if(c.name.replace(/ /g,"").toLocaleLowerCase().includes(search.toLocaleLowerCase().replace(/ /g,""))){
                charas.push({
                    image: c.image,
                    index: i,
                    type: c.type,
                    name: c.name,
                    desc: c.creatorNotes ?? 'No description',
                    chaId: c.chaId
                })
            }
        }
        return charas
    }
</script>

<div class="h-full w-full flex justify-center">
    <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col overflow-y-auto">
        <div class="mx-4 mb-6 flex flex-col">
            <div class="flex items-center gap-3 mb-2">
                <button 
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => endGrid()}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <div class="flex-1">
                    <TextInput placeholder="Search" bind:value={search} size="lg" autocomplete="off" fullwidth={true}/>
                </div>
            </div>
            <div class="flex items-center gap-2 mt-2">
                <div class="flex-1">
                    <TextInput placeholder={language.searchByTag} bind:value={tagSearch} size="sm" autocomplete="off" fullwidth={true}/>
                </div>
                <Button size="sm" disabled={tagSearching} onclick={runTagSearch}>
                    {tagSearching ? '...' : language.search}
                </Button>
            </div>
            {#if tagResults.length > 0}
                <div class="flex flex-wrap gap-2 mt-2">
                    {#each tagResults as result (result.id)}
                        <button
                            class="flex items-center gap-2 px-2 py-1 rounded-md border border-darkborderc hover:bg-selected transition-colors"
                            onclick={() => {
                                const idx = findCharacterIndexbyId(result.id);
                                if (idx !== -1) {
                                    changeChar(idx);
                                    endGrid();
                                }
                            }}
                        >
                            <span class="text-sm text-textcolor">{result.name}</span>
                        </button>
                    {/each}
                </div>
            {/if}
            <div class="flex flex-wrap gap-2 mt-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 3}}>
                    {language.simple}
                </Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 0}}>
                    {language.grid}
                </Button>
                <Button styled={selected === 1  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 1}}>
                    {language.list}
                </Button>
                <Button styled={selected === 2  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 2}}>
                    {language.trash}
                </Button>
                <div class="grow"></div>
                <span class="text-textcolor2 text-sm">
                    {formatChars(search).length} {language.character}
                </span>
            </div>
        </div>
        {#if selected === 0}
            <div class="w-full flex justify-center">
                <div class="flex flex-wrap gap-2 w-full justify-center">
                    {#each formatChars(search) as char}
                        <div class="flex items-center text-textcolor">
                            {#if char.image}
                                <BarIcon onClick={() => {changeChar(char.index)}} additionalStyle={getCharImage(char.image, 'css', { thumbnail: true })}></BarIcon>
                            {:else}
                                <BarIcon onClick={() => {changeChar(char.index)}} additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}>
                                    {#if char.type === 'group'}
                                        <Users />
                                    {:else}
                                        <User/>
                                    {/if}
                                </BarIcon>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>
        {:else if selected === 1}
            {#each formatChars(search) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <BarIcon onClick={() => {changeChar(char.index)}} additionalStyle={getCharImage(char.image, 'css', { thumbnail: true })}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                changeChar(char.index)
                            }}>
                                <SquareMousePointer />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name)
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 2}
            <span class="text-textcolor2 text-sm mb-2">{language.trashDesc}</span>
            {#each formatChars(search, characterStore.characters, true) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <BarIcon onClick={() => {changeChar(char.index)}} additionalStyle={getCharImage(char.image, 'css', { thumbnail: true })}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                const restoreIdx = findCharacterIndexbyId(char.chaId)
                                if (restoreIdx !== -1) {
                                    characterStore.characters[restoreIdx].trashTime = undefined
                                    checkCharOrder()
                                }
                            }}>
                                <Undo2Icon />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name, 'permanent')
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 3}
            <MobileCharacters endGrid={endGrid} search={search} hideTrash={true} />
        {/if}
    </div>
</div>
