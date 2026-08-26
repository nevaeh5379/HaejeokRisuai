<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertSelect } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, saveUserPersona, selectUserImg } from "src/ts/persona";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { onDestroy, onMount } from "svelte";
    import { sleep, sortableOptions } from "src/ts/util";
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { v4 } from "uuid";
    import { 
        PlusIcon, 
        UserIcon, 
        CameraIcon, 
        CheckIcon, 
        SearchIcon, 
        XIcon, 
        ImageOffIcon
    } from "@lucide/svelte";

    let stb: Sortable = null;
    let ele: HTMLDivElement = $state();
    let sorted = $state(0);
    let selectedId: string = null;
    let searchQuery = $state('');

    let selectedPersona = $derived(settingsStore.state.personas?.[settingsStore.state.selectedPersona]);
    let selectedPersonaIcon = $derived(selectedPersona?.icon ?? settingsStore.state.userIcon ?? '');

    $effect(() => {
        if (!settingsStore?.state?.personas || settingsStore.state.personas.length === 0) {
            settingsStore.state.personas = [{
                name: settingsStore?.state?.username || 'User',
                icon: settingsStore?.state?.userIcon || '',
                personaPrompt: settingsStore?.state?.personaPrompt || '',
                note: settingsStore?.state?.userNote || '',
                largePortrait: false
            }];
        }
        if (settingsStore.state.selectedPersona >= settingsStore.state.personas.length || settingsStore.state.selectedPersona < 0) {
            settingsStore.state.selectedPersona = 0;
        }
    });

    let filteredPersonas = $derived.by(() => {
        const list = settingsStore.state.personas || [];
        const q = searchQuery.trim().toLowerCase();
        if (!q) {
            return list.map((p, idx) => ({ persona: p, originalIndex: idx }));
        }
        return list
            .map((p, idx) => ({ persona: p, originalIndex: idx }))
            .filter(({ persona }) => {
                const name = (persona.name || '').toLowerCase();
                const note = (persona.note || '').toLowerCase();
                const prompt = (persona.personaPrompt || '').toLowerCase();
                return name.includes(q) || note.includes(q) || prompt.includes(q);
            });
    });

    const createStb = () => {
        if (!ele || searchQuery.trim() !== '') return;
        stb = Sortable.create(ele, {
            onStart: async () => {
                if (settingsStore?.state?.personas?.[settingsStore.state.selectedPersona]) {
                    settingsStore.state.personas[settingsStore.state.selectedPersona].id ??= v4();
                    selectedId = settingsStore.state.personas[settingsStore.state.selectedPersona].id;
                    saveUserPersona();
                }
            },
            onEnd: async () => {
                let idx: number[] = [];
                ele.querySelectorAll('[data-risu-idx]').forEach((e) => {
                    idx.push(parseInt(e.getAttribute('data-risu-idx')));
                });
                let newValue: {
                    personaPrompt: string;
                    name: string;
                    icon: string;
                    note?: string;
                    largePortrait?: boolean;
                    id?: string;
                }[] = [];
                idx.forEach((i) => {
                    newValue.push(settingsStore.state.personas[i]);
                });
                settingsStore.state.personas = newValue;
                const foundIndex = settingsStore.state.personas.findIndex((e) => e.id === selectedId);
                changeUserPersona(foundIndex !== -1 ? foundIndex : 0, 'noSave');
                try {
                    stb.destroy();
                } catch (error) {}
                sorted += 1;
                await sleep(1);
                createStb();
            },
            ...sortableOptions
        });
    };

    onMount(createStb);

    onDestroy(() => {
        if (stb) {
            try {
                stb.destroy();
            } catch (error) {}
        }
    });

    async function addNewPersona() {
        const sel = parseInt(await alertSelect([language.createfromScratch, language.importCharacter]));
        if (sel === 0) {
            saveUserPersona();
            settingsStore.state.personas.push({
                name: 'New Persona',
                icon: '',
                personaPrompt: '',
                note: '',
                largePortrait: false,
                id: v4()
            });
            changeUserPersona(settingsStore.state.personas.length - 1);
        } else if (sel === 1) {
            await importUserPersona();
        }
    }

    function duplicateCurrentPersona() {
        saveUserPersona();
        const current = settingsStore.state.personas[settingsStore.state.selectedPersona];
        if (!current) return;
        settingsStore.state.personas.push({
            name: `${current.name || 'Persona'} (Copy)`,
            icon: current.icon || '',
            personaPrompt: current.personaPrompt || '',
            note: current.note || '',
            largePortrait: current.largePortrait || false,
            id: v4()
        });
        changeUserPersona(settingsStore.state.personas.length - 1);
    }

    function removeUserImg() {
        settingsStore.state.userIcon = '';
        saveUserPersona();
    }

    async function deleteCurrentPersona() {
        if (settingsStore.state.personas.length <= 1) return;
        const currentName = settingsStore.state.personas[settingsStore.state.selectedPersona]?.name ?? '';
        const d = await alertConfirm(`${language.removeConfirm}${currentName}`);
        if (d) {
            saveUserPersona();
            let personas = settingsStore.state.personas;
            personas.splice(settingsStore.state.selectedPersona, 1);
            settingsStore.state.personas = personas;
            changeUserPersona(0, 'noSave');
        }
    }
</script>

<div class="flex-1 flex flex-col min-h-0 w-full">
    <h2 class="mb-3 text-2xl font-bold shrink-0">{language.persona}</h2>

    <!-- 2-Pane Responsive Grid Layout -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full flex-1 min-h-0 items-stretch">
        <!-- Left Pane: Persona List & Search -->
        <div class="lg:col-span-5 xl:col-span-5 flex flex-col gap-2.5 h-full min-h-0">
            <!-- Search & Add Toolbar in Single Line (Unified Height & Radius) -->
            <div class="flex items-center gap-1.5 shrink-0">
                <div class="relative flex-1">
                    <div class="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-textcolor2">
                        <SearchIcon size={14} />
                    </div>
                    <input 
                        type="text"
                        bind:value={searchQuery}
                        placeholder={`${language.persona} (${settingsStore.state.personas.length})...`}
                        class="w-full h-8 pl-8 pr-7 rounded-lg border border-darkborderc bg-darkbutton/70 text-textcolor placeholder-textcolor2/60 text-xs focus:outline-none focus:ring-1 focus:ring-textcolor/30 transition-all"
                    />
                    {#if searchQuery}
                        <button 
                            class="absolute inset-y-0 right-2 flex items-center text-textcolor2 hover:text-textcolor"
                            onclick={() => { searchQuery = ''; }}
                            title="Clear"
                        >
                            <XIcon size={13} />
                        </button>
                    {/if}
                </div>

                <button
                    onclick={addNewPersona}
                    class="h-8 w-8 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor hover:text-green-500 border border-darkborderc transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                    title={language.createfromScratch || "Add Persona"}
                >
                    <PlusIcon size={15} />
                </button>
            </div>

            <!-- Persona Cards Grid -->
            {#key sorted}
                <div 
                    class="grid grid-cols-1 xl:grid-cols-2 gap-2 flex-1 min-h-0 overflow-y-auto pr-1 content-start"
                    bind:this={ele}
                >
                    {#each filteredPersonas as { persona, originalIndex }}
                        {@const isSelected = originalIndex === settingsStore.state.selectedPersona}
                        <div
                            data-risu-idx={originalIndex}
                            class="group relative flex items-center gap-2.5 p-2 rounded-xl border transition-all cursor-pointer {isSelected ? 'border-selected bg-selected/20 ring-1 ring-selected/70 shadow-xs' : 'border-darkborderc/60 bg-darkbg/30 hover:bg-darkbutton hover:border-textcolor/30'}"
                            role="button"
                            tabindex="0"
                            onclick={() => changeUserPersona(originalIndex)}
                            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') changeUserPersona(originalIndex); }}
                        >
                            <!-- Avatar Thumbnail (Supports Large Portrait) -->
                            <div class="relative w-10 rounded-lg overflow-hidden bg-darkbg shrink-0 border border-darkborderc/40 flex items-center justify-center {persona.largePortrait ? 'h-14' : 'h-10'}">
                                {#if persona.icon === ''}
                                    <UserIcon size={20} class="text-textcolor2/60" />
                                {:else}
                                    {#await getCharImage(persona.icon, 'css', { thumbnail: true })}
                                        <div class="w-full h-full bg-darkbg animate-pulse"></div>
                                    {:then im}
                                        <div class="w-full h-full bg-cover bg-center" style={im}></div>
                                    {/await}
                                {/if}
                            </div>

                            <!-- Name & Note Info -->
                            <div class="flex flex-col min-w-0 flex-1">
                                <span class="font-bold text-xs sm:text-sm text-textcolor truncate leading-snug">
                                    {persona.name || 'New Persona'}
                                </span>
                                {#if persona.note}
                                    <span class="text-[10px] text-textcolor2/70 truncate mt-0.5">
                                        {persona.note}
                                    </span>
                                {/if}
                            </div>

                            <!-- Selected Badge / Checkmark -->
                            {#if isSelected}
                                <div class="shrink-0 text-textcolor flex items-center pr-0.5">
                                    <CheckIcon size={14} />
                                </div>
                            {/if}
                        </div>
                    {/each}

                    {#if filteredPersonas.length === 0}
                        <div class="col-span-full py-8 text-center text-xs text-textcolor2">
                            No personas match "{searchQuery}"
                        </div>
                    {/if}
                </div>
            {/key}
        </div>

        <!-- Right Pane: Active Persona Editor -->
        <div class="lg:col-span-7 xl:col-span-7 flex flex-col gap-4 p-5 rounded-2xl border border-darkborderc bg-darkbg/25 shadow-xs h-full min-h-0">
            <!-- Top Section: Avatar (Left) + Name & Note (Right) Integrated -->
            <div class="flex flex-col sm:flex-row items-start gap-4 pb-4 border-b border-darkborderc/40 shrink-0">
                <!-- Avatar with Action Buttons (Supports Large Portrait Aspect Ratio) -->
                <div class="flex flex-col items-center gap-1.5 shrink-0">
                    <button
                        onclick={() => selectUserImg()}
                        class="group relative rounded-2xl overflow-hidden border-2 border-darkborderc bg-darkbg hover:border-selected transition-all shadow-md shrink-0 cursor-pointer {selectedPersona?.largePortrait ? 'w-24 h-36 sm:w-28 sm:h-[10.66rem]' : 'w-24 h-24 sm:w-28 sm:h-28'}"
                        title="Change Avatar"
                    >
                        {#if selectedPersonaIcon === ''}
                            <div class="w-full h-full flex items-center justify-center text-textcolor2/60 bg-darkbutton/50">
                                <UserIcon size={40} />
                            </div>
                        {:else}
                            {#await getCharImage(selectedPersonaIcon, selectedPersona?.largePortrait ? 'lgcss' : 'css')}
                                <div class="w-full h-full bg-darkbg animate-pulse"></div>
                            {:then im}
                                <div class="w-full h-full" style={im}></div>
                            {/await}
                        {/if}

                        <!-- Hover Overlay -->
                        <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 text-white text-[10px] sm:text-xs font-medium">
                            <CameraIcon size={18} />
                            <span>Change</span>
                        </div>
                    </button>

                    <div class="flex items-center gap-1.5">
                        <button 
                            onclick={() => selectUserImg()}
                            class="px-2 py-0.5 rounded-md bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-[11px] font-medium transition-colors cursor-pointer"
                        >
                            Image
                        </button>
                        {#if selectedPersonaIcon !== ''}
                            <button 
                                onclick={removeUserImg}
                                class="px-2 py-0.5 rounded-md hover:bg-draculared/20 text-textcolor2 hover:text-draculared text-[11px] font-medium transition-colors cursor-pointer"
                            >
                                Reset
                            </button>
                        {/if}
                    </div>
                </div>

                <!-- Name & Note Form Inputs (Fills remaining horizontal space) -->
                <div class="flex flex-col gap-2.5 min-w-0 flex-1 w-full">
                    <div>
                        <span class="block text-xs font-semibold text-textcolor2 mb-1">{language.name}</span>
                        <TextInput 
                            marginBottom={false} 
                            size="md" 
                            placeholder="User" 
                            bind:value={settingsStore.state.username} 
                            oninput={saveUserPersona} 
                            fullwidth
                        />
                    </div>

                    {#if settingsStore.state.personaNote}
                        <div>
                            <span class="block text-xs font-semibold text-textcolor2 mb-1">{language.note}</span>
                            <TextInput 
                                marginBottom={false} 
                                size="md" 
                                bind:value={settingsStore.state.userNote} 
                                oninput={saveUserPersona} 
                                placeholder={`Put a unique identifier for this persona here. Example: [Alternate Hunters persona]`} 
                                fullwidth
                            />
                        </div>
                    {/if}
                </div>
            </div>

            <!-- Description (Prompt) Field (Fills remaining vertical space with full height) -->
            <div class="flex flex-col min-w-0 flex-1 min-h-0 overflow-hidden">
                <span class="block text-xs font-semibold text-textcolor2 mb-1 shrink-0">{language.description}</span>
                <div class="flex-1 w-full min-h-0">
                    <TextAreaInput 
                        autocomplete="off" 
                        height={"full"} 
                        bind:value={settingsStore.state.personaPrompt} 
                        onInput={saveUserPersona} 
                        placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} 
                        fullwidth
                    />
                </div>
            </div>

            <!-- Bottom Action Toolbar -->
            <div class="flex items-center justify-between pt-3 border-t border-darkborderc/40 flex-wrap gap-2 shrink-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <Button onclick={exportUserPersona} size="sm">{language.export}</Button>
                    <Button onclick={importUserPersona} size="sm">{language.import}</Button>
                    <Button onclick={duplicateCurrentPersona} size="sm">Duplicate</Button>
                    {#if settingsStore.state.personas.length > 1}
                        <Button styled="danger" size="sm" onclick={deleteCurrentPersona}>{language.remove}</Button>
                    {/if}
                </div>

                {#if settingsStore.state.personas[settingsStore.state.selectedPersona]}
                    <div class="flex items-center text-xs">
                        <Check bind:check={settingsStore.state.personas[settingsStore.state.selectedPersona].largePortrait} name={language.largePortrait} />
                    </div>
                {/if}
            </div>
        </div>
    </div>
</div>
